# Help Desk — IT Ticketing

Internal IT help desk: tickets with SLA tracking, an employee requestor
directory, configurable field options, role-based access control, and two-way
email intake through Resend.

**Stack:** Next.js (App Router) · React 19 · TypeScript · Tailwind v4 · MongoDB
(Mongoose) · Resend

---

## Data layer

MongoDB is the only datastore. Supabase, Firebase and Cloudinary have been
removed, along with the anonymous client-side querying that came with them.

> **Use a dedicated database.** `MONGODB_DB` must point at a database used only
> by this app. Collection names such as `tickets`, `users`, `roles` and
> `audit_logs` collide with other schemas, several of which already carry unique
> indexes. Default: `it_ticketing`.

### Collections

| Collection | Purpose |
|---|---|
| `users` | Login accounts (agents, supervisors, admins) |
| `requestors` | Employee / end-user directory — feeds the Requestor dropdown |
| `roles` | RBAC: a name plus a permissions object of booleans |
| `tickets` | Tickets, with embedded remark / status / assignment history |
| `ticket_counters` | One document per business day, holding the sequence |
| `dropdown_options` | Configurable options for every ticket field |
| `system_settings` | Singleton: numbering, SLA, email, rate limits |
| `email_messages` | Every inbound and outbound email |
| `audit_logs` | Immutable trail of privileged actions |
| `rate_limits` | Rate-limit windows, self-pruning via a TTL index |

Attachments are stored in **GridFS** (`fs.files` / `fs.chunks`).

### Key indexes

`ticketNumber` and `email_messages.messageId` are unique; `users.email` and
`requestors.employeeId` are unique (sparse on email); `tickets` carries a
compound `{ status, technician, dateCreated }` index for the default list query
plus `{ status, slaDueAt }` for breach scans. `rate_limits` expires each window
document when its window ends. Run `npm run verify` to assert all of this.

---

## Setup

```bash
npm install
cp .env.example .env.local     # then fill it in
npm run seed                   # roles, dropdowns, settings, a Super Admin
npm run dev
```

The seed creates `admin@it-ticketing.local` / `ChangeMe1234` with a forced
password change on first sign-in. Change it immediately — and if you ever lose
it, see **Forgotten admin password** below.

`JWT_SECRET` must be at least 32 characters or the app refuses to start:

```bash
openssl rand -base64 48
```

### Environment

| Variable | Purpose |
|---|---|
| `MONGODB_URI`, `MONGODB_DB` | Connection and dedicated database name |
| `JWT_SECRET` | Signs the session cookie (≥32 chars) |
| `SESSION_TIMEOUT_MIN` | Session lifetime and idle timeout |
| `RESEND_API_KEY` | Resend API key |
| `EMAIL_FROM` | Verified sending address |
| `INBOUND_EMAIL` | Address Gmail forwards to |
| `RESEND_INBOUND_SECRET` | Webhook signature secret |
| `RATE_LIMIT_*` | Defaults; all live-editable in Settings |
| `MAX_ATTACHMENT_BYTES` | Upload ceiling (default 10 MB) |
| `TICKET_PREFIX`, `TICKET_NUMBER_PATTERN` | Numbering defaults |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Seeded account |

`.env` supplies defaults only. Anything a Super Admin saves in **Configuration →
Settings** overrides it at runtime and takes effect immediately — no redeploy.

---

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Standard Next.js |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run seed` | Idempotent: roles, dropdowns, settings, Super Admin |
| `npm run verify` | Asserts indexes, seeded data, numbering and sanitisation |
| `npm run e2e` | Full HTTP suite against a running server (114 checks) |
| `npm run list-accounts` | Shows every account, its role and lock state |
| `npm run reset-password` | Admin password recovery (see below) |
| `npm run migrate:supabase:dry` | Reports what a migration would do |
| `npm run migrate:supabase` | One-time Supabase → MongoDB migration |

### Forgotten admin password

Accounts are local-only by design — there is no reset email — so recovery runs
against the database:

```bash
npm run list-accounts          # see who exists and who is locked out

# generate a strong password and print it once
npx tsx --conditions react-server scripts/reset-password.ts \
  --email admin@it-ticketing.local

# or set your own
npx tsx --conditions react-server scripts/reset-password.ts \
  --email you@company.com --password 'MyNewPass123'

# every Super Admin account at once
npx tsx --conditions react-server scripts/reset-password.ts \
  --role "Super Admin"

# just clear a lockout, keep the existing password
npx tsx --conditions react-server scripts/reset-password.ts \
  --email you@company.com --unlock-only
```

Invoke via `npx tsx ...` rather than `npm run` — npm strips flags like
`--email` before the script receives them.

A reset always clears `failedLoginAttempts` and `lockUntil`, reactivates the
account, and sets `mustChangePassword` so the owner picks a new one at next
sign-in (`--keep-password` opts out).

### Tests

`npm run verify` reads the real database. `npm run e2e` drives the real HTTP API
with a real session cookie, covering login rate-limiting and lockout, ticket
numbering, remarks history, RBAC scoping, CSV, dropdown deactivation, live
settings, and the whole inbound webhook path including signature verification,
threading, dedupe and auto-creation. It provisions its own throwaway Super Admin
and cleans up after itself, so it is safe to re-run.

```bash
npm run build && npm start          # in one terminal
BASE_URL=http://localhost:3000 npm run e2e
```

---

## Ticket numbering

The pattern is a setting, rendered live in the UI. Tokens:

`{PREFIX}` `{YYYY}` `{YY}` `{MM}` `{DD}` `{SEQ}` `{SEQ:N}` — anything else is
literal.

```
{PREFIX}-{YYYY}-{MM}-{DD}-{SEQ:3}   →  DSI-2026-10-06-001
{DD}-{MM}-{YYYY}-{SEQ:3}           →  06-10-2026-001
```

Sequence keys are business-local dates (Asia/Manila, UTC+8), so numbering
resets at local midnight. The counter uses a single atomic `$inc` with `upsert`,
which is what makes 50 parallel creates produce 50 distinct numbers. Number
*gaps* are possible and accepted: uniqueness is guaranteed, and a gap in the
audit trail is cheaper than a duplicate ticket number.

Changing the pattern bumps `patternVersion`, which is stamped onto each ticket.
Existing numbers are never rewritten. Inbound email threading reads the same
pattern, so changing it changes what the webhook can recognise.

## SLA

`dueAt = dateCreated + priority.slaHours`. Colour-banded green → amber → orange
→ red across the list and dashboard. Moving a ticket to **Scheduled** freezes the
clock and pushes the effective deadline forward by the frozen duration, so the
stored due date stays a stable fact.

## Roles and permissions

Four seeded roles: Super Admin, Admin, Agent, Viewer. Eighteen permissions in
`src/lib/shared/permissions.ts` are the single source of truth and are editable
from **Configuration → Roles & Access**.

Hiding a menu item is cosmetic. Every API route re-checks permissions
server-side, and the ticket query applies RBAC scope in one place
(`buildTicketFilter`) so no route can forget it. Agents without `viewAllTickets`
only ever see tickets assigned to or processed by them.

Guardrails: Super Admin cannot strip its own `manageRoles`/`manageSettings`, an
admin cannot suspend or demote their own account, and the last active Super
Admin cannot be changed — otherwise the system could become unadministrable.

## Email

Outbound replies go out via Resend with subject `[{ticketNumber}] {subject}` and
`Reply-To` pointing at the inbound address, so the conversation keeps flowing.

Inbound mail hits `POST /api/webhooks/resend/inbound`, which:

1. verifies the Svix signature over `{timestamp}.{rawBody}` with a ±5 min
   tolerance, failing closed when no secret is configured
2. dedupes on `messageId` (unique index)
3. threads onto an existing ticket via `X-Ticket-Id`, a ticket number parsed out
   of the subject, thread id, or `In-Reply-To`
4. otherwise auto-creates a ticket, matches or creates the requestor, and sends
   an auto-acknowledgement carrying the ticket number — which is what makes the
   next reply thread

Agent replies sent from Gmail are ingested too, attributed to the agent. All HTML
is sanitised (allowlist tags, stripped event handlers, `javascript:`/`data:`
URLs) and a plain-text fallback is always stored.

Configuration lives at **Configuration → Email / Resend**, including a connection
probe and a send-test button.

---

## Security notes

- Sessions are httpOnly, `SameSite=Strict` JWT cookies; the token body is only a
  fast path — the user document is re-read every request, so a suspended account
  or deleted role takes effect immediately.
- Passwords are bcrypt (12 rounds), min 10 chars with a letter and a number.
- Rate limits are Mongo-backed and read live from settings: 5 login attempts per
  15 min per IP+email, 10 tickets/hour per user (3/hour unauthenticated),
  100 req/min per IP globally, and a separate generous ceiling for the webhook.
  Account lockout triggers at 10 consecutive failures.
- Login is throttled per IP *and* email, so one attacker cannot lock every
  account out from a shared NAT.
- IDs are validated before hitting Mongoose, so a malformed id is a 400 rather
  than a 500.
- Attachments are served through an authenticated route with `nosniff` and a
  restrictive CSP rather than direct Cloudinary URLs.

## Layout

```
src/
  app/
    (app)/                 authenticated pages
    api/                   route handlers
    login/  page.tsx
  components/              app-shell, app-page, ui/primitives
  contexts/                SessionContext
  lib/
    models/                Mongoose schemas + ensureIndexes()
    server/                settings, rate-limit, tickets, sla, resend, gridfs
    shared/                permissions, constants, time, csv, format
    auth/                  password, jwt, session
    client/                typed fetch wrapper + view models
  proxy.ts                 session gate + global API rate limit
scripts/
  seed.ts  verify.ts  e2e.ts
  migrate-supabase-to-mongo.ts  defaults.ts  load-env.ts
```

## Known gaps

- The outbound **reply** path is implemented and type-checked but was not
  exercised end-to-end, because it needs a live Resend account. The inbound
  webhook is fully covered.
- Requestors that already have tickets cannot be hard-deleted; the API returns a
  409 pointing at deactivation instead, so ticket history stays intact.
- `typeOfConcern` seeds only `Incident` and `Request` because those are the only
  values the previous code ever used. All options are editable in Configuration.
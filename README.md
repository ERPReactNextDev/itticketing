# Help Desk — IT Ticketing

Internal IT help desk: tickets with SLA tracking, an employee requestor
directory, configurable field options, role-based access control, and two-way
email intake through Resend.

**Stack:** Next.js (App Router) · React 19 · TypeScript · Tailwind v4 · Supabase
(Postgres) · Resend

---

## Data layer

Postgres (Supabase) is the only datastore. MongoDB, Mongoose and GridFS have
been removed; the API routes talk to Postgres through the Supabase client using
the **service_role** key, which is server-side only.

> **Reused tables.** The app builds on the existing `public.users` and
> `public.tickets` tables and adds the columns it needs, rather than replacing
> them. `supabase/schema.sql` is idempotent — it only ever adds.

The `service_role` key bypasses Row Level Security, so RLS is enabled on every
app table with no policies: the anon/publishable key cannot read or write
directly, and the API layer is the only way in.

### Tables

| Table | Purpose |
|---|---|
| `users` | Login accounts (agents, supervisors, admins) — existing table + added columns |
| `requestors` | Employee / end-user directory — feeds the Requestor dropdown |
| `roles` | RBAC: a name plus a permissions object of booleans |
| `tickets` | Tickets — existing table + added columns (remark / status / assignment history as JSONB) |
| `ticket_counters` | One row per business day, holding the sequence |
| `dropdown_options` | Configurable options for every ticket field |
| `app_settings` | Singleton row: numbering, SLA, email, rate limits (distinct from any pre-existing `system_settings` table) |
| `email_messages` | Every inbound and outbound email |
| `system_audit_logs` | Immutable trail of privileged actions (distinct from any pre-existing `audit_logs` table) |
| `rate_limits` | Fixed-window rate-limit buckets |

Attachments are stored in the private **Supabase Storage** bucket
`ticket-attachments` and served through the authenticated `/api/files/[id]`
route.

### Helper functions

`supabase/schema.sql` also defines the atomic operations PostgREST cannot do in
one request:

| Function | Purpose |
|---|---|
| `next_ticket_seq(date_key)` | Atomically reserves the next ticket sequence |
| `consume_rate_limit(key, window_start)` | Atomically increments a rate-limit bucket |
| `append_ticket_remark(ticket_id, remark)` | Appends one remark to a ticket's timeline |
| `thread_ticket_email(ticket_id, message_id, thread_id)` | Records a message id and links the thread |
| `ticket_counts_by_technician()` | Open-ticket load per technician, for round-robin |

Run `npm run verify` to assert the tables, seed data, numbering and atomic
sequence are all in place.

---

## Setup

```bash
npm install
cp .env.example .env.local     # then fill it in
# paste supabase/schema.sql into Supabase → SQL Editor → Run
npm run seed                   # roles, dropdowns, settings, a SuperAdmin
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
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side key (bypasses RLS — never expose it) |
| `SUPABASE_STORAGE_BUCKET` | Attachment bucket (default `ticket-attachments`) |
| `JWT_SECRET` | Signs the session cookie (≥32 chars) |
| `SESSION_TIMEOUT_MIN` | Session lifetime and idle timeout |
| `REGISTER_SECRET` | Shared token (16+ chars) that gates the public `/register` page |
| `RESEND_API_KEY` | Resend API key |
| `EMAIL_FROM` | Verified sending address |
| `INBOUND_EMAIL` | Address Gmail forwards to |
| `RESEND_INBOUND_SECRET` | Webhook signature secret |
| `RATE_LIMIT_*` | Defaults; all live-editable in Settings |
| `MAX_ATTACHMENT_BYTES` | Upload ceiling (default 10 MB) |
| `TICKET_PREFIX`, `TICKET_NUMBER_PATTERN` | Numbering defaults |
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Seeded account |

`.env` supplies defaults only. Anything a SuperAdmin saves in **Configuration →
Settings** overrides it at runtime and takes effect immediately — no redeploy.

---

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Standard Next.js |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run seed` | Idempotent: roles, dropdowns, settings, SuperAdmin |
| `npm run verify` | Asserts tables, seeded data, numbering, the atomic sequence and sanitisation |
| `npm run e2e` | Full HTTP suite against a running server |
| `npm run list-accounts` | Shows every account, its role and lock state |
| `npm run reset-password` | Admin password recovery (see below) |

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

# every SuperAdmin account at once
npx tsx --conditions react-server scripts/reset-password.ts \
  --role "SuperAdmin"

# just clear a lockout, keep the existing password
npx tsx --conditions react-server scripts/reset-password.ts \
  --email you@company.com --unlock-only
```

Invoke via `npx tsx ...` rather than `npm run` — npm strips flags like
`--email` before the script receives them.

A reset always clears `LoginAttempts` and `lock_until`, reactivates the account,
and sets `must_change_password` so the owner picks a new one at next sign-in
(`--keep-password` opts out).

### Tests

`npm run verify` reads the real database. `npm run e2e` drives the real HTTP API
with a real session cookie, covering login rate-limiting and lockout, ticket
numbering, remarks history, RBAC scoping, CSV, dropdown deactivation, live
settings, and the whole inbound webhook path including signature verification,
threading, dedupe and auto-creation. It provisions its own throwaway SuperAdmin
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
resets at local midnight. The counter is reserved with an atomic
`insert ... on conflict do update ... returning` inside `next_ticket_seq()`,
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

Four seeded roles: SuperAdmin, Admin, Agent, Viewer. Eighteen permissions in
`src/lib/shared/permissions.ts` are the single source of truth and are editable
from **Configuration → Roles & Access**.

Hiding a menu item is cosmetic. Every API route re-checks permissions
server-side, and the ticket query applies RBAC scope in one place
(`buildTicketFilter`) so no route can forget it. Agents without `viewAllTickets`
only ever see tickets assigned to or processed by them.

Guardrails: SuperAdmin cannot strip its own `manageRoles`/`manageSettings`, an
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
  fast path — the user row is re-read every request, so a suspended account
  or deleted role takes effect immediately.
- Passwords are bcrypt (12 rounds), min 10 chars with a letter and a number.
- Rate limits live in Postgres and are read live from settings: 5 login attempts
  per 15 min per IP+email, 10 tickets/hour per user (3/hour unauthenticated),
  100 req/min per IP globally, and a separate generous ceiling for the webhook.
  Account lockout triggers at 10 consecutive failures.
- Login is throttled per IP *and* email, so one attacker cannot lock every
  account out from a shared NAT.
- IDs are validated before hitting Postgres, so a malformed id is a 400 rather
  than a 500.
- Attachments are served through an authenticated route with `nosniff` and a
  restrictive CSP rather than direct public URLs.

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
    db/                    Supabase client + row <-> document mappers
    server/                settings, rate-limit, tickets, sla, resend, storage
    shared/                permissions, constants, time, csv, format
    auth/                  password, jwt, session
    client/                typed fetch wrapper + view models
  proxy.ts                 session gate + global API rate limit
supabase/
  schema.sql               tables, helper functions, bucket, RLS
scripts/
  seed.ts  verify.ts  e2e.ts  defaults.ts  load-env.ts
```

## Known gaps

- The outbound **reply** path is implemented and type-checked but was not
  exercised end-to-end, because it needs a live Resend account. The inbound
  webhook is fully covered.
- Requestors that already have tickets cannot be hard-deleted; the API returns a
  409 pointing at deactivation instead, so ticket history stays intact.
- `typeOfConcern` seeds only `Incident` and `Request` because those are the only
  values the previous code ever used. All options are editable in Configuration.

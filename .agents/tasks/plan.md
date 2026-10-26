# IT Ticketing — Full UI Polish & Bug Fix Plan

> Task origin: "pakipolish ng buong ui at pakiayos ng mga bugs and errors make sure na lahat gumagana"
> Generated after reading every source file under `src/`.
> Build command: `npm run build` · Type-check: `npm run typecheck` · Lint: `npm run lint`

---

## Priority 1 — Build-blocking / Runtime-breaking Errors

These will either fail `next build`, throw at runtime, or produce wrong data.

---

- [ ] **1.1 — Fix duplicate import alias in `recent/page.tsx`**

  `TerminalBadge` is imported twice under different local names (`TerminalBadge` and `Badge`).
  The second `TerminalBadge as Badge` is unused, and ESLint/TypeScript will flag the
  duplicate named-import of the same binding.

  **File:** `src/app/(app)/tickets/recent/page.tsx`

  **Change:** Remove the line:
  ```ts
  TerminalBadge as Badge,
  ```
  from the `app-shell` import. The component already uses `TerminalBadge` for all badge
  references; replace the one call that says `<Badge …>` with `<TerminalBadge …>`.

  **Verify:** `npm run typecheck` — zero errors in this file.

---

- [ ] **1.2 — Add `aria-label` to all icon-only `<button>` elements that currently lack one**

  Several icon-only buttons are missing accessible labels and will fail ESLint's
  `jsx-a11y/control-has-associated-label` rule when strict a11y linting is on.
  More critically, they are unreachable to screen-reader users.

  **Files and locations:**

  | File | Element | Fix |
  |---|---|---|
  | `src/components/app-shell.tsx` | `<button … onClick={handleLogout}>` (LogOut icon, no text) | Add `aria-label="Sign out"` — the `title` prop already says "Sign out", promote it to aria-label |
  | `src/app/(app)/tickets/[id]/page.tsx` | Attachment row anchor uses `href` but no descriptive text — only `{fileId}` which is a MongoDB ObjectId | Wrap the FileId in a `<span className="sr-only">Download </span>` prefix or use a better label |
  | `src/app/(app)/configuration/dropdowns/page.tsx` | Move-up / move-down `▲▼` triangle buttons have only a `title` prop | Add `aria-label` matching the `title` value |

  **Verify:** `npm run lint` — no `aria-*` related errors.

---

- [ ] **1.3 — Fix missing `key` prop warning in `audit-logs/page.tsx` (React fragment in table rows)**

  `audit-logs/page.tsx` renders a `<>` fragment inside a `<tbody>`, iterating over
  `logs.map((log) => (<> <tr key={log.id}> … </tr> {expanded…} </>))`.
  The key is on the inner `<tr>`, not the outer `<React.Fragment>`. React will warn
  about "Each child in a list should have a unique key" because the map returns
  fragments without keys.

  **File:** `src/app/(app)/audit-logs/page.tsx`

  **Change:** Replace the bare `<>` fragments inside the map with
  `<React.Fragment key={log.id}>` so the key is on the outermost element returned
  from the map callback.

  ```tsx
  {logs.map((log) => (
    <React.Fragment key={log.id}>
      <tr className="…">…</tr>
      {expanded.has(log.id) && … ? (
        <tr key={`${log.id}-meta`} …>…</tr>
      ) : null}
    </React.Fragment>
  ))}
  ```

  **Verify:** `npm run build` — no React key warnings in output; `npm run typecheck` clean.

---

- [ ] **1.4 — Guard `formatDateTime` minute padding in `format.ts`**

  `formatDateTime` outputs minutes as `p.minute` raw (a number), so `08:07 AM`
  renders as `08:7 AM` (no leading zero). The `parts()` helper pads month and day
  but **not** minutes.

  **File:** `src/lib/shared/format.ts`

  **Change:** In `formatDateTime` and `formatTime`, replace:
  ```ts
  `${h12}:${p.minute} ${ampm}`
  ```
  with:
  ```ts
  `${h12}:${String(p.minute).padStart(2, "0")} ${ampm}`
  ```

  **Verify:** `npm run typecheck` clean. Manual smoke: create or view a ticket, confirm
  timestamps like `08 Jan 2025, 9:05 AM` show correctly (not `9:5 AM`).

---

- [ ] **1.5 — API: `/api/tickets/bulk` GET returns technician list even for non-assign roles**

  `bulk/route.ts` GET handler returns `{ technicians: [] }` when the user lacks
  `assignTechnician`. The ticket detail page (`[id]/page.tsx`) also calls this endpoint.
  If a user opens a ticket without `assignTechnician` they still trigger the API call
  (guarded by `if (!user?.permissions.assignTechnician) return`), so the empty array
  is correct. No code fix needed, but the client guard must not be removed.
  ✅ Already correct — document only.

---

- [ ] **1.6 — Fix `runBulk` page-refresh pattern in `tickets/page.tsx`**

  After a bulk action, `tickets/page.tsx` calls `router.refresh()` AND
  `setPage((current) => current)` hoping to re-trigger the `useEffect` that
  fetches tickets. `setPage(current => current)` is a no-op because React bails out
  of a state update that returns the same value, so the list does **not** reload
  after a bulk operation unless the page number actually changes.

  **File:** `src/app/(app)/tickets/page.tsx`

  **Change:** Add a dedicated `refreshNonce` state counter:
  ```ts
  const [refreshNonce, setRefreshNonce] = React.useState(0);
  ```
  Add it to the `useEffect` dependency array for the tickets fetch. After a bulk
  action replace `setPage((current) => current)` with `setRefreshNonce((n) => n + 1)`.
  This guarantees a re-fetch regardless of the current page.

  **Verify:** Select 2+ tickets → bulk-assign → confirm list refreshes showing the new
  assignment without a manual reload.

---

## Priority 2 — Runtime Bugs & Logic Errors

---

- [ ] **2.1 — `tickets/page.tsx` filter-reset does not reset `debouncedSearch`**

  `clearFilters()` resets `search` to `""` but `debouncedSearch` is only updated
  by the 300ms debounce effect. Until the debounce fires, the fetch still passes
  the old search term. Minor but visible: clicking "Clear" keeps showing old results
  for 300ms and then snapping.

  **File:** `src/app/(app)/tickets/page.tsx`

  **Change:** In `clearFilters()`, also call `setDebouncedSearch("")` immediately after
  `setSearch("")`.

  **Verify:** Type a search → click Clear → list immediately returns to unfiltered results.

---

- [ ] **2.2 — `tickets/[id]/page.tsx` Reopen button uses inline `options.status` lookup before options may be loaded**

  The "Reopen Ticket" `PrimaryButton` calls:
  ```ts
  options.status?.find((o) => !["resolved","closed","cancelled"].includes(o.value))?.value ?? "pending"
  ```
  At the moment the ticket loads, `options` is `{}` (the dropdown fetch runs
  concurrently). If the user clicks Reopen before options arrive, the status
  resolves to `"pending"` — which is correct as a fallback, but silently bypasses
  any configured initial status. More dangerously, if no option is found it always
  patches to `"pending"` even if `"pending"` has been deactivated or renamed.

  **File:** `src/app/(app)/tickets/[id]/page.tsx`

  **Change:** Wait for options to load before enabling the Reopen button. Add a
  `optionsLoaded` boolean state that flips to `true` when the dropdowns fetch
  completes. Disable the Reopen button (`disabled={!optionsLoaded}`) and add a
  brief `title="Loading…"` while loading.

  **Verify:** Open a closed ticket, confirm Reopen button is briefly disabled then
  enables, and clicking it sends the correct status value.

---

- [ ] **2.3 — `recent/page.tsx` sorts by `newest` (createdAt) but the description says "last touched"**

  The API call uses `sort=newest` (by `dateCreated`) but the UI copy says "Most
  recently updated tickets". The correct sort is `sort=activity` or `sort=sla`
  (by `lastActivityAt`). The API `ticket-query.ts` has a `newest` sort but not an
  `activity` sort by default.

  **Files:** `src/app/(app)/tickets/recent/page.tsx`

  **Change:** Change the API call to `/api/tickets?pageSize=15&sort=newest` → keep
  `sort=newest` but update the `PageHeading` description to say "Most recently
  created tickets" to match what is actually shown, OR add `sort=activity` to the
  `TicketListQuery` sort enum in `src/lib/server/ticket-query.ts` and switch the
  call accordingly. The simpler fix is to update the description. If adding a new
  sort order is desired, that is a separate enhancement.

  **Recommended:** Update description in `recent/page.tsx`:
  ```tsx
  description="Most recently created tickets. Open one to edit its fields and add remarks."
  ```

  **Verify:** `npm run typecheck` clean.

---

- [ ] **2.4 — `profile/page.tsx` session refresh after password change may not update `mustChangePassword`**

  After a successful `change-password`, the code does:
  ```ts
  const refreshed = await refresh();
  if (refreshed) setUser({ ...refreshed, mustChangePassword: false });
  ```
  The `refresh()` call re-fetches `/api/auth/me`, which reads the live DB. If the
  API correctly clears `mustChangePassword` on the DB record, `refreshed` already
  has `mustChangePassword: false` and the extra spread is harmless. However, if
  `/api/auth/me` returns the stale JWT claims without re-reading `mustChangePassword`
  from the DB, the spread provides the safety net. Check `src/app/api/auth/me/route.ts`.

  **File:** `src/app/api/auth/me/route.ts`

  **Change:** Confirm that `/api/auth/me` reads `mustChangePassword` from the live User
  document (not just the JWT claims). It should use `getSessionUser()` which calls
  `User.findById` — confirm that `mustChangePassword` is included in the returned
  `AuthUser` shape and is serialised in the response. If it is missing, add it.

  **Verify:** Log in as a seeded account with `mustChangePassword: true` → change
  password → confirm the "Password change required" banner disappears immediately.

---

- [ ] **2.5 — `app-shell.tsx` sidebar active-state detection for `/configuration/*` is too broad**

  `isActive` treats any pathname starting with `/configuration` as active for the
  "Configuration" nav item (`/configuration/dropdowns`). This is correct for the
  dropdown/email/settings pages, but `/configuration/roles` gets its own nav item
  ("Roles & Access"). Both nav items will show as active simultaneously when on a
  `/configuration/roles` page because `pathname.startsWith("/configuration")` matches
  both items.

  **File:** `src/components/app-shell.tsx`

  **Change:**
  ```ts
  if (href === "/configuration/dropdowns") {
    // Active for all /configuration/* EXCEPT /configuration/roles
    return pathname.startsWith("/configuration") && !pathname.startsWith("/configuration/roles");
  }
  ```

  **Verify:** Navigate to `/configuration/roles` → only "Roles & Access" is highlighted.
  Navigate to `/configuration/settings` → only "Configuration" is highlighted.

---

- [ ] **2.6 — `tickets/[id]/page.tsx` email reply `replyTo` is never updated when ticket loads**

  `replyTo` is initialised to `""` and set only once in the `load` callback:
  ```ts
  setReplyTo(response.ticket.requestorEmail ?? "");
  ```
  If the ticket loads and `requestorEmail` is empty (e.g., a manually-created ticket
  with no requestor email), `replyTo` stays `""` and the reply form shows an empty
  "To" field with no indication that it is missing. The user can still type a
  recipient, but there is no warning.

  **File:** `src/app/(app)/tickets/[id]/page.tsx`

  **Change:** When `showReply` becomes true and `replyTo` is empty, show a helper text:
  ```tsx
  {showReply && !replyTo ? (
    <p className="text-[10px] text-amber-600">
      No email on file for this requestor. Enter a recipient address.
    </p>
  ) : null}
  ```
  Place this directly above the `<Panel title="Reply via Email">`.

  **Verify:** Open a ticket with no requestor email → click "Reply via Email" → warning
  appears. Ticket with an email → no warning.

---

- [ ] **2.7 — `configuration/settings/page.tsx` live-preview effect has a suppressed exhaustive-deps warning**

  The comment `// eslint-disable-next-line react-hooks/exhaustive-deps` suppresses
  a legitimate warning. The `buildParts` function is defined inside the component
  but referenced inside the effect without being in the deps array. This means the
  preview re-renders on the wrong triggers.

  **File:** `src/app/(app)/configuration/settings/page.tsx`

  **Change:** Extract `buildParts` outside the component (it only uses `Date.now()`
  and the `preview` arg, both passed as params) and remove the eslint-disable
  comment. The effect deps array should be:
  ```ts
  [form?.ticketNumberPattern, form?.ticketPrefix, form?.seqPadLength, preview]
  ```
  Since `buildParts` no longer closes over component state, it is no longer a dep.

  **Verify:** `npm run lint` — no suppressed exhaustive-deps warnings. Changing the
  ticket prefix live-updates the preview correctly.

---

- [ ] **2.8 — `app/(app)/layout.tsx` does not redirect to `/profile` when `mustChangePassword` is set**

  The authenticated shell checks auth state and redirects to `/login` if no user,
  but it does not enforce the "must change password" redirect. That logic lives in
  `login/page.tsx` (redirects to `/profile?force=1` at login time) and `profile/page.tsx`
  (shows the forced-change banner), but if the user navigates away from the profile
  page before changing their password, they can reach the rest of the app.

  **File:** `src/app/(app)/layout.tsx`

  **Change:** In `AuthenticatedShell`, after confirming `user` is not null, add:
  ```ts
  if (user.mustChangePassword && !pathname?.startsWith("/profile")) {
    router.replace("/profile?force=1");
    return;
  }
  ```
  (Import `usePathname` from `next/navigation`.)

  **Verify:** Log in as an account with `mustChangePassword: true` → attempt to navigate
  to `/dashboard` → confirm you are redirected to `/profile?force=1`.

---

## Priority 3 — UI Polish

All changes in this section use existing primitives (`TerminalBadge`, `Panel`,
`PrimaryButton`, `GhostButton`, `AlertBanner`, etc.) from `src/components/app-shell.tsx`
and `src/components/ui/primitives.tsx`. No new shadcn components should be introduced.

---

- [ ] **3.1 — Mobile: sidebar is hidden at `< lg` with no hamburger menu**

  The sidebar uses `hidden … lg:flex` and there is no mobile-nav alternative. On
  phones and tablets the entire navigation disappears. The `useIsMobile` hook exists
  (`src/hooks/use-mobile.ts`) but is unused.

  **Files:** `src/components/app-shell.tsx`, `src/app/(app)/layout.tsx`

  **Changes:**
  1. Add a `<button>` in the top bar (left of the search box, shown only below `lg`)
     that toggles a `sidebarOpen` state. Use `Menu` icon from `lucide-react`.
  2. Add a slide-in overlay drawer: when `sidebarOpen` is true, render the same sidebar
     markup inside a fixed-positioned overlay with `z-30 bg-background` and a semi-transparent
     backdrop. Clicking the backdrop or pressing `Escape` closes it.
  3. The existing `<aside className="hidden … lg:flex">` stays unchanged.

  **Pattern:** Follow the same guard pattern as the existing sidebar — reuse the
  `sections` array, `canSee`, and `isActive` logic verbatim.

  **Verify:** At viewport width < 1024px, confirm a hamburger icon appears in the top bar,
  tapping it opens the nav, tapping a link closes the drawer and navigates correctly.

---

- [ ] **3.2 — Login page: no dark-mode support**

  `login/page.tsx` hard-codes `bg-muted/40` for the page background and uses
  `bg-red-50` / `text-red-700` for the error state. These render correctly in
  light mode but can have contrast issues in dark mode because `bg-red-50` is
  always light regardless of the theme.

  **File:** `src/app/login/page.tsx`

  **Changes:**
  - Error box already has dark variants: `dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300`
    — ✅ already correct.
  - The page background `bg-muted/40` and the card `bg-card` both use CSS variables
    and are theme-aware — ✅ already correct.
  - The "Help Desk" icon div uses inline `backgroundColor: \`\${ACCENT}1f\`` which is
    fine. ✅

  No code changes needed for login dark mode — the existing classes are already correct.

---

- [ ] **3.3 — Dashboard: loading state shows `"—"` for stat cards but no skeleton**

  When `loading` is `true`, each `StatCard` renders `"—"` as the value. This is
  functional but gives no visual sense of loading. Replace with a lightweight pulse
  skeleton inside `StatCard` that only renders during load.

  **File:** `src/app/(app)/dashboard/page.tsx` and `src/components/app-shell.tsx`

  **Changes:**
  1. In `StatCard` (in `app-shell.tsx`), add an optional `loading` prop:
     ```ts
     loading?: boolean;
     ```
  2. When `loading` is true, render:
     ```tsx
     <div className="h-9 w-20 animate-pulse rounded bg-muted" />
     ```
     instead of the value.
  3. In `dashboard/page.tsx`, pass `loading={loading}` to all 8 `StatCard` instances.

  **Verify:** Refresh the dashboard — all stat cards show a pulsing placeholder until
  data arrives.

---

- [ ] **3.4 — Tickets list: no indication which columns are sortable**

  The tickets table has no sort controls. Users expect clickable column headers.
  The API already supports `sort` param (from `ticket-query.ts`). Add sort-by-column
  for the most commonly used columns.

  **File:** `src/app/(app)/tickets/page.tsx`

  **Changes:**
  1. Add `sort` state: `const [sort, setSort] = React.useState<"newest" | "sla" | "updated">("newest")`.
  2. Pass `sort` to the API request params.
  3. Make `<Th>` accept an `onClick` and render a `ChevronUp`/`ChevronDown` icon
     (from `lucide-react`) when active. Add `cursor-pointer` and `hover:text-foreground`
     classes to sortable `<Th>` elements.
  4. Sortable columns: "Created" (newest/oldest), "SLA" (sla band), "Ticket #" (newest).

  **Verify:** Click "Created" column header → sort order toggles, list re-fetches.

---

- [ ] **3.5 — Ticket detail: `scheduledDate` input does not use the shared `TextInput` primitive**

  The scheduled-date input in `tickets/[id]/page.tsx` uses a bare `<input>` with
  manually duplicated Tailwind classes instead of the project's `TextInput` primitive.

  **File:** `src/app/(app)/tickets/[id]/page.tsx`

  **Change:** Replace the bare `<input type="date" …>` inside the "Scheduled Date"
  `LabeledField` with:
  ```tsx
  import { TextInput } from "@/components/ui/primitives";
  // …
  <TextInput
    type="date"
    defaultValue={ticket.scheduledDate ? ticket.scheduledDate.slice(0, 10) : ""}
    disabled={!canEditAny}
    onBlur={/* same handler */}
  />
  ```
  This ensures consistent focus ring, border, and disabled styling.

  **Verify:** Compare visually — the date input matches the other inputs on the form.

---

- [ ] **3.6 — Directory pages: search debounce is inside `useCallback` making it fire too early**

  Both `requestors/page.tsx` and `staff/page.tsx` wrap the fetch in a `useCallback`
  with `search` in the deps, then call it inside a `useEffect` with a 250ms timeout.
  This is fine, but the `page` state is also a dep of the callback, meaning a page
  change triggers a debounced fetch — so navigating to page 2 waits 250ms before
  loading. For pagination, the fetch should fire immediately; only search-text changes
  should be debounced.

  **Files:** `src/app/(app)/directory/requestors/page.tsx`,
  `src/app/(app)/directory/staff/page.tsx`

  **Change:** Split into two effects:
  ```ts
  // Debounced search / filter changes
  const [debouncedSearch, setDebouncedSearch] = React.useState(search);
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Immediate fetch on page or filter change
  React.useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, statusFilter, page]);
  ```
  The `load` function should take params rather than close over `search` directly.

  **Verify:** Changing page navigates immediately; typing in the search box still
  debounces by 250ms.

---

- [ ] **3.7 — `app-shell.tsx`: `AlertBanner` always shows an `AlertTriangle` icon, even for `success` and `info` tones**

  The `AlertBanner` component uses `AlertTriangle` for all four tones (warning,
  danger, info, success). A success banner should show `CheckCircle2`; an info
  banner should show `Info`. This causes visual confusion: a "Done" success message
  shows a warning-triangle icon.

  **File:** `src/components/app-shell.tsx`

  **Changes:**
  1. Import `CheckCircle2` and `Info` from `lucide-react` (both are already
     available in the project via the `lucide-react` dependency).
  2. Add an icon map in `AlertBanner`:
     ```ts
     const TONE_ICONS = {
       warning: AlertTriangle,
       danger: AlertTriangle,
       info: Info,
       success: CheckCircle2,
     };
     const ToneIcon = TONE_ICONS[tone];
     ```
  3. Replace `<AlertTriangle …>` with `<ToneIcon …>`.

  **Verify:** Create a ticket → the "Done" success banner shows a green checkmark icon.
  Trigger a rate-limit → the warning banner shows a triangle. Visual check all four
  toast-like banners.

---

- [ ] **3.8 — `configuration/dropdowns/page.tsx`: new colour picker only shows `<input type="color">` for priority and status tabs, but the new-option row (bottom of list) doesn't show a text input alongside it**

  In the existing-item edit row, the colour section shows both a colour picker AND a
  text input:
  ```tsx
  <input type="color" … />
  <TextInput value={draft?.color …} … className="flex-1" />
  ```
  But in the "new option" row (`creating && !draft?.id`), only the colour picker is
  shown without a text input. This means the hex value cannot be typed directly.

  **File:** `src/app/(app)/configuration/dropdowns/page.tsx`

  **Change:** In the "new option" row's colour field section, add the paired `TextInput`:
  ```tsx
  {hasColour ? (
    <LabeledField label="Colour">
      <div className="flex items-center gap-2">
        <input type="color" value={draft?.color ?? "#f97316"} onChange={…} className="h-9 w-12 rounded border border-border" />
        <TextInput
          value={draft?.color ?? "#f97316"}
          onChange={(event) => setDraft((current) => ({ ...current, color: event.target.value }))}
          className="flex-1"
        />
      </div>
    </LabeledField>
  ) : null}
  ```

  **Verify:** On the Priority tab, click "Add Option" → confirm both the colour swatch
  and hex text input appear together.

---

- [ ] **3.9 — Focus management: modal/panel forms do not trap focus or return focus on close**

  `RequestorPicker` (new ticket page) expands an inline quick-add form but focus does
  not move to it when it opens, and does not return to the "Add them" button when it
  closes. Similarly, the `StaffForm` and `RequestorForm` in directory pages open inline
  but don't auto-focus the first field.

  **Files:**
  - `src/app/(app)/tickets/new/page.tsx` (`RequestorPicker`)
  - `src/app/(app)/directory/requestors/page.tsx` (`RequestorForm`)
  - `src/app/(app)/directory/staff/page.tsx` (`StaffForm`, `ResetPasswordForm`)

  **Change:** The `TextInput` components already support `autoFocus` (passed through
  `...rest`). In each form's first `TextInput`, add `autoFocus`. This is the
  minimum accessible improvement without a full focus-trap library.

  Specifically:
  - `RequestorPicker` quick-add form → first name TextInput already has no `autoFocus`; add it.
  - `RequestorForm` → `employeeId` TextInput, add `autoFocus` when `!requestor` (creation mode).
  - `StaffForm` → `name` TextInput, add `autoFocus`.

  **Verify:** Open a form → cursor is in the first field. Tab sequence flows logically.

---

- [ ] **3.10 — `app-shell.tsx` `EmptyState` uses `Inbox` icon for every empty state, even ones unrelated to tickets**

  `EmptyState` imports and always renders `<Inbox>`. This is appropriate for the
  ticket list, but odd on the "No audit entries", "No requestors", etc. screens.

  **File:** `src/components/app-shell.tsx`

  **Change:** Add an optional `icon` prop to `EmptyState`:
  ```ts
  icon?: LucideIcon;
  ```
  Default to `Inbox` when not provided. Pass `ScrollText` for audit logs, `Users`
  for requestors/staff empty states.

  Update call sites:
  - `audit-logs/page.tsx`: `<EmptyState … icon={ScrollText} />`
  - `directory/requestors/page.tsx`: `<EmptyState … icon={Users} />`
  - `directory/staff/page.tsx`: `<EmptyState … icon={UserCog} />`

  **Verify:** Navigate to each page with no data → correct contextual icon shown.

---

- [ ] **3.11 — `tickets/page.tsx` bulk-action selects are uncontrolled (`defaultValue=""`) but should reset after each action**

  The bulk "Assign to" and "Set status" `<Select>` elements use `defaultValue=""`.
  Once an agent assigns, the select visually stays on the chosen value even after
  the action completes. Using `defaultValue` means React cannot reset it programmatically.

  **File:** `src/app/(app)/tickets/page.tsx`

  **Change:** Convert both selects from `defaultValue` to controlled `value` with their
  own state variables:
  ```ts
  const [bulkTechnicianId, setBulkTechnicianId] = React.useState("");
  const [bulkStatus, setBulkStatus] = React.useState("");
  ```
  Reset both to `""` at the top of `runBulk`. This ensures the dropdowns snap back
  to "Choose agent…" / "Choose status…" after each bulk action.

  **Verify:** Select 3 tickets → assign → dropdown resets to "Choose agent…" after the
  action completes.

---

- [ ] **3.12 — `app/layout.tsx` body uses `font-mono` as default font but should use `font-sans`**

  `src/app/layout.tsx` sets `className="… font-mono antialiased …"` on `<body>`.
  This makes all body text monospaced by default, which is intentional for this app's
  terminal aesthetic. However, the `globals.css` defines both `--font-sans` and
  `--font-mono`. The login form, dashboard descriptions, and most prose should render
  in the sans font; only code/badge labels should be mono.

  Currently the entire app is mono. This is a design decision, not a bug. If the
  intent is a consistent mono aesthetic:
  - ✅ Keep `font-mono` on body.
  - Ensure Geist Mono is loaded with `display: "swap"` (already done in `layout.tsx`).

  If the intent is to use sans for prose and mono for labels:
  - Change body to `font-sans` and add explicit `font-mono` to the badge/label classes.

  **Decision:** Keep `font-mono` on body (matches the existing design language). No
  change needed — document only.

---

- [ ] **3.13 — Add `<title>` per-page for browser tab clarity**

  Every page shows the same tab title "Help Desk — IT Ticketing" from the root layout
  metadata. In a multi-tab workflow, users cannot tell which tab is which.

  **Files:** One metadata export per page (Next.js App Router pattern).

  **Changes:** Add `export const metadata: Metadata` to each page's server component.
  Because all pages are `"use client"`, Next.js requires a separate `generateMetadata`
  or a wrapper server component. The simpler approach: use `useEffect` to set
  `document.title` client-side.

  Add to each key page:
  ```ts
  React.useEffect(() => {
    document.title = "Dashboard — Help Desk";
  }, []);
  ```

  Pages to update and their titles:

  | Page file | Title |
  |---|---|
  | `dashboard/page.tsx` | `Dashboard — Help Desk` |
  | `tickets/page.tsx` | `Tickets — Help Desk` |
  | `tickets/new/page.tsx` | `New Ticket — Help Desk` |
  | `tickets/[id]/page.tsx` | `{ticketNumber} — Help Desk` (set in a `useEffect` after `ticket` loads) |
  | `audit-logs/page.tsx` | `Audit Logs — Help Desk` |
  | `configuration/dropdowns/page.tsx` | `Configuration — Help Desk` |
  | `configuration/roles/page.tsx` | `Roles & Access — Help Desk` |
  | `configuration/email/page.tsx` | `Email Settings — Help Desk` |
  | `configuration/settings/page.tsx` | `Settings — Help Desk` |
  | `directory/requestors/page.tsx` | `Requestors — Help Desk` |
  | `directory/staff/page.tsx` | `Staff & Agents — Help Desk` |
  | `profile/page.tsx` | `My Profile — Help Desk` |

  **Verify:** Navigate to each page → browser tab shows the correct title.

---

- [ ] **3.14 — Pagination buttons should show page numbers for better navigation**

  All paginated lists (tickets, requestors, staff, audit logs) show only "Previous" /
  "Next" buttons with a "Page X of Y" label. When `totalPages` is large (e.g., 20+
  pages of audit logs), jumping to a specific page requires clicking many times.

  **Files:** All paginated pages (tickets, requestors, staff, audit-logs).

  **Change:** Add a page-number jump input beside the "Page X of Y" label:
  ```tsx
  <div className="flex items-center gap-2">
    <span className="text-[10px] text-muted-foreground">Page</span>
    <TextInput
      type="number"
      min={1}
      max={totalPages}
      value={page}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (n >= 1 && n <= totalPages) setPage(n);
      }}
      className="h-8 w-14 text-center"
    />
    <span className="text-[10px] text-muted-foreground">of {totalPages}</span>
  </div>
  ```

  **Verify:** On a list with >2 pages, type `3` in the input → list jumps to page 3.

---

- [ ] **3.15 — `tickets/[id]/page.tsx` attachment list shows raw MongoDB ObjectIds, not filenames**

  The attachments panel renders `{fileId}` directly, which is a 24-char hex
  ObjectId string. Users cannot tell which file is which.

  **File:** `src/app/(app)/tickets/[id]/page.tsx`

  **Context:** The `Ticket` type has `attachments: string[]` which are GridFS file IDs.
  The `GET /api/files/[id]` route serves the file. The filename is stored in GridFS
  metadata but is not in the `Ticket` DTO.

  **Options:**
  1. (Minimal) Prefix label with "Attachment" + index: `Attachment 1`, `Attachment 2`.
  2. (Better) Extend the ticket DTO to include attachment metadata
     `{ fileId: string; filename: string; contentType: string }[]` instead of `string[]`.
     Update `ticket-query.ts` to populate filenames from GridFS when serializing.

  **Recommended minimal fix** (no schema change needed):
  ```tsx
  <span className="truncate">{`Attachment ${index + 1}`}</span>
  ```
  Add `index` to the `.map()` call.

  **Verify:** Open a ticket with attachments → each attachment shows "Attachment 1",
  "Attachment 2" etc. instead of raw IDs.

---

- [ ] **3.16 — Consistent empty-state on `tickets/recent/page.tsx` when there are no tickets**

  The "Last Touched" panel only renders when `newest` is truthy. When there are zero
  tickets, both panels show `EmptyState` / no-data states but there is no explanation
  that the "Last Touched" panel is absent because there are no tickets yet.

  **File:** `src/app/(app)/tickets/recent/page.tsx`

  **Change:** When `!loading && !newest`, render the "Last Touched" panel with
  `<EmptyState title="No tickets yet" description="Create your first ticket to see it here." />`
  so the panel always appears (consistent layout).

  **Verify:** On a fresh system with no tickets, both panels render with empty states.

---

- [ ] **3.17 — `configuration/dropdowns/page.tsx`: the `RotateCcw` "Reload" button at the bottom of the page is isolated and easy to miss**

  The reload ghost button sits below the info banner, separated from the options
  list. It also conflicts visually with the "Add Option" button context.

  **File:** `src/app/(app)/configuration/dropdowns/page.tsx`

  **Change:** Move the "Reload options" button into the `Panel` `actions` prop
  alongside the "Add Option" button:
  ```tsx
  actions={
    <div className="flex items-center gap-2">
      <GhostButton icon={RotateCcw} onClick={() => void load()}>Reload</GhostButton>
      {canManage ? <PrimaryButton …>Add Option</PrimaryButton> : null}
    </div>
  }
  ```
  Remove the standalone `<GhostButton>` at the bottom of the page.

  **Verify:** Options panel has "Reload" + "Add Option" in the panel header. Bottom
  of page no longer has a floating reload button.

---

- [ ] **3.18 — `tickets/[id]/page.tsx` "Add Remark" textarea has no character count or maximum length enforced**

  Notes can be arbitrarily long. The API does not validate remark length.
  A very long note will render without truncation in the timeline and can degrade
  performance.

  **File:** `src/app/(app)/tickets/[id]/page.tsx`

  **Changes:**
  1. Add `maxLength={2000}` to the note `<TextArea>`.
  2. Show a live character counter below the textarea:
     ```tsx
     <p className="mt-1 text-right text-[9px] text-muted-foreground">
       {note.length}/2000
     </p>
     ```

  **Verify:** Typing in the note textarea shows a live character count. Paste a
  2001-char string — the textarea stops at 2000.

---

- [ ] **3.19 — `profile/page.tsx` `KeyValueRow` for "Session Expires" is confusing**

  The current rendering:
  ```tsx
  value={`${user ? "Activity" : "—"} after ${user ? "the configured timeout" : ""}`}
  ```
  Produces the string `"Activity after the configured timeout"` which is not useful.
  The session timeout in minutes is available in the settings (or can be derived).

  **File:** `src/app/(app)/profile/page.tsx`

  **Change:** Fetch the public settings endpoint on mount (`/api/settings`) and display
  the actual session timeout:
  ```tsx
  const [sessionTimeout, setSessionTimeout] = React.useState<number | null>(null);
  React.useEffect(() => {
    api.get<{ settings: { sessionTimeoutMin: number } }>("/api/settings")
      .then((r) => setSessionTimeout(r.settings.sessionTimeoutMin))
      .catch(() => {});
  }, []);
  // ...
  <KeyValueRow
    label="Session Expires"
    value={sessionTimeout ? `After ${sessionTimeout} minutes of inactivity` : "—"}
  />
  ```

  **Verify:** Profile page shows e.g. "After 60 minutes of inactivity".

---

- [ ] **3.20 — `app-shell.tsx` top-bar notification bell is a `<Link>` when tickets > 0 but a `<span>` when 0**

  When `openTicketCount` is 0, the bell renders as an inert `<span>`. This causes a
  layout shift (the `<Link>` and `<span>` have the same classes but different elements),
  and screen readers encounter a non-interactive span where they might expect a button.

  **File:** `src/components/app-shell.tsx`

  **Change:** Always render the bell as an `<Link>` but with `href="/tickets"` and no
  badge when count is 0:
  ```tsx
  <Link
    href="/tickets"
    className="relative rounded-md border border-border p-2 text-muted-foreground transition-colors hover:bg-muted"
    title={openTicketCount ? `${openTicketCount} open ticket(s)` : "Tickets"}
    aria-label={openTicketCount ? `${openTicketCount} open tickets` : "View tickets"}
  >
    <Bell className="h-4 w-4" />
    {typeof openTicketCount === "number" && openTicketCount > 0 ? (
      <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-background" style={{ backgroundColor: "#ef4444" }} />
    ) : null}
  </Link>
  ```
  Remove the `<span>` fallback.

  **Verify:** With 0 open tickets, the bell is still a clickable link to `/tickets`.
  With open tickets, the red dot appears.

---

## Summary of Files Changed

| File | Sections |
|---|---|
| `src/app/(app)/audit-logs/page.tsx` | 1.3, 3.10 |
| `src/app/(app)/configuration/dropdowns/page.tsx` | 3.8, 3.17 |
| `src/app/(app)/configuration/roles/page.tsx` | — (no changes needed) |
| `src/app/(app)/configuration/email/page.tsx` | — (no changes needed) |
| `src/app/(app)/configuration/settings/page.tsx` | 2.7 |
| `src/app/(app)/dashboard/page.tsx` | 3.3, 3.13 |
| `src/app/(app)/directory/requestors/page.tsx` | 3.6, 3.9, 3.10 |
| `src/app/(app)/directory/staff/page.tsx` | 3.6, 3.9, 3.10 |
| `src/app/(app)/layout.tsx` | 2.8 |
| `src/app/(app)/profile/page.tsx` | 3.13, 3.19 |
| `src/app/(app)/tickets/[id]/page.tsx` | 2.2, 2.6, 3.5, 3.13, 3.15, 3.18 |
| `src/app/(app)/tickets/new/page.tsx` | 3.9, 3.13 |
| `src/app/(app)/tickets/page.tsx` | 1.6, 2.1, 3.4, 3.11, 3.13, 3.14 |
| `src/app/(app)/tickets/recent/page.tsx` | 1.1, 2.3, 3.13, 3.16 |
| `src/app/api/auth/me/route.ts` | 2.4 (verify only) |
| `src/components/app-page.tsx` | — (no changes needed) |
| `src/components/app-shell.tsx` | 1.2, 2.5, 3.3, 3.7, 3.10, 3.20 |
| `src/components/ui/primitives.tsx` | 1.2 (aria-labels) |
| `src/lib/shared/format.ts` | 1.4 |

---

## Items Confirmed Correct (No Change)

- Auth flow: JWT + httpOnly cookie, session re-validation on every request — solid.
- Rate limiting: per-IP+email bucket with lockout, enforced server-side — solid.
- Ticket number reservation: atomic `$inc` counter, no races — solid.
- SLA computation: `computeSla` with pause/resume — solid.
- Permission model: every API route checks independently of client state — solid.
- Mongoose models: `select: false` on `passwordHash` — solid.
- GridFS attachment upload/download — solid.
- CSV export (`/api/tickets/export`) — solid.
- Bulk import (`/api/requestors/import`) — solid.
- Audit log immutability (no DELETE or UPDATE routes on AuditLog) — solid.
- Email inbound webhook: signature verification, dedup by message-id — solid.
- Dark mode CSS variables in `globals.css` — solid (all colours use oklch variables).
- `withApi` error wrapper: covers `AuthError`, `ForbiddenError`, Mongoose CastError, dup key — solid.

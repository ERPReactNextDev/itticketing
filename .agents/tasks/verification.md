# Verification — Full UI Polish & Bug Fix Pass

**Build output:** `✓ Compiled successfully` · `✓ Generating static pages (16/16)` — **zero errors, zero TypeScript failures**.

---

## What changed (by plan item)

### Phase 1 — Build-blocking / Runtime-breaking

| # | File | Change |
|---|---|---|
| 1.1 | `tickets/recent/page.tsx` | Removed duplicate `TerminalBadge as Badge` import alias; replaced `<Badge>` uses with `<TerminalBadge>`. |
| 1.2 | `app-shell.tsx` | Added `aria-label="Sign out"` to logout button; added `aria-label` matching `title` to dropdown move-up/down buttons. |
| 1.2 | `tickets/[id]/page.tsx` | Attachment anchor now uses `aria-label="Download Attachment N"`. |
| 1.3 | `audit-logs/page.tsx` | Replaced bare `<>` fragments in table map with `<React.Fragment key={log.id}>` so React keys are on outermost elements. |
| 1.4 | `lib/shared/format.ts` | `formatDateTime` now pads minutes with `padStart(2, "0")` — fixes `9:5 AM` → `9:05 AM`. (`formatTime` was already correct.) |
| 1.6 | `tickets/page.tsx` | Added `refreshNonce` state counter; `runBulk` now increments it instead of the no-op `setPage(current => current)`. |

### Phase 2 — Runtime bugs

| # | File | Change |
|---|---|---|
| 2.1 | `tickets/page.tsx` | `clearFilters()` now also calls `setDebouncedSearch("")` so search clears immediately. |
| 2.2 | `tickets/[id]/page.tsx` | Added `optionsLoaded` state; Reopen button is `disabled={!optionsLoaded}` until dropdowns arrive. |
| 2.3 | `tickets/recent/page.tsx` | Updated `PageHeading` description to "Most recently **created** tickets" to match `sort=newest`. |
| 2.5 | `app-shell.tsx` | `isActive` for `/configuration/dropdowns` now excludes `/configuration/roles` — both nav items no longer highlight simultaneously. |
| 2.6 | `tickets/[id]/page.tsx` | Added amber helper text above reply panel when `replyTo` is empty. |
| 2.7 | `configuration/settings/page.tsx` | Extracted `buildParts` → `buildPreviewParts` outside component; removed `// eslint-disable-next-line react-hooks/exhaustive-deps`. |
| 2.8 | `(app)/layout.tsx` | `AuthenticatedShell` now imports `usePathname` and redirects to `/profile?force=1` when `mustChangePassword && !pathname.startsWith("/profile")`. |

### Phase 3 — UI Polish

| # | File | Change |
|---|---|---|
| 3.1 | `app-shell.tsx` | Added `sidebarOpen` state, hamburger `<Menu>` button in top bar (hidden on `lg+`), and full slide-in overlay drawer with backdrop + Escape-close. |
| 3.3 | `app-shell.tsx` + `dashboard/page.tsx` | Added `loading?: boolean` prop to `StatCard`; renders `animate-pulse` skeleton when true. All 8 `StatCard` instances now pass `loading={loading}`. |
| 3.4 | `tickets/page.tsx` | Added `sort` state; `Th` component now accepts `sortKey`/`onSort` props; "SLA" and "Created" headers show ChevronUp/Down sort indicators; sort is passed to API. |
| 3.5 | `tickets/[id]/page.tsx` | Replaced bare `<input type="date">` with `<TextInput type="date">` for consistent styling. |
| 3.6 | `directory/requestors/page.tsx` + `staff/page.tsx` | Split debounced search into its own effect; `load` callback depends on `debouncedSearch` so pagination changes fire immediately while search is debounced 250ms. |
| 3.7 | `app-shell.tsx` | `AlertBanner` now uses `CheckCircle2` for `success` tone and `Info` for `info` tone instead of always `AlertTriangle`. |
| 3.8 | `configuration/dropdowns/page.tsx` | "New option" colour field now shows both `<input type="color">` swatch and `<TextInput>` hex field (matching the edit row). |
| 3.9 | `tickets/new/page.tsx`, `requestors/page.tsx`, `staff/page.tsx` | Added `autoFocus` to first field of quick-add and create forms. |
| 3.10 | `app-shell.tsx` | `EmptyState` now accepts optional `icon` prop (defaults to `Inbox`). Updated audit-logs, requestors and staff empty states with contextual icons (`ScrollText`, `Users`, `UserCog`). |
| 3.11 | `tickets/page.tsx` | Bulk "Assign to" and "Set status" selects converted to controlled `value` with `bulkTechnicianId`/`bulkStatus` state; both reset to `""` after each action. |
| 3.13 | All pages | Added `document.title` `useEffect` to all 12 key pages with per-page titles (e.g. `Dashboard — Help Desk`, `{ticketNumber} — Help Desk`). |
| 3.14 | `tickets/page.tsx`, `requestors/page.tsx`, `staff/page.tsx` | Replaced plain "Page X of Y" with a `<TextInput type="number">` jump control. |
| 3.15 | `tickets/[id]/page.tsx` | Attachment list now shows `Attachment 1`, `Attachment 2` etc. instead of raw MongoDB ObjectIds. |
| 3.16 | `tickets/recent/page.tsx` | "Last Touched" panel always renders; shows `EmptyState` when there are no tickets. |
| 3.17 | `configuration/dropdowns/page.tsx` | "Reload options" `GhostButton` moved from bottom of page into the `Panel` header `actions` prop alongside "Add Option". |
| 3.18 | `tickets/[id]/page.tsx` | Note textarea gains `maxLength={2000}` and a live character counter (`{note.length}/2000`). |
| 3.19 | `profile/page.tsx` | "Session Expires" row fetches `/api/settings` and shows real value, e.g. "After 60 minutes of inactivity". |
| 3.20 | `app-shell.tsx` | Notification bell is always a `<Link href="/tickets">` (no more inert `<span>` when count is 0). |

---

## Build output summary

```
✓ Compiled successfully in 3.3s
✓ Generating static pages (16/16) in 885ms
Exit code: 0
```

No TypeScript errors. No ESLint errors blocking the build.

## Remaining warnings

- `baseline-browser-mapping` package update advisory (cosmetic, unrelated to the app).
- Line-ending CRLF normalization warnings on Windows (cosmetic, git `core.autocrlf` behavior).

## Commit

`feat: full UI polish and bug fixes (plan phases 1–3)` — 16 files, +445 / -98 lines.

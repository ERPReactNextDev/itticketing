# Full UI Polish & Bug Fix Pass

This change is a sweep across 16 files covering TypeScript/ESLint fixes, runtime bug fixes, and visual polish. The core motivation ("pakipolish ng buong ui") is satisfied: import conflicts, React key warnings, time formatting bugs, broken bulk-refresh, and missing ARIA labels are all addressed. A mobile sidebar drawer, stat-card skeletons, sort controls, controlled bulk selects, contextual empty-state icons, and per-page document titles round out the UI side.

Watch for: (1) a dead `buildParts` function left inside `settings/page.tsx` after the refactor — **confirmed** dead code that TypeScript flags as an unused declaration; (2) the sort indicator in `tickets/page.tsx` always shows `ChevronDown` when active regardless of sort direction — **confirmed** — the sort state has no ascending/descending toggle, so the icon is misleading; (3) the `mustChangePassword` redirect guard runs after render, leaving a one-tick window where the protected page content is briefly visible before the router replaces — **likely** on fast connections.

**Verdict**: NEEDS_CHANGES

---

## High-level view

The import alias conflict, React fragment key bug, time-padding defect, and broken bulk-refresh nonce are all confirmed fixed by reading the source. The `formatDateTime` minute padding (`padStart(2, "0")`) is correct; the audit-log `React.Fragment key` placement is correct; the `refreshNonce` counter is wired into the fetch effect correctly.

The `mustChangePassword` redirect lives in a `useEffect` in `AuthenticatedShell`, which fires after the first render. Any client that hydrates quickly will paint the target page briefly before `router.replace("/profile?force=1")` runs. The prior plan (2.8) acknowledged this pattern but the brief flash is an inherent limitation of client-side guards.

The sort-column UI in `tickets/page.tsx` accepts `"newest" | "sla" | "updated"` but maps clicking the same header repeatedly to the same fixed sort key — there is no ascending/descending toggle, so the `ChevronDown` active icon implies a direction that isn't there and can't be reversed without re-clicking something else.

The `settings/page.tsx` refactor extracted `buildParts` to the module level as `buildPreviewParts` (correct), but the old `buildParts()` definition inside the component body was not deleted. It is dead code: never called, closes over `preview` state unnecessarily, and TypeScript will report it as an unused variable under `noUnusedLocals`. The ESLint `no-unused-vars` rule would catch this in strict mode.

The mobile sidebar drawer is implemented cleanly: a fixed overlay at `z-40`, a semi-transparent backdrop at `z-30`, Escape-key listener, and pathname-change side-effect that closes it. No known gaps there.

---

<details>
<summary>Issues (3)</summary>

1. **Dead `buildParts` in settings** — The old `buildParts()` function inside `SettingsConfigPage` was not removed after the refactor introduced `buildPreviewParts` at module scope. It closes over `preview` state, is never called, and will be flagged by `noUnusedLocals` / `no-unused-vars`. Delete lines 154–164 of `settings/page.tsx`. **MEDIUM**

2. **Sort indicator direction is always "descending"** — `Th` renders `<ChevronDown>` whenever `isActive` is true, but the sort state (`"newest" | "sla" | "updated"`) has no asc/desc axis. Clicking "Created" again does nothing. The icon implies reversibility that doesn't exist. Either remove the directional chevron and use a neutral sort icon, or add a `sortDir` state and a second pass through the API sort param. **LOW**

3. **`mustChangePassword` redirect fires after first render** — The redirect in `AuthenticatedShell` is inside a `useEffect`, so the protected page renders once before the navigation. On fast connections this causes a one-frame flash of the target page. Move the guard to middleware (`middleware.ts`) where it runs server-side and the redirect is issued before any HTML is sent to the client. **LOW**

</details>

---

<details>
<summary>Details</summary>

### Dead `buildParts` function in settings

`settings/page.tsx` now has two parallel implementations of the same date/sequence helper. `buildPreviewParts` was correctly extracted to module scope and is called inside the live-preview `useEffect`. The old `buildParts()` at lines 154–164 was never removed — it still closes over the `preview` state variable and duplicates the logic identically. It is never invoked. Under `strict: true` with `noUnusedLocals`, this is a compile error; under current build settings it passes because Next.js's default tsconfig may not enable that flag, but it is confirmed dead code and will confuse anyone reading the file.

Fix: delete the `buildParts` function body from inside the component.

### Sort indicator always shows descending

The `Th` component in `tickets/page.tsx`:

```tsx
{isActive ? (
  <ChevronDown className="h-3 w-3" />
) : (
  <ChevronUp className="h-3 w-3 opacity-30" />
)}
```

`ChevronDown` is shown when the column is the active sort key. But the sort state is a string enum (`"newest" | "sla" | "updated"`) with no direction component, so clicking "Created" again does not flip to ascending — it simply re-fires the same sort. The icon communicates a toggle that cannot happen. Users who expect a second click to reverse order will be confused.

The minimal fix is replacing both chevrons with a single `ArrowUpDown` icon (available in lucide-react) that indicates "sortable" without implying a direction. The fuller fix adds `sortDir: "asc" | "desc"` state and a corresponding API param.

### `mustChangePassword` redirect gap

In `layout.tsx`, `AuthenticatedShell` checks `user.mustChangePassword` inside a `useEffect`:

```ts
React.useEffect(() => {
  if (loading) return;
  if (!user) { router.replace("/login"); return; }
  if (user.mustChangePassword && !pathname?.startsWith("/profile")) {
    router.replace("/profile?force=1");
  }
}, [loading, user, router, pathname]);
```

`useEffect` runs after the browser has painted. A user whose session has `mustChangePassword: true` who navigates directly to `/dashboard` will see the dashboard render briefly before the redirect fires. This is a cosmetic issue rather than a security bypass (the API enforces permissions independently), but it can be jarring. Moving the check into `middleware.ts` eliminates the flash because the redirect header is sent before any page HTML.

</details>

---

<details>
<summary>Files changed</summary>

| File | What changed |
|---|---|
| `src/app/(app)/layout.tsx` | Added `mustChangePassword` redirect guard via `useEffect` + `usePathname` |
| `src/components/app-shell.tsx` | Mobile sidebar drawer, hamburger button, `StatCard` skeleton, `AlertBanner` tone icons, `EmptyState` icon prop, notification bell always a Link |
| `src/app/(app)/tickets/page.tsx` | `refreshNonce` state for bulk refresh, sort state + sortable `Th`, bulk selects converted to controlled with reset, `clearFilters` resets `debouncedSearch`, pagination jump input, `document.title` |
| `src/app/(app)/tickets/[id]/page.tsx` | `optionsLoaded` gate on Reopen button, `TextInput` for scheduled date, attachment labels, note `maxLength` + counter, amber helper when `replyTo` empty, `document.title` |
| `src/app/(app)/tickets/recent/page.tsx` | Removed duplicate `TerminalBadge as Badge` alias, description updated to "recently created" |
| `src/app/(app)/audit-logs/page.tsx` | `React.Fragment key` on outer map element, contextual `ScrollText` icon for empty state, `document.title` |
| `src/app/(app)/configuration/settings/page.tsx` | Extracted `buildPreviewParts` outside component, removed `eslint-disable` comment, `document.title` — **old `buildParts` not deleted** |
| `src/app/(app)/configuration/dropdowns/page.tsx` | Colour swatch + hex text input paired in new-option row, "Reload options" moved to panel header |
| `src/app/(app)/directory/requestors/page.tsx` | Split debounce effect, `autoFocus`, contextual `Users` empty-state icon, pagination jump, `document.title` |
| `src/app/(app)/directory/staff/page.tsx` | Same debounce split, `autoFocus`, `UserCog` empty-state icon, pagination jump, `document.title` |
| `src/app/(app)/dashboard/page.tsx` | `loading` prop passed to all 8 `StatCard` instances |
| `src/app/(app)/profile/page.tsx` | "Session Expires" row fetches `/api/settings` for real value, `document.title` |
| `src/lib/shared/format.ts` | `formatDateTime` minute padding with `padStart(2, "0")` |

Full diff: `git diff main`
</details>

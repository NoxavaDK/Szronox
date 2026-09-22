# LIST-01 — list gestures and quick actions: interaction plan

Status: implemented on `codex/list-01`, unmerged. No prior interaction plan existed in
`docs/implementation/` or `docs/product/` to update — this document is the first one; future
gesture work should update it in place rather than creating a parallel doc.

Built on the most current integrated frontend source at dispatch time: `codex/corpus-01`
(`b5a8946`), which carries `codex/review-repair-01`'s Reel Detail/AI-workspace/PWA work,
`agents/t06-screens`/`agents/t08-sync`'s screens, and the VPS-04 runtime batch. Root `master`'s
`apps/web/src` is still the bare T01 scaffold; the screens this task touches live only on that
integrated line, not on master.

## Read before implementing

- `docs/implementation/T00-contracts.md` — Reel invariants, route surface, mutation/conflict
  contract, feed-cover gate, frozen Publication/Materials/delete sections.
- `design/frozen-visual-spec.md` sec. 2 (Main Reel List) and `design/frozen-reel-detail-language-spec.md`
  (status/priority/editor selectors, kDrive/export/verification, delete confirmation copy).
- Current implementation: `ReelListScreen.tsx`, `ReelDetailScreen.tsx`/`detail-sections.tsx`
  (existing bottom-sheet and delete-confirm pattern, reused rather than redesigned),
  `screen-contracts.ts`, `useAppController.ts`, `App.tsx`, `data/api.ts`,
  `packages/contracts/src/index.ts` (`Reel`, route surface).

## Final interaction decisions

- **Tap** opens Reel Detail — unchanged.
- **Long press** (stationary hold, ~500ms) opens a compact quick-actions bottom sheet.
- **Swipe right** reveals the pipeline's next status as a direct-commit pill when the status
  order (`idea → to_record → editing → ready → published`) gives the current status exactly
  one unambiguous successor; on `published` (no successor) it reveals `Zmień status` instead,
  which opens the full status sheet rather than guessing.
- **Swipe left** reveals `Więcej`, which opens the same sheet as long press. It does **not**
  reveal `Archiwizuj` — see "Blocked: Archiwizuj" below.
- **Long press + drag (reorder)**: not implemented. `GET /reels` is "fixed product sorting"
  (T00 route surface) and no Reel-list view in this product has an explicit manual-order
  contract (unlike `ReelHook.position`, which orders hooks, a different entity). The brief's
  own condition — "reorder only in views explicitly supporting manual order" — is therefore
  never met today. This is a confirmed non-applicability, not a missing decision.
- Undo is shown after a successful status move (both the swipe-right pill and the sheet's own
  `Zmień status` picker), as a bottom snackbar with a `Cofnij` action, auto-dismissing after 6s.

## Per-action contract verification

| Action | Contract | Decision |
| --- | --- | --- |
| Zmień status | T00 mutation contract; `STATUS_ORDER`/`STATUS_LABELS` already frozen in `screen-contracts.ts` | Reuses the existing version-checked scalar PATCH (`status`), the existing feed-cover publish gate, and the existing status label set. Implemented. |
| Przypisz | "existing assignment meaning" = the `editorId` field / MONTUJE selector, frozen in the Reel Detail batch | Opens the same two-allowlisted-user + `Brak` picker Detail already uses, via the same PATCH. Implemented. |
| Kopiuj link | Needs "a working authenticated Reel deep link" | See "Deep-link routing" below — this needed a small, targeted addition since no client route previously reflected `route` into the URL at all. Implemented, scoped narrowly. |
| Otwórz kDrive | "existing stored folder reference", only when a folder exists | `hasKdriveFolder` mirrors `Reel.kdriveFolder !== null`. kDrive integration itself is not enabled anywhere in the product (`KDRIVE_ENABLED = false`, same flag Detail's Materials section already uses) — T04 remains unauthorized per `AGENTS.md`/`tasks.md`. The sheet item is shown only when a folder reference exists, and — exactly like Detail's own kDrive row — states unavailability honestly (`COPY.kdriveUnavailable`, now a single shared string) rather than pretending to open anything. |
| Usuń | Existing soft-delete contract, exact confirm copy from `screen-contracts.ts` `COPY` | Reuses `POST /reels/:id/delete`, the exact `Usunąć rolkę?` confirmation copy/labels, last and visually separated in the sheet. Implemented. |
| Manual reorder | Requires an explicit manual-order view + persistence contract | No such view exists (see above). Not implemented; nothing to gate. |
| **Duplikuj** | No approved contract | **Blocked — see below.** |
| **Archiwizuj** | Must be distinct from deletion; must not invent a workflow status | **Blocked — see below.** |

### Blocked: Duplikuj

There is no `duplicate`/`clone` endpoint anywhere in the route surface, and none of `T00`,
`tasks.md` or `AGENTS.md` defines what a duplicate should copy or reset. The brief itself
anticipates this ("never silently copy approvals, verification, publication state or AI
jobs") but that is a constraint on a feature that doesn't exist yet, not a specification of
one. Implementing it would mean inventing product policy — does a duplicate start at `idea`
regardless of the source status? Does it copy hooks (their `source`/`position` provenance),
`originalInput` (which T00 treats as an immutable capture record, not something a duplicate
action would legitimately "recapture"), the feed-cover flag, `editorId`? None of this is
decided anywhere. Per the brief's own instruction ("do not invent semantics, ship a
nonfunctional menu item"), `Duplikuj` is omitted from the shipped sheet entirely rather than
shown disabled or wired to a fabricated behavior.

**Missing decision for the lead:** an approved copy/reset contract for a Reel "duplicate" —
which fields carry over, which reset to their creation defaults, whether it needs a new
`POST /reels/:id/duplicate` route or is expressed as a client-side read-then-create, and
what happens to `originalInput`/hooks/attachments. Until that exists, `Duplikuj` cannot ship.

### Blocked: Archiwizuj

T00's soft-delete section is explicit: *"Active Reel overflow has only Usuń rolkę."* There is
no `archived` concept anywhere — not a sixth status (which the brief itself forbids inventing:
"do not invent a workflow status"), not a filtered view, not a field. The brief also forbids
treating it as a synonym for deletion ("must remain distinct from deletion"), which forecloses
the one interpretation that *would* have an existing contract. That leaves nothing to
implement against. `Archiwizuj` is omitted from both the sheet and the swipe-left reveal,
which therefore shows only `Więcej`.

**Missing decision for the lead:** what "archive" is supposed to mean product-wise — a new
persisted Reel attribute distinct from `deletedAt`, a saved/pinned client-side filter, or
something else — before any implementation (contract, migration, or UI) can be scoped.

## Deep-link routing (Kopiuj link)

Before this change, `route` (`useAppController.ts`) was pure in-memory React state — nothing
ever called `history.pushState`, so no URL ever named an open Reel and there was nothing for
`Kopiuj link` to produce a working link *to*. This is a small, targeted addition, not a
routing rewrite:

- `openDetail` now also does `history.pushState(..., '/reels/:id')` on success (only when the
  address bar doesn't already say so, to avoid duplicate history entries on a fresh deep link).
- On mount, once the session is confirmed, the app checks `location.pathname` for
  `/reels/:id` and opens that Reel — this is what makes a copied link actually work when
  visited, including after a full reload.
- A `popstate` listener syncs the two directions: back to `/` closes Detail, forward/back to
  `/reels/:id` opens it — new behavior where none existed, not a change to any existing
  back-gesture handling (there was no `pushState` anywhere before, so nothing here regresses
  "preserve browser back/edge gestures").
- `leaveDetail()` (used by Detail's own `onBack`) and the success paths of `deleteCurrent`/
  `restore` push `/` back onto the address bar so it doesn't keep naming a Reel that's no
  longer open. Other `list`-bound routes (Quick Add cancel, the deleted view, sign-out) never
  had a pushed URL to unwind and are untouched.
- The link itself is same-origin (`location.origin + '/reels/:id'`); "authenticated" is
  satisfied the same way every other route already is — the app is session-cookie gated
  (`main.tsx`: "no anon key... no Authorization header"), so opening it while signed out shows
  the existing Login screen, and while signed in as either allowlisted user opens the Reel
  (both users have equivalent product access per T00).
- Clipboard failure reuses the exact pattern `copyPublication` already established: report
  success only after `navigator.clipboard.writeText` resolves; on failure or when the API is
  unavailable, show the composed text for manual copying rather than claiming success.

## List-row mutations: a new call site, not a new contract

`ReelListItemView` gained `version`, `status` and `hasKdriveFolder` — all already present on
`Reel`, just not previously projected to the list view, because nothing needed them there
before quick actions existed. `useAppController` gained `patchReelById`/`removeReelById`,
which issue the *same* version-checked `PATCH`/`POST .../delete` T00 already specifies,
against a Reel that is not necessarily the open `current` one.

Only a genuine transport failure — `fetch` itself throwing, no response at all — reuses the
exact same offline path `changeReel`/`deleteCurrent` already use (`store.enqueue()` +
`SyncQueue.flush()` on reconnect) rather than a second mechanism; this is a corrected
distinction, see "Error handling" in the Correction pass below for the bug it fixes. The list
is deliberately **not** updated optimistically when a mutation is queued offline: unlike
Detail, there is no open screen here to reconcile the eventual result against, so "queued" is
reported honestly (`Brak sieci. Zmiana zostanie wysłana po powrocie sieci.`) instead of a row
that could silently revert later. Nothing is ever reported accepted before the server has it.
A status-changing patch also re-syncs the currently viewed tab (`refreshFilteredList`) rather
than patching the row in place — see "Status filtering" in the Correction pass.

Undo re-issues the same PATCH with the version returned by the original successful move (which
also goes through `refreshFilteredList`, so a Reel undone back into the viewed tab reappears).
If that conflicts (someone else changed the Reel meanwhile), the 409 is surfaced and the undo
is not retried or forced — it never overwrites an intervening edit.

## Accessibility: the non-gesture route

Every quick action is also reachable without a pointer gesture. The list row is a native
`<button>` (Tap/Enter/Space unchanged). The quick-actions sheet itself opens via `onContextMenu`
(right-click) and via keyboard — pressing the OS-standard `ContextMenu` key or `Shift+F10`
while a row is focused — deliberately *not* a new permanent button on the row, which the
brief rules out ("No permanent extra buttons on list rows"). From there, `Zmień status`,
`Przypisz` and `Usuń` are the same controls Reel Detail already exposes; `Kopiuj link`'s only
non-gesture route is this sheet, since Detail has no comparable action to point to.

The sheet (`ReelQuickActionsSheet`) is a `role="dialog"` with `aria-modal`, focuses its first
enabled control on open, restores focus to whatever opened it on close, dismisses on
`Escape`, and contains Tab/Shift+Tab within itself (boundary-cycling: Tab from the last
control wraps to the first, Shift+Tab from the first wraps to the last — added in the
correction pass below, since `aria-modal` had been declared without anything enforcing it).
This is scoped to this one component; Reel Detail's existing sheets
(`detail-sections.tsx`'s `MetadataSelectors`/`ReelOverflow`) are untouched, per the review's
own instruction that no app-wide accessibility refactor was needed here.

## Mobile/PWA gesture handling

`apps/web/src/ui/gestures.ts` separates the decision logic (pure, tested) from the stateful
Pointer Events wiring (`useRowGesture`):

- Axis lock: movement under 8px stays "undetermined" (still a long-press candidate); once
  resolved, horizontal beats a diagonal-favoring-vertical tie, and only a horizontal drag ever
  calls `preventDefault()` — vertical stays entirely with the browser's native scroll
  (`touch-action: pan-y pinch-zoom` on the row — see the correction pass below for why
  `pinch-zoom` has to be listed explicitly).
- **A defect found and fixed during self-review**: because the axis-lock threshold (8px) is
  smaller than the tap-slop threshold (10px) that would otherwise cancel a pending long-press,
  an axis could resolve to `vertical` at 8px while the long-press timer was still armed and
  would never be reached again once the axis was no longer `undetermined` — so a long vertical
  scroll could still fire the long-press callback ~500ms in. Fixed by clearing the long-press
  timer unconditionally the moment any axis resolves, not only via the slop check. Covered by
  code review; there is no DOM/testing-library in this project to reproduce the exact
  multi-pointermove sequence as an automated test, so this remains a manually-verified fix
  (see Verification below).
- Edge guard: a horizontal drag starting within 24px of the left edge and moving rightward is
  left entirely to the browser (the same physical gesture as iOS/Android's edge-back swipe).
- Long-press vs. drag: the long-press timer is armed on pointerdown and cleared the instant
  either axis resolves or the move exceeds the tap slop — so a drag can never also fire a
  long-press, and a long-press can never fire once the finger has moved.
- Pointer cancellation resets all state with no action firing (`onPointerCancel`/`reset`).
- Swipe reveal uses `transform: translateX()` with a restrained maximum (96px), snapping open
  past a 40px release threshold or springing back otherwise; `prefers-reduced-motion: reduce`
  drops the CSS transition (the reveal still functions, just without the animated snap).
- Haptics: `navigator.vibrate?.(10)` on a successful long-press — optional-chained, so devices/
  browsers without vibration support simply do nothing; no code path depends on it succeeding.
- Only one row's swipe reveal is open at a time; opening another closes the previous
  (`revealedId` lifted to `ReelListScreen`). Navigating away (Detail/Deleted) unmounts the list
  entirely, which is what "closes on view change" means in practice — nothing extra was needed
  for that case.
- Zoom and normal page scroll are untouched — nothing here calls `preventDefault()` outside a
  confirmed horizontal drag, and `touch-action: pan-y pinch-zoom` keeps pinch-zoom native (see
  the correction pass below).

## Correction pass (bounded review)

A bounded review before merge found five issues the pure gesture-logic tests didn't cover
(they test decision functions, not the stateful wiring or the surrounding app code). All five
are fixed on this branch; accepted as still out of scope: `Duplikuj`/`Archiwizuj` (pending
contracts), manual reordering, and keeping AI actions inside Detail.

- **BLOCKER — swipe reset mid-drag.** `ReelRow`'s cleanup effect read `!revealed && offset !==
  0` and called `close()`. `revealed` (`revealedId === item.id`, lifted to `ReelListScreen`)
  only becomes true on release, via `onSwipeOpen`; during the drag itself `offset` changes on
  every `pointermove` while `revealed` stays false the whole time — so the effect fired on
  every drag frame and reset the row before it could ever be released and open. Fixed by
  tracking the previous value of `revealed` and only closing on a true→false transition (i.e.
  when *another* row's reveal supersedes this one), which is the only case that needed
  handling — a row's own in-progress drag, and its own explicit close (tap-to-close, a reveal
  button's own handler), were already correct and untouched.
- **Status filtering.** A successful status-changing patch replaced the row in place
  (`list.map`) in whichever tab was currently loaded, so a Reel that moved out of the viewed
  tab stayed visible there under its new status label instead of leaving the list. Fixed with
  a new `refreshFilteredList()` in `useAppController.ts`: for a patch whose `changes.status !==
  undefined` (both the original move and its undo), it silently re-fetches `api.list({status})`
  for the tab currently being viewed instead of patching the array by hand — deliberately not
  `loadList()`, which also flips `loadState` to `'loading'` and would replace the whole list
  with a spinner for what should read as a quiet move. Non-status changes (Przypisz) keep the
  original in-place update, since they don't affect which tab a row belongs to.
- **Error handling.** `patchReelById`/`removeReelById` treated every non-409 error —
  including a real, structured rejection like 422 `FEED_COVER_REQUIRED`, 400
  `VALIDATION_ERROR` or 403 `FORBIDDEN` — as a transport failure and enqueued it for retry,
  reporting a false "Brak sieci" message that hid the actual reason and would have silently
  re-failed the same way once "retried". Fixed by branching on `error instanceof
  ClientApiError`: that means the server actually answered (a real response, not a dropped
  connection), so anything other than 409 is now surfaced via the same `polishError()` the
  rest of the app already uses, and only a genuine non-`ClientApiError` throw (fetch itself
  failing — no response at all) is queued.
- **Mobile zoom.** `touch-action: pan-y` does not preserve pinch-zoom — per the Touch Action
  spec, listing `pan-y` alone disables every other default touch behavior on that element,
  pinch-zoom included. Fixed to `touch-action: pan-y pinch-zoom`, which keeps vertical
  scrolling and pinch-zoom both native while still leaving horizontal panning unclaimed for
  the gesture hook to intercept once it confirms a horizontal drag.
- **Modal keyboard focus.** The sheet declared `aria-modal="true"` but nothing enforced it —
  Tab from the last focusable control could reach the list behind the (purely visual) backdrop.
  Fixed with a standard boundary-cycling trap inside `ReelQuickActionsSheet`'s own `onKeyDown`
  (Tab from the last element wraps to the first, Shift+Tab from the first wraps to the last),
  scoped to this one component only — no change to Reel Detail's existing sheets, per the
  review's own instruction that no app-wide accessibility refactor was needed here.

## Verification

Environment: no browser automation available this session (Claude in Chrome not installed;
declined). Everything below is changed-module compilation, unit tests on the pure decision
logic, and a full production build — real pointer/touch/keyboard interaction, actual-device
haptics and real browser back-gesture behavior are **UNVERIFIED**, per the brief's own
instruction to mark those explicitly rather than claim them.

```
npm run typecheck --workspace @szronox/web   # PASS (contracts + web, both tsconfig projects)
npm run build --workspace @szronox/web       # PASS (vite build + sw build)
npm run test:list-01 --workspace @szronox/web
  # = node --experimental-strip-types --test src/ui/tests/*.test.mjs src/ui/frozen-copy.test.mjs
  # PASS — 17/17 (9 new gesture-logic tests + the existing 8 frozen-copy assertions)
node --experimental-strip-types --test src/data/tests/*.test.mjs src/share/tests/*.test.mjs \
  src/ui/tests/*.test.mjs src/ui/frozen-copy.test.mjs
  # PASS — 54/54 (full existing T08/share suite + the above, confirming no regression)
```

`apps/api` and `apps/worker` were not touched; `npm run typecheck` at the repo root still
fails inside `apps/api` (`@electric-sql/pglite` module resolution, `AiInputSnapshot` shape
drift in `service.ts`/`service.test.ts`) — confirmed pre-existing on `codex/corpus-01` before
this branch's changes (same failures reproduced by stashing this branch's diff and re-running).
Not a LIST-01 regression; out of this task's file scope.

A fixture-driven interactive harness was wired for manual browser verification
(`DevPreview.tsx`'s `ListPreview`, extended with a local, backend-free `quickActions`
implementation) but not exercised live this session for the reason above. To use it: point
`main.tsx` at `<DevPreview />` temporarily (per that file's existing doc comment), `npm run
dev --workspace @szronox/web`, and drive it by hand or with browser automation once available.

### Coverage against the brief's checklist

| Check | Status |
| --- | --- |
| Tap/scroll/long-press/swipe separation | Decision logic unit-tested. Two real defects found and fixed by code review across the two review passes: a vertical scroll could still trigger long-press (initial self-review), and the reveal-close effect fired on every drag frame instead of only when superseded by another row, resetting a swipe before it could open (bounded review, see Correction pass). Live interaction still UNVERIFIED — no browser automation available in either session. |
| Correct Reel identity for every action | Every callback is `(id, ...) => ...`, resolved from `c.reels`/`items` by that id, never from `current`/a captured closure over "the open row" — verified by reading, not by a dedicated test. |
| Status gates, ambiguous transitions, safe undo | Feed-cover gate reuses the identical pre-check Detail already performs; ambiguous (`published`) case opens the sheet rather than guessing; undo re-PATCHes with the version returned by the move and surfaces (never forces past) a conflict; a status change now re-syncs the viewed tab (`refreshFilteredList`) instead of leaving the row misfiled — see Correction pass. Logic-level review; no live mutation test against a real API this session. |
| Delete confirmation and cancellation | Reuses the exact frozen confirm copy/labels; cancel returns to the sheet without a request. |
| Automatic-sort protection | No reorder implemented at all — see "Long press + drag" above. |
| Keyboard/screen-reader access, clipboard failures | Non-gesture routes implemented (ContextMenu key/right-click, existing Detail controls); the sheet now contains Tab focus within itself (Correction pass); clipboard failure reuses `copyPublication`'s truthful pattern. Actual screen-reader/keyboard-in-browser behavior UNVERIFIED (no AT or browser automation available in either session). |
| Mobile browser behavior | UNVERIFIED — no device/browser automation available in either session. Pinch-zoom regression found and fixed (Correction pass) by static CSS review, not by an actual pinch test. |

## Remaining gates

- The lead's requested follow-up — targeted browser checks of swipe, status/undo, keyboard
  focus and back navigation — is still **UNVERIFIED**: no browser automation was available in
  either session (Claude in Chrome not installed; declined both times it was offered). The
  code-level fix for each of the five findings is in place and covered by typecheck/build/unit
  tests, but none of the five has been exercised in an actual browser. The fixture harness
  (`DevPreview.tsx`'s `ListPreview`, already wired with a working `quickActions` and no backend
  dependency) is ready for whenever browser access is available — see Verification above for
  how to mount it.
- Live pointer/touch interaction, actual-device haptics, real screen-reader behavior, and
  browser back/edge-gesture behavior: **UNVERIFIED** for the same reason.
- `Duplikuj` and `Archiwizuj`: **blocked on lead decisions** described above; nothing shipped
  for either, by design. Accepted by the review.
- kDrive opening remains honestly disabled end-to-end (T04 unauthorized) — the list quick
  action inherits that, not a new limitation.
- Manual reorder: not applicable to any current view; revisit only if a future task introduces
  an explicitly manual-order list. Accepted by the review.

## Handoff

- Branch: `codex/list-01`, left unmerged, not deployed.
- Changed files: `apps/web/src/ui/gestures.ts` (new), `apps/web/src/ui/tests/gestures.test.mjs`
  (new), `apps/web/src/screens/ReelQuickActions.tsx` (new), `apps/web/src/screens/ReelQuickActions.module.css`
  (new), `apps/web/src/screens/ReelListScreen.tsx`, `apps/web/src/screens/ReelListScreen.module.css`,
  `apps/web/src/screens/fixtures.ts`, `apps/web/src/screens/preview/DevPreview.tsx`,
  `apps/web/src/ui/screen-contracts.ts`, `apps/web/src/ui/detail-sections.tsx` (dedup: shared
  `STATUS_ORDER` instead of two copies), `apps/web/src/controllers/useAppController.ts`,
  `apps/web/src/app/App.tsx`, `apps/web/package.json` (new `test:list-01` script).
- Commit: see the branch tip on `codex/list-01`.

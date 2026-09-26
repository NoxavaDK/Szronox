# UX-PUBLICATION-02 — Opus verification report

Reviewer: Opus 5.5, manual, as directed by the operator. Target: `codex/ux-publication-02` at `3425bc9`, baseline `4cb253e`, diff `git diff 4cb253e..3425bc9`. I made no implementation edit, merge, deployment, provider call or credential change.

## Method

- **Diff review:** all 22 changed files, against the dispatch, T00 and the current `plannedPublicationSlot` contract.
- **Rebuild:** `npm ci` from the existing lockfile (worktree-local `node_modules` only, no manifest or lockfile change), then `npm run build` PASS and `npm run typecheck` PASS. The worktree is still clean.
- **Browser composition:** headless Chrome 154 driven over CDP against Luna's built API and web on a local PGlite database with synthetic seeded Reels and a harness-issued session (the `sessionHarness` path the test suites use). No production or DEV records. Scripts are kept in the reviewer scratchpad.
- **Not repeated:** Luna's recorded unit suites.

## Results: 52 of 58 browser checks pass (6 failures, all classified below)

- **Layout:**
  - 390px single view, 800px drawer, 1200px two panes, 1600px two panes by default with an explicit `Trzy panele`.
  - Enlarged text approximated by CSS width: 1280px at 150% gives the drawer, 1440px at 125% gives two panes.
  - No horizontal overflow at any width.
  - The centre dominates (320/880px at 1200).
  - The three-pane preference persists across reload and falls back to two panes on a narrower window. Focus mode hides both side panes.
- **Selection persistence:** the selected Reel stays in the centre through a filter that excludes it, a status change that moves it out of the visible results, and a slot reschedule. Search text and filter survive switching between Rolki and Plan.
- **Detail:**
  - Empty script: `Opracuj` action, ŹRÓDŁA open above HOOKI, a 4-row script field.
  - Montaż: `Dodaj eksport`, with MATERIAŁY and non-empty UWAGI open.
  - Gotowe: `Wygeneruj opis`, with PUBLIKACJA open and the prerequisites stated inline.
  - A per-Reel manual collapse survives switching away and back.
  - The first export saves with no editor selected.
  - The cover icon focuses the completion control without changing it.
  - The selected hook shows first, with alternatives folded as `Pozostałe hooki (2)`. With no selection, candidates show and `Wybierz hook` is offered.
  - Planning inside PUBLIKACJA uses exactly Rano/Popołudnie/Wieczór, a reschedule persists, and `Po terminie` still shows in Plan.
- **Capture:**
  - `ZAPISZ` from the Gotowe filter opens the new Reel, and returning restores the Gotowe filter.
  - Offline capture shows "Zapis rolki oczekuje… Rolka nie została jeszcze utworzona" and no Reel. After reconnecting, the capture is created exactly once.
- **Draft safety:**
  - A rapid switch during typing saves A and shows B's own script.
  - A failed IndexedDB write keeps the current Reel open with its text and a truthful error ("Brak miejsca na zapis lokalny").
  - A concurrent server edit surfaces a conflict scoped to its Reel, which stays attached when returning. `Zachowaj moją wersję` saves the newest local text.
  - An unfinished hook edit is not applied by switching, is still visible on return (including a folded alternative), and disables `Wygeneruj opis`.
- **Stability:** no page exceptions.

## Classification

**BLOCKER:** none.

**CORRECTION NEEDED:**

1. **A conflicted Reel traps the user after further typing.** After a 409 conflict, more typing in that Reel followed by selecting another Reel does nothing. The Reel stays open and the notice reads "Nie udało się połączyć. Zmiany zostały zachowane lokalnie.", which misstates the cause.
   - Cause: `changeReel` returns early for a Reel in `blockedConflictReels` without scheduling a send, so `flushPending` stays null. `retainPendingDraftBeforeSwitch` then returns "Pending Reel draft was not scheduled for sending", and `polishError` maps that to the network message.
   - Suggested fix: treat a durably written draft of a conflict-blocked Reel as retained, so selection moves and the conflict stays with its Reel.
   - The data is safe, and resolving the conflict unblocks switching.
2. **Drawer keyboard access (700–1019px).** Opening the drawer leaves focus on `<body>`, Escape does not close it, focus is not contained, and `role="dialog"` has no `aria-modal`. Reuse the existing sheet pattern: focus on open, Escape to close, contained Tab, and focus returned on close.
3. **Contextual actions ignore AI availability.** `Opracuj` and `Wygeneruj opis` at the top of Detail open the AI workspace even when `aiCapability.enabled` is false. The workspace then says "Usługa jest chwilowo niedostępna". The AI row and the PUBLIKACJA button are gated. The contextual action should be gated the same way (for example, hidden or quiet).
4. **Visual overlap.** On two/three-pane desktop, the fixed `Wyloguj` button overlaps the new `Dwa panele / Skupienie` toolbar. For Astra: on 390px mobile it also crowds the list's `⋮` button, which looks pre-existing.

**CORRECTION NEEDED, pre-existing and not a Luna regression:**

5. **Typing while a save is in flight causes a self-conflict.** With about 1.5s latency, a second debounced patch is sent with the pre-flight `expectedVersion` while the first is still in flight. It then 409s against the client's own earlier save, with or without switching. The newest text is preserved locally as a conflict and is never lost, but the user sees a false conflict. Current master `650c581` reproduces this identically, so it predates this branch.
   - Suggested fix (root decision): serialize scalar sends per Reel, and rebase a queued patch onto the version returned by the in-flight one.

**OPEN REAL-WORLD GATE:**

- **Provider semantic quality:** UNVERIFIED. No live call was made; the grounded-complement and short-fallback behaviour needs a credentialed provider check.
- **Capture with server-confirmed creation but a pending or failed attachment upload:** not exercised (the harness uses memory storage). UNVERIFIED in the browser; the code path reports failures and pending uploads separately.
- **Real Android device, touch and OS text scaling:** not run. Enlarged text was approximated by CSS width, and a desktop browser's zoom was not driven.

**ACCEPTED / NO FURTHER TESTING NOW:**

- **PUBLICATION-02 server and worker, by code review:**
  - New runs carry `publicationContextVersion: 2` and prompt id `gemini-02-publication-provisional-v2`.
  - The prompt uses only the saved script, the selected hook's text framed as tone, and the eligible text sources with provenance. Those are captured text, `additionalText`, original-share fields named `text` (case-insensitive) and `inputNote`. URLs, images, unselected hooks and programme material are excluded.
  - `relevant()` and the apply check compare exact hook identity and text plus source text. Script edit-and-revert stays stale via `scriptRevision`. Unrelated metadata and applying the other publication field do not stale a proposal.
  - Legacy unmarked runs stay script-only for both freshness and prompt. Nothing reuses runs by hash or filters on prompt ID.
- **Other:** list search over the derived label, the `Wszystkie` filter (a view, not a status), paginated all-status loading with repeated-cursor detection, and preservation of the publication-slot planner through the rebase.

## Minor observations (no action required)

- In drawer layout, hidden copies of the list and plan stay mounted inside the closed drawer (for context retention). They are invisible and caused no duplicate visible controls.
- Switching away from a Reel with a pending edit waits for the network save, not only the local draft. On a slow connection selection lags by one round trip.
- A published Reel that still has a date shows the `Termin … · Zmień termin` shortcut.

# UI-04 — LIST-FILTER-02 and SCRIPT-COPY-01 for Luna

Status: both product corrections explicitly approved for one Luna 6 implementation by the operator on 2026-09-29. Root dispatches one agent after pinning these contracts. No merge or deployment is authorized.

## Approved task and assignment

- **Task ID:** UI-04, combining LIST-FILTER-02 and SCRIPT-COPY-01 in one implementation/handoff.
- **Exact task:** Make `Wszystkie` the initial Rolki Status choice and show the four unpublished pipeline statuses there, while `Opublikowane` remains an explicit published-only filter; add `Kopiuj skrypt` in Reel Detail, composing the current visible script with the explicitly selected hook before it.
- **Exact model:** `gpt-6-luna`, high reasoning (Luna 6). It implemented the relevant list/controller UI and selected-hook presentation, so this is a suitable bounded follow-up.
- **Difficulty:** medium. The list risk is consistency across initial selection, pagination and refreshed rows; the copy risk is current hook/script drafts, Reel switching and truthful clipboard fallback.
- **Dependencies:** current root T00 and `tasks.md`; integrated Opus UI-02/PUBLICATION-02 v3, persistent `selectedHookId`, current inline hook edits, script autosave and the established publication-copy clipboard pattern. Root pins the exact integrated commit before agent start. No provider, VPS or production data access is needed.
- **Workspace:** a separate Luna worktree from the approved current root baseline; do not edit the old `codex/ux-publication-02` checkout or Opus's review checkout.

Proposed Luna editable files only:

- `apps/web/src/controllers/useAppController.ts` for the initial Status choice and any necessary list refresh behavior.
- `apps/web/src/app/App.tsx` for the Rolki list membership rule.
- `apps/web/src/screens/ReelDetailScreen.tsx` and `ReelDetailScreen.module.css` for the compact script-copy control, feedback and manual fallback.
- `apps/web/src/ui/screen-contracts.ts` only for the new Detail props needed to pass current Reel identity/copy intent.
- An optional small pure composition helper in `apps/web/src/data/script-copy.ts` and adjacent focused tests in `apps/web/src/data/tests/` or `apps/web/src/controllers/tests/` for these two behaviors.
- A new `docs/implementation/UI-04-result.md` for the implementation handoff.

Root owns T00, this preparation, `tasks.md`, integration and review. No edits to `StatusSelector`, shared contracts, API/worker, schema, planner, publication-copy code, package manifests or lockfiles are assigned. If an implementation needs a wider file allowlist, Luna proposes it to root before editing.

## Behavior to preserve

1. Keep the visible Polish option labels `Wszystkie`, `Pomysły`, `Do nagrania`, `Montaż`, `Gotowe` and `Opublikowane`. `Wszystkie` is a view filter, not a Reel status. Do not add or rename statuses.
2. On a fresh app session, Rolki selects `Wszystkie`, including after reload. The choice is an existing in-memory browsing filter; do not introduce persistence or reset a user's filter merely because they navigate to Detail, Plan or back.
3. `Wszystkie` displays all four pipeline statuses and no published rows. Mixed-status rows retain their existing status labels and search. `Opublikowane` displays the published history through its existing option. Explicit single-status filters remain exact.
4. Preserve full pagination before applying the pipeline exclusion. A first server page consisting of published Reels must not hide pipeline Reels on later pages or incorrectly show an empty list. Do not change the server's unfiltered `GET /reels` meaning.
5. A status move into `published` removes the row from `Wszystkie` after the existing refresh/sync path; moving it back makes it eligible again. Keep the current Detail identity, draft handling, quick actions, undo, capture return and selected filter behavior intact. Deleted Reels remain in their separate view.
6. The Plan view keeps its own existing membership rules; do not alter scheduling or publication flows.

## SCRIPT-COPY-01 behavior

1. Place one secondary `Kopiuj skrypt` button by the `Skrypt` heading, with a 44px touch target and clean 320/360px reflow. It remains usable when AI is unavailable and on a read-only published Reel. Do not turn it into the Detail primary action.
2. The copied value is `selected hook text + "\n\n" + current script` when both are nonempty. Copy the current editable script, including unsaved text. If the selected hook is being edited inline, use its current visible edit text; do not save it or silently substitute the prior saved text. Preserve internal whitespace/newlines. No metadata, title, hashtags or unselected hooks are included.
3. With no valid selected hook or an empty selected-hook text, copy only the script. Do not infer the first/only hook or change `selectedHookId`. With no meaningful script, keep the action unavailable and do not claim success.
4. Copy only from an explicit click. Success feedback follows clipboard resolution; unavailable/rejected clipboard access produces a Polish failure message and selectable copy-ready text. A delayed result must not show the prior Reel's text/feedback under a newly opened Reel.
5. No persistence, status, hook, AI or network mutation occurs. Preserve publication copy and its separate description/hashtags behavior.

## Focused acceptance and handoff

- Verify initial `Wszystkie` selection and a mixed synthetic set spanning all five statuses: four pipeline statuses appear, published does not. Then choose `Opublikowane` and confirm only published appears; check at least one other explicit status filter.
- Verify that pagination reaches pipeline items after a published-only page and that the current list refresh does not reintroduce a newly published row into `Wszystkie`.
- Verify copy cases: selected hook plus script with exact two-newline separator; no selected hook; selected-hook inline edit; script unsaved edit; empty script; clipboard success/failure/unavailable; Reel switch while a clipboard result is pending. Check that the control is visible beside Skrypt at 320/360px and works with AI unavailable/read-only published state.
- Run web typecheck and a small focused test or synthetic browser check for the changed list/copy boundaries. Avoid broad publication, provider, API or worker suites.
- Report changed files, exact commands and results, any unverified UI gate, limitations and commit ID. Stop at a clean bounded handoff; do not merge or deploy.

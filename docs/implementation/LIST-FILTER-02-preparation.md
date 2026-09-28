# LIST-FILTER-02 — prepare Luna's pipeline-default correction

Status: product correction requested by the operator on 2026-09-28; prepared for Luna, **not dispatched**. No implementation, merge or deployment is authorized by this document.

## Task and assignment for approval

- **Task ID:** LIST-FILTER-02.
- **Exact task:** Make `Wszystkie` the initial Rolki Status choice. In `Wszystkie`, show `idea`, `to_record`, `editing` and `ready` Reels, excluding `published`; keep `Opublikowane` as an explicit filter that shows published Reels. Preserve the other four exact filters.
- **Exact model:** `gpt-6-luna`, high reasoning. It recently implemented the relevant list/controller UI, so this is a suitable bounded follow-up.
- **Difficulty:** low. The risk is consistency between initial selection, paginated data, refreshed list data and rendered rows after a status transition.
- **Dependencies:** current root T00 and `tasks.md`; current `master` at preparation (`5f9b709`, with Opus's UI-02/PUBLICATION-02 v3 fixes integrated); existing `StatusSelector`, `listEveryActiveReel`, list quick actions, search and the planner. Before implementation, root confirms the then-current integration baseline. No provider, VPS or production data access is needed.
- **Workspace:** a separate Luna worktree based on the approved current root baseline; do not work in the old `codex/ux-publication-02` checkout or Opus's review checkout. No worktree is created by this preparation.

Proposed Luna editable files only:

- `apps/web/src/controllers/useAppController.ts` for the initial Status choice and any necessary list refresh behavior.
- `apps/web/src/app/App.tsx` for the Rolki list membership rule.
- One adjacent focused test file in `apps/web/src/controllers/tests/` or `apps/web/src/data/tests/` if needed to verify the behavior; keep it about this filter only.
- A new `docs/implementation/LIST-FILTER-02-result.md` for the implementation handoff.

Root owns T00, this preparation, `tasks.md`, integration and review. No edits to `StatusSelector`, shared contracts, API/worker, schema, planner, package manifests or lockfiles are assigned. If an implementation needs a wider file allowlist, Luna proposes it to root before editing.

## Behavior to preserve

1. Keep the visible Polish option labels `Wszystkie`, `Pomysły`, `Do nagrania`, `Montaż`, `Gotowe` and `Opublikowane`. `Wszystkie` is a view filter, not a Reel status. Do not add or rename statuses.
2. On a fresh app session, Rolki selects `Wszystkie`, including after reload. The choice is an existing in-memory browsing filter; do not introduce persistence or reset a user's filter merely because they navigate to Detail, Plan or back.
3. `Wszystkie` displays all four pipeline statuses and no published rows. Mixed-status rows retain their existing status labels and search. `Opublikowane` displays the published history through its existing option. Explicit single-status filters remain exact.
4. Preserve full pagination before applying the pipeline exclusion. A first server page consisting of published Reels must not hide pipeline Reels on later pages or incorrectly show an empty list. Do not change the server's unfiltered `GET /reels` meaning.
5. A status move into `published` removes the row from `Wszystkie` after the existing refresh/sync path; moving it back makes it eligible again. Keep the current Detail identity, draft handling, quick actions, undo, capture return and selected filter behavior intact. Deleted Reels remain in their separate view.
6. The Plan view keeps its own existing membership rules; do not alter scheduling or publication flows.

## Focused acceptance and handoff

- Verify initial `Wszystkie` selection and a mixed synthetic set spanning all five statuses: four pipeline statuses appear, published does not. Then choose `Opublikowane` and confirm only published appears; check at least one other explicit status filter.
- Verify that pagination reaches pipeline items after a published-only page and that the current list refresh does not reintroduce a newly published row into `Wszystkie`.
- Run web typecheck and a small list-specific test or synthetic browser check for those boundaries. Avoid broad publication, provider, API or worker suites.
- Report changed files, exact commands and results, any unverified UI gate, limitations and commit ID. Stop at a clean bounded handoff; do not merge or deploy.

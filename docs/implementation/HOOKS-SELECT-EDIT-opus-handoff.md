# HOOKS-SELECT-EDIT — Opus implementation and DEV release

Date: 2026-09-23. The user explicitly authorized Claude/Opus to implement, test, merge to master and deploy this bounded hook correction to DEV. The T00 amendment is the current product contract and overrides its older no-selection sentence. The full original request is attached in the user conversation as `Pasted text.txt`; this handoff pins the integration decisions needed to execute it.

## Dispatch

| Required item | Decision |
| --- | --- |
| Task ID | HOOKS-SELECT-EDIT |
| Exact task | Persist one optional selected `ReelHook` ID per Reel; select via full row, edit inline, clear on selected-hook delete; integrate selected context only where current script work needs it; test, merge, and deploy to DEV. |
| Exact model | Claude Opus 5.5 (`claude-opus-5-5`), manual Claude Code session. No fallback or nested agents. |
| Suitability | One implementer can coordinate the wire type, PostgreSQL constraint, versioned API, UI interaction and narrow AI context change. |
| Difficulty | Medium. The main risks are cross-Reel references, races with deletion/edit, unsaved inline text, and changing fact-check coverage accidentally. |
| Dependencies | Current master plus T00 and frozen visual spec. At preparation, master was `454e83e`; PUBLICATION-01 is merged and latest recorded DEV image is `d82cefc`. Confirm live source before rollout. Read `PUBLICATION-01-result.md` and the latest deployment result. |
| Editable files | The allowlist below, in a fresh separate `codex/hooks-select-edit` worktree; preserve unrelated root dirty/untracked files. |
| Acceptance | All original user scenarios, the focused checks and deployment evidence below. Implementation, merge and DEV rollout are already authorized; proceed without asking again. |

## Contract and implementation boundary

- `Reel.selectedHookId: Id | null`; database `app.reels.selected_hook_id uuid null` with null default. Keep the shortlist in `app.reel_hooks`; selected text always comes from the referenced row. Historical Reels stay null, including Reels with hooks. Do not backfill a first hook. Enforce the same-Reel reference on the server and preferably at the database level; do not permit a stale/cross-Reel/deleted hook ID to become selected. Document the chosen FK/transaction strategy and test delete races. Never rewrite an applied migration.
- Add one explicit selection mutation to the existing `/api/v1` surface with `operationId`, `expectedVersion`, the existing idempotency semantics, and an authoritative Reel response. A null selection may be permitted for explicit clearing; selected-hook deletion must clear atomically under the same Reel versioned transaction. No per-hook `Użyj` action. Keep source/provenance unchanged when selecting or editing.
- Hook edits reuse the existing `PATCH /reels/:id/hooks/:hookId` path; no duplicate endpoint or delete/recreate. An editor with a dirty draft must keep it on conflict/offline failure, even after a later Reel refresh. A successful edit retains ID, `source`, `createdAt`, ordering and selection.
- `HOOKI` in Reel Detail: the ordinary row is a generous pointer/touch and keyboard target. Show subtle selected styling plus the visible `✓ WYBRANY` label. A user-authored row shows `WŁASNY` independent of selection, so both labels may appear. Inline edit uses a small `✎` or similarly compact control and `Gotowe`/cancel behavior; the existing `×` deletes. Separate controls must not trigger row selection. Do not use purple text highlighting as state. Respect the established mobile density and no large buttons/new screen.
- `+ Wygeneruj więcej` and initial/generated hooks append candidates without auto-selection. Do not alter the generation response shape, append-once semantics or publication generation. Existing Opracuj script proposal remains explicit `Zastosuj`.
- Inspect actual script-development input. Where it needs a single current hook, resolve `selectedHookId` against the snapshotted shortlist and pass that hook as the selected/current context. The full shortlist remains available. Fact Check still covers script plus **all** active hooks; additive hook generation still sees all hooks. Other AI actions, prompts, source/corpus logic and provider settings stay unchanged. If no selected hook, keep valid no-selection behavior rather than guessing one. Older run snapshots/results must remain readable without migration.
- Preserve version conflicts, idempotent replay and deleted-Reel guards. A selection should not mutate script or `scriptRevision`; hook edit/delete still affects coverage and freshness as already contracted. No broad new workflow state or analytics.

## Allowlist

- One new ordered migration in `database/migrations/`, plus `deploy/vps/postgres/grants.sql` only if the new column/route requires a grant change. Re-run the migration/grant jobs in their established order.
- `packages/contracts/src/index.ts` for the selected ID and typed selection request/response.
- `apps/api/src/core/{repository,routes}.ts`, their focused test files, and directly necessary mapper/error code only.
- `apps/web/src/screens/ReelDetailScreen.tsx` and its CSS module, `apps/web/src/ui/screen-contracts.ts`, `apps/web/src/app/App.tsx`, `apps/web/src/controllers/useAppController.ts`, `apps/web/src/data/api.ts`, and focused adjacent tests/fixtures. Touch `AiWorkspace.tsx` only if required to display or preserve the same selected state; keep `+ Wygeneruj więcej` behavior.
- `apps/api/src/ai/service.ts`, `apps/worker/src/ai/actions.ts` and their focused tests only if inspection shows a genuine current-hook input seam. No unrelated Gemini refactor.
- `docs/implementation/HOOKS-SELECT-EDIT-result.md` and a short tasks/T00 clarification if implementation uncovers a concrete contract gap. The root has already pinned the approved amendment in T00/AGENTS.

Do not change root dependencies/lockfiles, existing migrations, corpus, publication generation, Task Tracker, Caddy, DNS or production hostname. If an extra file is essential, state its specific boundary reason in the result.

## Focused acceptance

1. Select any one of several hooks; exactly one selected ID persists on GET/list/detail and reload. Switching selects a different existing ID. A Reel with zero/many hooks and null selection stays valid.
2. Invalid, deleted and cross-Reel IDs cannot be selected. Concurrent select/delete and stale versions do not leave a dangling selection. Same-operation replay returns the original result; reused ID with another payload fails as before.
3. User provenance is independent of selection. Selected own hook renders `WŁASNY` and `✓ WYBRANY`. Editing selected or unselected rows preserves hook ID/provenance/position and selection. Conflicts keep the inline draft and expose a truthful Polish error.
4. Unselected deletion keeps the selected ID; selected deletion clears it without choosing another. Initial capture and AI append never select automatically.
5. Row selection works for pointer/touch and keyboard; edit/delete controls do not select. Selected state is explicit and persists independently of browser text selection or hover.
6. Only the selected ID is treated as the current hook in downstream script context where that concept exists. Fact Check still includes all hooks; `generate_hooks` still appends and leaves selection alone. Existing no-selected-hook Reels do not crash or silently choose a candidate.
7. Run focused API/UI/worker tests for touched boundaries plus one integrated build/typecheck. Do not repeat unrelated Gemini/provider, corpus, Android, publication or broad review suites. Record exact commands/results and mark browser or provider checks as UNVERIFIED when unavailable.

## Merge and DEV rollout

Commit the implementation on the separate branch, review its final diff for scope, then merge it to master. This user's explicit merge instruction applies to this task. Do not absorb unrelated untracked root content. Record implementation and merge SHAs; deploy the merge revision.

Target only `https://dev.szronox.zieloni.tech`, `/opt/szronox-dev`, project `szronox-dev`, port `127.0.0.1:3011`. Use existing SSH key/agent for `ubuntu@51.195.103.79`, host-owned configuration and `/opt/szronox-dev/config/dc-gemini.sh` / `Dockerfile.deploy`. Preserve secret ownership, network/role separation, existing Caddy config and all other services. Inspect current release, pending AI work and host override before changing it. Keep prior image/source and a verified pre-migration backup. Build candidate, apply additive migration as schema owner, apply grants if needed, roll API and worker to the same release, and verify `/api/v1/ready`, privilege enforcement, the hook mutation path and unchanged neighbour health. No production/root hostname rollout or production kDrive edits.

Rollback must account for the new nullable column and any newly stored selected IDs. Prefer an additive schema compatible with the previous code. Retain previous source/image/config and document how to revert code without overwriting later user activity. Do not restore the database dump as a routine code rollback.

Return changed files, acceptance results, exact commands, actual model, implementation/merge/deploy SHAs and image identity, backup/rollback location, live versus simulated evidence, remaining limitations and any manual browser gate. Classify as BLOCKER, CORRECTION NEEDED, OPEN REAL-WORLD GATE or ACCEPTED / NO FURTHER TESTING NOW.

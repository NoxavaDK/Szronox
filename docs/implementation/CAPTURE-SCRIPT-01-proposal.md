# CAPTURE-SCRIPT-01 — enter a ready script in Quick Add

Date: 2026-09-24. User-requested product correction, grounded in T00's direct-script amendment. No agent dispatched or DEV deployment authorized by this proposal.

| Item | Proposal |
| --- | --- |
| Task ID | CAPTURE-SCRIPT-01 |
| Exact task | Add a compact `Pomysł` / `Gotowy skrypt` choice to Quick Add's main text field. A saved script choice creates one Reel with exact `originalInput.text` and editable `script` atomically, including queued/offline retries. |
| Exact model | `gpt-5.6-sol`, high reasoning, one bounded coding agent in a new `codex/capture-script-01` worktree. No fallback or nested agents. |
| Suitability | The change crosses an existing typed request, one database transaction, IndexedDB draft/queue replay and a small UI control; Sol can implement against the root-pinned contract without redesigning capture. |
| Difficulty | Medium. Main risks: losing a long pasted script, splitting create and script PATCH, queued operation reinterpretation, and changing legacy idea semantics. |
| Dependencies | Integrated master at dispatch; T00 direct-script amendment; frozen Quick Add visual language; existing PWA draft/queue and API idempotency contracts. No provider, corpus or kDrive dependency. |
| Editable files | `apps/web/src/screens/QuickAddScreen.tsx` and its CSS module; `apps/web/src/ui/screen-contracts.ts`; `apps/web/src/app/App.tsx`; `apps/web/src/controllers/useAppController.ts`; `apps/web/src/drafts/store.ts` and directly affected queue/recovery code/tests under `apps/web/src/data/**`, `apps/web/src/drafts/**`; `apps/api/src/core/repository.ts`, `apps/api/src/core/routes.ts`, `apps/api/src/core.test.ts`; focused Quick Add test/fixture files; `docs/implementation/CAPTURE-SCRIPT-01-result.md`. Root owns shared contract type changes before dispatch. No migration, root dependency or lockfile changes expected. |
| Acceptance | Exact scenarios below plus focused build/typecheck, API and web checks. Agent hands off a scoped commit; root reviews/integrates. DEV deployment requires separate explicit authorization. |

## Boundaries and acceptance

- Default `Pomysł` behavior and labels remain. The compact choice appears with the TEKST field and never rewrites its value on toggle. A new captured script is shown under `Skrypt` immediately after save/reload. Keep `originalInput.text` intact; do not use mutable `inputNote` as the script store.
- The API accepts `initialScript` only when it exactly matches nonempty `input.text`; reject mismatch/blank atomically. Create script and original input in the same transaction and idempotency result. Initial `scriptRevision` remains 0, as for all new Reels. Existing clients that omit `initialScript` continue unchanged.
- Persist the choice in the account-scoped capture draft; include the exact `initialScript` in the queued create payload. A crash, offline retry or account switch must not lose or reinterpret it. Keep mixed image/URL/text descriptors as they were. An unsupported input still fails explicitly.
- `ZAPISZ` creates the authored script without AI. `✦ Opracuj` may enqueue after successful create, but any generated script is only a proposal requiring `Zastosuj`; publication generation reads the saved script. Do not change Gemini prompts or publication behavior.
- Test default idea capture, direct script capture/reload, toggle both ways without lost text, same-operation replay, mismatched/blank script rejection, queue recovery, and no automatic replacement by Opracuj. Record exact commands and limits. No unrelated browser/provider/device acceptance rerun.

The user has approved the product need and suggested a toggle. The next step under AGENTS.md is explicit approval of this eight-part task/model dispatch before starting the coding agent. No feature work or deployment is inferred from this proposal alone.

# UX-PUBLICATION-02 — Opus verification handoff

Status: implementation complete; manual Opus verification next, then Astra final UI review. No merge or deployment is authorized. This document records the Luna handoff and root diff review; it does not claim browser or provider acceptance.

## Exact review target

- Branch: `codex/ux-publication-02`.
- Worktree: `/Users/kubabilski/Desktop/SzroNox/.worktrees/ux-publication-02`.
- Implementation commit: `3425bc90b33e259dc107decd12c63b5284b7d08b`.
- Baseline: `4cb253e` (includes Opus's CONTENT-PLANNER-01 publication-slot implementation and the root UX/PUBLICATION-02 pins).
- Diff: `git diff 4cb253e..3425bc9`.
- Implementer: `gpt-6-luna`, high reasoning; root reviewed scope, contracts and the changed interfaces.
- Requested next reviewer: manual Opus, as directed by the operator. Do not substitute another model or start nested agents.

Read `AGENTS.md`, `docs/implementation/T00-contracts.md`, `docs/implementation/UX-PUBLICATION-02-dispatch.md`, `design/frozen-visual-spec.md` and `design/frozen-reel-detail-language-spec.md`. The dispatch is the approved bounded correction to the frozen language. Preserve the current `plannedPublicationSlot` wire contract and `planOf(...).slot`; free publication time is retired.

Review the diff and recorded evidence first. Run a small number of targeted checks for concrete concerns. Do not repeat the entire build, API/worker suites or accepted CONTENT-PLANNER-01 acceptance for independent confirmation. Do not edit implementation code, merge, deploy, provision, change credentials, or make live provider calls under this handoff. Record findings for the root; a review report may be written to `docs/implementation/UX-PUBLICATION-02-opus-review.md`.

## Implemented scope

- Mobile Detail remains one continuous editorial surface with contextual action, reordered sections, per-Reel first-entry defaults and session overrides, selected hook plus folded alternatives, smaller empty script, first export, publication summary/access, generation prerequisites and cover-control focus.
- Successful capture opens the created Reel while retaining the prior browsing filter. Queued/offline capture and recoverable attachment states retain their existing behavior.
- Rolki has a compact Status filter, `Wszystkie`, title/derived-label search, mixed-status labels and uncapped all-status pagination with repeated-cursor failure handling.
- Desktop defaults to Rolki/Plan beside the selected Reel. Three panes and focus are explicit device preferences per user; intermediate widths use a drawer. Search and selector views remain mounted to preserve browsing context.
- Scalar draft switching waits for durable retention, including typing while the next Reel loads. A failed write retains the current Reel. Older saves cannot delete newer drafts or mark them saved. Conflicts are scoped to their Reel; the local conflict choice uses the newest retained/pending text and pauses the affected debounce. Current-Reel unfinished hook edits block publication generation.
- PUBLICATION-02 snapshots version 2, saved script/revision, selected hook framing and eligible saved textual sources. It preserves legacy script-only runs, per-field explicit apply/collision/replay and scoped freshness. No source fetching, OCR, programme evidence or live provider use was added.

## Owned implementation files

- `apps/api/src/ai/service.ts`, `apps/api/src/ai/service.test.ts`.
- `apps/worker/src/ai/actions.ts`, `apps/worker/src/ai/actions.test.ts`.
- `apps/web/src/app/App.tsx`, `apps/web/src/app/App.css`.
- `apps/web/src/controllers/useAppController.ts`, `apps/web/src/controllers/draft-switch.ts`, `apps/web/src/controllers/tests/draft-switch.test.mjs`.
- `apps/web/src/data/errors.ts`.
- `apps/web/src/screens/PublicationSection.tsx`, `PublicationSection.module.css`, `ReelDetailScreen.tsx`, `ReelDetailScreen.module.css`, `ReelListScreen.tsx`, `ReelListScreen.module.css` (all in that directory).
- `apps/web/src/ui/StatusSelector.tsx`, `StatusSelector.module.css`, `detail-sections.tsx`, `detail-sections.module.css`, `screen-contracts.ts`, `workspace-layout.ts` (all in that directory).

No implementation migration, dependency or lockfile change. The root-owned marker pin and current planner migrations are inherited from the baseline. Luna's worktree was clean at handoff.

## Recorded verification — ACCEPTED / NO FURTHER TESTING NOW

Evidence below is from Luna. Root inspected the diff and correction wiring without rerunning those suites.

| Command | Working directory | Result |
| --- | --- | --- |
| `npm run build && npm run typecheck` | Implementation worktree | PASS: contracts, web, API and worker, before the later web-only correction and planner baseline rebase |
| `node --test dist/ai/service.test.js` | `apps/api` | PASS: 16/16, including new selected-hook identity/text/deletion and source freshness cases |
| `node --test dist/ai/actions.test.js` | `apps/worker` | PASS: 12/12, including v2 prompt inputs/exclusions and null selection |
| `npm run test:list-01` | `apps/web` | PASS: 17/17 existing list tests |
| `npm run typecheck --workspace @szronox/web` | Implementation worktree | PASS after final corrections and rebase |
| `node --experimental-strip-types --test src/controllers/tests/draft-switch.test.mjs src/data/tests/planner.test.mjs` | `apps/web` | PASS after final rebase: 16/16 (5 draft/controller, 11 planner) |
| `git diff --check HEAD^ HEAD` | Implementation worktree | PASS after final rebase |

The initial build used a temporary worktree-local `node_modules/@szronox/contracts` link to resolve the pinned worktree's generated contracts rather than the stale shared root link. The temporary link was removed. No dependency manifest or lockfile changed.

These local tests establish plumbing, input exclusion and focused draft logic. They do not establish the provider's factual grounding or editorial quality, or replace a browser interaction check.

## Focused Opus verification

Use the existing local/development fixture or an already configured test session. If the session is unavailable, record the browser check as UNVERIFIED; do not use production records or create an authentication workaround.

1. Check representative mobile, intermediate drawer, two-pane and optional three-pane widths, including enlarged text. Verify center dominance, scroll/search retention, drawer open/close and focus/keyboard access; selecting/filtering/rescheduling cannot evict the current Reel.
2. Check section defaults and per-Reel overrides, selected-hook alternatives, first export with no editor, publication prerequisite hints and the cover icon opening/scrolling/focusing without toggling completion. Confirm publication planning uses the three current slots and the existing date/overdue behavior.
3. Check capture from a non-idea filter, server-confirmed creation with pending attachments, and queued/offline capture with truthful pending state. Return retains the browsing context.
4. Check rapid Reel switching during scalar typing, a failed local draft write, typing while a request is in flight, late save/conflict responses, and switching with an unfinished hook edit. Confirm each draft/conflict stays with its Reel and explicit local conflict resolution uses the latest text. Helper tests passed; full browser composition remains open.
5. Inspect PUBLICATION-02 freshness and PUBLICATION-01 application boundaries. New runs include only the selected hook and saved `originalInput.text`, `additionalText`, ordered original-share fields named `text` (case-insensitive), and `inputNote`. Share title, URLs, images, unselected hooks and programme content are excluded as evidence. Script edit-and-revert remains stale via `scriptRevision`; hook/source-note freshness compares exact current text/identity, with no new hook/source revision system. Unrelated metadata and applying the other publication field must not stale the proposal. Legacy unmarked runs remain script-only.

## Root review classification and remaining gates

- **BLOCKER:** none identified in the final reviewed diff; this is provisional pending the targeted composition checks above.
- **CORRECTION NEEDED:** root-raised draft-switch and conflict-choice issues were corrected before handoff, as were the drawer backdrop, hook-list markup and publication summary gaps. No open correction is recorded here.
- **OPEN REAL-WORLD GATE:** authenticated browser/layout, enlarged-text and unsaved-hook-switch checks were not executed by Luna. This is the meaningful next browser boundary, not a reason to repeat unrelated local suites.
- **OPEN REAL-WORLD GATE:** provider semantic quality is UNVERIFIED. No live call ran. A credentialed provider check needs its own configured test credentials/authorization; it must verify complementary grounded copy and the short-description fallback. Do not describe fixture prompt tests as proof of naturalness or absence of invented facts.
- **ACCEPTED / NO FURTHER TESTING NOW:** local evidence above, file allowlist, unchanged dependency/migration scope and preservation of the current publication-slot planner through the rebase.

After Opus reports, the root resolves any concrete findings and gives the resulting commit to Astra for the final UI check. Integration or deployment remains a separate operator decision.

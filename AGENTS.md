# SzroNox implementation rules

- Discussion, documentation, code and identifiers are English. All application UI copy is Polish.
- The product architecture and UX are frozen except for explicitly approved corrections below. Visual authority is `design/frozen-visual-spec.md` and its `design/frozen-reel-detail-language-spec.md` delta plus T00 behavioral contracts. It supersedes historical renderer references; do not require or await PNGs/screenshots.
- The root agent is technical lead: owns shared contracts, invariants, architecture, review and integration. Delegate routine implementation to bounded coding agents.
- Current authorization: VPS-00–03 approved with amendments in docs/implementation/VPS-batch-dispatch.md. SOURCE-01 (gpt-6-luna/high) and IDEAS-PLAN (gpt-6-luna/medium) are approved for implementation per docs/implementation/SOURCE-01-IDEAS-PLAN-luna-handoff.md; root pins contracts first, then dispatches them in separate worktrees. Root owns pins/integration; VPS-01 is manual Opus only; VPS-02 uses gpt-5.6-sol/high; VPS-03 uses gpt-5.6-luna (manual Sonnet fallback only if unavailable). Separate worktrees and assigned files/migrations only. VPS-04 onward remain gated. No broad correction re-review or live VPS changes.
- Infrastructure authority: docs/implementation/VPS-00-contracts.md replaces Supabase infrastructure with VPS PostgreSQL, application-owned two-user sessions and private lightweight filesystem storage. Preserve frozen product behavior and stable user IDs. No new Supabase dependencies; no SQLite substitution. Development tools receive development credentials only. VPS-00 does not authorize deployment or feature implementation.
- Before any other start/resume/model substitution, present task ID, exact task, exact model, suitability, difficulty, dependencies, editable files and acceptance criteria; wait for explicit user approval. Never infer delegation approval from approval of architecture or available quota. Do not spawn nested agents.
- Read `docs/implementation/T00-contracts.md` and `docs/implementation/tasks.md` before work. Work only in your assigned worktree and file allowlist.
- Do not edit shared contracts, another agent's files, root dependencies or lockfiles unless assigned. Propose contract changes to the lead.
- Hooks are persistent `ReelHook` records, not a singular text-valued Reel.hook field. The user-approved HOOKS-SELECT-EDIT correction in T00 adds one nullable selectedHookId reference; selection is explicit and never inferred. Requested AI hook generation appends alternatives and never changes selection or replaces existing hooks. No per-hook `Użyj` action, hook analytics or complex versioning.
- One Reel capture may combine multiple supported images and URL/text, preserving exact original shared fields without silent truncation. Verification requires a valid selected editor; export linking remains independent. Read the current root T00 and wire types, not older worktree snapshots.
- Opracuj may suggest at most one existing library meme. Unknown IDs are invalid. Never attach/replace memes automatically.
- Every Reel requires a separate feed cover (`Okładka do feedu`): SQL feed_cover_done defaults false, JSON feedCoverDone. Missing cover blocks transition to published only, not editing/ready. Compact Detail state and completion control in PUBLIKACJA; follow the consolidated written visual specification. KDRIVE-02 amends this: an optional kDrive cover reference may be stored, and a successful cover upload sets feedCoverDone=true in the same version-checked write; the explicit toggle may still unset it. No gallery, version list or image editor. See the authoritative root T00 amendment.
- Cover metadata uses a consistent small outline image/landscape pictogram with neutral/check state, not an OKŁ abbreviation; final artwork remains with the visual spec. Publication description and hashtags stay separate editable fields. Primary `Kopiuj opis` combines them with exactly two newlines only when both are present; copy has no persistence side effect and must handle clipboard failure truthfully. See T00.
- T16 dispatch remains unauthorized. Completed Opracowanie/Fact Check and programme surfaces are visually frozen in the consolidated written spec. Sprawdź język and the eight Reel Detail batch surfaces are frozen; publication-draft collision UI remains pending. Do not invent unfinished surfaces or infer approval to start.
- Sprawdź fakty core behavior is frozen in T00: current script plus all active hooks, claim-level evidence and exactly three factual statuses, exact source-scoped Użyj korekty with per-item stale protection. Its completed visual workspace is frozen by the consolidated written spec; no implementation dispatch.
- Programme search results and attached-proposition view are frozen in T00: consolidated written visual language, up to three indexed-evidence candidates, one explicit Przypnij attachment. Indicator opens an attachment without searching; Zmień postulat searches current content while retaining it until explicit replacement; Odłącz sets unchecked without searching. Replacement-search rejection/errors never detach. No feature dispatch is authorized.
- Programme corpus authority: `docs/product/programme-corpus-spec.md` (content model) and `docs/product/programme-corpus-operator-bundle.md` (operator input). Import, approval and activation are three separate operator acts run as the schema owner; exactly one release per corpus is active; indexed content is immutable and neither runtime role may write it. Citations resolve the archived PDF through the authenticated version-specific route, never a public URL. An unadopted draft requires a recorded admission amendment with a named approver. No corpus is imported: import, approval, activation and any deployment remain separately authorized.
- Final writing prompts, Style Profile and editorial wording are NOT frozen. Diagnostic prompts and fixtures must be clearly labeled provisional. Do not turn them into production editorial prompts.
- No application features beyond scope: no analytics, calendar, autopublishing, admin UI or new workflow states. KDRIVE-02 explicitly authorizes one bounded resumable relay uploader into a Reel's own kDrive folder for feed covers and video exports only; it is not a general file manager and provides no browsing, deleting, renaming or arbitrary destinations.
- Never print secrets. Live provider tests require configured test credentials; absent access is an explicit unverified gate, not a passing result.
- Do not provision paid resources, change real kDrive production data, deploy or send messages. Spikes may use explicitly designated disposable test resources only.
- Every handoff includes owned files, acceptance results, exact verification commands, remaining limitations and its commit ID if available. Do not merge your own branch.


# TESTING / REVIEW BUDGET POLICY

Avoid duplicate verification work.

The purpose of Astra review is to catch integration risk, not to independently reproduce every test already run by a bounded implementation agent.

## 1. TASK-LEVEL TESTING

The implementation agent owns testing its own task against the task acceptance criteria.

Before handoff it must provide:

- exact commands run;
- exact results;
- changed files;
- known limitations;
- explicit UNVERIFIED gates;
- commit ID.

Do not ask a second model to rerun the entire task suite merely for independent confirmation.

## 2. ASTRA REVIEW

For a completed task, Astra should normally:

- inspect the handoff;
- inspect the diff/architecture boundaries;
- verify that scope and contracts were respected;
- run only a SMALL number of targeted checks where there is a concrete integration or correctness risk.

Do not rerun:

- the full task test suite;
- full build/typecheck repeatedly;
- external documentation research already resolved;
- adversarial testing already performed by the implementation agent;

unless there is a specific reason.

If no concrete concern exists, accept the agent's recorded evidence provisionally and move to integration.

## 3. INTEGRATION TESTING

After several parallel tasks are integrated, test the INTEGRATED behavior rather than repeating each child task's isolated tests.

Focus on:

- interfaces between tasks;
- migration compatibility;
- shared dependencies;
- runtime composition;
- regressions caused by integration.

Do not redo isolated evidence that integration did not affect.

## 4. REAL-ENVIRONMENT GATES

Browser/device/VPS/provider checks should happen once at the milestone where they become meaningful.

Examples:

- real PostgreSQL concurrency → VPS-06
- real HTTPS/browser acceptance → VPS-07
- installed Android Share Target → dedicated Android gate
- live Gemini/provider behavior → AI/provider gate
- live kDrive → dedicated kDrive gate

Do not repeatedly attempt these gates in earlier tasks.

## 5. RE-TEST ONLY ON TRIGGER

A previously accepted area should be retested only if:

- code affecting it changed;
- integration exposes a failure;
- a dependency/version changed materially;
- a previously UNVERIFIED real-environment gate is now being executed;
- there is a concrete defect hypothesis.

"Independent confirmation" alone is not enough reason for another broad review.

## 6. MODEL BUDGET

Do not launch a separate high-reasoning reviewer for work already:

- implemented;
- acceptance-tested;
- corrected;
- handed off with evidence.

Use high-reasoning models for unresolved architecture, security-sensitive implementation, difficult integration defects or ambiguous failures.

## 7. REPORTING

For every review, classify findings as:

- BLOCKER
- CORRECTION NEEDED
- OPEN REAL-WORLD GATE
- ACCEPTED / NO FURTHER TESTING NOW

Do not turn an open real-world gate into repeated local testing.

Default behavior after a clean bounded handoff:
INTEGRATE, THEN TEST AT THE NEXT MEANINGFUL BOUNDARY.

# Standalone T03 handoff for manually selected Opus

You are the user-selected Opus implementation agent for **T03 — Gemini capability spike** in the SzroNox project. This is a bounded diagnostic task, not production feature implementation. The Codex technical lead cannot launch Opus in its current environment; you are being started manually by the user. Do not spawn or delegate to other agents.

## Worktree and preservation

Work ONLY in:

`/Users/kubabilski/Desktop/SzroNox/.worktrees/t03-gemini`

Expected branch: `agents/t03-gemini`; shared baseline commit: `2c411e5`.

First inspect `pwd`, `git status --short --untracked-files=all`, current branch and existing files. If you cannot access this exact local worktree, report that prerequisite instead of creating a replacement repository. The previous Sol agent stopped on quota and is not to be resumed. Its files are uncommitted and must be reviewed/preserved, not reset, cleaned, overwritten wholesale or discarded.

Read the worktree's `AGENTS.md`, `docs/implementation/T00-contracts.md`, `docs/implementation/tasks.md`, and `packages/contracts/src/index.ts`. Current user authorization in this prompt/AGENTS.md overrides any older task-table statement that T04 may start. You own **only `spikes/gemini/**`**. Do not edit shared contracts, root dependencies/lockfiles, other worktrees, UI, migrations or design assets. Technical lead owns contract changes and integration.

## Existing partial work to review first

- `spikes/gemini/README.md`
- `spikes/gemini/package.json`
- `spikes/gemini/src/diagnostic.mjs`
- `spikes/gemini/test/diagnostic.test.mjs`
- `spikes/gemini/fixtures/synthetic-provider-response.json`

It currently uses Node built-in fetch/test with no external dependencies, Gemini Developer API generateContent, configurable diagnostic model, separate synthetic/live modes, provider-metadata extraction, and bounded HTTP retries. These are candidate building blocks, NOT accepted capability evidence. At the last presence-only check, GEMINI_API_KEY and GOOGLE_API_KEY were absent; do not assume that remains true or that credentials exist elsewhere.

Before modifications, record which existing pieces are usable and which need correction. Preserve useful implementation. Do not implement a general SDK or multi-provider abstraction.

## Frozen project constraints

- English discussion/docs/code. Any user-facing application text is Polish; do not build application UI in this task.
- Stack: React/Vite, Fastify, PostgreSQL/Supabase, Supabase Auth/Storage, durable PostgreSQL-backed jobs. This spike is standalone and must not alter that stack.
- There are five Reel statuses; AI work is an operation, never a new status.
- Hooks are persistent ReelHook records: id, reelId, text, source user|ai, position, createdAt. No singular authoritative hook or per-hook Użyj action. Requested generation appends alternatives once; all active hooks plus script are included in fact-check scope.
- A hook-producing run does not become stale merely because its own appliedHookIds were appended; other runs still see those new hooks as changed coverage. This is a future application invariant, not a provider-side write capability.
- Opracuj may suggest at most ONE existing-library meme: { memeId, rationale, relevantFragment? } or null. IDs must be checked against supplied candidates and live library records later. Models cannot invent a meme record or silently attach/replace it. No meme analytics/vector infrastructure.
- T16 AI result UI is BLOCKED pending frozen mockups. Do not design it or infer composition from fixtures.
- Final writing prompts, Style Profile, real-script examples and editorial wording are NOT approved. Use explicitly labeled DIAGNOSTIC ONLY, neutral/synthetic prompts. Do not freeze production models or editorial templates.

## Exact task

Review and complete/correct this diagnostic spike against current official Gemini documentation and, when approved credentials/network are actually available, bounded live probes:

1. Multimodal image input: verify transport acceptance separately from meaningful image understanding. Do not treat a one-pixel image as evidence of useful screenshot interpretation.
2. URL context: test public accessible content and an unavailable/restricted URL; preserve actual retrieval status and location in the provider response. Model prose claiming retrieval is not proof.
3. Google Search grounding: capture actual search execution metadata, source references and mappings between output and sources. Identify what supporting evidence is and is not returned.
4. Structured output: parse and independently validate the response against the requested schema. Report tool+schema compatibility for the tested model/endpoint, not a blanket Gemini capability claim. A two-step diagnostic is acceptable if necessary; do not silently drop citations to obtain JSON.
5. Failure modes: authentication/permission, rate limit, transient provider errors, transport timeout/network failure, malformed successful responses, missing candidates/evidence and incomplete/blocked responses. Classify retryability explicitly and keep attempts bounded.
6. Evidence boundaries: distinguish model-produced text, source URL metadata, actual retrieved excerpts, and synthetic fixtures. A generated quotation is not a retrieved excerpt. An existing URL alone is insufficient for green confirmation.
7. Application-shaped synthetic validation: preserve hook arrays/source locations, bound generated additions, and reject unknown/out-of-candidate meme IDs. These are local contract checks, not proof that Gemini enforces foreign keys or factual accuracy.

Use primary official sources (`ai.google.dev`, official Google SDK/API docs). Record actual access dates, tested endpoint/model and compatibility limitations. Do not rely on the partial README's asserted documentation claims without checking them.

## Specific review questions already identified by the lead

These are inspection targets, not permission to expand scope:

- `extractEvidence` currently reads top-level urlContextMetadata while grounding is read from the first candidate; verify the real response nesting. Do not concatenate several candidates' text and attach only the first candidate's citations as if they corresponded.
- The structured-output probe currently records a response but does not independently validate it. Add meaningful assertions and per-probe verdicts.
- A successful HTTP status currently permits malformed/empty JSON to pass through; distinguish response receipt from capability success.
- Transport errors/timeouts are not necessarily assigned retryable classifications. Test that policy explicitly; never loop indefinitely.
- The current header-only credential test does not prove error output is redacted. Ensure provider/error text cannot leak credentials; do not print request headers or raw sensitive responses.
- The current fixed default diagnostic model does not prove combined search+structured-output support. Make any model-specific limitations explicit, with no production editorial-model decision.
- Tests that merely count probe names do not establish behaviour. Prefer injected-response tests for evidence parsing, missing evidence, schema failures, safe error reporting and bounded retries.

## Execution and safety boundaries

Check environment-variable presence without printing values. Use credentials only if explicitly configured for these tests. Do not search the user's home/keychain for keys, provision paid resources, change production data, publish/deploy, or send messages. No account reset or quota purchase. Live tests should be small and bounded; if access is missing, finish local diagnostic work and mark live acceptance UNVERIFIED/BLOCKED.

Keep raw sensitive live artifacts local in ignored `spikes/gemini/artifacts/private/`. Only redacted, provenance-labeled evidence belongs in committed artifacts. Synthetic fixtures use reserved example domains and are clearly labeled synthetic. Do not represent them as captured provider responses.

Existing entry commands (inspect before running):

`cd /Users/kubabilski/Desktop/SzroNox/.worktrees/t03-gemini/spikes/gemini`

`npm run check`

`npm run synthetic`

`npm run live` — only with configured test credentials and permitted access; never place a secret literal into a shared command/history.

## Acceptance criteria

- Existing partial files reviewed and useful work preserved; changes confined to spikes/gemini.
- Reproducible local commands complete; meaningful tests pass for parser/evidence separation, schema validation, error handling, retry bounds and redaction.
- Every capability has a separate verdict: PASS, FAIL or UNVERIFIED, with evidence classified live vs synthetic vs documentation-only.
- Live success is established from actual response metadata/validated content, not model assertions or HTTP 200 alone.
- Missing source evidence is explicit; no blanket factual correctness claim, invented source or fake foreign-key acceptance.
- Model/endpoint/tool compatibility and source-metadata limitations are documented, with a narrow adapter recommendation for the lead.
- No final writing prompt, Style Profile, editorial examples, production feature integration, AI-result UI, other agent or later task started.
- Missing credentials/device/network access is reported honestly, not hidden by synthetic success.

## Required handoff to the user and technical lead

Return:

1. What Sol's partial work contained, what you retained and what you corrected.
2. Files changed, branch and local commit ID if a commit is possible. Stage/commit only your spike directory; never merge or push.
3. Exact commands and pass/fail results.
4. Acceptance matrix including live/unverified boundaries, tested models/endpoints and important findings.
5. Code worth keeping, corrections still required and genuine blockers.
6. Narrow recommendations for future tasks, without launching them.

If committing is unavailable, preserve uncommitted files and report that state. Stop after the handoff. The technical lead will review the actual files and decide integration; no next batch starts without explicit user approval.

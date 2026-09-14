# R01 — bounded technical review of T00–T03

Status: proposal awaiting user approval. Preparing this prompt does not authorize execution.

## Delegation proposal

1. Task ID: R01.
2. Exact task: review the existing T00 contracts, T01 scaffold, T02 Android Share Target diagnostic and T03 Gemini diagnostic. Identify concrete defects, missing acceptance evidence and cross-task contract drift. Produce a report only; do not implement corrections.
3. Model/agent: the user's manually selected Opus session. Codex cannot instantiate Opus and cannot see its exact provider model identifier. Before execution, the user must select/approve the exact Opus version; record the interface-reported identifier if available, never guess it. Do not substitute another model.
4. Suitability: a substantial reasoning review across contracts, browser persistence and AI provenance, using the user's available Opus capacity. Codex technical lead independently adjudicates the findings afterward; Opus reviewing its own T03 changes is not independent acceptance.
5. Estimated difficulty: high, bounded to existing T00–T03 artifacts. No implementation or architecture expansion.
6. Dependencies: current T00 documents; T01 commits b3e39d8 and ce107c3; T02 commits 0499bff and bafffec; T03 commit cb41abd. No provider credentials required for this review.
7. Editable files: only `/Users/kubabilski/Desktop/SzroNox/.worktrees/t03-gemini/spikes/gemini/docs/R01-review.md`. Everything else is read-only. Existing documented local checks may create ignored build/test artifacts. No source, dependency, lockfile, contract or baseline changes.
8. Acceptance: cover all four scopes; findings include severity, exact file/line, reproducible trigger, consequence and minimal correction; separate observed, simulated, documentation-backed and unverified evidence; verify material Gemini claims against endpoint-specific official sources; report per-task pass/fail/unverified criteria; recommend retained code, corrections and next batch without launching it. Explain important negative findings and limitations. Do not invent findings to fill a quota.

## Standalone prompt — run only after the user approves the proposal/model

You are reviewing SzroNox as Opus. This is a report-only technical review, not permission to implement. Do not launch agents or background jobs, merge, reset, discard work, deploy, provision resources or call paid provider APIs. Do not search for credentials. Stop after the report.

Record the exact model identifier only if your interface exposes it. Otherwise state that the exact identifier is unavailable and identify the user-selected Opus label honestly.

Read the root AGENTS.md and these authoritative current root files:

- `/Users/kubabilski/Desktop/SzroNox/docs/implementation/T00-contracts.md`
- `/Users/kubabilski/Desktop/SzroNox/docs/implementation/tasks.md`
- `/Users/kubabilski/Desktop/SzroNox/packages/contracts/src/index.ts`

Inspect each isolated worktree, its AGENTS.md and existing changes without copying or merging between them:

- T01: `/Users/kubabilski/Desktop/SzroNox/.worktrees/t01-scaffold`, branch `agents/t01-scaffold`, expected latest commit `ce107c3`.
- T02: `/Users/kubabilski/Desktop/SzroNox/.worktrees/t02-android-share`, branch `agents/t02-android-share`, expected latest commit `bafffec`.
- T03: `/Users/kubabilski/Desktop/SzroNox/.worktrees/t03-gemini`, branch `agents/t03-gemini`, expected latest commit `cb41abd`.

Record actual commit IDs and dirty state. Lead-owned AGENTS.md changes are intentional. If paths are inaccessible, report the blocker instead of recreating repositories or claiming review from summaries.

Approved baseline: React/Vite, Fastify, PostgreSQL/Supabase, Supabase Auth/Storage, PostgreSQL-backed jobs, kDrive production files. Preserve the product/visual direction. Hooks are a persistent additive shortlist, without individual Use actions or complex versioning. Opracuj may suggest at most one existing candidate meme; never silently assign or replace. Final editorial prompts and Style Profile are not approved. T16 AI-result UI is blocked. T04 and later work may not start.

Review priorities:

The current root T00 includes the later required-feed-cover amendment. Check the amended contracts: feedCoverDone defaults false; no asset reference required; incomplete cover blocks transition to published but not editing/ready; atomic combined completion/publication and concurrency rules; compact Detail state with the control in PUBLIKACJA. Final cover visuals are pending. Do not count its absence from older T01–T03 snapshots as an implementation defect: those tasks predate the amendment and do not implement Reel features. Report integration implications only.

1. T00: data ownership, optimistic concurrency and draft/account isolation; transaction boundaries and idempotent application; hook freshness including a run's own appended hooks; evidence provenance and existing-meme validation. Report contradictions or missing prerequisites rather than redesigning approved decisions.
2. T01: workspace/build/type contracts, production static path and API fallback boundary, environment/secrets separation, worker shutdown, dependency/CI assumptions. Lead already ran install/build/typecheck/tests, real built-asset/API smoke and worker shutdown; production audit was clean after upgrading @fastify/static. Remote CI has not run. Review meaningful risks rather than repeating every check without cause.
3. T02: service-worker module registration, POST capture and commit-before-redirect, stable identity through raw-to-draft promotion, concurrent/repeated operations, account binding and quarantine, reopen/offline/storage failure behavior. Distinguish deterministic transaction-double tests from actual IndexedDB/browser behavior. Twelve local tests passed; desktop-browser integration and Android share-sheet behavior remain unverified. Do not claim these gates pass from code inspection. Review whether module-worker/cache assumptions need an explicit offline gate.
4. T03: inspect `docs/sol-partial-review.md`, `docs/findings.md`, `docs/acceptance-matrix.md`, README, all source and relevant tests. Challenge both inherited Sol code and your own prior Opus changes. Check candidate-scoped evidence, citation offsets/source associations, empty/blocked/malformed responses, verdict aggregation, retries/timeouts, redaction and contract guards. Determine whether tests can pass while accepting a materially invalid provider response.
5. Specifically verify T03 documentation claims using official Google API documentation: keep generateContent and Interactions endpoints distinct; resolve request/response spellings per endpoint and REST vs SDK; check model-specific combined search/schema support; distinguish model-output quotations from actually retrieved excerpts. Do not call an API shape ambiguous merely because different endpoints or SDKs have different shapes. An HTTP 400 or generic provider error must not automatically prove feature incompatibility, a wrong field name or successful inaccessible-URL handling. Establish whether the harness can distinguish these cases. Cite exact supporting URLs, access dates and uncertainties. This is verification of claims, not a mandate to implement another API surface.

You may run documented local synthetic/unit/build checks as necessary. No live Gemini requests, installations, device configuration or persistent servers for this review. Stop temporary processes you start. Record commands, outcomes and what was not run. Synthetic fixtures are never provider evidence.

Write only the allowed R01-review.md. Format:

- Reviewed revisions and environment/model identification.
- Findings, severity ordered, each with exact file/line, trigger, impact, evidence and smallest proposed correction. Separate confirmed defects from questions or future hardening.
- Acceptance matrix for T00/T01/T02/T03: passed, failed, unverified, with evidence type and source.
- Code worth retaining and corrections required before acceptance/integration.
- External/manual gates, including actual Android and credentialed Gemini verification.
- Recommended next bounded batch with dependencies; recommendation only, no dispatch.
- Commands run and limitations.

Do not commit source changes or repair your findings. Return the report path and concise results to the user. The Codex technical lead will independently reproduce material findings, resolve contract issues and prepare any correction delegation for explicit approval.

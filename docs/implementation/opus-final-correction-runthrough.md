# Opus final correction runthrough — proposal awaiting approval

1. **Task ID:** C04-RUNTHROUGH (bounded completion/review of C01–C03 only; not original task T04).
2. **Exact task:** Resolve the remaining correction findings below in their existing worktrees, rerun focused local checks, and deliver a consolidated acceptance matrix. Do not implement product features, alter frozen contracts, merge branches or start the kDrive spike.
3. **Exact model/agent:** User-launched Opus 5, `claude-opus-5` as reported by the user's Opus environment. The Codex launcher cannot instantiate it. Confirm the actual selected model in that environment; no automatic substitution. One manual agent, no nested agents.
4. **Why appropriate:** One final bounded pass can use the existing review evidence and the user's Opus capacity. Opus must not treat its own prior implementation as independently accepted; the technical lead checks the final regressions afterward.
5. **Estimated difficulty:** Medium–high, concentrated on evidence validation and shutdown-test reliability. No new architecture.
6. **Dependencies:** T01/C01 `75451f5`; T02/C02 `9767c90`; T03/C03 `bf910f2`; current root T00/contracts and lead reviews. Preserve later commits if HEAD has advanced; never reset to these revisions. Latest root programme/Fact Check amendments are read-only and outside implementation scope.
7. **Editable files:** T01 worktree: `apps/api/src/**`, `apps/web/src/contracts-check.ts`, `docs/implementation/C01-result.md`. T02: only `spikes/android-share/**`. T03: only `spikes/gemini/**`, preserving original fixtures and historical R01/partial-review records. Root documents/contracts, other worktrees' unrelated files, package/dependency files, product designs and production features are read-only. Write one scoped follow-up result in each worktree; return a consolidated summary to the user. Any additional file/scope requirement goes back to the lead.
8. **Acceptance criteria:** Address every confirmed item below with focused positive/negative regressions; report review-only items honestly; build/typecheck/tests pass where applicable; validate no unrelated edits; preserve all existing work; each task gets a separate scoped commit, left unmerged. No live Gemini requests, remote CI trigger, deployment or Android provisioning. Actual browser evidence is optional only if a local disposable browser is already available; otherwise label it unverified. Stop all temporary processes. No task outside C01–C03 starts.

## Standalone instructions, after explicit approval

Read `/Users/kubabilski/Desktop/SzroNox/AGENTS.md`, the current root `docs/implementation/T00-contracts.md`, `packages/contracts/src/index.ts`, `docs/implementation/C02-lead-review.md` and `docs/implementation/C03-lead-review.md`. The current root contract working copy includes later frozen amendments; older worktree copies are not authority. These amendments do not authorize feature implementation.

Worktrees:

- C01: `/Users/kubabilski/Desktop/SzroNox/.worktrees/t01-scaffold`
- C02: `/Users/kubabilski/Desktop/SzroNox/.worktrees/t02-android-share`
- C03: `/Users/kubabilski/Desktop/SzroNox/.worktrees/t03-gemini`

Record actual HEADs and dirty files before touching anything. Lead-owned AGENTS.md changes must remain untouched. C01's handoff attributes implementation to a user-approved Sonnet 5 substitute; C02 to user-approved Opus, not the original Sol allocation; C03 to manual Opus. Preserve accurate attribution.

## C03 — confirmed remaining corrections, highest priority

The lead reran 116 passing tests and independently reproduced these again at bf910f2. They are not hypothetical:

1. **Validate evidence relationships, not array lengths.** A candidate with one query, one source, and a support naming nonexistent partIndex=99 and groundingChunkIndices=[999] still passes both search and combined grounding. Require actual referenced sources and valid nonempty source spans. A dangling reference, missing segment, malformed index or failed segment resolution cannot count toward PASS. Keep usable evidence scoped to the selected candidate, including retrieved-excerpt reporting.
2. **Use exact URL-status semantics.** `BOGUS_SUCCESS` passes accessible retrieval; `URL_RETRIEVAL_STATUS_NEW_UNKNOWN` passes unavailable retrieval. Only exact documented success/failure enums qualify; unknown and unspecified values remain unverified and preserved verbatim. Validate status against the requested URL on the selected candidate.
3. **Reject split UTF-8 coordinates.** `resolveSegmentText` for text `ą`, bytes [1,2), returns ok=true and a replacement character. Decode/validate byte boundaries strictly and return typed failure; wire it into the grounding verdict. Keep positive multipart and Unicode cases. Do not reject a legitimate literal replacement character by output-string matching alone.
4. **Correct G3's documentation qualification.** Keep responseJsonSchema explicit. The lead could not substantiate the claim that additionalProperties is listed under responseSchema's Schema object; the cited API page lists it under JSON-schema alternatives. Supply an exact supporting subsection or qualify the claim. Neither side has observed a live invalid-request rejection, and a generic 400 proves no capability limitation.
5. **Make request provenance match the report.** The report says every result records its structured-output field, but the emitted base currently records endpoint/model only. Include field/API-version metadata where relevant, or narrow the claim. Keep exit codes and evidence labels consistent.

Do not reopen fixed behavior: original success-output redaction and body-read bounded retries passed independent regressions. Retain and rerun those checks after the changes. No new endpoint surface, model migration, editorial prompt, production adapter or programme/Fact Check UI.

## C02 — confirmed remaining corrections

1. **Root-route MIME.** `/` reads index.html but chooses MIME from `/`, returning application/octet-stream. Choose MIME from the actual served filename; assert both `/` and `/index.html` return HTML. Keep the PNG MIME/dimension checks. This predates C02 but blocks confidence in the documented browser entry point.
2. **Unusable-input contradiction.** Unknown metadata alone (`tracking_id=123`) is marked NO_SUPPORTED_INPUT by normalization but mapped to an accepted request. Use one consistent usability rule; retain unknown fields without treating tracking metadata as meaningful capture content. Cover repeated recognized fields where the first is empty and a later value is useful. No partial request or silent truncation.
3. **Live receiver state.** app.js observes registration/controller once. Refresh the dedicated state on controllerchange; do not re-register repeatedly or let form success overwrite it. Exercise acquisition/loss of control with an event-capable test double. Browser-check must wait for visible readiness rather than race the asynchronous registration callback.

Preserve storage.js's commit-before-redirect and same-key promotion behavior. Browser/Android/concurrent IndexedDB checks remain unverified unless actually run; expanded test code is not evidence of execution. No automatic skipWaiting, no production UI, no device/hosting setup.

## C01 — verification and narrowly scoped follow-ups

C01 is now at 75451f5. Its result reports 8 passing tests; the lead inspected the code but has not rerun its new socket-based suite in this pass.

1. Reproduce unknown API method envelopes, missing asset 404s, actual asset MIME, valid SPA navigation and actual shared-package consumption; run build/typecheck/tests. Do not expand the routing design without a concrete failure.
2. **Strengthen shutdown evidence.** shutdown.test.ts equates client TCP connect/write with server handler entry, which does not prove that an application request is in flight before SIGTERM. Arrange a deterministic test handshake proving handler entry, then show it drains and new work is refused while shutdown is ongoing. Current refusal test waits until process exit and therefore proves only that an exited process does not accept connections.
3. **Bound the test harness.** Register exit observation before signalling and handle an already-exited child; current waitForExit attaches later and can miss exit. Bound response/exit waits so a regression cannot hang the suite. Exercise close-error/deadline behavior through a test-only seam, not a production feature endpoint. Keep shutdown repeat-safe and clean up every child.
4. **Avoid a misleading type guard.** `contracts-check.ts` exports isErrorResponse that accepts `{error:null}` as ErrorResponse. It is currently only a consumption check, not a used production validator. Replace it with a harmless compile-time contract exercise or validate the shape truthfully; do not export an unsound runtime guard merely to force an import.
5. **Correct the CI report.** `.github/workflows/ci.yml` exists, contrary to “none exists in this repo yet.” Say CI is configured but remote execution is unverified. Do not trigger remote CI in this runthrough.

## Handoff and stop

For each task: reviewed base, changed files, exact commands, pass/fail/unverified criteria, remaining blockers and new scoped commit. In the consolidated summary distinguish implementation completed from independently accepted and real runtime evidence from doubles. Preserve approved root changes and all historical spike artifacts. Do not merge, dispatch another task, or continue automatically afterward. Return to the user for lead review.

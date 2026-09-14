# T03 independent lead review

Reviewed 2026-09-14 at `cb41abd` in `.worktrees/t03-gemini`. This is independent of the Opus author. Source was not changed. Verdict: **corrections required before diagnostic acceptance; live provider capabilities remain UNVERIFIED**.

## Evidence and retained work

`npm run check` passed all 85 tests and syntax checks. `node src/diagnostic.mjs --mode synthetic` exited 0. An initial npm invocation from the worktree root failed because the isolated package lives under `spikes/gemini`; the correctly scoped commands above passed. Additional injected-response probes below reproduced defects without network/provider calls. No credentials were inspected or used; the redaction test used a synthetic sentinel and replaced fetch in that temporary process.

Keep the zero-dependency Node harness, diagnostic-only prompts, separate synthetic/live modes, explicit credential gate, quadrant PNG, per-candidate extraction, independent local schema checks, bounded retries, additive-hook/candidate-meme checks and preservation record. Tests are useful, but some assertions explicitly encode incorrect success conditions. Their count is not capability acceptance.

All paths below are relative to the T03 worktree's `spikes/gemini/` directory.

## Confirmed findings

### G1 — false grounding and URL verdicts (high)

`src/probes.mjs:190`, `:214`, `:239`, `:297`.

Reproduced with injected responses:

| Input | Actual verdict | Required interpretation |
| --- | --- | --- |
| Combined JSON `{ "answer": "x", "citedUrls": [] }`, no provider grounding | PASS, citationsRetained=false | No proof of combined grounding; cannot pass the advertised capability |
| Unavailable-URL probe gets authentication/permission 403 | PASS | Authentication failed; URL behavior unverified |
| Combined probe gets transport timeout | Claims model/endpoint does not support combination | Transport failure gives no compatibility conclusion |
| First candidate has no grounding; second has one source and no queries | Search PASS with queries=0 and supports=0 | Do not borrow another candidate's evidence or claim executed queries |
| Only top-level URL success metadata for an unrelated URL | Accessible URL PASS | No candidate-scoped evidence for requested URL |

The tests even require PASS for combined JSON without citations. Fix predicates and tests together: candidate-local usable evidence, requested URL matching and explicit retrieval status, separate transport/auth/request/capability outcomes. Unknown status strings, unspecified statuses and errors unrelated to retrieval are not evidence of failed URL retrieval. Keep model-supplied citedUrls separate from provider references.

### G2 — successful output bypasses credential redaction (high)

`src/diagnostic.mjs:96–109`, `:156`; `src/transport.mjs:79`.

Using only fake key `SYNTHETIC_SECRET_SENTINEL` and an injected fetch returning it as model text, `JSON.stringify(await runLive())` still contained the sentinel. The success path adds `extracted` and schema/parse diagnostics directly; only error descriptions are redacted. This contradicts the documented output guarantee. Sanitize the complete emitted result, including success, malformed-text details and top-level errors; add a subprocess/output-level regression check. Do not claim an actual credential leak occurred in this review.

### G3 — endpoint documentation and request-schema justification are unreliable (medium)

`README.md` “Two documented response surfaces”; `docs/findings.md` §§2,4,5; `src/probes.mjs:270` and `:294`.

The harness sends only `models/{model}:generateContent`; the capability guides' Interactions examples call `/interactions`. Their different response shapes are not uncertainty about which response this fixed endpoint returns. The API reference explicitly lists googleSearch, urlContext and responseJsonSchema. It describes responseSchema as an OpenAPI subset; the probe places JSON Schema additionalProperties in it. Correct the schema/request pairing rather than infer a provider capability failure from an invalid request. These are documentation/contract findings, not an observed live 400. [GenerateContent reference](https://ai.google.dev/api/generate-content).

The endpoint-specific guide labels Generate Content Legacy and shows responseFormat.text.schema; it describes combined tools/schema as a Gemini 3 preview. This supports a model-specific documentation expectation, not the assertion that every arbitrary failure proves unsupported combination. README, findings and acceptance matrix must agree. [Generate Content structured output guide](https://ai.google.dev/gemini-api/docs/generate-content/structured-output).

Lead decision for the correction: retain a narrowly scoped generateContent diagnostic; make its request/response contract explicit and document current fields with exact endpoint/model provenance. Preserve the historical Interactions fixture, but do not treat it as accepted evidence for this endpoint. No production provider/model migration is approved. Do not add a second provider surface merely to hide the mismatch. No final editorial prompts.

### G4 — citation parsing loses mapping and advertised Interactions support is incorrect (medium)

`src/evidence.mjs:27–29`, `:118–120`, `:158`.

Classic extraction joins text parts with inserted newlines and drops their boundaries, while retaining untouched segment offsets. The reference defines segment partIndex and byte offsets within a part. Preserve indexed raw parts and offset units; do not use flattened text as the citation coordinate system. Include multipart/Unicode cases in correction tests. [GenerateContent Segment reference](https://ai.google.dev/api/generate-content#Segment).

Injected documented Interactions text annotation `{type:'url_citation', url, title, start_index, end_index}` produced zero sources: parser expects nested url_citation/urlCitation. The official example reads fields directly on the annotation. Correct or explicitly quarantine this unsupported parser branch; retaining an old fixture is not a reason to advertise support. [URL context examples](https://ai.google.dev/gemini-api/docs/url-context).

### G5 — blocked/truncated output can pass semantic probes (medium)

`src/evidence.mjs:217–221`; `src/probes.mjs:164`, `:279`, `:297`.

Injected SAFETY candidate containing valid diagnostic JSON passes structured_output_alone. Only transport calls incompleteCandidates, which itself accepts MAX_TOKENS. Separate “bytes accepted” from usable completed answer; semantic probes must consistently handle blocked/truncated/missing content and prompt-level blocks. The comprehension predicate also accepts a sentence denying knowledge if the colour names appear in order. Prefer a small independently checked quadrant answer shape over substring vocabulary matching. This changes diagnostic prompts only.

### G6 — response-body transport failures lose retry classification (medium)

`src/transport.mjs:173`.

Injected response.text() throwing TimeoutError becomes empty text, then terminal malformed_success, one attempt. The fetch deadline covers body consumption too; keep body-read failures within transport classification and bounded retries. Genuine invalid JSON remains distinct. Secondary classifier consistency: HTTP 408 is retryable but classified request_or_content while docs call it provider_transient; error.code can be ignored when a generic error.name exists. Add cases for the actual Node error shapes, without broadening into a production retry framework.

## Additional scope and evidence limits

- Runner returns exit 0 when results are unverified but none fail, although README describes zero as all probes passing. Synthetic parser rows are hardcoded PASS after extraction rather than compared against expected output. Define exit semantics honestly and validate fixture expectations.
- The local schema validator reports unsupported keywords separately while valid may remain true. Probe success must not imply full validation when unsupported checks remain.
- Application guards are partial synthetic checks, not a complete T00 validator: defaulting absent fields can hide missing required output; returned-hook preservation is a simulation, not a provider contract asking it to rewrite all hooks. Keep actual existing-hook persistence application-owned. No new hook selection/use flow.
- Candidate meme IDs are checked locally; a live database existence check is still a future backend responsibility, already specified by T00.
- Metadata-only source existence is not factual confirmation. Preserve evidenceKind and source association; do not manufacture retrieved quotations from generated prose or broaden the programme flow.
- No combined model gate exists in buildProbes despite the documentation wording. Record explicit diagnostic model and endpoint for each result, with capability unverified until observed. Two-step fallback is only a proposal here; no two-step probe was implemented.

## Acceptance

| Criterion | Lead result |
| --- | --- |
| Preserve Sol work, isolate spike, avoid editorial/UI changes | PASS by inspection |
| Existing unit/synthetic checks | PASS: 85 tests, synthetic exit 0; limited scope |
| Trustworthy capability verdicts | FAIL: G1/G5 |
| Complete output redaction | FAIL: G2 simulated reproduction |
| Endpoint-specific request/docs consistency | Corrections required: G3 |
| Evidence mapping | PARTIAL: candidate separation retained, G1/G4 remain |
| Failure taxonomy/retry handling | PARTIAL: useful bounds, G1/G6 remain |
| Live image/URL/search/schema/provider behavior | UNVERIFIED; no live calls in this review |

## Reproduction notes

From `spikes/gemini`, import buildProbes, extractEvidence, generateContent and runLive into a temporary Node --input-type=module process. Invoke probe.verdict against the table's minimal payloads; for G2 inject global fetch returning a candidate with the fake sentinel and set only the temporary process's fake GEMINI_API_KEY; restore both in finally. For G6 inject fetchImpl returning `{ok:true,status:200,text:async()=>{throw new DOMException('timeout','TimeoutError')}}`. No source edits or real service requests are needed. The observed results are recorded above.

All web sources accessed 2026-09-14. Live support remains distinct from documentation evidence. Correction work requires a separate approved delegation; all existing spike artifacts remain preserved.

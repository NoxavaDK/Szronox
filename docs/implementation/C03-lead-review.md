# C03 lead review at bf910f2

Verdict: **retain the corrections; not yet accepted as complete**. Three reproducible evidence-validation defects remain within G1/G4. No implementation or agent dispatch occurred during this review. No live provider request was made.

## Verified

- Current T03 HEAD is bf910f2, on fb1e25a; only the pre-existing lead-owned AGENTS.md change is dirty.
- npm run check: **116/116 PASS**. npm run synthetic: exit 0 (8 fixture checks).
- Explicitly credential-free subprocess: live mode exits 2 with BLOCKED; no network request is possible through that gate.
- Independently reran original counterexamples: combined JSON without grounding fails; unavailable-URL 403 and combined transport timeout are unverified; unrelated top-level URL metadata is unverified; SAFETY JSON does not pass semantic checks.
- Injected body-read TimeoutError now retries three times and retains transport_timeout.
- Injected success-path fake key is redacted from runLive results. No real credential was tested or exposed.
- git diff fb1e25a bf910f2 confirms R01-review.md, sol-partial-review.md and all seven original fixtures are byte-identical. All source changes are under spikes/gemini. No resets or merges.

## Remaining corrections

### C03-R1 — dangling supports still prove grounding (high)

Locations: T03 `spikes/gemini/src/probes.mjs:370` and `:453`.

Both search and combined probes count supports.length without validating the source/segment relationship. Reproduced candidate: STOP with usable answer; one query; one source at chunk index 0; one support pointing to partIndex=99 and groundingChunkIndices=[999]. Both probes return PASS. Neither the referenced source nor the cited part exists. This is still false evidence acceptance, not merely an optional stricter parser.

Required: count only validated mappings to actual source indices and resolvable nonempty candidate spans. Validate malformed indices, missing segments and coordinate failures explicitly. Invalid mappings must not support PASS even when all three arrays are nonempty. Preserve valid multipart/non-ASCII positives. Keep retrieved-excerpt reporting candidate-scoped too: the current hasRetrievedExcerpt(extracted) helper can still describe a sibling candidate's excerpt in the selected candidate's result.

### C03-R2 — unknown URL statuses can still pass (medium)

Location: T03 `spikes/gemini/src/evidence.mjs:122–132`.

Reproduced on a usable candidate matching the requested URL:

- `URL_RETRIEVAL_STATUS_NEW_UNKNOWN` passes unavailable-URL handling as a reported failure.
- `BOGUS_SUCCESS` passes accessible-URL retrieval despite statusRecognised=false.

Prefix/suffix recognition is not enum validation. Use exact known statuses; preserve unknown strings but leave capability unverified. The reference lists UNSPECIFIED, SUCCESS, ERROR, PAYWALL and UNSAFE. UNSPECIFIED is not a reported retrieval failure. [Google UrlRetrievalStatus reference](https://ai.google.dev/api/generate-content#UrlRetrievalStatus), accessed 2026-09-14.

### C03-R3 — split UTF-8 coordinates return corrupted success (medium)

Location: T03 `spikes/gemini/src/evidence.mjs:187`.

Reproduced resolveSegmentText on part text `ą`, startIndex=1, endIndex=2: `{ok:true,text:'�',partIndex:0}`. The numerical byte range fits, but splits a multibyte character. Buffer.toString substitutes a replacement character. This violates the typed-failure guarantee for invalid citation coordinates.

Required: validate character boundaries or decode the selected bytes strictly; return a typed invalid-UTF8/coordinate failure. Wire this outcome into C03-R1 rather than leaving a correct helper unused by verdicts. Do not reject a legitimate literal replacement character solely by scanning output text.

## G3 documentation nuance

I agree that no live rejection was demonstrated and that a 400 alone never proves missing capability. My original review explicitly classified the request-shape concern as documentation/contract evidence, not an observed provider 400.

However, I cannot confirm the new claim that the cited reference lists additionalProperties under responseSchema's Schema object. The inspected Schema JSON representation omits it; the page lists it under the JSON Schema alternative and function parametersJsonSchema. The assertion in endpoint.mjs:38 and C03-corrections.md therefore needs an exact supporting subsection or qualification, not repetition as established fact. The current choice of responseJsonSchema is coherent and should remain explicit. [GenerateContent reference](https://ai.google.dev/api/generate-content#Schema), accessed 2026-09-14.

Small reporting correction: C03 says the actual structured-output field is recorded on every result, but runLive's result base records only endpoint/model. Either emit the field/API version per result (or once in the containing artifact) or narrow that documentation statement. No provider/model migration is requested.

## Acceptance status

| Area | Status |
| --- | --- |
| Preservation and bounded scope | PASS |
| Existing checks, fixture expectations and credential-free gate | PASS |
| Original successful-output redaction regression | PASS |
| Body-read retry regression | PASS |
| Blocked/truncated semantic output and endpoint quarantine | Improved; tested blocked cases no longer pass |
| Grounding and URL verdict integrity | NOT COMPLETE: R1/R2 |
| Citation coordinate integrity | NOT COMPLETE: R3 |
| Documentation consistency | Small corrections above |
| Actual Gemini capabilities | UNVERIFIED, unchanged |

Use these exact synthetic cases for a bounded follow-up in the existing T03 worktree. Do not discard prior tests/artifacts, add a new provider surface, write production prompts/UI, or make live calls. Any further agent execution still requires explicit user approval; this report does not dispatch it.

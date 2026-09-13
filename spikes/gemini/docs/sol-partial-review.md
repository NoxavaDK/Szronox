# Review of the pre-existing partial spike (Sol, uncommitted)

Recorded before modification. Files inspected at baseline `2c411e5` on branch `agents/t03-gemini`:
`README.md`, `package.json`, `src/diagnostic.mjs`, `test/diagnostic.test.mjs`,
`fixtures/synthetic-provider-response.json`.

Nothing was reset, cleaned or discarded. Every item below marked RETAINED survives in the
corrected spike, moved into a module but behaviourally unchanged unless noted.

## Retained

| Piece | Where it lives now | Why it was kept |
| --- | --- | --- |
| Zero-dependency Node built-in `fetch` + `node:test` harness | unchanged, whole spike | Correct for a standalone spike; avoids root dependency/lockfile edits this task may not make |
| Separate `synthetic` / `live` modes with a hard credential gate | `src/diagnostic.mjs` | Correct shape for an unverified-live gate; absent credentials must not read as success |
| Configurable diagnostic model via `GEMINI_DIAGNOSTIC_MODEL` | `src/probes.mjs` | Keeps the spike from freezing a production editorial model |
| `classifyHttpError` retry policy (408/429/5xx retryable; 400/403 terminal) | `src/transport.mjs` | Matches documented guidance: "Only retry on transient errors (like 429, 408, or 5xx). Do not retry on client errors (like 400 or 403)" |
| `withBoundedRetry` with injectable `sleep` and `maxAttempts` | `src/transport.mjs` | Bounded, testable, never unbounded; injectable clock makes retry bounds assertable |
| `origin: model_output` vs `origin: provider_metadata` labelling | `src/evidence.mjs` | The central correct idea of the spike; extended rather than replaced |
| `DIAGNOSTIC ONLY` neutral prompts, no editorial wording | `src/probes.mjs` | Complies with the T00 Correction 4 prompt gate |
| Reserved `.invalid` domain in synthetic fixtures | `fixtures/` | Keeps synthetic data unmistakably synthetic |
| API key sent only via `x-goog-api-key`, never in URL or body | `src/transport.mjs` | Correct; now additionally enforced on the output path |

## Corrected

| # | Defect | Evidence | Correction |
| --- | --- | --- | --- |
| 1 | `extractEvidence` read `response.urlContextMetadata` at **top level** | Documented as candidate-level: `candidates[0].urlContextMetadata` | Read per candidate |
| 2 | The synthetic fixture encoded that same top-level shape, so no test could ever catch defect 1 | `fixtures/synthetic-provider-response.json` | Fixture **kept as-is** and relabelled as the regression case: a test asserts the top-level block is reported as `topLevelUrlRetrieval` and never merged into a candidate. A correctly-shaped `url-context-candidate-scoped.json` was added alongside it |
| 3 | All candidates' text concatenated, but only `candidates[0].groundingMetadata` attached — citations could be reported against text they do not support | `src/diagnostic.mjs` lines 54-61 | Evidence extracted strictly per candidate; no cross-candidate join |
| 4 | Structured-output probe recorded a response but never validated it | `probes[4]`, `runLive` | Independent schema validator + per-probe verdict |
| 5 | HTTP 200 with malformed/empty JSON passed as success (`.json().catch(() => ({}))`) | `generateContent` | Response receipt and capability success are now distinct outcomes |
| 6 | Transport timeout/network errors carried no `retryable` flag, so `withBoundedRetry` silently treated them as terminal and they surfaced as `category: "local"` | `AbortSignal.timeout` throws a `TimeoutError` with no `.retryable` | Explicit transport classification with tested retryability |
| 7 | The redaction test only asserted the key sits in a request header — it never proved error text or results are clean | `test/diagnostic.test.mjs` line 34 | Real redaction applied to every emitted string, with a test feeding a key-bearing provider error |
| 8 | Fixed default `gemini-2.5-flash` cannot support the combined search + structured-output case at all | Combining the two is documented as a **Gemini 3 preview** feature; on earlier models it is rejected | Combined probe is model-gated and reports per-model compatibility, never a blanket Gemini claim |
| 9 | `covers required diagnostic capability probes` asserted probe **names** only — no behaviour | `test/diagnostic.test.mjs` line 45 | Replaced with injected-response behavioural tests |
| 10 | One-pixel PNG treated as the multimodal probe | `ONE_PIXEL_PNG` | Split: transport acceptance vs. image understanding, the latter with a checkable ground truth |
| 11 | Request used `generationConfig.responseJsonSchema`, asserted as "documented for generateContent" | Not confirmed on that reference page, which names `responseSchema`; the capability guides show `response_format` instead | Switched to `responseMimeType` + `responseSchema`. The ambiguity is recorded in `findings.md` §5: a 400 on this probe means "wrong field name", not "no structured-output support" |
| 12 | No application-shaped synthetic validation at all (hook preservation, bounded additions, meme-ID rejection) | absent | Added in `src/contract-checks.mjs` |
| 13 | README asserted documentation conclusions that do not hold | see `README.md` findings | Rewritten against re-checked primary sources with access dates |
| 14 | No ignore rule for raw live artifacts | absent | `.gitignore` for `artifacts/private/` |

## Not adopted

- `usageMetadata` at response top level was **correct** in Sol's parser and is unchanged.
- No general SDK, multi-provider abstraction or production adapter was introduced; out of scope.

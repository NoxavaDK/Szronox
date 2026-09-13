# T03 findings — documentation review

All primary sources accessed **2026-09-13** via `ai.google.dev`. No live provider
call was possible (no credential configured), so everything below is
**documentation-only** evidence unless a live run later confirms it. Community
forum reports are labelled as such and are not treated as primary.

---

## 1. The partial spike's central parsing bug is real

`urlContextMetadata` is documented at **candidate level**, not at response top
level:

```json
{ "candidates": [ { "content": {...},
    "url_context_metadata": { "url_metadata": [
      { "retrieved_url": "https://example.com",
        "url_retrieval_status": "URL_RETRIEVAL_STATUS_SUCCESS" } ] } } ] }
```

The partial parser read `response.urlContextMetadata`. Against a real response it
would have found nothing and reported "no retrieval metadata" for every URL probe
— which, combined with fluent model prose, is exactly the failure this spike
exists to prevent. The retained fixture `synthetic-provider-response.json`
encoded the same wrong shape, so no test could have caught it. It is kept as the
regression case; the parser now reports it as `topLevelUrlRetrieval`.

## 2. `generateContent` is now labelled Legacy

Current documentation splits into two surfaces:

| Surface | Docs path | Response shape |
| --- | --- | --- |
| Interactions API (current) | `/gemini-api/docs/url-context`, `/google-search` | step-based: `google_search_call`, `url_context_result`, `model_output` with inline `url_citation` annotations |
| generateContent (Legacy) | `/gemini-api/docs/generate-content/...` | `candidates[].groundingMetadata`, `candidates[].urlContextMetadata` |

The partial README claimed the `groundingMetadata` shape was "documented for
`generateContent`" without noting that the capability guides now lead with the
step-based shape. Both are live in the docs today. Because no call could be made,
the parser handles **both** and reports which it saw as `shape`, rather than
betting on one.

**For the lead:** the endpoint choice is a real decision, not a detail. The spike
keeps `generateContent` because a durable, non-interactive worker job maps to it
cleanly, but this should be re-confirmed before T12/T13 build on it.

## 3. Google Search grounding returns no quotable text — this constrains T00

`groundingChunks[].web` carries `uri` and `title`. The documentation shows **no
text content** in chunks. `groundingSupports` maps output spans
(`startIndex`/`endIndex`) to chunk indices, so claim→source attribution is
available, but the source body is not.

Consequences for `packages/contracts/src/index.ts`:

- `SourceEvidence.evidenceKind` will be `'tool_metadata_only'` for essentially
  every search-grounded source. `'retrieved_excerpt'` is **not reachable**
  through this tool. The enum is correct and needs no change — but an adapter
  must not populate `evidenceText` from model prose to make results look richer.
- `SourceEvidence.url` would receive a **provider redirect URI**
  (`vertexaisearch.cloud.google.com/grounding-api-redirect/...`), not a publisher
  URL. Storing it as `url` stores a redirect that may expire. The parser flags
  this as `uriIsProviderRedirect`. The lead should decide whether the contract
  wants the redirect, a resolved URL, or both.
- T00's rule "Model-generated quotations are not automatically excerpts. Missing
  evidence downgrades to uncertain" is therefore the **normal** path for
  fact-check, not an edge case.

URL context has the same property: it reports a retrieved URL and a status, not
the retrieved body.

## 4. Search + structured output is model-gated, and the default model fails it

> "Gemini 3 lets you combine Structured Outputs with built-in tools, including
> Grounding with Google Search, URL Context, Code Execution, File Search, and
> Function Calling." — structured-output docs, flagged as a **preview** feature
> for Gemini 3 series models.

On earlier models the combination is rejected. Reported errors include
*"Unable to submit request because controlled generation is not supported with
google_search tool"* and *"Search Grounding can't be used with JSON/YAML/XML
mode"* (forum reports, not primary docs).

The partial spike defaulted to `gemini-2.5-flash` and had a single combined
expectation, so it could only ever have produced a misleading blanket result.
The combined case is now its own probe, and a rejection is recorded as a
**compatibility answer for that model**, never as "Gemini cannot do this".

There is also a forum report that on Gemini 3, grounding metadata can come back
**empty** when structured output is enabled — i.e. citations silently dropped to
obtain JSON. Unverified, but it is precisely the outcome T00 forbids, so the
combined probe checks `citationsRetained` explicitly rather than accepting valid
JSON as success.

**Two-step fallback** (ground first, structure second) is the documented
workaround and remains available. It costs a second call and must not drop
citations between steps.

## 5. Structured-output field naming is genuinely ambiguous

Across current pages the REST examples show `generationConfig.responseFormat`
with nested `{ text: { mimeType, schema } }`, while SDK examples use
`responseMimeType` + `responseJsonSchema`, and the generateContent reference
names `responseSchema`. The partial spike used `responseJsonSchema` and asserted
it was "documented for `generateContent`"; that is not confirmed on the reference
page.

The probe now sends `responseMimeType` + `responseSchema` (the field named on the
generateContent reference). **Which spelling the endpoint accepts is an open
question that only a live call can settle** — a 400 `INVALID_ARGUMENT` on this
probe means "wrong field name", not "no structured output support", and the live
runner should be re-run with the alternative spelling before concluding anything.

## 6. URL context limits worth recording

- Max 20 URLs per request; max 34 MB per URL.
- URLs must be publicly accessible: **no localhost, private networks or tunnels.**
- Unsupported: paywalled content, YouTube, Google Workspace files, video/audio.
- Supported: HTML/JSON/plain text, PNG/JPEG/BMP/WebP, PDF.
- Documented status values: `URL_RETRIEVAL_STATUS_SUCCESS`,
  `URL_RETRIEVAL_STATUS_UNSAFE`, plus an error status. The full enum is not
  exhaustively documented, so the parser preserves whatever string arrives rather
  than mapping to a closed set.
- `urlContextMetadata` can be returned as an **empty object** when the tool was
  registered but never invoked — so "tool enabled" is not "retrieval attempted".
- URL context + Google Search: supported together. URL context + function
  calling: explicitly unsupported.

Because private networks are refused, the unavailable-URL probe uses a reserved
`.invalid` hostname rather than the partial spike's `http://127.0.0.1:9/private`,
which tested a documented rejection rather than a retrieval failure.

## 7. Error taxonomy and retry policy

| HTTP | Status | Retry? |
| --- | --- | --- |
| 400 | `INVALID_ARGUMENT` / `FAILED_PRECONDITION` | No |
| 403 | `PERMISSION_DENIED` | No |
| 404 | `NOT_FOUND` | No |
| 429 | `RESOURCE_EXHAUSTED` | Yes, with backoff |
| 500 | `INTERNAL` | Yes |
| 503 | `UNAVAILABLE` | Yes |
| 504 | `DEADLINE_EXCEEDED` | Yes (raise client deadline) |

> "Only retry on transient errors (like 429, 408, or 5xx). Do not retry on client
> errors (like 400 or 403)."

The partial spike's HTTP classifier already matched this and was kept. What was
missing is that **transport** failures carried no classification at all: an
`AbortSignal.timeout` rejection has no `retryable` property, so every timeout was
treated as terminal by accident. That is now an explicit, tested decision.

Blocked-generation reasons to handle: `SAFETY`, `RECITATION`,
`PROHIBITED_CONTENT`, `SPII`, `BLOCKLIST`, plus `promptFeedback.blockReason`. A
blocked response is HTTP 200 and must never read as success.

## Sources

- https://ai.google.dev/api/generate-content
- https://ai.google.dev/gemini-api/docs/url-context
- https://ai.google.dev/gemini-api/docs/generate-content/url-context
- https://ai.google.dev/gemini-api/docs/google-search
- https://ai.google.dev/gemini-api/docs/generate-content/google-search
- https://ai.google.dev/gemini-api/docs/structured-output
- https://ai.google.dev/gemini-api/docs/generate-content/structured-output
- https://ai.google.dev/gemini-api/docs/api-errors
- https://ai.google.dev/gemini-api/docs/troubleshooting

Forum/issue reports, explicitly secondary: `discuss.ai.google.dev` threads on
grounding with response schemas and on empty grounding metadata under structured
output; `googleapis/python-genai` issue 665.

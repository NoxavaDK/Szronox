# T03 acceptance matrix

Verdict per capability, with the evidence class that backs it.

**Evidence classes**

| Class | Meaning |
| --- | --- |
| `live` | An actual provider response was received and inspected. |
| `synthetic` | An authored fixture. Proves this repository's parsing/validation. Proves nothing about Gemini. |
| `documentation` | Read from official docs on 2026-09-13. Not execution evidence. |

**Live status: BLOCKED.** No `GEMINI_API_KEY` or `GOOGLE_API_KEY` was configured
in this environment (checked by presence only; no value was read, and no search
of the home directory or keychain was performed). Network egress to
`generativelanguage.googleapis.com` works — an unauthenticated request returns
HTTP 403, as expected without a key — so the blocker is credentials alone, not
connectivity. Every provider capability below is therefore **UNVERIFIED**.

---

## Status after C03 (2026-09-14)

> Updated for the independent review findings G1–G6. See
> [`C03-corrections.md`](C03-corrections.md). **No live call has been made**, so every
> provider capability is still UNVERIFIED — but several rows that previously *could* have
> reported a false PASS no longer can.

## Capability verdicts

| # | Capability | Verdict | Evidence | Basis |
| --- | --- | --- | --- | --- |
| 1a | Multimodal image input — transport acceptance | UNVERIFIED | — | Probe ready. Passes on any returned candidate, including a blocked one: byte acceptance is its only claim |
| 1b | Multimodal image understanding | UNVERIFIED | — | Probe now requires a checkable quadrant answer. Prose naming the colours is `unverified`, not a pass (G5) |
| 2a | URL context — retrievable page | UNVERIFIED | documentation | Requires candidate-scoped `*_SUCCESS` for the **requested** URL. Top-level or other-URL metadata cannot pass it (G1) |
| 2b | URL context — unavailable/restricted URL | UNVERIFIED | documentation | Requires a **positively reported** failure. Unspecified/unrecognised statuses and call-level errors are `unverified` (G1) |
| 3 | Google Search grounding — execution metadata and source mapping | UNVERIFIED | documentation | Requires queries, sources and supports on the one answering candidate; evidence is never borrowed across candidates (G1) |
| 4a | Structured output alone | UNVERIFIED | documentation | JSON Schema sent in `responseJsonSchema`; field recorded per result. Unsupported schema keywords downgrade a pass to `unverified` (G3) |
| 4b | Structured output combined with Google Search | UNVERIFIED | documentation | Requires valid JSON **and** provider grounding on the same candidate. Model-written `citedUrls` never count (G1). Documented as a Gemini 3 preview; recorded as `modelExpectation`, not asserted |
| 5 | Failure modes — classification and retry bounds | **PASS** | synthetic | Injected-response tests; no credential required. Now includes body-read failures and 408 (G6) |
| 6 | Evidence boundaries — model text vs metadata vs excerpt | **PASS** (local), UNVERIFIED (live) | synthetic + documentation | Citation coordinates resolve per part in UTF-8 bytes (G4); Interactions shape quarantined |
| 7 | Application-shaped validation — hooks, bounded additions, meme IDs | **PASS** | synthetic | Local T00 contract enforcement. Partial by design: not a complete T00 validator, and not evidence Gemini respects any of it |
| 8 | Complete output redaction | **PASS** | synthetic | Success path, malformed-body diagnostics and top-level errors all redacted; regression tests use a synthetic sentinel (G2) |
| 9 | Endpoint/request contract explicit | **PASS** | documentation | One pinned endpoint in `src/endpoint.mjs`, with provenance and the request fields actually sent (G3) |

### Verdict rules now enforced

- **No error produces a PASS or a capability conclusion.** Authentication, quota, transport
  and rejected-request failures resolve to `unverified` with `capabilityConclusion: "none"`.
- **No blocked or truncated candidate is judged semantically.** `MAX_TOKENS` is a
  truncation, not an answer; a `promptFeedback.blockReason` blocks every semantic probe.
- **Evidence is candidate-local and URL-matched.**
- **Model-produced text is never provider evidence**, including `citedUrls` it writes.

## Failure modes (row 5, detail)

Each is asserted with an injected response or error — no credential required, so
these verdicts are real rather than deferred.

| Failure mode | Classification | Retryable | Verdict |
| --- | --- | --- | --- |
| Authentication / permission (401, 403) | `authentication_or_permission` | No | PASS |
| Rate limit / quota (429) | `quota_or_rate_limit` | Yes, bounded | PASS |
| Provider transient (500, 502, 503, 504) | `provider_transient` | Yes, bounded | PASS |
| Request or content error (400, 404) | `request_or_content` | No | PASS |
| Transport timeout | `transport_timeout` | Yes, bounded | PASS |
| Transport network reset/refused | `transport_network` | Yes, bounded | PASS |
| Unrecognised transport failure | `transport_unknown` | **No** — never loop on an unnamed error | PASS |
| HTTP 200 with unparseable body | `malformed_success` | No | PASS |
| HTTP 200 with empty body | `malformed_success` | No | PASS |
| Missing candidates | reported as `unrecognised` shape, zero candidates | n/a | PASS |
| Blocked / incomplete generation | `incompleteCandidates`, `promptFeedback.blockReason` | n/a | PASS |
| Credential leakage into error text | redacted, header keys omitted | n/a | PASS |

Retry bound: **3 attempts**, exponential backoff, retried only for errors explicitly marked
retryable. Asserted directly — the unbounded case fails the suite.

C03 additions to this table: a **body-read** failure (`response.text()` rejecting) is now a
retryable `transport_timeout`/`transport_network` with `phase: "body_read"` rather than a
terminal malformed body; **HTTP 408** is `provider_transient`, not `request_or_content`; an
**empty 200 body** is its own `EMPTY_SUCCESS_BODY`; and a meaningful `error.code` is no
longer masked by a generic `error.name` (G6).

## What a green run here does and does not mean

`npm run check` and `npm run synthetic` passing means: the parser separates
provenance correctly, the validator rejects non-conforming output, errors are
classified and bounded, credentials do not leak, and the application guards
reject bad model output.

It does **not** mean any Gemini capability works. No provider response has been
observed. In particular there is no evidence that Gemini retrieves URLs,
executes searches, returns citations, honours a schema, preserves hooks, respects
a meme ID, or states anything true.

## Known evidence limits

These hold regardless of what a live run shows, and they are the constraints the adapter
must be built around.

- **Grounding chunks are references, not quotations.** A chunk supplies a URI and a title.
  Unless the provider includes text, the source is `tool_metadata_only` and nothing in it
  can be quoted to a user. `SourceEvidence.evidenceKind` already encodes this; the adapter
  must set it from what was actually returned, never optimistically.
- **Grounding URIs may be provider redirects.** URIs under
  `vertexaisearch.cloud.google.com` are redirect links, not publisher URLs. Storing one as
  `SourceEvidence.url` stores a redirect that may expire. Flagged as `uriIsProviderRedirect`.
- **A URL existing is not evidence.** A reachable link says nothing about whether it
  supports the claim attached to it. No probe treats URL presence as confirmation.
- **Nothing here tests factual accuracy.** The spike cannot and does not assert that a
  grounded answer is true.
- **Nothing here tests foreign keys.** The meme-ID check proves our validator rejects an
  unknown ID. Gemini cannot enforce that a library record exists.

## Two-step fallback, only if a live run requires it

If the target model rejects search combined with a response schema: step 1 runs the
grounded request and keeps `groundingChunks`/`groundingSupports`; step 2 structures step
1's text with no tools attached. Citations from step 1 must be carried through by the
caller.

**Dropping citations to obtain clean JSON is not an acceptable resolution** — it produces
exactly the unsupported-but-tidy output this spike exists to make visible.

## To close the live gates

```sh
cd spikes/gemini
mkdir -p artifacts/private
GEMINI_API_KEY=... npm run live > artifacts/private/live-$(date -u +%Y%m%dT%H%M%SZ).json
```

Supply the key through the environment, not as a literal in a shared command.
Exit codes: `0` every probe passed, `1` at least one failed, `2` blocked before any request,
`3` no failures but at least one capability unverified, `4` usage error. A run that reaches
no failures but leaves capabilities open exits `3`, not `0`. Then update rows 1–4 with the observed result, note the model and
endpoint used, and file a redacted summary in `artifacts/`.

Re-run 4a with the alternative field spelling before concluding anything about
structured output, and run 4b against a Gemini 3 model before concluding anything
about the combination.

# T03 Gemini capability spike

An isolated diagnostic harness, not production AI integration. Every prompt is neutral and
marked `DIAGNOSTIC ONLY`. It defines no SzroNox writing prompt, Style Profile, editorial
decision, model choice or UI behaviour, and proposes no shared-contract change.

**Status: live acceptance BLOCKED.** No API key was configured in this environment, so no
provider capability has been verified. Network egress to the provider host works (an
unauthenticated request returns 403 as expected), so the blocker is credentials alone.

| Document | Contents |
| --- | --- |
| [`docs/acceptance-matrix.md`](docs/acceptance-matrix.md) | Per-capability verdicts, failure-mode results, how to close the live gates |
| [`docs/findings.md`](docs/findings.md) | Documentation review with access dates, sources and T00 implications |
| [`docs/sol-partial-review.md`](docs/sol-partial-review.md) | What the earlier partial work contained, what was kept and what was corrected |

## What this spike can and cannot tell you

It can tell you what *our* code does with a provider response: how it separates evidence
from prose, validates a schema, classifies a failure, and bounds a retry. All of that is
unit-tested.

It cannot tell you what Gemini does. That requires a live run. Until then every provider
row in the capability matrix reads `UNVERIFIED`, and a green `npm run synthetic` is not
evidence to the contrary — synthetic mode parses files this repository wrote.

## Run

Node.js 20+. No install step, no dependencies.

```sh
cd spikes/gemini
npm run check       # syntax check + 85 unit tests
npm run synthetic   # parse fixtures; every result labelled synthetic_fixture
npm run live        # requires a configured key; exits 2 (BLOCKED) without one
```

`npm run live` reads `GEMINI_API_KEY` or `GOOGLE_API_KEY` from the environment. Configure
it in your shell session or a local env file — **never inline it into a command**, which
would place the secret in shell history. Exit codes: `0` all probes passed, `1` at least
one probe failed, `2` live mode was blocked before any request.

Redirect live output to `artifacts/private/` (gitignored). It may contain external page
content and provider error text.

## Two documented response surfaces

This is the most important finding for whoever writes the adapter, and it contradicts the
earlier draft of this file.

As read on **2026-09-13**, the capability guides and the API reference document *different
shapes*, and `generateContent` is **not** marked deprecated:

| Concern | `generateContent` reference | Capability guides |
| --- | --- | --- |
| Output container | `candidates[]` with `finishReason`, `content` | `steps[]`: `google_search_call`, `google_search_result`, `url_context_result`, `model_output` |
| Citations | `groundingMetadata.groundingChunks` / `groundingSupports` | inline `url_citation` annotations with `start_index`/`end_index` |
| Search tool | — | `google_search` ("Older models use `google_search_retrieval`") |
| JSON output | `responseMimeType` + `responseSchema` | `response_format: { type, mime_type, schema }` |

The earlier draft asserted camel-case `googleSearch` and `responseJsonSchema` as
"documented for generateContent". Neither is confirmed on that reference page.
`responseJsonSchema` has been replaced with `responseSchema` here.

Which shape the target model and endpoint actually return is **unresolved without a live
call**. The parser therefore handles both and reports which it saw, as
`shape: generate_content_candidates | interactions_steps | unrecognised`, so the first
live run settles it immediately instead of failing obscurely.

Sources, all read 2026-09-13:
[generateContent reference](https://ai.google.dev/api/generate-content) ·
[URL context](https://ai.google.dev/gemini-api/docs/url-context) ·
[Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search) ·
[Structured output](https://ai.google.dev/gemini-api/docs/structured-output)

## Probes

Each probe owns its verdict, and a verdict is never "we received a response".

| Probe | Passes only when |
| --- | --- |
| `multimodal_transport` | A candidate comes back and is not blocked. Claims transport acceptance and explicitly nothing about understanding. |
| `multimodal_comprehension` | The model names all four quadrant colours of a generated PNG **in the correct order**. A one-pixel image cannot separate "accepted bytes" from "read the picture", so it is not used. |
| `url_context_accessible` | The provider reports a `*_SUCCESS` retrieval status. No metadata ⇒ `unverified`, never pass — fluent prose is not retrieval. |
| `url_context_unavailable` | The provider reports a non-success status, or errors. A reported success for a `.invalid` host is a **fail**. |
| `search_grounding` | Executed queries **and** source references are present. Reports separately whether any source carries a quotable excerpt. |
| `structured_output_alone` | The text parses as JSON **and** satisfies the requested schema, re-validated locally. |
| `structured_output_with_search` | Both are accepted together and citations survive. Documented as **Preview, Gemini 3 series only** ("Preview: This feature is available only to Gemini 3 series models"), so the default diagnostic model `gemini-2.5-flash` is expected to reject it. A rejection is recorded as a compatibility answer for that model, not a diagnostic failure. |

Combining Google Search with structured output is documented as a **Gemini 3 preview**
feature; earlier models — including the `gemini-2.5-flash` default — reject it. So a `fail`
here against the default model is expected and says nothing about Gemini generally. The
documented two-step fallback (ground first, structure second) remains available and must
not drop citations between the steps. There is also an unverified report that grounding
metadata can return empty when structured output is enabled, which is why this probe checks
`citationsRetained` rather than accepting valid JSON as success.

## Evidence boundaries

Four things are kept apart, and tests enforce the separation:

- `model_output` — text the model wrote. Never evidence.
- `tool_metadata` — a URL or title the tooling reported.
- `retrieved_excerpt` — text the provider says it actually fetched.
- `synthetic_fixture` — authored here. Evidence about parsing only.

A generated quotation is not a retrieved excerpt. An existing URL is not confirmation.
Grounding chunks usually carry no text, so their sources are `tool_metadata_only` — which
is what `SourceEvidence.evidenceKind` in the T00 contract already anticipates. Grounding
URIs under `vertexaisearch.cloud.google.com` are provider redirects, not publisher URLs,
and are flagged `uriIsProviderRedirect`.

## Failure handling

| Category | Retryable | Source |
| --- | --- | --- |
| `authentication_or_permission` (401/403) | no | HTTP status |
| `request_or_content` (4xx other) | no | HTTP status |
| `quota_or_rate_limit` (429) | yes | HTTP status |
| `provider_transient` (5xx, 408) | yes | HTTP status |
| `transport_timeout` | yes | `AbortSignal.timeout` |
| `transport_network` | yes | named socket/DNS errors |
| `transport_unknown` | **no** | anything unnamed stays terminal rather than looping |
| `malformed_success` | no | HTTP 200 whose body is not valid JSON |

Retries are bounded (default 3 attempts, exponential backoff) and only ever applied to
errors explicitly marked retryable. `malformed_success` exists because a 200 with an
unreadable body previously became `{}` and flowed on as an empty success.

Credentials travel only in the `x-goog-api-key` header — never the URL, body, or a log.
Provider error text is redacted before it reaches any message or artifact, because
providers echo request context back; header-shaped fields are dropped whole rather than
masked. Tests cover the echoed-key case specifically.

## Synthetic fixtures

All use RFC 2606 reserved domains (`.invalid`) and carry `_synthetic` and `_purpose`
markers. They are **not** captured provider responses.

| Fixture | Exercises |
| --- | --- |
| `synthetic-provider-response.json` | Baseline grounding; retrieval metadata at the response top level. |
| `url-context-candidate-scoped.json` | Retrieval metadata nested in the candidate, one success and one error. |
| `multi-candidate-classic.json` | Two candidates where only the second is grounded. |
| `interactions-steps.json` | The step-based shape with an inline `url_citation`. |
| `blocked-response.json` | `finishReason: SAFETY` with no content. |
| `application-valid.json` / `application-invalid.json` | Application guards, satisfied and deliberately violated. |

## T00 compatibility notes

A future adapter must validate provider output against application-owned contracts; the
provider schema is transport evidence only. Locally checked here, against
`packages/contracts/src/index.ts` as read 2026-09-13:

- All input hooks survive unchanged — ids, text, `source` and `position`. Generation
  appends; it never rewrites or reorders.
- At most **three** hook additions per successful call (T00-contracts.md line 28), and a
  new hook must be attributed `source: "ai"`.
- At most one meme suggestion, whose `memeId` must be among the supplied
  `memeCandidateIds`. An id outside that set is an invented reference and is rejected.
- Fact-check claims must locate to `{ field: 'script' }` or a supplied `hookId`, and a
  `confirmed` claim with no cited source is rejected.

These prove our validation, not Gemini's behaviour. Gemini cannot enforce a foreign key
and cannot establish that a claim is true.

## Not in scope

No production adapter, SDK wrapper or multi-provider abstraction. No editorial prompt,
Style Profile or real-script example. No AI-result UI (T16 is blocked pending mockups). No
model selection: `GEMINI_DIAGNOSTIC_MODEL` defaults to `gemini-2.5-flash` **for this
diagnostic only** and freezes nothing.

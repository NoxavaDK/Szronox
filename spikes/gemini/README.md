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
| [`docs/C03-corrections.md`](docs/C03-corrections.md) | **Current.** Corrections applied for independent-review findings G1–G6, with what each verdict used to claim |

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
npm run check       # syntax check + 116 unit tests
npm run synthetic   # parse fixtures; every result labelled synthetic_fixture
npm run live        # requires a configured key; exits 2 (BLOCKED) without one
```

`npm run live` reads `GEMINI_API_KEY` or `GOOGLE_API_KEY` from the environment. Configure
it in your shell session or a local env file — **never inline it into a command**, which
would place the secret in shell history. Exit codes: `0` every probe passed, `1` at least one
probe failed, `2` live mode was blocked before any request, `3` no failures but at least one
capability is UNVERIFIED, `4` usage error. C03 correction: a run with unverified results no
longer exits `0`.

Redirect live output to `artifacts/private/` (gitignored). It may contain external page
content and provider error text.

## One endpoint, pinned

> **Corrected by C03 (2026-09-14).** An earlier version of this section was headed "Two
> documented response surfaces" and treated the difference between the Interactions guides
> and the generateContent reference as uncertainty about what *this* endpoint returns. That
> was wrong: they are two different endpoints. The earlier wording is preserved in the git
> history and the reasoning is recorded in [`docs/C03-corrections.md`](docs/C03-corrections.md) §G3.

This harness calls exactly one endpoint:

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
```

`src/endpoint.mjs` pins that contract — request fields, response shape and provenance — in
one place. Responses are `candidates[]` with `content.parts`, `groundingMetadata` and
candidate-scoped `urlContextMetadata`.

The Interactions endpoint (`/interactions`) returns a `steps[]` shape with inline
`url_citation` annotations. This harness does not call it. A `steps[]` payload is
**quarantined**: recorded as `shape: "quarantined_unsupported_shape"`, yielding no
candidates and contributing no evidence. The historical fixture is kept for provenance, not
as accepted evidence.

JSON Schema documents are sent in `generationConfig.responseJsonSchema`, and the field used
is recorded on every result. `responseSchema` (an OpenAPI 3.0 subset) is documented in
`endpoint.mjs` for contrast but is not used here. A rejected request is never read as a
missing provider capability — the request may be wrong on our side.

Sources, read 2026-09-14:
[generateContent reference](https://ai.google.dev/api/generate-content) ·
[Generate Content structured output](https://ai.google.dev/gemini-api/docs/generate-content/structured-output) ·
[URL context](https://ai.google.dev/gemini-api/docs/url-context) ·
[Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search)

## Probes

Each probe owns its verdict, and a verdict is never "we received a response".

| Probe | Passes only when |
| --- | --- |
| `multimodal_transport` | A candidate comes back. Claims byte acceptance and nothing else — a blocked candidate still demonstrates it. |
| `multimodal_comprehension` | The model returns a checkable `{topLeft,topRight,bottomLeft,bottomRight}` answer matching the generated image. Prose mentioning the colours is `unverified`, not a pass. |
| `url_context_accessible` | Provider metadata **on the answering candidate** reports a `*_SUCCESS` status **for the URL the probe requested**. Top-level or other-URL metadata does not count. |
| `url_context_unavailable` | The provider **positively reports** a retrieval failure for the requested URL. An unspecified or unrecognised status is `unverified`. |
| `search_grounding` | Executed queries, source references **and** span mappings are present on the one answering candidate. Evidence is never borrowed from a sibling. |
| `structured_output_alone` | A usable candidate's text parses **and** satisfies every checked constraint. Unsupported schema keywords downgrade it to `unverified`. |
| `structured_output_with_search` | JSON validates **and** the same candidate carries provider queries, sources and supports. Model-written `citedUrls` are never evidence. |

**No error ever produces a PASS, and no error produces a capability conclusion.**
Authentication, quota, transport and rejected-request failures all resolve to `unverified`
with `capabilityConclusion: "none"`. A blocked or truncated candidate is never judged
semantically. Both rules are C03 corrections; see
[`docs/C03-corrections.md`](docs/C03-corrections.md) §G1 and §G5.

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

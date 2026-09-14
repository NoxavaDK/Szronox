# C03 — corrections to the T03 Gemini diagnostic

Applied 2026-09-14 on branch `agents/t03-gemini`, on top of `fb1e25a` (which sits on
`cb41abd`). The worktree was **not** reset to `cb41abd`; all prior artifacts are preserved.

Input: `docs/implementation/T03-independent-review.md` (independent lead review, findings
G1–G6) and the C03 delegation. This file is the correction record. It does not replace the
earlier documents, and it does not pretend the earlier conclusions were never made —
`docs/R01-review.md`, `docs/sol-partial-review.md` and every original fixture are retained
as historical evidence.

**No live Gemini call was made in this batch.** Every provider capability remains
UNVERIFIED. Nothing here is a production adapter, model decision, editorial prompt or UI.

---

## What was wrong, and what it is now

### G1 — false grounding and URL verdicts (high)

The review reproduced five verdicts that asserted more than the evidence supported. The
root cause was a single missing rule, now made explicit in `src/probes.mjs`:

> **No error ever produces a PASS, and no error produces a capability conclusion.**

An authentication refusal, a quota refusal, a transport timeout and a rejected request all
say the same thing about the capability under test: nothing. They resolve to `unverified`
through one `errorVerdict` helper, so the rule cannot be forgotten in one probe.

| Reproduced input | Was | Now |
| --- | --- | --- |
| Combined JSON `{"answer":"x","citedUrls":[]}`, no provider grounding | PASS, `citationsRetained:false` | **fail** — model-written `citedUrls` are `model_output`, never provider evidence |
| Unavailable-URL probe receives a 403 | PASS | **unverified** — "the capability was never exercised" |
| Combined probe receives a transport timeout | "Model/endpoint does not support this combination" | **unverified**, `capabilityConclusion: "none"` |
| Candidate 0 ungrounded, candidate 1 has a source and no queries | search PASS with `queries=0, supports=0` | **fail** — every figure is read from the one answering candidate |
| Top-level retrieval success for an **unrelated** URL | accessible-URL PASS | **unverified** — retrieval must be candidate-scoped and match the requested URL |

Two further rules were added while fixing these:

- A retrieval failure must be **positively reported**. `..._UNSPECIFIED` and unrecognised
  status strings are neither success nor a demonstrated failure, so they yield `unverified`.
  Previously any non-SUCCESS string counted as a reported failure.
- Even an HTTP 400 is not incompatibility. The request may be wrong on our side — see G3 —
  so a rejection is recorded with its code and left unverified.

### G2 — successful output bypassed credential redaction (high)

Reproduced: with a fake key and an injected fetch returning it as model text,
`JSON.stringify(await runLive())` still contained the sentinel. Only error descriptions
were redacted; the success path attached `extracted` and parse/schema diagnostics raw.

Now redaction happens at the point of emission. `runLive` redacts each complete result
before it joins the list, and `main` redacts the whole payload again before writing to
stdout, so a field added later cannot bypass sanitisation by being introduced somewhere
new. The top-level error handler is redacted too. Two regression tests cover the echoed-key
success path and the malformed-body diagnostic path.

**No real credential was used or exposed at any point**, in the review or in this
correction. The sentinel is synthetic.

### G3 — endpoint documentation and request-schema justification (medium)

The earlier README framed the difference between the Interactions guides and the
generateContent reference as *uncertainty about what this endpoint returns*. That was
wrong. They are **two different endpoints**. This harness calls exactly one:

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
```

`src/endpoint.mjs` now pins that contract in one place, with provenance, and records the
request fields actually sent. The Interactions shape is quarantined (see G4).

On the structured-output field, the harness sends JSON Schema documents in
`responseJsonSchema` and **records the field it used on every result**.

> **Corrected by C04 (2026-09-14).** This section originally claimed that
> `additionalProperties` *is* listed among `responseSchema`'s supported properties,
> and that the earlier request was therefore not self-evidently invalid. **That
> claim is withdrawn.** It came from a search-result summary rather than a read of
> the reference's Schema subsection. The lead inspected `#Schema` and reports its
> JSON representation omits `additionalProperties`, which appears on that page
> under the JSON Schema alternative and function `parametersJsonSchema`. Re-fetching
> the subsection directly returned a truncated page, so this spike cannot
> substantiate the original assertion and no longer repeats it.
>
> The substantive rule is unchanged and was never in dispute: a rejected request is
> never evidence of a missing capability. Neither side has observed a live
> invalid-request rejection, and a generic 400 proves no capability limitation.

The combined search + schema case is documented as a Gemini 3 series preview. That
expectation is now attached to the probe as `modelExpectation`, and the tested model is
recorded on every live result. It is not a general Gemini claim in either direction.

Sources re-checked 2026-09-14: [generateContent reference](https://ai.google.dev/api/generate-content),
[Generate Content structured output guide](https://ai.google.dev/gemini-api/docs/generate-content/structured-output).

### G4 — citation coordinates and the Interactions branch (medium)

**Coordinates.** The parser joined `content.parts` with `"\n"` and then applied the
provider's untouched `Segment` offsets to that synthetic string. `Segment` offsets are
**UTF-8 byte offsets within one part**, identified by `partIndex`. The two coincide only
for a single-part ASCII response.

The fixture `fixtures/multipart-unicode-citation.json` makes the difference concrete. A
support cites `partIndex 1`, bytes 11–19:

- correct resolution → `"gęślą"`
- superseded flattened resolution → `"ęść odpo"`

Both look like plausible quotations. That is exactly why this mattered: a mis-resolved
citation does not look broken. `resolveSegmentText` now resolves against the correct part
in bytes and returns a typed failure (`offset_out_of_range`, `part_index_out_of_range`,
`missing_offsets`, `no_segment`) rather than a wrong slice. Parts are kept indexed and
measured; `modelText.value` is flagged `concatenatedForDisplayOnly`.

**Interactions branch.** The parser expected a nested `url_citation`, while the documented
example reads `type`/`url`/`title`/`start_index`/`end_index` directly on the annotation, so
a documented payload produced zero sources while appearing supported. Per the C03
direction this branch is now **quarantined, not repaired**: a `steps[]` payload is recorded
with `shape: "quarantined_unsupported_shape"`, yields no candidates and contributes no
evidence. Retaining the historical fixture is not a reason to advertise support for an
endpoint this harness does not call.

### G5 — blocked and truncated output could pass semantic probes (medium)

A SAFETY-blocked candidate carrying valid diagnostic JSON passed `structured_output_alone`.
Only the transport layer consulted `incompleteCandidates`, which itself accepted
`MAX_TOKENS`.

Usability is now explicit per candidate:

| finishReason | state | usable |
| --- | --- | --- |
| `STOP` with text | `complete` | yes |
| `STOP` with no text | `empty` | no |
| `MAX_TOKENS` | `truncated` | no — bytes arrived, the answer did not |
| `SAFETY`, `RECITATION`, `PROHIBITED_CONTENT`, `SPII`, `BLOCKLIST`, `OTHER`, image variants | `blocked` | no |
| anything unrecognised | `unknown_finish_reason` | no |

Every semantic probe calls one `requireUsable` guard, and a `promptFeedback.blockReason`
blocks them all. The transport probe deliberately still passes on a blocked candidate,
because "bytes were accepted" is the only claim it makes — that separation is now asserted
by a test rather than left implicit.

The comprehension probe no longer matches colour words in prose. It requests a checkable
`{topLeft, topRight, bottomLeft, bottomRight}` shape and validates it. The old predicate
passed the sentence *"I cannot see the image, but quadrants are often red, green, blue or
white."* — all four colours, in order. An answer that does not arrive in the checkable
shape is now `unverified`, not `fail`, because format compliance and comprehension cannot
be separated from prose. This changed diagnostic prompts only.

### G6 — response-body transport failures lost retry classification (medium)

`await response.text().catch(() => "")` turned a body-read timeout into an empty string,
then into a terminal `malformed_success` after a single attempt. The request deadline
covers body consumption, so a body-read failure is a transport failure. It now carries its
classification, a `phase: "body_read"` marker and the full retry budget. Genuinely invalid
JSON stays terminal and distinct, and an empty 200 body is now its own `EMPTY_SUCCESS_BODY`
rather than being merged into the malformed case.

Two secondary classifier defects were fixed:

- HTTP 408 was retryable but categorised `request_or_content`; it is a timeout and is now
  `provider_transient`.
- The classifier read `error.name ?? error.code`, so a generic `name: "Error"` masked a
  meaningful `code: "ECONNRESET"`. All of `name`, `code`, `cause.code` and `cause.name` are
  now considered.

### Additional scope items from the review

- **Exit codes.** README described `0` as "all probes passed" while the runner returned `0`
  for a run with unverified results. Codes are now defined and tested: `0` all pass, `1`
  some failed, `2` live blocked, `3` no failures but something unverified, `4` usage error.
  A live run whose calls all 403 now exits `3`, with zero passes and zero fails.
- **Synthetic fixture expectations.** Parser rows were hardcoded PASS after extraction.
  Each fixture now declares expected output in `fixtures/parser-expectations.json` — kept
  separate so the historical provider-shaped fixtures stay byte-for-byte preserved — and a
  fixture with no declared expectation fails rather than passing silently.
- **Partial schema validation.** The validator reports keywords it cannot check. A probe
  now returns `unverified`, not `pass`, when unsupported keywords remain, so partial
  validation never reads as full conformance.
- **Model and endpoint provenance.** Every live result records the tested model and
  endpoint.

---

## Deliberately not done

- **No live Gemini call.** Out of scope for this batch; all capabilities stay UNVERIFIED.
- **No second provider surface.** The Interactions branch was quarantined rather than
  implemented. Adding a second endpoint to hide the mismatch was explicitly excluded.
- **No production adapter, model decision, editorial prompt, Style Profile or UI.**
- **No two-step grounding fallback probe.** It remains a proposal in `findings.md`, not an
  implementation, and is labelled as such.
- **Application guards remain partial synthetic checks**, not a complete T00 validator.
  Returned-hook preservation is a simulation of our own adapter, not a provider contract.
  Live meme-ID existence stays a backend responsibility per T00.

## Verification

```sh
cd spikes/gemini
npm run check       # 116 tests, all pass
npm run synthetic   # 8 fixture checks, exit 0
npm run live        # exit 2 (BLOCKED): no credential configured
```

The 27 tests in `test/regressions-g1-g6.test.mjs` reproduce each reviewed defect and assert
the corrected behaviour, so reverting any correction fails the suite.

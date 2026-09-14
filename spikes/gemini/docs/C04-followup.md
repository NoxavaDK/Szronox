# C04 follow-up — T03 evidence-validation corrections

Applied 2026-09-14 on `agents/t03-gemini`, on top of **`bf910f2`** (which sits on `fb1e25a`
→ `cb41abd`). No reset. All prior artifacts preserved: `docs/R01-review.md`,
`docs/sol-partial-review.md`, `docs/C03-corrections.md` and every original fixture.

Input: `docs/implementation/C03-lead-review.md`, findings **C03-R1/R2/R3** plus two
documentation corrections. The lead reproduced all three against `bf910f2`; so did I before
changing anything.

**Attribution:** implemented by user-launched Opus 5 (`claude-opus-5`), manual handoff. This
is the same agent that authored C03, so it is **not** independent acceptance of its own
work — the lead rechecks the regressions.

**No live Gemini call.** All provider capabilities remain UNVERIFIED.

---

## R1 — dangling supports proved grounding (high)

`validateSupports(candidate)` in `src/evidence.mjs` replaces `supports.length` in both
grounding verdicts. The root error was treating array length as an evidence relationship.

A support counts only when, all scoped to the selected candidate: it carries a segment;
every chunk index it names refers to a source that exists here; its coordinates resolve
(valid part, in range, whole characters); and the resolved span is non-empty. Invalid
supports are returned with a reason rather than dropped, so a verdict can say *why* evidence
was refused.

| Reproduction | Before | After |
| --- | --- | --- |
| 1 query, 1 source at chunk 0, support → `partIndex 99`, `chunkIndices [999]` | search **PASS**, combined **PASS** | both **fail**, `invalidSupports[0].reason = dangling_source_reference` |
| Same, with a valid mapping to chunk 0 | pass | **pass** (`validSupports: 1`) — positives preserved |

Distinct refusal reasons are asserted individually: `missing_segment`,
`no_source_reference`, `dangling_source_reference`, `empty_span`,
`unresolvable_segment:<reason>`.

Also fixed here: `hasRetrievedExcerpt(extracted)` scanned every candidate, so a sibling's
excerpt could be reported inside the selected candidate's result. Both grounding verdicts
now use `candidateHasRetrievedExcerpt(candidate)`.

## R2 — unknown URL statuses passed (medium)

Prefix/suffix matching is not enum validation. `/_SUCCESS$/` accepted `BOGUS_SUCCESS`;
`/^URL_RETRIEVAL_STATUS_/` plus "not SUCCESS, not UNSPECIFIED" made
`URL_RETRIEVAL_STATUS_NEW_UNKNOWN` a *reported failure*.

Membership is now exact. I confirmed the enum independently rather than taking it on trust —
ordinals from the generativelanguage protobuf reference, accessed 2026-09-14:

| Value | Ordinal | Treatment |
| --- | --- | --- |
| `URL_RETRIEVAL_STATUS_UNSPECIFIED` | 0 | recognised, reports nothing → unverified |
| `URL_RETRIEVAL_STATUS_SUCCESS` | 1 | retrieval succeeded |
| `URL_RETRIEVAL_STATUS_ERROR` | 2 | reported failure |
| `URL_RETRIEVAL_STATUS_PAYWALL` | 3 | reported failure |
| `URL_RETRIEVAL_STATUS_UNSAFE` | 4 | reported failure |

Anything else is preserved verbatim (`status` unchanged, `statusRecognised: false`) and
leaves the capability unverified. A future enum addition therefore degrades to "unknown"
rather than to a spurious pass. Status is still matched against the requested URL on the
selected candidate.

## R3 — split UTF-8 coordinates returned corrupted success (medium)

`resolveSegmentText` on part text `ą` with bytes `[1,2)` returned
`{ok:true, text:'�'}`: the numeric range fits, but it splits a two-byte character and
`Buffer.toString` silently substitutes a replacement character.

The check is a **re-encode round trip**, not a scan of the output for U+FFFD. That
distinction is the point the lead flagged: a part whose source genuinely contains a literal
replacement character re-encodes identically and is still resolvable.

| Case | Result |
| --- | --- |
| `"ą"`, bytes `[1,2)` | `{ok:false, reason:"invalid_utf8_boundary"}`, no text returned |
| `"a�b"`, bytes `[1,4)` | `{ok:true, text:"�"}` — legitimate content accepted |
| Multipart `"Zażółć gęślą…"` `partIndex 1`, bytes `[11,19)` | `{ok:true, text:"gęślą"}` |

Wired into R1: a split boundary surfaces as
`unresolvable_segment:invalid_utf8_boundary` and disqualifies the mapping, so the helper is
not merely correct-but-unused.

## Documentation corrections

**`additionalProperties` claim — withdrawn.** C03 asserted the reference lists
`additionalProperties` among `responseSchema`'s supported properties. That came from a
search-result summary, not from reading `#Schema`. The lead inspected the subsection and
reports it omits the field, which appears instead under the JSON Schema alternative and
function `parametersJsonSchema`. My attempt to re-fetch that subsection returned a truncated
page, so **this spike cannot substantiate the claim and no longer makes it**. Corrected in
`src/endpoint.mjs` and `docs/C03-corrections.md` with the reasoning visible, not silently
deleted.

The rule that actually mattered is unchanged and was never disputed: a rejected request is
never evidence of a missing capability, and no live invalid-request rejection has been
observed by either side.

**Request provenance now matches the report.** C03 claimed every result records its
structured-output field while the emitted base carried endpoint and model only. Each live
result now emits `apiVersion` and `structuredOutputField` — the pinned field for probes that
send a schema, and `null` for those that do not, rather than implying a field was used.

## Retained, re-verified

The lead asked that fixed behaviour not be reopened. Both regressions still pass after these
changes:

- successful-output credential redaction (`G2`, `G2b`) — synthetic sentinel only
- body-read bounded retries and transport classification (`G6.1`–`G6.3`)

## Commands

```sh
cd spikes/gemini
npm run check       # 128 tests, all pass (116 before C04 + 12 new)
npm run synthetic   # exit 0, 8 fixture checks
npm run live        # exit 2 (BLOCKED): no credential configured
```

## Status

| Area | Status |
| --- | --- |
| R1 dangling-support validation | **corrected**, positives preserved |
| R2 exact URL status enum | **corrected**, unknown values preserved verbatim |
| R3 UTF-8 boundary typed failure, wired into verdicts | **corrected** |
| `additionalProperties` documentation claim | **withdrawn and qualified** |
| Per-result request provenance | **emitted**, claim no longer overstated |
| Redaction and body-read retries | retained, re-verified |
| Actual Gemini capabilities | **UNVERIFIED**, unchanged — no live call |
| Independent acceptance | **not given**: same agent authored C03 |

## Remaining blockers

- Credentialed live probes. Every capability row stays UNVERIFIED until `npm run live` runs
  with a configured key.
- The structured-output field pairing is still documentation-only reasoning. Only a live
  call distinguishes "wrong field name" from anything else, and a 400 alone would prove
  neither.

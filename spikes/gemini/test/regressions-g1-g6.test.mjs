/**
 * C03 regression suite.
 *
 * Every test here reproduces a defect recorded in
 * `docs/implementation/T03-independent-review.md` and then asserts the corrected
 * behaviour. The review's own reproduction inputs are used verbatim where it
 * gave them, so these tests fail if any correction is reverted.
 *
 * No network, no credentials. The only "secret" is a fake sentinel.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { extractEvidence, resolveSegmentText, usableCandidate } from "../src/evidence.mjs";
import { buildProbes } from "../src/probes.mjs";
import { classifyHttpError, classifyTransportError, generateContent } from "../src/transport.mjs";
import { runLive } from "../src/diagnostic.mjs";

const probes = new Map(buildProbes().map((probe) => [probe.id, probe]));
const verdict = (id, response, context) => probes.get(id).verdict(extractEvidence(response), context);

const candidate = (text, extra = {}) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP", ...extra }],
});

// ───────────────────────── G1 — false grounding and URL verdicts ─────────────

test("G1.1 combined probe does not pass on model-claimed citations with no provider grounding", () => {
  // Review input: {"answer":"x","citedUrls":[]} with no grounding metadata.
  // Was: PASS with citationsRetained=false.
  const outcome = verdict("structured_output_with_search", candidate('{"answer":"x","citedUrls":[]}'));
  assert.notEqual(outcome.verdict, "pass", "valid JSON alone cannot pass the combined capability");
  assert.equal(outcome.verdict, "fail");
  assert.equal(outcome.sources, 0);
  assert.equal(outcome.modelClaimedUrlsAreNotEvidence, true);
});

test("G1.1b model-supplied citedUrls are never counted as provider evidence", () => {
  const outcome = verdict(
    "structured_output_with_search",
    candidate('{"answer":"x","citedUrls":["https://example.invalid/a","https://example.invalid/b"]}'),
  );
  assert.equal(outcome.verdict, "fail");
  assert.equal(outcome.modelClaimedUrls, 2);
  assert.equal(outcome.sources, 0, "model prose must not raise the provider source count");
});

test("G1.2 an authentication failure cannot prove unreachable-URL handling", () => {
  // Was: PASS ("Provider surfaced an explicit error for an unreachable URL").
  const outcome = verdict("url_context_unavailable", null, {
    error: { category: "authentication_or_permission", status: 403, code: "PERMISSION_DENIED", retryable: false },
  });
  assert.equal(outcome.verdict, "unverified");
  assert.equal(outcome.capabilityConclusion, "none");
  assert.match(outcome.summary, /never exercised/i);
});

test("G1.3 a transport timeout yields no compatibility conclusion", () => {
  // Was: fail with interpretation "Model/endpoint does not support this combination".
  const outcome = verdict("structured_output_with_search", null, {
    error: { category: "transport_timeout", retryable: true, code: "TimeoutError" },
  });
  assert.equal(outcome.verdict, "unverified");
  assert.equal(outcome.capabilityConclusion, "none");
  assert.ok(!("interpretation" in outcome), "must not assert unsupported combination from a timeout");
});

test("G1.3b even a rejected request is not recorded as incompatibility", () => {
  const outcome = verdict("structured_output_with_search", null, {
    error: { category: "request_or_content", status: 400, code: "INVALID_ARGUMENT", retryable: false },
  });
  assert.equal(outcome.verdict, "unverified");
  assert.match(outcome.summary, /malformed request on our side|NOT recorded as incompatibility/i);
});

test("G1.4 search grounding never borrows another candidate's sources", () => {
  // Review input: first candidate ungrounded, second has one source and no queries.
  // Was: PASS with queries=0 and supports=0.
  const outcome = verdict("search_grounding", {
    candidates: [
      { content: { parts: [{ text: "Ungrounded answer." }] }, finishReason: "STOP" },
      {
        content: { parts: [{ text: "Other candidate." }] },
        finishReason: "STOP",
        groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.invalid/a", title: "A" } }] },
      },
    ],
  });
  assert.notEqual(outcome.verdict, "pass");
  assert.equal(outcome.candidateIndex, 0, "the answering candidate is the one judged");
  assert.equal(outcome.sources, 0);
});

test("G1.4b sources without an executed query do not pass", () => {
  const outcome = verdict("search_grounding", candidate("Answer.", {
    groundingMetadata: {
      groundingChunks: [{ web: { uri: "https://example.invalid/a", title: "A" } }],
      groundingSupports: [{ segment: { partIndex: 0, startIndex: 0, endIndex: 6 }, groundingChunkIndices: [0] }],
    },
  }));
  assert.equal(outcome.verdict, "unverified");
  assert.match(outcome.summary, /execution is unproven/i);
});

test("G1.5 top-level retrieval metadata for an unrelated URL cannot pass the accessible-URL probe", () => {
  // Review input: only top-level URL success metadata, for a different URL.
  // Was: PASS.
  const outcome = verdict("url_context_accessible", {
    candidates: [{ content: { parts: [{ text: "The heading is Example Domain." }] }, finishReason: "STOP" }],
    urlContextMetadata: {
      urlMetadata: [{ retrievedUrl: "https://unrelated.invalid/other", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" }],
    },
  });
  assert.equal(outcome.verdict, "unverified");
  assert.equal(outcome.topLevelRetrievalIgnored, 1);
});

test("G1.5b candidate-scoped success for the requested URL does pass", () => {
  const outcome = verdict("url_context_accessible", candidate("Example Domain", {
    urlContextMetadata: {
      urlMetadata: [{ retrievedUrl: "https://example.com/", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" }],
    },
  }));
  assert.equal(outcome.verdict, "pass");
});

test("G1.5c retrieval metadata for a different URL does not answer the requested one", () => {
  const outcome = verdict("url_context_accessible", candidate("heading", {
    urlContextMetadata: {
      urlMetadata: [{ retrievedUrl: "https://example.invalid/elsewhere", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" }],
    },
  }));
  assert.equal(outcome.verdict, "unverified");
});

test("G1.6 an unspecified or unknown retrieval status is not a reported failure", () => {
  for (const status of ["URL_RETRIEVAL_STATUS_UNSPECIFIED", "SOMETHING_NEW"]) {
    const outcome = verdict("url_context_unavailable", candidate("could not read", {
      urlContextMetadata: {
        urlMetadata: [{ retrievedUrl: "https://t03-diagnostic.invalid/page", urlRetrievalStatus: status }],
      },
    }));
    assert.equal(outcome.verdict, "unverified", `status ${status} must not count as a demonstrated failure`);
  }
});

test("G1.6b an explicit retrieval error for the requested URL does pass", () => {
  const outcome = verdict("url_context_unavailable", candidate("could not read", {
    urlContextMetadata: {
      urlMetadata: [{ retrievedUrl: "https://t03-diagnostic.invalid/page", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_ERROR" }],
    },
  }));
  assert.equal(outcome.verdict, "pass");
});

// ───────────────────────── G2 — output redaction ─────────────────────────────

test("G2 a credential echoed as model text never reaches the emitted result", async () => {
  const SENTINEL = "SYNTHETIC_SECRET_SENTINEL";
  const realFetch = globalThis.fetch;
  const realKey = process.env.GEMINI_API_KEY;
  const realGoogle = process.env.GOOGLE_API_KEY;
  try {
    process.env.GEMINI_API_KEY = SENTINEL;
    delete process.env.GOOGLE_API_KEY;
    // The provider echoes the key back inside ordinary successful output.
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        candidates: [{
          content: { parts: [{ text: `key ${SENTINEL} leaked into prose` }] },
          finishReason: "STOP",
        }],
      }),
    });

    const serialised = JSON.stringify(await runLive());
    assert.ok(!serialised.includes(SENTINEL), "the success path must be redacted, not only error descriptions");
    assert.ok(serialised.includes("[REDACTED]"), "redaction must be visible rather than silently dropping content");
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = realKey;
    if (realGoogle !== undefined) process.env.GOOGLE_API_KEY = realGoogle;
  }
});

test("G2b redaction also covers malformed-body diagnostics", async () => {
  const SENTINEL = "SYNTHETIC_SECRET_SENTINEL";
  const realFetch = globalThis.fetch;
  const realKey = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = SENTINEL;
    // HTTP 200 whose body is not JSON, echoing the key: the parse diagnostic
    // used to carry the first 120 characters through unredacted.
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => `not json ${SENTINEL}` });
    const serialised = JSON.stringify(await runLive());
    assert.ok(!serialised.includes(SENTINEL));
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = realKey;
  }
});

// ───────────────────────── G4 — citation coordinates and quarantine ──────────

test("G4.1 a citation resolves against its own part using UTF-8 byte offsets", () => {
  const extracted = extractEvidence({
    candidates: [{
      content: { parts: [{ text: "Pierwsza część odpowiedzi. " }, { text: "Zażółć gęślą jaźń dla źdźbła." }] },
      finishReason: "STOP",
      groundingMetadata: {
        groundingChunks: [{ web: { uri: "https://example.invalid/a", title: "A" } }],
        groundingSupports: [{ segment: { partIndex: 1, startIndex: 11, endIndex: 19 }, groundingChunkIndices: [0] }],
      },
    }],
  });
  const only = extracted.candidates[0];
  const resolved = resolveSegmentText(only, only.supports[0].segment);
  assert.equal(resolved.ok, true);
  // The superseded parser joined parts and applied these offsets to the
  // flattened string, producing "ęść odpo" — a different, plausible quotation.
  assert.equal(resolved.text, "gęślą");
  assert.notEqual(resolved.text, "ęść odpo");
});

test("G4.1b parts stay indexed and measured in bytes", () => {
  const extracted = extractEvidence({
    candidates: [{ content: { parts: [{ text: "ą" }, { text: "b" }] }, finishReason: "STOP" }],
  });
  assert.deepEqual(extracted.candidates[0].parts.map((p) => p.partIndex), [0, 1]);
  assert.equal(extracted.candidates[0].parts[0].byteLength, 2, "ą is two UTF-8 bytes");
  assert.equal(extracted.candidates[0].modelText.concatenatedForDisplayOnly, true);
});

test("G4.1c an out-of-range or missing offset fails loudly instead of slicing something plausible", () => {
  const extracted = extractEvidence({
    candidates: [{ content: { parts: [{ text: "short" }] }, finishReason: "STOP" }],
  });
  const only = extracted.candidates[0];
  assert.equal(resolveSegmentText(only, { partIndex: 0, startIndex: 0, endIndex: 999 }).reason, "offset_out_of_range");
  assert.equal(resolveSegmentText(only, { partIndex: 7, startIndex: 0, endIndex: 1 }).reason, "part_index_out_of_range");
  assert.equal(resolveSegmentText(only, { partIndex: 0 }).reason, "missing_offsets");
  assert.equal(resolveSegmentText(only, null).reason, "no_segment");
});

test("G4.2 the Interactions steps shape is quarantined, not advertised as supported", () => {
  // The documented annotation shape reads fields directly on the annotation; the
  // old parser expected a nested url_citation and silently produced 0 sources.
  const extracted = extractEvidence({
    steps: [
      { type: "google_search_call", queries: ["q"] },
      {
        type: "model_output",
        content: [{
          text: "Answer.",
          annotations: [{ type: "url_citation", url: "https://example.invalid/a", title: "A", start_index: 0, end_index: 7 }],
        }],
      },
    ],
  });
  assert.equal(extracted.shape, "quarantined_unsupported_shape");
  assert.equal(extracted.candidates.length, 0, "a different endpoint's payload yields no candidates");
  assert.equal(extracted.quarantined.reason, "unsupported_response_shape");
  assert.match(extracted.quarantined.detail, /generateContent only/);
});

// ───────────────────────── G5 — blocked and truncated output ─────────────────

test("G5.1 a SAFETY-blocked candidate carrying valid JSON does not pass a semantic probe", () => {
  // Review input: injected SAFETY candidate containing valid diagnostic JSON.
  const outcome = verdict("structured_output_alone", {
    candidates: [{
      content: { parts: [{ text: '{"classification":"liquid","confidence":0.9}' }] },
      finishReason: "SAFETY",
    }],
  });
  assert.equal(outcome.verdict, "unverified");
  assert.match(outcome.summary, /No usable candidate/);
});

test("G5.2 a truncated (MAX_TOKENS) candidate is not a usable answer", () => {
  const extracted = extractEvidence({
    candidates: [{ content: { parts: [{ text: '{"classification":"gas","confidence":0.5}' }] }, finishReason: "MAX_TOKENS" }],
  });
  assert.equal(usableCandidate(extracted), null, "MAX_TOKENS is a truncation, not an answer");
  assert.equal(extracted.candidates[0].usability.state, "truncated");
  assert.equal(verdict("structured_output_alone", {
    candidates: [{ content: { parts: [{ text: '{"classification":"gas","confidence":0.5}' }] }, finishReason: "MAX_TOKENS" }],
  }).verdict, "unverified");
});

test("G5.3 a prompt-level block is reported and blocks semantic verdicts", () => {
  const response = {
    candidates: [{ content: { parts: [{ text: '{"classification":"gas","confidence":0.5}' }] }, finishReason: "STOP" }],
    promptFeedback: { blockReason: "SAFETY" },
  };
  assert.equal(extractEvidence(response).promptBlockReason, "SAFETY");
  const outcome = verdict("structured_output_alone", response);
  assert.equal(outcome.verdict, "unverified");
  assert.equal(outcome.promptBlockReason, "SAFETY");
});

test("G5.4 transport acceptance is still reported for a blocked candidate", () => {
  // Bytes accepted and usable answer are different claims; the transport probe
  // measures only the first.
  const outcome = verdict("multimodal_transport", {
    candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }],
  });
  assert.equal(outcome.verdict, "pass");
  assert.equal(outcome.candidateState, "blocked");
  assert.match(outcome.limitation, /Not evidence of image understanding/);
});

test("G5.5 comprehension is judged on a checkable shape, not colour words in prose", () => {
  // The old predicate passed this sentence: all four colours appear, in order.
  const denial = "I cannot see the image, but quadrants are often red, green, blue or white.";
  const outcome = verdict("multimodal_comprehension", candidate(denial));
  assert.notEqual(outcome.verdict, "pass");
  assert.equal(outcome.verdict, "unverified");

  const correct = verdict("multimodal_comprehension",
    candidate('{"topLeft":"red","topRight":"green","bottomLeft":"blue","bottomRight":"white"}'));
  assert.equal(correct.verdict, "pass");

  const wrong = verdict("multimodal_comprehension",
    candidate('{"topLeft":"blue","topRight":"green","bottomLeft":"red","bottomRight":"white"}'));
  assert.equal(wrong.verdict, "fail");
  assert.equal(wrong.wrong.length, 2);
});

// ───────────────────────── G6 — transport classification ─────────────────────

test("G6.1 a body-read timeout stays a retryable transport failure", async () => {
  // Review input: text() throwing TimeoutError. Was: empty text -> terminal
  // malformed_success after one attempt.
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      text: async () => { throw new DOMException("timeout", "TimeoutError"); },
    };
  };
  await assert.rejects(
    generateContent({
      apiKey: "fake-diagnostic-key-000000", model: "m", request: {}, fetchImpl,
      retry: { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
    }),
    (error) => {
      assert.equal(error.category, "transport_timeout");
      assert.equal(error.retryable, true);
      assert.equal(error.phase, "body_read");
      assert.notEqual(error.code, "MALFORMED_SUCCESS_BODY");
      return true;
    },
  );
  assert.equal(calls, 3, "a retryable body-read failure must use the retry budget");
});

test("G6.1b genuinely invalid JSON remains a distinct terminal outcome", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, text: async () => "<html>" }; };
  await assert.rejects(
    generateContent({
      apiKey: "fake-diagnostic-key-000000", model: "m", request: {}, fetchImpl,
      retry: { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
    }),
    (error) => {
      assert.equal(error.code, "MALFORMED_SUCCESS_BODY");
      assert.equal(error.category, "malformed_success");
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(calls, 1, "a malformed contract is not retried");
});

test("G6.2 HTTP 408 is classified as a transient provider timeout", () => {
  const classification = classifyHttpError(408);
  assert.equal(classification.retryable, true);
  assert.equal(classification.category, "provider_transient", "408 is a timeout, not a malformed request");
});

test("G6.3 a meaningful error code is not masked by a generic error name", () => {
  // name: "Error" used to win over code: "ECONNRESET", making it terminal.
  const classification = classifyTransportError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
  assert.equal(classification.retryable, true);
  assert.equal(classification.category, "transport_network");

  const nested = classifyTransportError(Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_BODY_TIMEOUT" } }));
  assert.equal(nested.retryable, true);
  assert.equal(nested.category, "transport_timeout");

  const unknown = classifyTransportError(new Error("something new"));
  assert.equal(unknown.retryable, false, "an unnamed failure must stay terminal rather than loop");
});

// ═════════════════════ C04 — lead review of C03 at bf910f2 ═══════════════════
//
// Each case below was reproduced by the lead against bf910f2 and must not
// regress. Sources: docs/implementation/C03-lead-review.md R1-R3.

import { URL_RETRIEVAL_FAILURES, candidateHasRetrievedExcerpt, validateSupports } from "../src/evidence.mjs";

const grounded = (supports, chunks = [{ web: { uri: "https://example.invalid/a", title: "A" } }]) => ({
  candidates: [{
    content: { parts: [{ text: "Answer." }] },
    finishReason: "STOP",
    groundingMetadata: { webSearchQueries: ["q"], groundingChunks: chunks, groundingSupports: supports },
  }],
});

test("C04-R1 a support naming a nonexistent part and a dangling chunk index is not grounding", () => {
  // Reproduced by the lead: one query, one source, one support -> PASS on both
  // probes, although neither the cited part nor the referenced source existed.
  const bad = [{ segment: { partIndex: 99, startIndex: 0, endIndex: 5 }, groundingChunkIndices: [999] }];
  const search = verdict("search_grounding", grounded(bad));
  assert.equal(search.verdict, "fail");
  assert.equal(search.validSupports, 0);
  assert.equal(search.invalidSupports[0].reason, "dangling_source_reference");

  const combinedBody = JSON.stringify({ answer: "x", citedUrls: [] });
  const combined = verdict("structured_output_with_search", {
    candidates: [{
      content: { parts: [{ text: combinedBody }] },
      finishReason: "STOP",
      groundingMetadata: {
        webSearchQueries: ["q"],
        groundingChunks: [{ web: { uri: "https://example.invalid/a", title: "A" } }],
        groundingSupports: bad,
      },
    }],
  });
  assert.equal(combined.verdict, "fail");
  assert.equal(combined.validSupports, 0);
});

test("C04-R1b a valid mapping to an existing source does pass", () => {
  const good = [{ segment: { partIndex: 0, startIndex: 0, endIndex: 6 }, groundingChunkIndices: [0] }];
  const outcome = verdict("search_grounding", grounded(good));
  assert.equal(outcome.verdict, "pass");
  assert.equal(outcome.validSupports, 1);
});

test("C04-R1c every invalid mapping shape is named rather than silently dropped", () => {
  const candidate = extractEvidence(grounded([
    { groundingChunkIndices: [0] },                                                   // no segment
    { segment: { partIndex: 0, startIndex: 0, endIndex: 6 }, groundingChunkIndices: [] }, // no reference
    { segment: { partIndex: 0, startIndex: 0, endIndex: 6 }, groundingChunkIndices: [7] }, // dangling
    { segment: { partIndex: 0, startIndex: 2, endIndex: 2 }, groundingChunkIndices: [0] }, // empty span
    { segment: { partIndex: 0, startIndex: 0, endIndex: 999 }, groundingChunkIndices: [0] }, // out of range
  ])).candidates[0];
  const outcome = validateSupports(candidate);
  assert.equal(outcome.validCount, 0);
  assert.deepEqual(outcome.invalid.map((entry) => entry.reason), [
    "missing_segment",
    "no_source_reference",
    "dangling_source_reference",
    "empty_span",
    "unresolvable_segment:offset_out_of_range",
  ]);
});

test("C04-R1d retrieved-excerpt reporting stays on the selected candidate", () => {
  // The old helper scanned every candidate, so a sibling's excerpt could be
  // reported inside the selected candidate's result.
  const extracted = extractEvidence({
    candidates: [
      { content: { parts: [{ text: "Selected." }] }, finishReason: "STOP",
        groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.invalid/a", title: "A" } }] } },
      { content: { parts: [{ text: "Sibling." }] }, finishReason: "STOP",
        groundingMetadata: { groundingChunks: [{ web: { uri: "https://example.invalid/b", title: "B", text: "Fetched body." } }] } },
    ],
  });
  assert.equal(candidateHasRetrievedExcerpt(extracted.candidates[0]), false, "selected candidate has no excerpt");
  assert.equal(candidateHasRetrievedExcerpt(extracted.candidates[1]), true);
});

test("C04-R2 URL status recognition is exact enum membership, not pattern matching", () => {
  // BOGUS_SUCCESS matched /_SUCCESS$/ and passed accessible retrieval.
  const accessible = (status) => verdict("url_context_accessible", {
    candidates: [{ content: { parts: [{ text: "h" }] }, finishReason: "STOP",
      urlContextMetadata: { urlMetadata: [{ retrievedUrl: "https://example.com/", urlRetrievalStatus: status }] } }],
  });
  assert.equal(accessible("BOGUS_SUCCESS").verdict, "unverified");
  assert.equal(accessible("URL_RETRIEVAL_STATUS_NEW_UNKNOWN").verdict, "unverified");
  assert.equal(accessible("URL_RETRIEVAL_STATUS_SUCCESS").verdict, "pass");
});

test("C04-R2b only documented failure values are a reported retrieval failure", () => {
  const unavailable = (status) => verdict("url_context_unavailable", {
    candidates: [{ content: { parts: [{ text: "h" }] }, finishReason: "STOP",
      urlContextMetadata: { urlMetadata: [{ retrievedUrl: "https://t03-diagnostic.invalid/page", urlRetrievalStatus: status }] } }],
  });
  // ERROR, PAYWALL and UNSAFE are the documented failures.
  for (const status of URL_RETRIEVAL_FAILURES) {
    assert.equal(unavailable(status).verdict, "pass", `${status} is a documented failure`);
  }
  // UNSPECIFIED is documented but reports nothing; an invented value even less so.
  assert.equal(unavailable("URL_RETRIEVAL_STATUS_UNSPECIFIED").verdict, "unverified");
  assert.equal(unavailable("URL_RETRIEVAL_STATUS_NEW_UNKNOWN").verdict, "unverified");
});

test("C04-R2c an unrecognised status is preserved verbatim", () => {
  const extracted = extractEvidence({
    candidates: [{ content: { parts: [{ text: "h" }] }, finishReason: "STOP",
      urlContextMetadata: { urlMetadata: [{ retrievedUrl: "https://example.com/", urlRetrievalStatus: "BOGUS_SUCCESS" }] } }],
  });
  const [entry] = extracted.candidates[0].urlRetrieval;
  assert.equal(entry.status, "BOGUS_SUCCESS", "the received string is not normalised away");
  assert.equal(entry.statusRecognised, false);
  assert.equal(entry.retrieved, false);
  assert.equal(entry.retrievalFailed, false);
});

test("C04-R3 a byte range that splits a multibyte character is a typed failure", () => {
  // Reproduced by the lead: text "ą", bytes [1,2) returned ok:true with U+FFFD.
  const candidate = extractEvidence({
    candidates: [{ content: { parts: [{ text: "ą" }] }, finishReason: "STOP" }],
  }).candidates[0];
  const outcome = resolveSegmentText(candidate, { partIndex: 0, startIndex: 1, endIndex: 2 });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "invalid_utf8_boundary");
  assert.equal(outcome.text, undefined, "no corrupted text is returned alongside the failure");
});

test("C04-R3b a literal replacement character in the source is still resolvable", () => {
  // The check must be a re-encode round trip, not a scan for U+FFFD in the
  // output, or genuine content would be rejected.
  const candidate = extractEvidence({
    candidates: [{ content: { parts: [{ text: "a�b" }] }, finishReason: "STOP" }],
  }).candidates[0];
  const outcome = resolveSegmentText(candidate, { partIndex: 0, startIndex: 1, endIndex: 4 });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.text, "�");
});

test("C04-R3c a split boundary disqualifies the mapping in the grounding verdict", () => {
  // R3 wired into R1: a correct helper unused by verdicts would fix nothing.
  const outcome = verdict("search_grounding", {
    candidates: [{
      content: { parts: [{ text: "ąę" }] },
      finishReason: "STOP",
      groundingMetadata: {
        webSearchQueries: ["q"],
        groundingChunks: [{ web: { uri: "https://example.invalid/a", title: "A" } }],
        groundingSupports: [{ segment: { partIndex: 0, startIndex: 1, endIndex: 3 }, groundingChunkIndices: [0] }],
      },
    }],
  });
  assert.equal(outcome.verdict, "fail");
  assert.equal(outcome.invalidSupports[0].reason, "unresolvable_segment:invalid_utf8_boundary");
});

test("C04-R3d valid multipart and Unicode coordinates still resolve", () => {
  const candidate = extractEvidence({
    candidates: [{
      content: { parts: [{ text: "Pierwsza część odpowiedzi. " }, { text: "Zażółć gęślą jaźń dla źdźbła." }] },
      finishReason: "STOP",
    }],
  }).candidates[0];
  const outcome = resolveSegmentText(candidate, { partIndex: 1, startIndex: 11, endIndex: 19 });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.text, "gęślą");
});

test("C04-R5 a schema-sending probe records its structured-output field", async () => {
  const { runLive } = await import("../src/diagnostic.mjs");
  const realFetch = globalThis.fetch;
  const realKey = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = "fake-diagnostic-key-000000";
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
      candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }],
    }) });
    const results = await runLive();
    const schemaProbe = results.find((r) => r.probe === "structured_output_alone");
    const plainProbe = results.find((r) => r.probe === "url_context_accessible");
    assert.equal(schemaProbe.structuredOutputField, "responseJsonSchema");
    assert.equal(schemaProbe.apiVersion, "v1beta");
    // Narrowed honestly: probes that send no schema record null rather than
    // implying a field was used.
    assert.equal(plainProbe.structuredOutputField, null);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = realKey;
  }
});

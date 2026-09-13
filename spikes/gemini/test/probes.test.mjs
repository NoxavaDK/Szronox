/**
 * Probe verdicts, driven by injected responses.
 *
 * The partial spike's only probe test asserted the list of probe ids, which
 * cannot distinguish a working diagnostic from a broken one. These tests feed
 * each verdict function a response and assert the judgement, including the cases
 * where a probe MUST fail.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { extractEvidence } from "../src/evidence.mjs";
import { QUADRANT_EXPECTATION, buildProbes, buildQuadrantPng, probeIds } from "../src/probes.mjs";

const probes = new Map(buildProbes().map((probe) => [probe.id, probe]));
const verdictFor = (id, response, context) => probes.get(id).verdict(extractEvidence(response), context);

const textResponse = (text, extra = {}) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP", ...extra }],
});

test("every required capability has a probe", () => {
  assert.deepEqual(probeIds(), [
    "multimodal_transport",
    "multimodal_comprehension",
    "url_context_accessible",
    "url_context_unavailable",
    "search_grounding",
    "structured_output_alone",
    "structured_output_with_search",
  ]);
});

test("the quadrant image is a real PNG with the documented colours", () => {
  const png = buildQuadrantPng(64);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.deepEqual(Object.values(QUADRANT_EXPECTATION), ["red", "green", "blue", "white"]);
});

test("transport probe passes on any candidate but claims only transport", () => {
  const outcome = verdictFor("multimodal_transport", textResponse("received"));
  assert.equal(outcome.verdict, "pass");
  assert.match(outcome.limitation, /not evidence of image understanding/i);
});

test("transport probe fails on a blocked or absent candidate", () => {
  assert.equal(verdictFor("multimodal_transport", { candidates: [] }).verdict, "fail");
  assert.equal(
    verdictFor("multimodal_transport", { candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] }).verdict,
    "fail",
  );
});

test("comprehension probe passes only when all four colours appear in quadrant order", () => {
  const outcome = verdictFor(
    "multimodal_comprehension",
    textResponse("Top-left is red, top-right is green, bottom-left is blue and bottom-right is white."),
  );
  assert.equal(outcome.verdict, "pass");
});

test("comprehension probe fails when a colour is missing", () => {
  const outcome = verdictFor("multimodal_comprehension", textResponse("It is red, green and blue."));
  assert.equal(outcome.verdict, "fail");
  assert.match(JSON.stringify(outcome.missing), /white/);
});

test("comprehension probe fails when the colours are named in the wrong order", () => {
  // All four words present, arrangement wrong: vocabulary, not comprehension.
  const outcome = verdictFor("multimodal_comprehension", textResponse("white, blue, green, red"));
  assert.equal(outcome.verdict, "fail");
  assert.match(outcome.summary, /not in the requested quadrant order/);
});

test("comprehension probe fails on empty text", () => {
  assert.equal(verdictFor("multimodal_comprehension", textResponse("")).verdict, "fail");
});

test("URL probe is unverified when the model narrates a page with no retrieval metadata", () => {
  // The central evidence boundary: fluent prose is not proof of retrieval.
  const outcome = verdictFor(
    "url_context_accessible",
    textResponse("I read the page and its heading is Example Domain."),
  );
  assert.equal(outcome.verdict, "unverified");
  assert.equal(outcome.modelTextPresent, true);
});

test("URL probe passes only on a provider-reported success status", () => {
  const outcome = verdictFor("url_context_accessible", textResponse("Example Domain", {
    urlContextMetadata: {
      urlMetadata: [{ retrievedUrl: "https://example.com/", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" }],
    },
  }));
  assert.equal(outcome.verdict, "pass");
});

test("URL probe fails when metadata exists but reports no success", () => {
  const outcome = verdictFor("url_context_accessible", textResponse("heading", {
    urlContextMetadata: {
      urlMetadata: [{ retrievedUrl: "https://example.com/", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_ERROR" }],
    },
  }));
  assert.equal(outcome.verdict, "fail");
});

test("unavailable-URL probe passes on a reported failure and fails on a false success", () => {
  const failed = verdictFor("url_context_unavailable", textResponse("could not read", {
    urlContextMetadata: {
      urlMetadata: [{ retrievedUrl: "https://t03-diagnostic.invalid/page", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_ERROR" }],
    },
  }));
  assert.equal(failed.verdict, "pass");

  const bogus = verdictFor("url_context_unavailable", textResponse("read it fine", {
    urlContextMetadata: {
      urlMetadata: [{ retrievedUrl: "https://t03-diagnostic.invalid/page", urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS" }],
    },
  }));
  assert.equal(bogus.verdict, "fail");
});

test("unavailable-URL probe accepts an explicit provider error as the answer", () => {
  const outcome = verdictFor("url_context_unavailable", null, {
    error: { category: "request_or_content", retryable: false },
  });
  assert.equal(outcome.verdict, "pass");
  assert.equal(outcome.retryable, false);
});

test("unavailable-URL probe is unverified when nothing at all is reported", () => {
  assert.equal(verdictFor("url_context_unavailable", textResponse("I could not reach it.")).verdict, "unverified");
});

test("grounding probe fails an answer with no search metadata and no sources", () => {
  const outcome = verdictFor("search_grounding", textResponse("Node.js LTS is version 22."));
  assert.equal(outcome.verdict, "fail");
  assert.match(outcome.summary, /ungrounded/);
});

test("grounding probe fails when search ran but returned no sources", () => {
  const outcome = verdictFor("search_grounding", textResponse("answer", {
    groundingMetadata: { webSearchQueries: ["node lts version"], groundingChunks: [] },
  }));
  assert.equal(outcome.verdict, "fail");
  assert.match(outcome.summary, /no source references/);
});

test("grounding probe passes with sources and states that they carry no excerpt", () => {
  const outcome = verdictFor("search_grounding", textResponse("answer", {
    groundingMetadata: {
      webSearchQueries: ["node lts version"],
      groundingChunks: [{ web: { uri: "https://example.invalid/a", title: "A" } }],
      groundingSupports: [{ segment: { startIndex: 0, endIndex: 6 }, groundingChunkIndices: [0] }],
    },
  }));
  assert.equal(outcome.verdict, "pass");
  assert.equal(outcome.sources, 1);
  assert.equal(outcome.retrievedExcerptsPresent, false);
  assert.match(outcome.limitation, /no retrieved excerpt to quote/);
});

test("structured-output probe fails on prose instead of JSON", () => {
  const outcome = verdictFor("structured_output_alone", textResponse("Water is a liquid at 20C."));
  assert.equal(outcome.verdict, "fail");
  assert.match(outcome.summary, /not valid JSON/);
});

test("structured-output probe fails on JSON that violates the schema", () => {
  // Parsing is not conformance: the earlier spike would have recorded this as a
  // result without noticing.
  const outcome = verdictFor(
    "structured_output_alone",
    textResponse('{"classification":"plasma","confidence":3}'),
  );
  assert.equal(outcome.verdict, "fail");
  assert.match(outcome.summary, /violated the requested schema/);
  assert.ok(outcome.errors.length >= 2);
});

test("structured-output probe passes on a conforming response", () => {
  const outcome = verdictFor("structured_output_alone", textResponse('{"classification":"liquid","confidence":0.95}'));
  assert.equal(outcome.verdict, "pass");
  assert.equal(outcome.value.classification, "liquid");
});

test("combined probe reports a provider rejection as a compatibility answer", () => {
  const outcome = verdictFor("structured_output_with_search", null, {
    error: { category: "request_or_content", code: "INVALID_ARGUMENT", retryable: false },
  });
  assert.equal(outcome.verdict, "fail");
  assert.match(outcome.interpretation, /does not support this combination/);
});

test("combined probe records whether citations survived the structuring step", () => {
  const withCitations = verdictFor("structured_output_with_search", textResponse(
    '{"answer":"Node 22","citedUrls":["https://example.invalid/a"]}',
    {
      groundingMetadata: {
        webSearchQueries: ["node lts"],
        groundingChunks: [{ web: { uri: "https://example.invalid/a", title: "A" } }],
      },
    },
  ));
  assert.equal(withCitations.verdict, "pass");
  assert.equal(withCitations.citationsRetained, true);

  // JSON valid, grounding silently emptied: the failure mode worth catching.
  const withoutCitations = verdictFor(
    "structured_output_with_search",
    textResponse('{"answer":"Node 22","citedUrls":[]}'),
  );
  assert.equal(withoutCitations.verdict, "pass");
  assert.equal(withoutCitations.citationsRetained, false);
  assert.equal(withoutCitations.sources, 0);
});

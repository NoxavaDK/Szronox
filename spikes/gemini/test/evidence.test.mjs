import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  candidateSourceCount,
  extractEvidence,
  hasRetrievedExcerpt,
  incompleteCandidates,
  resolveSegmentText,
  unusableSummary,
  usableCandidate,
} from "../src/evidence.mjs";

const fixture = async (name) =>
  JSON.parse(await readFile(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"));

test("labels model text and tool metadata with distinct provenance", () => {
  const extracted = extractEvidence({
    candidates: [{
      content: { parts: [{ text: "A claim." }] },
      finishReason: "STOP",
      groundingMetadata: {
        groundingChunks: [{ web: { uri: "https://example.invalid/a", title: "A" } }],
        groundingSupports: [{ segment: { partIndex: 0, startIndex: 0, endIndex: 8 }, groundingChunkIndices: [0] }],
      },
    }],
  });
  const candidate = extracted.candidates[0];
  assert.equal(candidate.modelText.origin, "model_output");
  assert.equal(candidate.sources[0].origin, "tool_metadata");
  assert.equal(candidate.supports[0].origin, "tool_metadata");
});

test("reads urlContextMetadata from the candidate, not the response top level", async () => {
  const extracted = extractEvidence(await fixture("url-context-candidate-scoped.json"));
  const retrieval = extracted.candidates[0].urlRetrieval;
  assert.equal(retrieval.length, 2);
  assert.equal(retrieval[0].retrieved, true);
  assert.equal(retrieval[1].retrieved, false);
  assert.equal(retrieval[1].retrievalFailed, true);
});

test("does not merge top-level urlContextMetadata into a candidate's retrieval record", async () => {
  // Regression for the partial spike, which read this field at the response top
  // level and so attributed it to the candidate.
  const extracted = extractEvidence(await fixture("synthetic-provider-response.json"));
  assert.deepEqual(extracted.candidates[0].urlRetrieval, []);
  assert.equal(extracted.topLevelUrlRetrieval.length, 1);
  assert.equal(extracted.topLevelUrlRetrieval[0].url, "https://example.invalid/synthetic-source");
});

test("keeps each candidate's citations with its own text", async () => {
  const extracted = extractEvidence(await fixture("multi-candidate-classic.json"));
  assert.equal(extracted.candidates.length, 2);
  assert.equal(candidateSourceCount(extracted.candidates[0]), 0);
  assert.equal(extracted.candidates[0].searchQueries.length, 0);
  assert.equal(candidateSourceCount(extracted.candidates[1]), 1);
  assert.match(extracted.candidates[1].modelText.value, /Second candidate/);
});

test("treats a reference without text as metadata only, never as an excerpt", async () => {
  const extracted = extractEvidence(await fixture("synthetic-provider-response.json"));
  const source = extracted.candidates[0].sources[0];
  assert.equal(source.evidenceKind, "tool_metadata_only");
  assert.equal(source.excerpt, null);
  assert.equal(hasRetrievedExcerpt(extracted), false);
});

test("recognises an actual retrieved excerpt when the provider supplies one", () => {
  const extracted = extractEvidence({
    candidates: [{
      content: { parts: [{ text: "Answer." }] },
      finishReason: "STOP",
      groundingMetadata: {
        groundingChunks: [{ web: { uri: "https://example.invalid/b", title: "B", text: "Retrieved body text." } }],
      },
    }],
  });
  assert.equal(extracted.candidates[0].sources[0].evidenceKind, "retrieved_excerpt");
  assert.equal(hasRetrievedExcerpt(extracted), true);
});

test("flags provider redirect URIs so they are not stored as publisher URLs", () => {
  const extracted = extractEvidence({
    candidates: [{
      content: { parts: [{ text: "x" }] },
      finishReason: "STOP",
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "R" } },
          { web: { uri: "https://example.invalid/direct", title: "D" } },
        ],
      },
    }],
  });
  const [redirect, direct] = extracted.candidates[0].sources;
  assert.equal(redirect.uriIsProviderRedirect, true);
  assert.equal(direct.uriIsProviderRedirect, false);
});

test("citation offsets resolve within their own part, in UTF-8 bytes", async () => {
  const extracted = extractEvidence(await fixture("multipart-unicode-citation.json"));
  const candidate = extracted.candidates[0];
  assert.equal(candidate.parts.length, 2);
  const resolved = resolveSegmentText(candidate, candidate.supports[0].segment);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.text, "gęślą");
  assert.equal(candidate.supports[0].segment.offsetUnit, "utf8_bytes_within_part");
});

test("the Interactions steps shape is quarantined rather than parsed as evidence", async () => {
  const extracted = extractEvidence(await fixture("interactions-steps.json"));
  assert.equal(extracted.shape, "quarantined_unsupported_shape");
  assert.equal(extracted.candidates.length, 0);
  assert.equal(extracted.quarantined.reason, "unsupported_response_shape");
  assert.ok(extracted.quarantined.stepCount > 0, "the payload is recorded, just not trusted");
});

test("a blocked response is unusable and reports its prompt-level block", async () => {
  const extracted = extractEvidence(await fixture("blocked-response.json"));
  assert.equal(extracted.candidates[0].usability.state, "blocked");
  assert.equal(usableCandidate(extracted), null);
  assert.equal(extracted.promptBlockReason, "SAFETY");
  assert.match(unusableSummary(extracted), /prompt blocked/);
  assert.equal(incompleteCandidates(extracted).length, 1);
});

test("truncation is distinguished from completion", () => {
  const truncated = extractEvidence({
    candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" }],
  });
  assert.equal(truncated.candidates[0].usability.state, "truncated");
  assert.equal(usableCandidate(truncated), null);

  const complete = extractEvidence({
    candidates: [{ content: { parts: [{ text: "whole" }] }, finishReason: "STOP" }],
  });
  assert.equal(complete.candidates[0].usability.state, "complete");
  assert.ok(usableCandidate(complete));
});

test("a STOP candidate with no text is empty, not a usable answer", () => {
  const extracted = extractEvidence({
    candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
  });
  assert.equal(extracted.candidates[0].usability.state, "empty");
  assert.equal(usableCandidate(extracted), null);
});

test("distinguishes an unrecognised payload from an empty one", () => {
  assert.equal(extractEvidence({ unexpected: true }).shape, "unrecognised");
  assert.equal(extractEvidence(null).shape, "unrecognised");
  assert.equal(extractEvidence(null).candidates.length, 0);
});

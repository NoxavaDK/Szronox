import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  countSources,
  extractEvidence,
  hasRetrievedExcerpt,
  incompleteCandidates,
} from "../src/evidence.mjs";

const fixture = async (name) =>
  JSON.parse(await readFile(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"));

test("labels model text and tool metadata with distinct provenance", () => {
  const extracted = extractEvidence({
    candidates: [{
      content: { parts: [{ text: "A claim." }] },
      groundingMetadata: {
        groundingChunks: [{ web: { uri: "https://example.invalid/a", title: "A" } }],
        groundingSupports: [{ segment: { text: "A claim." }, groundingChunkIndices: [0] }],
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
  assert.equal(retrieval[0].status, "URL_RETRIEVAL_STATUS_SUCCESS");
  assert.equal(retrieval[1].status, "URL_RETRIEVAL_STATUS_ERROR");
});

test("does not merge top-level urlContextMetadata into a candidate's retrieval record", async () => {
  // Regression for the partial spike, which read this field at the response
  // top level and so attributed it to the candidate.
  const extracted = extractEvidence(await fixture("synthetic-provider-response.json"));
  assert.deepEqual(extracted.candidates[0].urlRetrieval, []);
  assert.equal(extracted.topLevelUrlRetrieval.length, 1);
  assert.equal(extracted.topLevelUrlRetrieval[0].url, "https://example.invalid/synthetic-source");
});

test("keeps each candidate's citations with its own text", async () => {
  // The partial spike joined every candidate's text but attached only
  // candidates[0]'s citations, presenting sources against unsupported text.
  const extracted = extractEvidence(await fixture("multi-candidate-classic.json"));
  assert.equal(extracted.candidates.length, 2);
  assert.equal(extracted.candidates[0].sources.length, 0);
  assert.equal(extracted.candidates[0].searchQueries.length, 0);
  assert.equal(extracted.candidates[1].sources.length, 1);
  assert.match(extracted.candidates[1].modelText.value, /Second candidate/);
  assert.equal(countSources(extracted), 1);
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

test("parses the step-based shape and maps citations to output spans", async () => {
  const extracted = extractEvidence(await fixture("interactions-steps.json"));
  assert.equal(extracted.shape, "interactions_steps");
  const candidate = extracted.candidates[0];
  assert.deepEqual(candidate.searchQueries, ["synthetic step query"]);
  assert.equal(candidate.sources[0].uri, "https://example.invalid/step-source");
  assert.equal(candidate.sources[0].evidenceKind, "tool_metadata_only");
  assert.deepEqual(candidate.supports[0].groundingChunkIndices, [0]);
  assert.equal(candidate.urlRetrieval[0].status, "SUCCESS");
});

test("a blocked response is reported as incomplete, never as usable content", async () => {
  const extracted = extractEvidence(await fixture("blocked-response.json"));
  const incomplete = incompleteCandidates(extracted);
  assert.equal(incomplete.length, 1);
  assert.equal(incomplete[0].finishReason, "SAFETY");
  assert.equal(extracted.promptFeedback.blockReason, "SAFETY");
  assert.equal(extracted.candidates[0].modelText.value, "");
});

test("distinguishes an unrecognised payload from an empty one", () => {
  assert.equal(extractEvidence({ unexpected: true }).shape, "unrecognised");
  assert.equal(extractEvidence(null).shape, "unrecognised");
  assert.equal(extractEvidence(null).candidates.length, 0);
});

/**
 * Turn a provider response into evidence with its provenance attached.
 *
 * The whole point of this module is refusing to let four different things blur
 * together:
 *
 *   model_output      - text the model wrote. Never evidence of anything.
 *   tool_metadata     - a URL or title the provider's tooling reported.
 *   retrieved_excerpt - text the provider says it actually fetched.
 *   synthetic_fixture - authored locally; evidence of parsing, nothing else.
 *
 * A model writing "according to example.com, X" is `model_output`. A grounding
 * chunk naming example.com is `tool_metadata`. Only the third is an excerpt,
 * and Gemini's grounding chunks generally do *not* contain one — which is a
 * finding the adapter has to live with, not a gap to paper over. The T00
 * contract already draws this line: `SourceEvidence.evidenceKind` is
 * `'retrieved_excerpt' | 'tool_metadata_only'`.
 *
 * Two response shapes are handled because the primary documentation currently
 * describes both, on different pages, and no live call was available to settle
 * which one the target endpoint returns (see README, "Two documented response
 * surfaces"). The shape actually seen is reported as `shape`, so a reader can
 * tell which contract a result came from rather than assuming.
 */

/** Per-candidate, so a citation can never be attached to another candidate's text. */
function readClassicCandidate(candidate, index) {
  const parts = candidate?.content?.parts ?? [];
  const text = parts.map((part) => part?.text).filter((value) => typeof value === "string").join("\n");
  const grounding = candidate?.groundingMetadata ?? null;

  const sources = (grounding?.groundingChunks ?? []).flatMap((chunk, chunkIndex) => {
    const web = chunk?.web ?? chunk?.retrievedContext;
    if (!web) return [];
    return [{
      chunkIndex,
      origin: "tool_metadata",
      uri: web.uri ?? null,
      title: web.title ?? null,
      // Grounding URIs are provider redirect links, not publisher URLs. An
      // adapter that stores this as SourceEvidence.url stores a redirect.
      uriIsProviderRedirect:
        typeof web.uri === "string" && web.uri.includes("vertexaisearch.cloud.google.com"),
      // Grounding chunks carry a reference, not the fetched body. Saying so
      // explicitly is what stops a URL being read as a quotation.
      evidenceKind: typeof web.text === "string" && web.text.length > 0
        ? "retrieved_excerpt"
        : "tool_metadata_only",
      excerpt: typeof web.text === "string" && web.text.length > 0 ? web.text : null,
    }];
  });

  const supports = (grounding?.groundingSupports ?? []).map((support) => ({
    origin: "tool_metadata",
    segment: support?.segment ?? null,
    groundingChunkIndices: support?.groundingChunkIndices ?? [],
  }));

  return {
    candidateIndex: index,
    finishReason: candidate?.finishReason ?? null,
    modelText: { origin: "model_output", value: text },
    sources,
    supports,
    searchQueries: grounding?.webSearchQueries ?? [],
    searchEntryPointPresent: Boolean(grounding?.searchEntryPoint),
    // Candidate-scoped on purpose. Reading this from the top level of the
    // response attributed one candidate's retrieval status to all of them.
    urlRetrieval: readUrlRetrieval(candidate?.urlContextMetadata ?? candidate?.url_context_metadata),
  };
}

function readUrlRetrieval(metadata) {
  const entries = metadata?.urlMetadata ?? metadata?.url_metadata ?? [];
  return entries.map((entry) => ({
    origin: "tool_metadata",
    url: entry?.retrievedUrl ?? entry?.retrieved_url ?? null,
    // Preserved verbatim. A model sentence claiming it read a page is not a
    // retrieval status, and the two must stay distinguishable.
    status: entry?.urlRetrievalStatus ?? entry?.url_retrieval_status ?? null,
  }));
}

/**
 * The newer step-based shape documented on the capability guides, where search
 * calls, search results and model output are separate steps and citations are
 * inline annotations rather than a parallel metadata block.
 */
function readStepShape(response) {
  const steps = Array.isArray(response?.steps) ? response.steps : [];
  const sources = [];
  const supports = [];
  const searchQueries = [];
  const urlRetrieval = [];
  const textChunks = [];

  steps.forEach((step) => {
    const kind = step?.type ?? step?.step_type ?? null;

    if (kind === "google_search_call") {
      for (const query of step?.queries ?? []) if (typeof query === "string") searchQueries.push(query);
    }

    if (kind === "url_context_result") {
      for (const entry of step?.url_metadata ?? step?.urlMetadata ?? [step]) {
        urlRetrieval.push({
          origin: "tool_metadata",
          url: entry?.retrieved_url ?? entry?.retrievedUrl ?? entry?.url ?? null,
          status: entry?.status ?? entry?.url_retrieval_status ?? null,
        });
      }
    }

    if (kind === "model_output") {
      const blocks = step?.content ?? [];
      for (const block of Array.isArray(blocks) ? blocks : [blocks]) {
        if (typeof block?.text === "string") textChunks.push(block.text);
        for (const annotation of block?.annotations ?? []) {
          const citation = annotation?.url_citation ?? annotation?.urlCitation;
          if (!citation) continue;
          const chunkIndex = sources.length;
          sources.push({
            chunkIndex,
            origin: "tool_metadata",
            uri: citation.url ?? null,
            title: citation.title ?? null,
            // An annotation points at a span of the model's own text. It is a
            // pointer, not the fetched source body.
            evidenceKind: "tool_metadata_only",
            excerpt: null,
          });
          supports.push({
            origin: "tool_metadata",
            segment: {
              startIndex: citation.start_index ?? citation.startIndex ?? null,
              endIndex: citation.end_index ?? citation.endIndex ?? null,
            },
            groundingChunkIndices: [chunkIndex],
          });
        }
      }
    }

    // `google_search_result` carries search suggestions, which are provider
    // chrome for display. They are deliberately not pushed into `supports`:
    // that list means "this span of output rests on these sources", and an
    // entry with no source indices would read as an unsupported claim.
  });

  const searchSuggestionsPresent = steps.some(
    (step) => (step?.type ?? step?.step_type) === "google_search_result"
      && Array.isArray(step?.search_suggestions) && step.search_suggestions.length > 0,
  );

  return {
    candidateIndex: 0,
    finishReason: response?.finish_reason ?? response?.finishReason ?? null,
    modelText: { origin: "model_output", value: textChunks.join("\n") },
    sources,
    supports,
    searchQueries,
    searchEntryPointPresent: searchSuggestionsPresent,
    urlRetrieval,
  };
}

/**
 * Extract evidence, keeping every candidate separate.
 *
 * `candidates` is an array even when there is one, because the previous
 * version concatenated every candidate's text and then attached only the first
 * candidate's citations to the result — which reads as though the citations
 * covered all of it.
 */
export function extractEvidence(response) {
  const hasSteps = Array.isArray(response?.steps) && response.steps.length > 0;
  const rawCandidates = Array.isArray(response?.candidates) ? response.candidates : [];

  const candidates = hasSteps
    ? [readStepShape(response)]
    : rawCandidates.map((candidate, index) => readClassicCandidate(candidate, index));

  // Kept for the honest case where a response matched neither shape, so a
  // caller can tell "no evidence" from "we did not understand the payload".
  const shape = hasSteps ? "interactions_steps" : rawCandidates.length > 0 ? "generate_content_candidates" : "unrecognised";

  return {
    shape,
    candidates,
    promptFeedback: response?.promptFeedback ?? null,
    usageMetadata: response?.usageMetadata ?? null,
    modelVersion: response?.modelVersion ?? null,
    // A top-level block is still reported when present, but labelled, so it is
    // never silently merged into a candidate's retrieval record.
    topLevelUrlRetrieval: readUrlRetrieval(response?.urlContextMetadata ?? response?.url_context_metadata),
  };
}

/** Total sources across candidates, for probe verdicts that need a count. */
export function countSources(extracted) {
  return extracted.candidates.reduce((total, candidate) => total + candidate.sources.length, 0);
}

/**
 * Whether any source carries text the provider says it retrieved.
 *
 * Separated from `countSources` because "there are citations" and "there is a
 * quotable excerpt" are different claims, and conflating them is what turns a
 * bare URL into apparent proof.
 */
export function hasRetrievedExcerpt(extracted) {
  return extracted.candidates.some((candidate) =>
    candidate.sources.some((source) => source.evidenceKind === "retrieved_excerpt"));
}

/** Candidates that were cut short or blocked, which must never read as success. */
export function incompleteCandidates(extracted) {
  const acceptable = new Set(["STOP", "MAX_TOKENS", null]);
  return extracted.candidates
    .filter((candidate) => !acceptable.has(candidate.finishReason))
    .map((candidate) => ({ candidateIndex: candidate.candidateIndex, finishReason: candidate.finishReason }));
}

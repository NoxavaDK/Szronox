/**
 * Turn a generateContent response into evidence with its provenance attached.
 *
 * Four things must never blur together:
 *
 *   model_output      - text the model wrote. Never evidence of anything.
 *   tool_metadata     - a URL or title the provider's tooling reported.
 *   retrieved_excerpt - text the provider says it actually fetched.
 *   synthetic_fixture - authored locally; evidence of parsing, nothing else.
 *
 * C03 corrections applied here (independent review T03-independent-review.md):
 *
 *  G4a  Citation coordinates are no longer taken from flattened text. Parts are
 *       kept indexed and a Segment is resolved against its own part using BYTE
 *       offsets, per the Segment reference (partIndex + byte offsets within a
 *       part). The previous version joined parts with "\n" and then applied the
 *       provider's untouched offsets to that synthetic string, silently shifting
 *       every citation in a multi-part or non-ASCII response.
 *  G4b  The Interactions/steps branch is QUARANTINED. This harness calls exactly
 *       one endpoint, models/{model}:generateContent. The steps shape belongs to
 *       a different endpoint, is not parsed as evidence, and is never counted.
 *  G5   Candidate usability is explicit. A blocked or truncated candidate is not
 *       a usable answer even when it happens to carry parseable content.
 *
 * Endpoint/response provenance: ai.google.dev/api/generate-content, accessed
 * 2026-09-14. See src/endpoint.mjs for the pinned request/response contract.
 */

/**
 * finishReason -> usability. `STOP` is the only reason that yields a complete
 * answer. `MAX_TOKENS` is a truncation: bytes arrived, the answer did not.
 * Everything else is a block.
 *
 * The previous `incompleteCandidates` treated MAX_TOKENS as acceptable, which is
 * how a truncated response reached a semantic verdict (G5).
 */
const BLOCKED_REASONS = new Set([
  "SAFETY", "RECITATION", "PROHIBITED_CONTENT", "SPII", "BLOCKLIST", "OTHER",
  "IMAGE_SAFETY", "IMAGE_RECITATION", "IMAGE_PROHIBITED_CONTENT", "IMAGE_OTHER",
]);

function usabilityOf(finishReason, hasText) {
  if (finishReason === null || finishReason === undefined) {
    return hasText
      ? { usable: true, state: "complete", reason: "no finishReason reported; text present" }
      : { usable: false, state: "empty", reason: "no finishReason and no text" };
  }
  if (finishReason === "STOP") {
    return hasText
      ? { usable: true, state: "complete", reason: "STOP" }
      : { usable: false, state: "empty", reason: "STOP with no text content" };
  }
  if (finishReason === "MAX_TOKENS") {
    return { usable: false, state: "truncated", reason: "MAX_TOKENS: output was cut off mid-answer" };
  }
  if (BLOCKED_REASONS.has(finishReason)) {
    return { usable: false, state: "blocked", reason: `blocked: ${finishReason}` };
  }
  return { usable: false, state: "unknown_finish_reason", reason: `unrecognised finishReason: ${finishReason}` };
}

/** Keep parts indexed and measured. Byte length is what Segment offsets index. */
function readParts(candidate) {
  const raw = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  return raw
    .map((part, partIndex) => ({ partIndex, text: typeof part?.text === "string" ? part.text : null }))
    .filter((part) => part.text !== null)
    .map((part) => ({ ...part, byteLength: Buffer.byteLength(part.text, "utf8") }));
}

function readSources(grounding) {
  return (grounding?.groundingChunks ?? []).flatMap((chunk, chunkIndex) => {
    const web = chunk?.web ?? chunk?.retrievedContext;
    if (!web) return [];
    const excerpt = typeof web.text === "string" && web.text.length > 0 ? web.text : null;
    return [{
      chunkIndex,
      origin: "tool_metadata",
      uri: web.uri ?? null,
      title: web.title ?? null,
      // Grounding URIs are provider redirect links, not publisher URLs.
      uriIsProviderRedirect: typeof web.uri === "string" && web.uri.includes("vertexaisearch.cloud.google.com"),
      // A reference is not a quotation. Saying so explicitly is what stops a
      // bare URL being read as supporting text.
      evidenceKind: excerpt ? "retrieved_excerpt" : "tool_metadata_only",
      excerpt,
    }];
  });
}

/**
 * Supports keep their own coordinate system. `partIndex` defaults to 0 only
 * because the reference documents that default; the offset unit is recorded so
 * no consumer can mistake these for JavaScript string indices.
 */
function readSupports(grounding) {
  return (grounding?.groundingSupports ?? []).map((support) => {
    const segment = support?.segment ?? null;
    return {
      origin: "tool_metadata",
      segment: segment
        ? {
            partIndex: Number.isInteger(segment.partIndex) ? segment.partIndex : 0,
            startIndex: Number.isInteger(segment.startIndex) ? segment.startIndex : null,
            endIndex: Number.isInteger(segment.endIndex) ? segment.endIndex : null,
            // Provider-supplied convenience copy; NOT the coordinate system.
            text: typeof segment.text === "string" ? segment.text : null,
            offsetUnit: "utf8_bytes_within_part",
          }
        : null,
      groundingChunkIndices: Array.isArray(support?.groundingChunkIndices) ? support.groundingChunkIndices : [],
    };
  });
}

/**
 * The documented `UrlRetrievalStatus` enum, exactly.
 *
 * C04/C03-R2: the previous version recognised statuses by prefix and suffix
 * pattern, which is not enum validation. `BOGUS_SUCCESS` matched `/_SUCCESS$/`
 * and passed accessible retrieval; `URL_RETRIEVAL_STATUS_NEW_UNKNOWN` matched the
 * prefix, was not SUCCESS and not UNSPECIFIED, and so passed as a *reported
 * failure*. Both were false evidence.
 *
 * Membership is now exact. An unrecognised value is preserved verbatim and leaves
 * the capability unverified, so a future enum addition degrades to "unknown"
 * rather than to a spurious pass.
 *
 * Values and ordinals confirmed 2026-09-14 against the generativelanguage
 * protobuf reference: UNSPECIFIED(0), SUCCESS(1), ERROR(2), PAYWALL(3), UNSAFE(4).
 * https://ai.google.dev/api/generate-content#UrlRetrievalStatus
 */
export const URL_RETRIEVAL_SUCCESS = "URL_RETRIEVAL_STATUS_SUCCESS";
export const URL_RETRIEVAL_UNSPECIFIED = "URL_RETRIEVAL_STATUS_UNSPECIFIED";
export const URL_RETRIEVAL_FAILURES = new Set([
  "URL_RETRIEVAL_STATUS_ERROR",
  "URL_RETRIEVAL_STATUS_PAYWALL",
  "URL_RETRIEVAL_STATUS_UNSAFE",
]);

function readUrlRetrieval(metadata) {
  const entries = metadata?.urlMetadata ?? metadata?.url_metadata ?? [];
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const status = entry?.urlRetrievalStatus ?? entry?.url_retrieval_status ?? null;
    const success = status === URL_RETRIEVAL_SUCCESS;
    const failed = typeof status === "string" && URL_RETRIEVAL_FAILURES.has(status);
    // UNSPECIFIED is a documented value but reports nothing either way.
    const recognised = success || failed || status === URL_RETRIEVAL_UNSPECIFIED;
    return {
      origin: "tool_metadata",
      url: entry?.retrievedUrl ?? entry?.retrieved_url ?? null,
      // Preserved exactly as received, recognised or not.
      status,
      statusRecognised: recognised,
      retrieved: success,
      // A failure must be one of the documented failure values, never inferred
      // from "not success".
      retrievalFailed: failed,
    };
  });
}

function readCandidate(candidate, index) {
  const parts = readParts(candidate);
  const grounding = candidate?.groundingMetadata ?? null;
  const joined = parts.map((part) => part.text).join("");
  const finishReason = candidate?.finishReason ?? null;

  return {
    candidateIndex: index,
    finishReason,
    usability: usabilityOf(finishReason, joined.trim().length > 0),
    // Indexed parts are the citation coordinate system.
    parts,
    modelText: {
      origin: "model_output",
      value: joined,
      // Concatenated without separators for display only. Never index into this
      // with provider offsets; use resolveSegmentText.
      concatenatedForDisplayOnly: true,
    },
    sources: readSources(grounding),
    supports: readSupports(grounding),
    searchQueries: Array.isArray(grounding?.webSearchQueries) ? grounding.webSearchQueries : [],
    searchEntryPointPresent: Boolean(grounding?.searchEntryPoint),
    // Candidate-scoped. Reading this from the response top level attributed one
    // candidate's retrieval status to all of them.
    urlRetrieval: readUrlRetrieval(candidate?.urlContextMetadata ?? candidate?.url_context_metadata),
  };
}

/**
 * Resolve a grounding support back to the exact text it cites.
 *
 * This is the G4 fix in one function: the offsets belong to ONE part and are
 * counted in UTF-8 bytes. Returning a typed failure rather than a wrong slice is
 * the point — a citation that cannot be resolved must not silently become a
 * plausible-looking quotation.
 */
export function resolveSegmentText(candidate, segment) {
  if (!segment) return { ok: false, reason: "no_segment" };
  const part = candidate?.parts?.find((entry) => entry.partIndex === (segment.partIndex ?? 0));
  if (!part) return { ok: false, reason: "part_index_out_of_range", partIndex: segment.partIndex ?? 0 };

  const { startIndex, endIndex } = segment;
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) {
    return { ok: false, reason: "missing_offsets" };
  }
  const bytes = Buffer.from(part.text, "utf8");
  if (startIndex < 0 || endIndex > bytes.length || startIndex > endIndex) {
    return { ok: false, reason: "offset_out_of_range", partByteLength: bytes.length, startIndex, endIndex };
  }

  const slice = bytes.subarray(startIndex, endIndex);
  const text = slice.toString("utf8");

  // C04/C03-R3: a numerically valid range can still split a multibyte character.
  // `Buffer.toString` silently substitutes U+FFFD, so `ą` with bytes [1,2) used to
  // return ok:true and a replacement character — corrupted success, exactly what
  // the typed-failure contract exists to prevent.
  //
  // The check is a re-encode round trip rather than scanning the output for
  // U+FFFD: a part whose source text genuinely contains a literal replacement
  // character re-encodes identically and is correctly accepted.
  if (!Buffer.from(text, "utf8").equals(slice)) {
    return {
      ok: false,
      reason: "invalid_utf8_boundary",
      detail: "byte range splits a multibyte character",
      partIndex: part.partIndex, startIndex, endIndex,
    };
  }
  return { ok: true, text, partIndex: part.partIndex };
}

/**
 * Validate a candidate's grounding supports as actual evidence relationships.
 *
 * C04/C03-R1: the probes previously counted `supports.length`. A support naming
 * `partIndex: 99` and `groundingChunkIndices: [999]` therefore proved grounding
 * even though neither the cited part nor the referenced source existed. Array
 * length is not a relationship.
 *
 * A support counts only when all of the following hold, all scoped to THIS
 * candidate:
 *   - it carries a segment,
 *   - every chunk index it names refers to a source that exists here,
 *   - its coordinates resolve (valid part, in-range, whole characters),
 *   - the resolved span is non-empty.
 *
 * Invalid supports are returned with a reason rather than dropped, so a verdict
 * can report why evidence was refused.
 */
export function validateSupports(candidate) {
  const sources = candidate?.sources ?? [];
  const known = new Set(sources.map((source) => source.chunkIndex));
  const valid = [];
  const invalid = [];

  for (const [position, support] of (candidate?.supports ?? []).entries()) {
    const indices = support?.groundingChunkIndices ?? [];
    if (!support?.segment) {
      invalid.push({ position, reason: "missing_segment" });
      continue;
    }
    if (indices.length === 0) {
      invalid.push({ position, reason: "no_source_reference" });
      continue;
    }
    const dangling = indices.filter((index) => !known.has(index));
    if (dangling.length > 0) {
      invalid.push({ position, reason: "dangling_source_reference", danglingIndices: dangling });
      continue;
    }
    const resolved = resolveSegmentText(candidate, support.segment);
    if (!resolved.ok) {
      invalid.push({ position, reason: `unresolvable_segment:${resolved.reason}` });
      continue;
    }
    if (resolved.text.length === 0) {
      invalid.push({ position, reason: "empty_span" });
      continue;
    }
    valid.push({ position, groundingChunkIndices: indices, resolvedText: resolved.text, partIndex: resolved.partIndex });
  }

  return { valid, invalid, validCount: valid.length, invalidCount: invalid.length };
}

/** Sources on ONE candidate that actually carry retrieved text. */
export function candidateHasRetrievedExcerpt(candidate) {
  return (candidate?.sources ?? []).some((source) => source.evidenceKind === "retrieved_excerpt");
}

/**
 * G4b — quarantine, do not parse.
 *
 * A `steps` payload comes from the Interactions endpoint, which this harness
 * does not call. Recording that it was seen is useful; treating it as evidence
 * for generateContent would be a category error. The historical fixture is kept
 * for provenance only.
 */
function quarantineUnsupportedShape(response) {
  const steps = Array.isArray(response?.steps) ? response.steps : [];
  return {
    reason: "unsupported_response_shape",
    detail:
      "Payload carries a `steps` array, which is the Interactions endpoint shape. " +
      "This harness calls models/{model}:generateContent only. The payload is recorded, " +
      "not parsed, and contributes no evidence.",
    stepTypes: steps.map((step) => step?.type ?? step?.step_type ?? null),
    stepCount: steps.length,
  };
}

export function extractEvidence(response) {
  const hasSteps = Array.isArray(response?.steps) && response.steps.length > 0;
  const rawCandidates = Array.isArray(response?.candidates) ? response.candidates : [];

  if (hasSteps && rawCandidates.length === 0) {
    return {
      shape: "quarantined_unsupported_shape",
      candidates: [],
      quarantined: quarantineUnsupportedShape(response),
      promptFeedback: response?.promptFeedback ?? null,
      promptBlockReason: response?.promptFeedback?.blockReason ?? null,
      usageMetadata: response?.usageMetadata ?? null,
      modelVersion: response?.modelVersion ?? null,
      topLevelUrlRetrieval: readUrlRetrieval(response?.urlContextMetadata ?? response?.url_context_metadata),
    };
  }

  return {
    shape: rawCandidates.length > 0 ? "generate_content_candidates" : "unrecognised",
    candidates: rawCandidates.map((candidate, index) => readCandidate(candidate, index)),
    quarantined: hasSteps ? quarantineUnsupportedShape(response) : null,
    promptFeedback: response?.promptFeedback ?? null,
    promptBlockReason: response?.promptFeedback?.blockReason ?? null,
    usageMetadata: response?.usageMetadata ?? null,
    modelVersion: response?.modelVersion ?? null,
    // Recorded, but never merged into a candidate's retrieval record. Metadata
    // with no candidate scope cannot support a candidate-scoped claim (G1).
    topLevelUrlRetrieval: readUrlRetrieval(response?.urlContextMetadata ?? response?.url_context_metadata),
  };
}

/** The candidate a semantic probe may judge, or null when none is usable (G5). */
export function usableCandidate(extracted) {
  if (extracted?.promptBlockReason) return null;
  return extracted?.candidates?.find((candidate) => candidate.usability.usable) ?? null;
}

/** Why no candidate was usable, for an honest verdict message. */
export function unusableSummary(extracted) {
  if (extracted?.promptBlockReason) {
    return `prompt blocked before generation: ${extracted.promptBlockReason}`;
  }
  const states = (extracted?.candidates ?? []).map((c) => `#${c.candidateIndex}:${c.usability.state}`);
  return states.length > 0 ? `no usable candidate (${states.join(", ")})` : "no candidates returned";
}

/** Sources on ONE candidate. Cross-candidate totals cannot support a claim (G1). */
export function candidateSourceCount(candidate) {
  return candidate?.sources?.length ?? 0;
}

export function hasRetrievedExcerpt(extracted) {
  return (extracted?.candidates ?? []).some((candidate) =>
    candidate.sources.some((source) => source.evidenceKind === "retrieved_excerpt"));
}

/** Candidates that were blocked or truncated, i.e. must never read as success. */
export function incompleteCandidates(extracted) {
  return (extracted?.candidates ?? [])
    .filter((candidate) => !candidate.usability.usable)
    .map((candidate) => ({
      candidateIndex: candidate.candidateIndex,
      finishReason: candidate.finishReason,
      state: candidate.usability.state,
    }));
}

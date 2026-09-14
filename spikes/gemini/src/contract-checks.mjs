/**
 * Application-shaped checks against a *synthetic* model result.
 *
 * These are local guards the future adapter would need. They are emphatically
 * not evidence about Gemini. Passing them means "if a model returned this
 * shape, our own validation would catch the interesting mistakes" — it says
 * nothing about whether Gemini enforces foreign keys (it cannot), respects a
 * schema (separately probed), or states true things (not testable here).
 *
 * Shapes follow `packages/contracts/src/index.ts` as read on 2026-09-13. This
 * module proposes no contract change and imports nothing from the workspace,
 * so the spike stays standalone.
 */

/** Hooks must survive a round trip intact: ids, order and authorship. */
export function checkHooksPreserved(inputHooks, returnedHooks) {
  const errors = [];
  const inputById = new Map(inputHooks.map((hook) => [hook.id, hook]));

  for (const hook of inputHooks) {
    const returned = returnedHooks.find((candidate) => candidate.id === hook.id);
    if (!returned) {
      // The invariant is that generation *appends*; a missing input hook means
      // something replaced rather than added.
      errors.push(`hook ${hook.id}: present in input snapshot but absent from result`);
      continue;
    }
    if (returned.text !== hook.text) errors.push(`hook ${hook.id}: text was modified`);
    if (returned.source !== hook.source) errors.push(`hook ${hook.id}: source changed from ${hook.source} to ${returned.source}`);
    if (returned.position !== hook.position) errors.push(`hook ${hook.id}: position changed from ${hook.position} to ${returned.position}`);
  }

  for (const returned of returnedHooks) {
    if (!inputById.has(returned.id) && returned.source !== "ai") {
      errors.push(`hook ${returned.id}: new hook must be attributed to source "ai"`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Requested generation appends alternatives, and not without limit.
 *
 * T00: "Opracuj proposes up to three additional hook texts... its initial
 * contract allows up to three additions per successful call, not a cap on total
 * hooks." So the bound is per call, and it is three.
 */
export function checkHookAdditionsBounded(hookAdditions, { maxAdditions = 3 } = {}) {
  const errors = [];
  if (!Array.isArray(hookAdditions)) {
    return { valid: false, errors: ["hookAdditions: expected an array"] };
  }
  if (hookAdditions.length > maxAdditions) {
    errors.push(`hookAdditions: ${hookAdditions.length} additions exceeds the bound of ${maxAdditions}`);
  }
  hookAdditions.forEach((text, index) => {
    if (typeof text !== "string" || text.trim() === "") {
      errors.push(`hookAdditions[${index}]: expected non-empty text`);
    }
  });
  return { valid: errors.length === 0, errors };
}

/**
 * At most one meme suggestion, and only from the supplied candidates.
 *
 * A model cannot create a library record, so an id outside the candidate set
 * is an invented reference and must be rejected rather than attached. This is
 * a local check: it proves our validation rejects the id, not that Gemini
 * declined to invent one.
 */
export function checkMemeSuggestion(suggestion, memeCandidateIds) {
  const errors = [];
  if (suggestion === null || suggestion === undefined) {
    return { valid: true, errors: [], accepted: null };
  }
  if (Array.isArray(suggestion)) {
    return { valid: false, errors: ["memeSuggestion: at most one suggestion is permitted"], accepted: null };
  }
  if (typeof suggestion.memeId !== "string" || suggestion.memeId === "") {
    errors.push("memeSuggestion.memeId: expected a non-empty id");
  } else if (!memeCandidateIds.includes(suggestion.memeId)) {
    errors.push(`memeSuggestion.memeId: ${suggestion.memeId} is not among the supplied candidates`);
  }
  if (typeof suggestion.rationale !== "string" || suggestion.rationale.trim() === "") {
    errors.push("memeSuggestion.rationale: expected a non-empty rationale");
  }
  if (suggestion.relevantFragment !== undefined && typeof suggestion.relevantFragment !== "string") {
    errors.push("memeSuggestion.relevantFragment: expected a string when present");
  }
  return { valid: errors.length === 0, errors, accepted: errors.length === 0 ? suggestion : null };
}

/**
 * Fact-check claims must point at a real location in the reviewed material.
 *
 * All active hooks plus the script are in scope, so a claim citing a hook id
 * that was never supplied is unattributable and cannot be shown against
 * anything.
 */
export function checkClaimLocations(claims, { hookIds }) {
  const errors = [];
  claims.forEach((claim, index) => {
    const location = claim?.location;
    if (!location || typeof location !== "object") {
      errors.push(`claims[${index}].location: missing`);
      return;
    }
    if (location.field === "script") return;
    if (location.field === "hook") {
      if (!hookIds.includes(location.hookId)) {
        errors.push(`claims[${index}].location.hookId: ${location.hookId} was not part of the reviewed hooks`);
      }
      return;
    }
    errors.push(`claims[${index}].location.field: expected "script" or "hook", received ${String(location.field)}`);
  });
  return { valid: errors.length === 0, errors };
}

/**
 * Every claim's cited sources must exist in the result's own source list.
 *
 * Also reports how many sources carry an actual excerpt, because a claim
 * supported only by `tool_metadata_only` sources is supported by a URL, not by
 * anything anyone can read.
 */
export function checkSourceReferences(claims, sources) {
  const errors = [];
  const byId = new Map(sources.map((source) => [source.id, source]));
  let excerptBacked = 0;

  claims.forEach((claim, index) => {
    for (const sourceId of claim?.sourceIds ?? []) {
      if (!byId.has(sourceId)) {
        errors.push(`claims[${index}].sourceIds: ${sourceId} does not exist in sources`);
      }
    }
    const backing = (claim?.sourceIds ?? []).map((id) => byId.get(id)).filter(Boolean);
    if (backing.some((source) => source.evidenceKind === "retrieved_excerpt")) excerptBacked += 1;
    if (claim?.status === "confirmed" && backing.length === 0) {
      // "Confirmed" with nothing behind it is the exact overclaim this spike
      // exists to make visible.
      errors.push(`claims[${index}]: status "confirmed" with no cited source`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
    claimsWithExcerptBackedSource: excerptBacked,
    claimsTotal: claims.length,
  };
}

/** Run every application-shaped check over one synthetic result. */
export function runContractChecks({ inputSnapshot, result }) {
  const hookIds = inputSnapshot.hooks.map((hook) => hook.id);
  const checks = {
    hooksPreserved: checkHooksPreserved(inputSnapshot.hooks, result.hooks ?? inputSnapshot.hooks),
    hookAdditionsBounded: checkHookAdditionsBounded(result.hookAdditions ?? []),
    memeSuggestion: checkMemeSuggestion(result.memeSuggestion ?? null, inputSnapshot.memeCandidateIds),
    claimLocations: checkClaimLocations(result.claims ?? [], { hookIds }),
    sourceReferences: checkSourceReferences(result.claims ?? [], result.sources ?? []),
  };
  const failures = Object.entries(checks).filter(([, outcome]) => !outcome.valid).map(([name]) => name);
  return { valid: failures.length === 0, failures, checks };
}

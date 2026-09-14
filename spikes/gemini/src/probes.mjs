/**
 * Capability probes, each with its own verdict function.
 *
 * Three rules shape this file after the C03 corrections.
 *
 * First, a verdict is never "we received a response". Every PASS must name
 * provider-controlled evidence that is scoped to ONE usable candidate.
 *
 * Second — the G1 correction — **no error ever produces a PASS, and no error
 * produces a capability conclusion.** An authentication failure, a quota refusal,
 * a transport timeout and a rejected request all mean the same thing about the
 * capability under test: nothing. They resolve to `unverified` with the failure
 * recorded. Even an HTTP 400 is not proof of incompatibility, because the request
 * itself may be wrong (see endpoint.mjs on the schema field).
 *
 * Third — the G5 correction — a blocked or truncated candidate is never judged
 * semantically, even when it carries parseable content.
 *
 * Every prompt is neutral and marked DIAGNOSTIC ONLY. None of them is, or may
 * become, a SzroNox writing prompt.
 */

import { deflateSync } from "node:zlib";

import { ENDPOINT_CONTRACT, withResponseSchema } from "./endpoint.mjs";
import { parseModelJson, validateAgainstSchema } from "./schema.mjs";
import {
  candidateSourceCount,
  hasRetrievedExcerpt,
  unusableSummary,
  usableCandidate,
} from "./evidence.mjs";

const QUADRANTS = [
  { name: "red", rgb: [220, 40, 40] },
  { name: "green", rgb: [40, 170, 70] },
  { name: "blue", rgb: [40, 80, 210] },
  { name: "white", rgb: [245, 245, 245] },
];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** Built at runtime so the expected answer and the pixels share one source. */
export function buildQuadrantPng(size = 64) {
  const half = size / 2;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // per-scanline filter: none
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = QUADRANTS[(y < half ? 0 : 2) + (x < half ? 0 : 1)].rgb;
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b;
      offset += 3;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;  // bit depth
  header[9] = 2;  // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const QUADRANT_EXPECTATION = {
  topLeft: "red", topRight: "green", bottomLeft: "blue", bottomRight: "white",
};

const COLOUR_NAMES = QUADRANTS.map((q) => q.name);

/**
 * G5: a checkable answer shape replaces substring matching. The previous
 * predicate passed any prose containing the four colour words in order —
 * including a sentence denying it could see the image.
 */
const QUADRANT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topLeft", "topRight", "bottomLeft", "bottomRight"],
  properties: Object.fromEntries(
    ["topLeft", "topRight", "bottomLeft", "bottomRight"].map((key) => [key, { type: "string", enum: COLOUR_NAMES }]),
  ),
};

const STRUCTURED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["classification", "confidence"],
  properties: {
    classification: { type: "string", enum: ["solid", "liquid", "gas"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

const GROUNDED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "citedUrls"],
  properties: {
    answer: { type: "string", minLength: 1 },
    citedUrls: { type: "array", items: { type: "string" }, maxItems: 5 },
  },
};

const ACCESSIBLE_URL = "https://example.com/";
/** RFC 2606 reserved: cannot resolve, cannot reach a private network. */
const UNAVAILABLE_URL = "https://t03-diagnostic.invalid/page";

const pass = (summary, detail = {}) => ({ verdict: "pass", summary, ...detail });
const fail = (summary, detail = {}) => ({ verdict: "fail", summary, ...detail });
const unverified = (summary, detail = {}) => ({ verdict: "unverified", summary, ...detail });

/**
 * G1 — the single place that decides what a provider/transport failure proves.
 * The answer is always: nothing about the capability.
 */
function errorVerdict(error, capability) {
  const category = error?.category ?? "local_error";
  const explanations = {
    authentication_or_permission:
      "Authentication or permission failed. The capability was never exercised.",
    quota_or_rate_limit:
      "The request was refused for quota or rate limits. The capability was never exercised.",
    provider_transient:
      "The provider failed transiently. No capability conclusion follows.",
    transport_timeout:
      "The request timed out in transport. No capability conclusion follows.",
    transport_network:
      "The connection failed. No capability conclusion follows.",
    transport_unknown:
      "An unrecognised transport failure occurred. No capability conclusion follows.",
    malformed_success:
      "The provider answered with an unusable body. The capability is unproven.",
    request_or_content:
      "The provider rejected the request. This may be a malformed request on our side " +
      "(for example the structured-output field pairing) rather than a missing capability, " +
      "so it is NOT recorded as incompatibility.",
  };
  return unverified(`${capability} unverified: ${explanations[category] ?? "The call failed."}`, {
    error: { category, code: error?.code ?? null, status: error?.status ?? null, retryable: Boolean(error?.retryable) },
    capabilityConclusion: "none",
  });
}

/** Compare a reported retrieval URL against the URL the probe actually asked for. */
function sameUrl(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  try { return new URL(a).href === new URL(b).href; } catch { return a === b; }
}

/** Retrieval records on the usable candidate that concern the requested URL. */
function retrievalForRequested(candidate, requestedUrl) {
  return (candidate?.urlRetrieval ?? []).filter((entry) => sameUrl(entry.url, requestedUrl));
}

/** Guard every semantic probe: no usable candidate means no semantic verdict (G5). */
function requireUsable(extracted) {
  const candidate = usableCandidate(extracted);
  if (candidate) return { candidate, blocked: null };
  return {
    candidate: null,
    blocked: unverified(`No usable candidate to judge: ${unusableSummary(extracted)}.`, {
      candidates: (extracted?.candidates ?? []).map((c) => ({
        candidateIndex: c.candidateIndex, finishReason: c.finishReason, state: c.usability.state,
      })),
      promptBlockReason: extracted?.promptBlockReason ?? null,
    }),
  };
}

function parseAndValidate(candidate, schema) {
  const parsed = parseModelJson(candidate.modelText.value);
  if (!parsed.ok) return { ok: false, stage: "parse", detail: parsed.detail, reason: parsed.reason };
  const validation = validateAgainstSchema(parsed.value, schema);
  if (!validation.valid) return { ok: false, stage: "schema", errors: validation.errors, value: parsed.value };
  // Partial validation must not read as full conformance.
  return {
    ok: true,
    value: parsed.value,
    unsupportedChecks: validation.unsupported,
    fullyValidated: validation.unsupported.length === 0,
  };
}

export function buildProbes() {
  const imageBase64 = buildQuadrantPng().toString("base64");

  return [
    {
      id: "multimodal_transport",
      capability: "Inline image transport",
      question: "Does the endpoint accept inline image bytes at all?",
      request: {
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/png", data: imageBase64 } },
            { text: "DIAGNOSTIC ONLY. Reply with the single word: received." },
          ],
        }],
      },
      verdict(extracted, { error } = {}) {
        if (error) return errorVerdict(error, "Inline image transport");
        if ((extracted.candidates ?? []).length === 0) return fail("No candidate returned.");
        // Deliberately narrow. Transport acceptance is exactly what a blocked or
        // truncated candidate still demonstrates: the bytes were accepted.
        const first = extracted.candidates[0];
        return pass("Endpoint accepted inline PNG bytes and returned a candidate.", {
          candidateState: first.usability.state,
          limitation: "Transport acceptance only. Not evidence of image understanding.",
        });
      },
    },

    {
      id: "multimodal_comprehension",
      capability: "Image comprehension",
      question: "Can the model actually read a simple image, not merely accept it?",
      request: {
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/png", data: imageBase64 } },
            {
              text: "DIAGNOSTIC ONLY. This image has four equal quadrants, each a solid colour. "
                + "Report the colour of each quadrant as JSON with keys topLeft, topRight, bottomLeft, bottomRight. "
                + `Each value must be exactly one of: ${COLOUR_NAMES.join(", ")}.`,
            },
          ],
        }],
        generationConfig: withResponseSchema({}, QUADRANT_SCHEMA),
      },
      schema: QUADRANT_SCHEMA,
      verdict(extracted, { error } = {}) {
        if (error) return errorVerdict(error, "Image comprehension");
        const { candidate, blocked } = requireUsable(extracted);
        if (blocked) return blocked;

        const result = parseAndValidate(candidate, QUADRANT_SCHEMA);
        if (!result.ok) {
          // Format non-compliance cannot be separated from comprehension here, so
          // this is unverified rather than a comprehension failure.
          return unverified("Answer did not arrive in the checkable quadrant shape, so comprehension could not be assessed.", {
            stage: result.stage, detail: result.detail ?? null, errors: result.errors ?? null,
          });
        }
        const wrong = Object.entries(QUADRANT_EXPECTATION)
          .filter(([key, colour]) => result.value[key] !== colour)
          .map(([key, colour]) => ({ quadrant: key, expected: colour, received: result.value[key] }));
        return wrong.length === 0
          ? pass("Model reported every quadrant colour correctly in a checkable shape.", {
              answer: result.value,
              limitation: "A synthetic four-colour image is a floor, not evidence of screenshot or chart comprehension.",
            })
          : fail("Model returned a well-formed answer with incorrect quadrant colours.", { wrong, answer: result.value });
      },
    },

    {
      id: "url_context_accessible",
      capability: "URL retrieval (reachable URL)",
      question: "Does the provider report an actual successful retrieval for the requested reachable URL?",
      requestedUrl: ACCESSIBLE_URL,
      request: {
        contents: [{ role: "user", parts: [{ text: `DIAGNOSTIC ONLY. Retrieve ${ACCESSIBLE_URL} and state its page heading.` }] }],
        tools: [{ urlContext: {} }],
      },
      verdict(extracted, { error } = {}) {
        if (error) return errorVerdict(error, "URL retrieval");
        const { candidate, blocked } = requireUsable(extracted);
        if (blocked) return blocked;

        // G1: candidate-scoped, and matched to the URL we actually asked for.
        // Top-level metadata and other URLs cannot support this claim.
        const matching = retrievalForRequested(candidate, ACCESSIBLE_URL);
        if (matching.length === 0) {
          return unverified("No candidate-scoped retrieval record for the requested URL; model prose alone cannot establish retrieval.", {
            requestedUrl: ACCESSIBLE_URL,
            candidateRetrievalUrls: (candidate.urlRetrieval ?? []).map((entry) => entry.url),
            topLevelRetrievalIgnored: extracted.topLevelUrlRetrieval.length,
          });
        }
        const succeeded = matching.filter((entry) => entry.retrieved);
        if (succeeded.length > 0) {
          return pass("Provider reported a successful retrieval status for the requested URL.", { retrieval: matching });
        }
        const unrecognised = matching.filter((entry) => !entry.statusRecognised);
        if (unrecognised.length === matching.length) {
          return unverified("Retrieval status for the requested URL was not a recognised status value.", { retrieval: matching });
        }
        return fail("Provider returned retrieval metadata for the requested URL without a success status.", { retrieval: matching });
      },
    },

    {
      id: "url_context_unavailable",
      capability: "URL retrieval (unreachable URL)",
      question: "Is an unreachable URL reported as a retrieval failure rather than narrated as read?",
      requestedUrl: UNAVAILABLE_URL,
      request: {
        contents: [{ role: "user", parts: [{ text: `DIAGNOSTIC ONLY. Attempt to retrieve ${UNAVAILABLE_URL} and report whether retrieval succeeded.` }] }],
        tools: [{ urlContext: {} }],
      },
      verdict(extracted, { error } = {}) {
        // G1: a call-level error says nothing about URL retrieval behaviour. The
        // previous version returned PASS here, so an auth 403 "proved" correct
        // unreachable-URL handling.
        if (error) return errorVerdict(error, "Unreachable-URL handling");
        const { candidate, blocked } = requireUsable(extracted);
        if (blocked) return blocked;

        const matching = retrievalForRequested(candidate, UNAVAILABLE_URL);
        if (matching.length === 0) {
          return unverified("No candidate-scoped retrieval record for the requested URL; cannot distinguish failure from silent skip.", {
            requestedUrl: UNAVAILABLE_URL,
            candidateRetrievalUrls: (candidate.urlRetrieval ?? []).map((entry) => entry.url),
          });
        }
        if (matching.some((entry) => entry.retrieved)) {
          return fail("Provider reported successful retrieval for a URL that cannot resolve.", { retrieval: matching });
        }
        // A positively reported failure is the evidence. "Not success" is not:
        // an unspecified or unrecognised status proves nothing either way.
        const reportedFailure = matching.filter((entry) => entry.retrievalFailed);
        return reportedFailure.length > 0
          ? pass("Provider explicitly reported a retrieval failure for the requested URL.", { retrieval: matching })
          : unverified("Retrieval status was unspecified or unrecognised, which is not a reported failure.", { retrieval: matching });
      },
    },

    {
      id: "search_grounding",
      capability: "Google Search grounding",
      question: "Does a grounded answer come with executed queries and source references on the same candidate?",
      request: {
        contents: [{ role: "user", parts: [{ text: "DIAGNOSTIC ONLY. In one sentence, what is the current stable version number of the Node.js LTS release line?" }] }],
        tools: [{ googleSearch: {} }],
      },
      verdict(extracted, { error } = {}) {
        if (error) return errorVerdict(error, "Search grounding");
        const { candidate, blocked } = requireUsable(extracted);
        if (blocked) return blocked;

        // G1: everything below is read from ONE candidate. The previous version
        // summed sources across candidates while reading queries from the first,
        // so an ungrounded candidate could borrow a sibling's citations.
        const queries = candidate.searchQueries.length;
        const sources = candidateSourceCount(candidate);
        const supports = candidate.supports.length;
        const detail = { candidateIndex: candidate.candidateIndex, queries, sources, supports };

        if (queries === 0 && sources === 0) {
          return fail("No search execution metadata and no sources on the answering candidate; the answer is ungrounded.", detail);
        }
        if (sources === 0) return fail("Search ran but returned no source references on the answering candidate.", detail);
        if (queries === 0) {
          return unverified("Sources are present but no executed query is reported on this candidate, so search execution is unproven.", detail);
        }
        if (supports === 0) {
          return unverified("Queries and sources are present but nothing maps output spans to them.", detail);
        }
        return pass("Search executed and source references were attached on the answering candidate.", {
          ...detail,
          retrievedExcerptsPresent: hasRetrievedExcerpt(extracted),
          limitation: hasRetrievedExcerpt(extracted)
            ? "Excerpt text present."
            : "Sources are tool_metadata_only: URLs and titles, with no retrieved excerpt to quote.",
        });
      },
    },

    {
      id: "structured_output_alone",
      capability: "Structured output",
      question: "Does the requested schema actually constrain the response?",
      request: {
        contents: [{ role: "user", parts: [{ text: "DIAGNOSTIC ONLY. Classify water at 20 degrees Celsius and standard pressure." }] }],
        generationConfig: withResponseSchema({}, STRUCTURED_SCHEMA),
      },
      schema: STRUCTURED_SCHEMA,
      verdict(extracted, { error } = {}) {
        if (error) return errorVerdict(error, "Structured output");
        // G5: a SAFETY-blocked candidate carrying valid JSON used to pass here.
        const { candidate, blocked } = requireUsable(extracted);
        if (blocked) return blocked;

        const result = parseAndValidate(candidate, STRUCTURED_SCHEMA);
        if (!result.ok) {
          return result.stage === "parse"
            ? fail(`Response was not valid JSON (${result.reason}).`, { detail: result.detail })
            : fail("Response parsed but violated the requested schema.", { errors: result.errors, value: result.value });
        }
        return result.fullyValidated
          ? pass("Response parsed and satisfied every checked constraint of the requested schema.", { value: result.value })
          : unverified("Response satisfied the checks this validator supports, but the schema uses keywords it cannot check.", {
              value: result.value, unsupportedChecks: result.unsupportedChecks,
            });
      },
    },

    {
      id: "structured_output_with_search",
      capability: "Google Search grounding combined with structured output",
      question: "Are search grounding and a response schema usable together, with citations surviving?",
      modelExpectation:
        "Documented as a Gemini 3 series preview feature. On other models this may be rejected; a rejection " +
        "is a fact about the tested model, never a general Gemini capability claim.",
      request: {
        contents: [{ role: "user", parts: [{ text: "DIAGNOSTIC ONLY. In one sentence, state the current Node.js LTS version and list the URLs you used." }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: withResponseSchema({}, GROUNDED_SCHEMA),
      },
      schema: GROUNDED_SCHEMA,
      verdict(extracted, { error, model } = {}) {
        // G1: a transport timeout used to be reported as "model/endpoint does not
        // support this combination". No failure supports that conclusion.
        if (error) return errorVerdict(error, "Combined search and structured output");
        const { candidate, blocked } = requireUsable(extracted);
        if (blocked) return blocked;

        const result = parseAndValidate(candidate, GROUNDED_SCHEMA);
        if (!result.ok) {
          return result.stage === "parse"
            ? fail(`Combined request returned non-JSON (${result.reason}).`, { detail: result.detail })
            : fail("Combined response violated the schema.", { errors: result.errors, value: result.value });
        }

        // G1: the model's own citedUrls are model_output. They are never evidence
        // that grounding ran. Only provider metadata on THIS candidate counts.
        const queries = candidate.searchQueries.length;
        const sources = candidateSourceCount(candidate);
        const supports = candidate.supports.length;
        const detail = {
          model: model ?? null,
          candidateIndex: candidate.candidateIndex,
          queries, sources, supports,
          modelClaimedUrls: Array.isArray(result.value.citedUrls) ? result.value.citedUrls.length : 0,
          modelClaimedUrlsAreNotEvidence: true,
        };

        if (sources === 0 || queries === 0 || supports === 0) {
          return fail(
            "JSON validated, but the combination is unproven: the answering candidate lacks executed queries, "
            + "source references or span mappings. Model-supplied citedUrls do not substitute for provider metadata.",
            detail,
          );
        }
        return result.fullyValidated
          ? pass("Search grounding and the response schema applied together, with citations retained on the same candidate.", detail)
          : unverified("Grounding evidence is present, but the schema uses keywords this validator cannot check.", {
              ...detail, unsupportedChecks: result.unsupportedChecks,
            });
      },
    },
  ];
}

/** Probe ids in the order the runner executes them. */
export function probeIds() {
  return buildProbes().map((probe) => probe.id);
}

export { ENDPOINT_CONTRACT };

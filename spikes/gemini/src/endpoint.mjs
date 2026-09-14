/**
 * The one endpoint this harness calls, and its pinned request contract.
 *
 * C03 / G3. The earlier README claimed "two documented response surfaces" and
 * treated the difference between the Interactions guides and the generateContent
 * reference as uncertainty about what *this* endpoint returns. That was wrong:
 * they are two different endpoints. This harness calls exactly one:
 *
 *     POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *
 * The Interactions examples call `/interactions` and are not evidence about this
 * endpoint's responses. Their shape is quarantined in evidence.mjs, never parsed
 * as evidence.
 *
 * No production provider or model migration is approved by this file. It records
 * what the diagnostic sends and why, with provenance, so a reader can check the
 * request rather than infer it from a failure.
 */

export const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

/** Default diagnostic model. NOT a production editorial model decision. */
export const DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * Structured-output field pairing.
 *
 * Both fields exist on GenerationConfig:
 *
 *   responseSchema      a select subset of an OpenAPI 3.0 Schema object
 *   responseJsonSchema  a JSON Schema document
 *
 * The probes' schemas are written as JSON Schema, so they are sent in
 * `responseJsonSchema`. The previous version sent a JSON Schema document in
 * `responseSchema`.
 *
 * Honest nuance, recorded rather than glossed: the documented supported-property
 * list for `responseSchema` DOES include `additionalProperties`, so the previous
 * request was not self-evidently invalid. The correction that actually matters is
 * not which field is "right" — it is that the harness must never infer a provider
 * capability limit from a rejected request (G1/G3). Field choice is now explicit
 * and recorded on every result so a 400 can be diagnosed instead of guessed at.
 *
 * Sources, accessed 2026-09-14:
 *   https://ai.google.dev/api/generate-content
 *   https://ai.google.dev/gemini-api/docs/generate-content/structured-output
 */
export const STRUCTURED_OUTPUT_FIELD = "responseJsonSchema";

export const ENDPOINT_CONTRACT = {
  endpoint: "models.generateContent",
  apiVersion: "v1beta",
  method: "POST",
  documentedAt: "https://ai.google.dev/api/generate-content",
  accessed: "2026-09-14",
  requestFields: {
    tools: {
      googleSearch: "Tool.googleSearch — listed on the generateContent reference",
      urlContext: "Tool.urlContext — listed on the generateContent reference",
    },
    generationConfig: {
      responseMimeType: "application/json when a schema is requested",
      responseJsonSchema: "JSON Schema document (the field this harness uses)",
      responseSchema: "OpenAPI 3.0 subset; NOT used here, kept documented for contrast",
    },
  },
  responseShape: "candidates[] with content.parts, groundingMetadata, urlContextMetadata",
  notThisEndpoint: {
    interactions: "steps[] with inline url_citation annotations — different endpoint, quarantined",
  },
  combinedSearchAndSchema:
    "Documented as a Gemini 3 series preview feature. On other models the combination may be " +
    "rejected. A rejection observed on a specific model is a fact about that model; it is not " +
    "proof that the combination is unsupported generally, and a transport or auth failure proves " +
    "nothing about it at all.",
};

/** Build the URL for a model. Kept here so the endpoint is defined in one place. */
export function generateContentUrl(model) {
  return `${API_ROOT}/models/${encodeURIComponent(model)}:generateContent`;
}

/** Attach a JSON Schema to a request using the pinned field. */
export function withResponseSchema(generationConfig, schema) {
  return { ...generationConfig, responseMimeType: "application/json", [STRUCTURED_OUTPUT_FIELD]: schema };
}

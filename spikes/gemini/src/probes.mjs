/**
 * Capability probes, each with its own verdict function.
 *
 * Two rules shape this file.
 *
 * First, every probe decides its own PASS/FAIL/UNVERIFIED from evidence, not
 * from having received a response. "The call returned 200" is recorded, but it
 * is never a verdict — that conflation is what let a malformed body and an
 * ungrounded answer both look like success.
 *
 * Second, transport acceptance and understanding are separate probes. A model
 * accepting image bytes says nothing about whether it can read a screenshot,
 * so a one-pixel PNG cannot stand in for the second question. The image below
 * has four distinguishable quadrants precisely so a wrong answer is visible.
 *
 * Every prompt is neutral and marked DIAGNOSTIC ONLY. None of them is, or may
 * become, a SzroNox writing prompt.
 */

import { deflateSync } from "node:zlib";

import { parseModelJson, validateAgainstSchema } from "./schema.mjs";
import { countSources, hasRetrievedExcerpt, incompleteCandidates } from "./evidence.mjs";

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
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
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

/**
 * Build the quadrant test image at runtime.
 *
 * Generated rather than committed as a base64 blob so a reader can see exactly
 * what the model is being shown, and so the expected answer below is derived
 * from the same source as the pixels.
 */
export function buildQuadrantPng(size = 64) {
  const half = size / 2;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // per-scanline filter: none
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const quadrant = (y < half ? 0 : 2) + (x < half ? 0 : 1);
      const [r, g, b] = QUADRANTS[quadrant].rgb;
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b;
      offset += 3;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;   // bit depth
  header[9] = 2;   // colour type: truecolour
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

/** `unverified` is a first-class outcome: no evidence is not a failure to act on. */
const pass = (summary, detail = {}) => ({ verdict: "pass", summary, ...detail });
const fail = (summary, detail = {}) => ({ verdict: "fail", summary, ...detail });
const unverified = (summary, detail = {}) => ({ verdict: "unverified", summary, ...detail });

function firstCandidate(extracted) {
  return extracted.candidates[0] ?? null;
}

function modelTextOf(extracted) {
  return firstCandidate(extracted)?.modelText.value ?? "";
}

export function buildProbes() {
  const imageBase64 = buildQuadrantPng().toString("base64");

  return [
    {
      id: "multimodal_transport",
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
      verdict(extracted) {
        const blocked = incompleteCandidates(extracted);
        if (blocked.length > 0) return fail("Response was blocked or truncated.", { blocked });
        if (!firstCandidate(extracted)) return fail("No candidate returned.");
        // Deliberately narrow: this establishes transport, nothing more.
        return pass("Endpoint accepted inline PNG bytes and returned a candidate.", {
          limitation: "Transport acceptance only. This is not evidence of image understanding.",
        });
      },
    },
    {
      id: "multimodal_comprehension",
      question: "Can the model actually read a simple image, not merely accept it?",
      request: {
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/png", data: imageBase64 } },
            {
              text: "DIAGNOSTIC ONLY. This image has four equal quadrants, each a solid colour. "
                + "Name the colour of the top-left, top-right, bottom-left and bottom-right quadrant, in that order.",
            },
          ],
        }],
      },
      verdict(extracted) {
        const text = modelTextOf(extracted).toLowerCase();
        if (text.trim() === "") return fail("Model returned no text.");
        const order = ["topLeft", "topRight", "bottomLeft", "bottomRight"];
        const positions = order.map((key) => ({ key, colour: QUADRANT_EXPECTATION[key], at: text.indexOf(QUADRANT_EXPECTATION[key]) }));
        const missing = positions.filter((entry) => entry.at < 0).map((entry) => `${entry.key}=${entry.colour}`);
        if (missing.length > 0) return fail("Model did not name every expected colour.", { missing });
        // Order matters: naming all four colours in the wrong arrangement is
        // not comprehension, it is a lucky vocabulary match.
        const ordered = positions.every((entry, index) => index === 0 || entry.at > positions[index - 1].at);
        return ordered
          ? pass("Model named all four quadrant colours in the correct order.", {
              limitation: "A synthetic four-colour image is a floor, not evidence of screenshot or chart comprehension.",
            })
          : fail("Model named the colours but not in the requested quadrant order.", {
              observedOrder: positions.map((entry) => `${entry.key}@${entry.at}`),
            });
      },
    },
    {
      id: "url_context_accessible",
      question: "Does the provider report an actual successful retrieval for a reachable URL?",
      request: {
        contents: [{ role: "user", parts: [{ text: "DIAGNOSTIC ONLY. Retrieve https://example.com/ and state its page heading." }] }],
        tools: [{ urlContext: {} }],
      },
      verdict(extracted) {
        const retrieval = [...(firstCandidate(extracted)?.urlRetrieval ?? []), ...extracted.topLevelUrlRetrieval];
        if (retrieval.length === 0) {
          // The model may well describe the page from memory. That is not
          // retrieval, so the absence of metadata is decisive here.
          return unverified("No URL retrieval metadata returned; model prose alone cannot establish retrieval.", {
            modelTextPresent: modelTextOf(extracted).length > 0,
          });
        }
        const success = retrieval.filter((entry) => typeof entry.status === "string" && /SUCCESS/i.test(entry.status));
        return success.length > 0
          ? pass("Provider reported a successful retrieval status.", { retrieval })
          : fail("Provider returned retrieval metadata without a success status.", { retrieval });
      },
    },
    {
      id: "url_context_unavailable",
      question: "Is an unreachable URL reported as a failure rather than narrated as read?",
      request: {
        // `.invalid` is reserved by RFC 2606 and must never resolve, so this
        // cannot accidentally reach a real host or a private network.
        contents: [{ role: "user", parts: [{ text: "DIAGNOSTIC ONLY. Attempt to retrieve https://t03-diagnostic.invalid/page and report whether retrieval succeeded." }] }],
        tools: [{ urlContext: {} }],
      },
      verdict(extracted, { error } = {}) {
        if (error) {
          return pass("Provider surfaced an explicit error for an unreachable URL.", {
            errorCategory: error.category, retryable: error.retryable,
          });
        }
        const retrieval = [...(firstCandidate(extracted)?.urlRetrieval ?? []), ...extracted.topLevelUrlRetrieval];
        if (retrieval.length === 0) {
          return unverified("No retrieval metadata returned; cannot distinguish failure from silent skip.", {
            modelTextPresent: modelTextOf(extracted).length > 0,
          });
        }
        const failed = retrieval.filter((entry) => typeof entry.status === "string" && !/SUCCESS/i.test(entry.status));
        return failed.length > 0
          ? pass("Provider reported a non-success retrieval status.", { retrieval })
          : fail("Provider reported success for a URL that cannot resolve.", { retrieval });
      },
    },
    {
      id: "search_grounding",
      question: "Does a grounded answer come with executed queries and source references?",
      request: {
        contents: [{ role: "user", parts: [{ text: "DIAGNOSTIC ONLY. In one sentence, what is the current stable version number of the Node.js LTS release line?" }] }],
        tools: [{ googleSearch: {} }],
      },
      verdict(extracted) {
        const candidate = firstCandidate(extracted);
        if (!candidate) return fail("No candidate returned.");
        const sources = countSources(extracted);
        const queries = candidate.searchQueries.length;
        if (queries === 0 && sources === 0) {
          return fail("No search execution metadata and no sources; the answer is ungrounded.", {
            modelTextPresent: candidate.modelText.value.length > 0,
          });
        }
        if (sources === 0) {
          return fail("Search ran but returned no source references.", { queries });
        }
        return pass("Search executed and source references were attached.", {
          queries,
          sources,
          supports: candidate.supports.length,
          // The distinction the adapter has to live with: references are URLs,
          // not quotable text.
          retrievedExcerptsPresent: hasRetrievedExcerpt(extracted),
          limitation: hasRetrievedExcerpt(extracted)
            ? "Excerpt text present."
            : "Sources are tool_metadata_only: URLs and titles, with no retrieved excerpt to quote.",
        });
      },
    },
    {
      id: "structured_output_alone",
      question: "Does the requested schema actually constrain the response?",
      request: {
        contents: [{ role: "user", parts: [{ text: "DIAGNOSTIC ONLY. Classify water at 20 degrees Celsius and standard pressure." }] }],
        generationConfig: {
          // `responseSchema` is the field named on the generateContent
          // reference; `responseJsonSchema` was assumed by the earlier draft
          // and is not confirmed there. See README.
          responseMimeType: "application/json",
          responseSchema: STRUCTURED_SCHEMA,
        },
      },
      schema: STRUCTURED_SCHEMA,
      verdict(extracted) {
        const parsed = parseModelJson(modelTextOf(extracted));
        if (!parsed.ok) return fail(`Response was not valid JSON (${parsed.reason}).`, { detail: parsed.detail });
        const validation = validateAgainstSchema(parsed.value, STRUCTURED_SCHEMA);
        return validation.valid
          ? pass("Response parsed and satisfied the requested schema.", { value: parsed.value })
          : fail("Response parsed but violated the requested schema.", { errors: validation.errors, value: parsed.value });
      },
    },
    {
      id: "structured_output_with_search",
      question: "Are Google Search and a response schema usable together on this model?",
      request: {
        contents: [{ role: "user", parts: [{ text: "DIAGNOSTIC ONLY. In one sentence, state the current Node.js LTS version and list the URLs you used." }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { responseMimeType: "application/json", responseSchema: GROUNDED_SCHEMA },
      },
      schema: GROUNDED_SCHEMA,
      verdict(extracted, { error } = {}) {
        if (error) {
          // A rejection here is a real, useful compatibility answer for this
          // model and endpoint — not a diagnostic failure.
          return fail("Provider rejected combining search with a response schema.", {
            errorCategory: error.category,
            code: error.code,
            interpretation: "Model/endpoint does not support this combination; use the two-step probe.",
          });
        }
        const parsed = parseModelJson(modelTextOf(extracted));
        if (!parsed.ok) return fail(`Combined request returned non-JSON (${parsed.reason}).`, { detail: parsed.detail });
        const validation = validateAgainstSchema(parsed.value, GROUNDED_SCHEMA);
        if (!validation.valid) return fail("Combined response violated the schema.", { errors: validation.errors });
        return pass("Search and response schema were accepted together.", {
          sources: countSources(extracted),
          // Citations must survive the structuring step; dropping them to
          // obtain clean JSON would defeat the purpose.
          citationsRetained: countSources(extracted) > 0,
          value: parsed.value,
        });
      },
    },
  ];
}

/** Probe ids in the order the runner executes them. */
export function probeIds() {
  return buildProbes().map((probe) => probe.id);
}

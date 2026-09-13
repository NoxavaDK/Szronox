/**
 * Independent parsing and schema validation.
 *
 * Asking for a schema is not evidence the provider honoured one. The partial
 * spike recorded the structured-output response and stopped there, so a
 * response violating the requested shape would still have read as a result.
 * Everything here re-checks the response locally instead of trusting the
 * request configuration.
 *
 * This validator covers the JSON Schema subset the diagnostic schemas actually
 * use. It is deliberately small: an incomplete validator that reports what it
 * cannot check is safer than one that silently passes unsupported keywords.
 */

/** Keywords this validator understands. Anything else is reported, not ignored. */
const SUPPORTED = new Set([
  "type", "enum", "const", "properties", "required", "additionalProperties",
  "items", "minItems", "maxItems", "minimum", "maximum", "minLength", "maxLength",
]);

function typeOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/**
 * Parse text the model was asked to return as JSON.
 *
 * Kept separate from validation so "the model did not return JSON at all" and
 * "the model returned JSON of the wrong shape" stay distinguishable — they have
 * different causes and different fixes.
 */
export function parseModelJson(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, reason: "empty", detail: "no text content in the response" };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return {
      ok: false,
      reason: "unparseable",
      // Truncated: a long malformed body is noise in an artifact, and may echo
      // request content.
      detail: `${error.message} | first 120 chars: ${text.slice(0, 120)}`,
    };
  }
}

export function validateAgainstSchema(value, schema, path = "$") {
  const errors = [];
  const unsupported = [];
  const walk = (node, sub, at) => {
    if (!sub || typeof sub !== "object") return;

    for (const keyword of Object.keys(sub)) {
      if (!SUPPORTED.has(keyword)) unsupported.push(`${at}: unsupported keyword "${keyword}" was not checked`);
    }

    if (sub.type) {
      const actual = typeOf(node);
      const expected = sub.type === "integer" ? "number" : sub.type;
      if (actual !== expected) {
        errors.push(`${at}: expected ${sub.type}, received ${actual}`);
        return; // Further keyword checks would be meaningless on the wrong type.
      }
      if (sub.type === "integer" && !Number.isInteger(node)) {
        errors.push(`${at}: expected an integer, received ${node}`);
      }
    }

    if (Object.hasOwn(sub, "const") && node !== sub.const) {
      errors.push(`${at}: expected const ${JSON.stringify(sub.const)}`);
    }
    if (Array.isArray(sub.enum) && !sub.enum.includes(node)) {
      errors.push(`${at}: ${JSON.stringify(node)} is not one of ${JSON.stringify(sub.enum)}`);
    }
    if (typeof node === "number") {
      if (typeof sub.minimum === "number" && node < sub.minimum) errors.push(`${at}: ${node} < minimum ${sub.minimum}`);
      if (typeof sub.maximum === "number" && node > sub.maximum) errors.push(`${at}: ${node} > maximum ${sub.maximum}`);
    }
    if (typeof node === "string") {
      if (typeof sub.minLength === "number" && node.length < sub.minLength) errors.push(`${at}: shorter than minLength ${sub.minLength}`);
      if (typeof sub.maxLength === "number" && node.length > sub.maxLength) errors.push(`${at}: longer than maxLength ${sub.maxLength}`);
    }

    if (Array.isArray(node)) {
      if (typeof sub.minItems === "number" && node.length < sub.minItems) errors.push(`${at}: ${node.length} items < minItems ${sub.minItems}`);
      if (typeof sub.maxItems === "number" && node.length > sub.maxItems) errors.push(`${at}: ${node.length} items > maxItems ${sub.maxItems}`);
      if (sub.items) node.forEach((item, index) => walk(item, sub.items, `${at}[${index}]`));
    }

    if (node && typeof node === "object" && !Array.isArray(node)) {
      for (const key of sub.required ?? []) {
        if (!Object.hasOwn(node, key)) errors.push(`${at}: missing required property "${key}"`);
      }
      if (sub.additionalProperties === false) {
        const allowed = new Set(Object.keys(sub.properties ?? {}));
        for (const key of Object.keys(node)) {
          if (!allowed.has(key)) errors.push(`${at}: unexpected property "${key}"`);
        }
      }
      for (const [key, child] of Object.entries(sub.properties ?? {})) {
        if (Object.hasOwn(node, key)) walk(node[key], child, `${at}.${key}`);
      }
    }
  };

  walk(value, schema, path);
  return { valid: errors.length === 0, errors, unsupported };
}

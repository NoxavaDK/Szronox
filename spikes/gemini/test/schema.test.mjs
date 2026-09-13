import assert from "node:assert/strict";
import test from "node:test";

import { parseModelJson, validateAgainstSchema } from "../src/schema.mjs";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["classification", "confidence"],
  properties: {
    classification: { type: "string", enum: ["solid", "liquid", "gas"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

test("accepts a response that satisfies the requested schema", () => {
  const result = validateAgainstSchema({ classification: "liquid", confidence: 0.9 }, SCHEMA);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("rejects a value outside the enum", () => {
  const result = validateAgainstSchema({ classification: "plasma", confidence: 0.5 }, SCHEMA);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /not one of/);
});

test("rejects a number outside its bounds", () => {
  assert.equal(validateAgainstSchema({ classification: "gas", confidence: 1.4 }, SCHEMA).valid, false);
  assert.equal(validateAgainstSchema({ classification: "gas", confidence: -0.1 }, SCHEMA).valid, false);
});

test("rejects a missing required property", () => {
  const result = validateAgainstSchema({ classification: "gas" }, SCHEMA);
  assert.match(result.errors.join(" "), /missing required property "confidence"/);
});

test("rejects an extra property when additionalProperties is false", () => {
  const result = validateAgainstSchema(
    { classification: "gas", confidence: 0.5, commentary: "unrequested prose" },
    SCHEMA,
  );
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /unexpected property "commentary"/);
});

test("rejects the wrong type and stops rather than cascading", () => {
  const result = validateAgainstSchema({ classification: 7, confidence: 0.5 }, SCHEMA);
  assert.equal(result.valid, false);
  assert.equal(result.errors.filter((e) => e.includes("classification")).length, 1);
});

test("validates arrays, item types and item bounds", () => {
  const schema = { type: "array", maxItems: 2, items: { type: "string" } };
  assert.equal(validateAgainstSchema(["a", "b"], schema).valid, true);
  assert.equal(validateAgainstSchema(["a", "b", "c"], schema).valid, false);
  assert.equal(validateAgainstSchema(["a", 2], schema).valid, false);
});

test("distinguishes an integer from a number", () => {
  const schema = { type: "integer", minimum: 0 };
  assert.equal(validateAgainstSchema(3, schema).valid, true);
  assert.equal(validateAgainstSchema(3.5, schema).valid, false);
});

test("reports keywords it cannot check instead of passing them silently", () => {
  const result = validateAgainstSchema({ a: 1 }, {
    type: "object",
    properties: { a: { type: "number", multipleOf: 3 } },
  });
  assert.equal(result.valid, true);
  assert.match(result.unsupported.join(" "), /multipleOf/);
});

test("separates 'not JSON at all' from 'JSON of the wrong shape'", () => {
  assert.deepEqual(parseModelJson("  "), { ok: false, reason: "empty", detail: "no text content in the response" });
  const broken = parseModelJson("Here is your answer: {classification: gas}");
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, "unparseable");

  const good = parseModelJson('{"classification":"gas","confidence":0.2}');
  assert.equal(good.ok, true);
  assert.equal(good.value.classification, "gas");
});

test("truncates a malformed body so artifacts do not carry echoed request content", () => {
  const result = parseModelJson("x".repeat(5000));
  assert.equal(result.ok, false);
  assert.ok(result.detail.length < 400);
});

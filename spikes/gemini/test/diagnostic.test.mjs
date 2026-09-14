/**
 * Runner-level behaviour.
 *
 * The earlier version of this file asserted that five probe ids existed in a
 * particular order, which is true regardless of what any probe concludes. What
 * matters at this level is narrower: synthetic mode must never be able to
 * report a live result, credential presence must be observable without the
 * value, and live mode must refuse to run rather than silently degrade.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { credentialStatus, runSynthetic } from "../src/diagnostic.mjs";
import { probeIds } from "../src/probes.mjs";

test("synthetic results are labelled synthetic, without exception", async () => {
  const results = await runSynthetic();
  assert.ok(results.length > 0);
  for (const result of results) {
    assert.equal(result.evidenceLevel, "synthetic_fixture");
    // The guard against a green synthetic run being read as provider evidence:
    // every result must carry a stated limitation that scopes it to local
    // behaviour ("only") or disclaims provider proof outright.
    assert.equal(typeof result.limitation, "string");
    assert.match(result.limitation, /\bonly\b|not evidence/i);
  }
});

test("synthetic mode never emits a live evidence level", async () => {
  const results = await runSynthetic();
  assert.equal(results.some((result) => result.evidenceLevel === "live_provider"), false);
});

test("the application fixtures are judged against their declared expectation", async () => {
  const results = await runSynthetic();
  const contractResults = results.filter((result) => result.probe.startsWith("contract_checks:"));
  assert.equal(contractResults.length, 2);
  // Both must pass: the valid fixture by satisfying the guards, the invalid one
  // by being rejected. A guard that accepted everything would fail here.
  for (const result of contractResults) assert.equal(result.verdict, "pass", result.probe);
});

test("credential presence is reported without exposing a value", () => {
  const status = credentialStatus({ GEMINI_API_KEY: "super-secret-value" });
  assert.deepEqual(status, { present: ["GEMINI_API_KEY"], configured: true });
  assert.ok(!JSON.stringify(status).includes("super-secret-value"));
});

test("absent credentials are reported as absent, not guessed at", () => {
  assert.deepEqual(credentialStatus({}), { present: [], configured: false });
  assert.deepEqual(credentialStatus({ GEMINI_API_KEY: "" }), { present: [], configured: false });
});

test("every capability under test has a probe, and each probe has a verdict", async () => {
  const { buildProbes } = await import("../src/probes.mjs");
  const ids = probeIds();
  // Presence is necessary but not sufficient; the verdict functions themselves
  // are exercised in probes.test.mjs.
  for (const required of [
    "multimodal_transport", "multimodal_comprehension",
    "url_context_accessible", "url_context_unavailable",
    "search_grounding", "structured_output_alone", "structured_output_with_search",
  ]) {
    assert.ok(ids.includes(required), `missing probe: ${required}`);
  }
  for (const probe of buildProbes()) {
    assert.equal(typeof probe.verdict, "function", `${probe.id} has no verdict function`);
    assert.equal(typeof probe.question, "string");
  }
});

test("synthetic output carries no credential-shaped material or request headers", async () => {
  const serialised = JSON.stringify(await runSynthetic());
  assert.ok(!/AIza[0-9A-Za-z_-]{10,}/.test(serialised), "a Google API key pattern must never appear in output");
  assert.ok(!serialised.includes("x-goog-api-key"), "request headers must never be serialised into results");
});

test("synthetic fixtures reference only reserved example domains", async () => {
  // Keeps authored fixtures from ever pointing at a real host, which would blur
  // the line between a fixture and a captured response.
  const serialised = JSON.stringify(await runSynthetic());
  for (const url of serialised.match(/https?:\/\/[^"\\\s]+/g) ?? []) {
    assert.match(
      url,
      /^https?:\/\/(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|[a-z0-9-]+\.invalid)(?:[/:?#]|$)/i,
      `fixture referenced a non-reserved host: ${url}`,
    );
  }
});

// ── Exit semantics (C03): unverified is not success ───────────────────────────

test("exit codes distinguish pass, fail and unverified", async () => {
  const { EXIT, exitCodeFor } = await import("../src/diagnostic.mjs");
  assert.equal(exitCodeFor({ pass: 3, fail: 0, unverified: 0 }), EXIT.pass);
  assert.equal(exitCodeFor({ pass: 2, fail: 1, unverified: 4 }), EXIT.fail, "a failure outranks anything else");
  // The correction: a run with no failures but open capabilities must not exit 0,
  // because README described zero as "all probes passed".
  assert.equal(exitCodeFor({ pass: 2, fail: 0, unverified: 1 }), EXIT.unverified);
  assert.notEqual(EXIT.unverified, EXIT.pass);
});

test("a live run whose calls all fail reports unverified, never pass", async () => {
  const { runLive, exitCodeFor, summarise } = await import("../src/diagnostic.mjs");
  const realFetch = globalThis.fetch;
  const realKey = process.env.GEMINI_API_KEY;
  try {
    process.env.GEMINI_API_KEY = "fake-diagnostic-key-000000";
    globalThis.fetch = async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ error: { message: "denied", status: "PERMISSION_DENIED" } }),
    });
    const results = await runLive();
    const counts = summarise(results);
    assert.equal(counts.pass, 0, "an authentication failure proves no capability");
    assert.equal(counts.fail, 0, "nor is it a capability failure");
    assert.equal(counts.unverified, results.length);
    assert.equal(exitCodeFor(counts), 3);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = realKey;
  }
});

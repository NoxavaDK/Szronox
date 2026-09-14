#!/usr/bin/env node
/**
 * T03 diagnostic runner.
 *
 * Two modes that must never be confused:
 *
 *   synthetic - parses authored fixtures and checks them against declared
 *               expectations. Proves this repository's parsing, validation and
 *               contract checks. Proves nothing about Gemini.
 *   live      - calls the provider. Requires an explicitly configured key and is
 *               the only mode that can produce a live verdict.
 *
 * C03 corrections (T03-independent-review.md):
 *
 *  G2   Redaction is applied to the COMPLETE emitted payload, not only to error
 *       descriptions. The previous version added `extracted` and parse/schema
 *       diagnostics to the success path unredacted, so a credential echoed back
 *       as model text would have reached stdout. Redaction now happens at the
 *       single point of emission, so no future field can bypass it by being
 *       added somewhere new.
 *  Exit Exit codes are defined honestly: unverified is not success.
 *  Fix  Synthetic parser rows are compared against declared expectations instead
 *       of being hardcoded PASS after extraction.
 */

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { DEFAULT_MODEL, ENDPOINT_CONTRACT, STRUCTURED_OUTPUT_FIELD } from "./endpoint.mjs";
import { extractEvidence, resolveSegmentText } from "./evidence.mjs";
import { buildProbes } from "./probes.mjs";
import { describeError, generateContent, redact } from "./transport.mjs";
import { runContractChecks } from "./contract-checks.mjs";

/**
 * Exit codes. README and this table must agree.
 *
 *   0  every probe reached a PASS verdict
 *   1  at least one probe FAILED
 *   2  live mode was blocked before any request (no credential configured)
 *   3  no failures, but at least one capability is UNVERIFIED
 *   4  usage error
 */
export const EXIT = { pass: 0, fail: 1, blocked: 2, unverified: 3, usage: 4 };

/** Presence only. The value is never read into a message, artifact or log. */
export function credentialStatus(env = process.env) {
  const names = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
  const present = names.filter((name) => typeof env[name] === "string" && env[name].length > 0);
  return { present, configured: present.length > 0 };
}

/** Secret values for redaction. Collected, never emitted. */
function activeSecrets(env = process.env) {
  return ["GEMINI_API_KEY", "GOOGLE_API_KEY"]
    .map((name) => env[name])
    .filter((value) => typeof value === "string" && value.length > 0);
}

async function readFixture(name) {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * Compare an extraction against a fixture's declared expectations.
 * Expectations live in a separate file so the historical provider-shaped
 * fixtures stay byte-for-byte preserved.
 */
function checkParserExpectation(extracted, expectation) {
  const failures = [];
  const check = (label, actual, expected) => {
    if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };

  if (expectation.shape !== undefined) check("shape", extracted.shape, expectation.shape);
  if (expectation.candidateCount !== undefined) check("candidateCount", extracted.candidates.length, expectation.candidateCount);
  if (expectation.promptBlockReason !== undefined) check("promptBlockReason", extracted.promptBlockReason, expectation.promptBlockReason);
  if (expectation.topLevelRetrievalCount !== undefined) {
    check("topLevelRetrievalCount", extracted.topLevelUrlRetrieval.length, expectation.topLevelRetrievalCount);
  }
  if (expectation.quarantined !== undefined) check("quarantined", extracted.quarantined !== null, expectation.quarantined);

  for (const [index, want] of Object.entries(expectation.candidates ?? {})) {
    const candidate = extracted.candidates[Number(index)];
    if (!candidate) { failures.push(`candidate ${index}: missing`); continue; }
    if (want.usableState !== undefined) check(`candidate[${index}].usability.state`, candidate.usability.state, want.usableState);
    if (want.sourceCount !== undefined) check(`candidate[${index}].sources`, candidate.sources.length, want.sourceCount);
    if (want.supportCount !== undefined) check(`candidate[${index}].supports`, candidate.supports.length, want.supportCount);
    if (want.searchQueryCount !== undefined) check(`candidate[${index}].searchQueries`, candidate.searchQueries.length, want.searchQueryCount);
    if (want.urlRetrievalCount !== undefined) check(`candidate[${index}].urlRetrieval`, candidate.urlRetrieval.length, want.urlRetrievalCount);
    if (want.partCount !== undefined) check(`candidate[${index}].parts`, candidate.parts.length, want.partCount);
    if (want.resolvedSegments !== undefined) {
      const resolved = candidate.supports.map((support) => {
        const outcome = resolveSegmentText(candidate, support.segment);
        return outcome.ok ? outcome.text : `<unresolved:${outcome.reason}>`;
      });
      if (JSON.stringify(resolved) !== JSON.stringify(want.resolvedSegments)) {
        failures.push(`candidate[${index}].resolvedSegments: expected ${JSON.stringify(want.resolvedSegments)}, got ${JSON.stringify(resolved)}`);
      }
    }
  }
  return failures;
}

async function runSynthetic() {
  const directory = fileURLToPath(new URL("../fixtures/", import.meta.url));
  const expectations = await readFixture("parser-expectations.json");
  const files = (await readdir(directory))
    .filter((name) => name.endsWith(".json") && name !== "parser-expectations.json")
    .sort();
  const results = [];

  for (const file of files) {
    const fixture = await readFixture(file);

    if (file.startsWith("application-")) {
      const outcome = runContractChecks(fixture);
      const matched = outcome.valid === Boolean(fixture.expectValid);
      results.push({
        probe: `contract_checks:${file}`,
        evidenceLevel: "synthetic_fixture",
        verdict: matched ? "pass" : "fail",
        expectation: fixture.expectValid ? "should satisfy contract checks" : "should be rejected",
        failures: outcome.failures,
        checks: outcome.checks,
        limitation: "Local contract validation. Not evidence that Gemini enforces ids, schemas or truth.",
      });
      continue;
    }

    const expectation = expectations[file];
    const extracted = extractEvidence(fixture);
    if (!expectation) {
      // An unexpected fixture must not silently pass.
      results.push({
        probe: `parser:${file}`,
        evidenceLevel: "synthetic_fixture",
        verdict: "fail",
        summary: "No declared expectation for this fixture; add one to parser-expectations.json.",
        limitation: "Parser output was not validated.",
      });
      continue;
    }
    const failures = checkParserExpectation(extracted, expectation);
    results.push({
      probe: `parser:${file}`,
      evidenceLevel: "synthetic_fixture",
      verdict: failures.length === 0 ? "pass" : "fail",
      summary: expectation.describes,
      expectationFailures: failures,
      extracted,
      limitation: "Validates local parsing and provenance labelling only. Not evidence about the provider.",
    });
  }

  return results;
}

async function runLive() {
  const status = credentialStatus();
  if (!status.configured) {
    const error = new Error("Live mode BLOCKED: no GEMINI_API_KEY or GOOGLE_API_KEY is configured in this environment.");
    error.blocked = true;
    throw error;
  }

  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const model = process.env.GEMINI_DIAGNOSTIC_MODEL ?? DEFAULT_MODEL;
  const secrets = [apiKey];
  const results = [];

  for (const probe of buildProbes()) {
    // Every result is redacted as a whole before it joins the list, so no field
    // added later can reach output unsanitised (G2).
    // C04/C03-R5: the C03 report claimed every result records its
    // structured-output field, but the base recorded endpoint and model only.
    // The field and API version are now emitted for the probes that actually
    // send a schema, and omitted for those that do not, so the artifact matches
    // the documentation instead of overstating it.
    const base = {
      probe: probe.id,
      capability: probe.capability,
      question: probe.question,
      evidenceLevel: "live_provider",
      model,
      endpoint: ENDPOINT_CONTRACT.endpoint,
      apiVersion: ENDPOINT_CONTRACT.apiVersion,
      structuredOutputField: probe.schema ? STRUCTURED_OUTPUT_FIELD : null,
    };
    try {
      const { body, attempts } = await generateContent({ apiKey, model, request: probe.request });
      const extracted = extractEvidence(body);
      results.push(redact({
        ...base,
        attempts,
        responseShape: extracted.shape,
        ...probe.verdict(extracted, { model }),
        extracted,
      }, secrets));
    } catch (error) {
      const described = describeError(error, secrets);
      const extracted = extractEvidence(null);
      results.push(redact({
        ...base,
        ...probe.verdict(extracted, { error: described, model }),
        error: described,
      }, secrets));
    }
  }

  return results;
}

function summarise(results) {
  const counts = { pass: 0, fail: 0, unverified: 0 };
  for (const result of results) if (result.verdict in counts) counts[result.verdict] += 1;
  return counts;
}

function exitCodeFor(counts) {
  if (counts.fail > 0) return EXIT.fail;
  if (counts.unverified > 0) return EXIT.unverified;
  return EXIT.pass;
}

async function main() {
  const modeIndex = process.argv.indexOf("--mode");
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "synthetic";
  if (mode !== "live" && mode !== "synthetic") {
    process.stderr.write(`Unknown mode: ${mode}\n`);
    process.exitCode = EXIT.usage;
    return;
  }

  const results = mode === "live" ? await runLive() : await runSynthetic();
  const counts = summarise(results);
  const payload = {
    mode,
    generatedAt: new Date().toISOString(),
    endpoint: mode === "live" ? ENDPOINT_CONTRACT.endpoint : null,
    credentials: credentialStatus().configured ? "configured" : "absent",
    summary: counts,
    exitCode: exitCodeFor(counts),
    results,
  };

  // Single point of emission, redacted as a whole. Belt and braces with the
  // per-result redaction in runLive.
  process.stdout.write(`${JSON.stringify(redact(payload, activeSecrets()), null, 2)}\n`);
  process.exitCode = exitCodeFor(counts);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Top-level errors are redacted too: a thrown provider message can carry
    // echoed request content.
    process.stderr.write(`${redact(String(error?.message ?? error), activeSecrets())}\n`);
    process.exitCode = error?.blocked ? EXIT.blocked : EXIT.fail;
  });
}

export { runSynthetic, runLive, exitCodeFor, summarise };

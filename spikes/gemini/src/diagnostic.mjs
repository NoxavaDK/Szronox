#!/usr/bin/env node
/**
 * T03 diagnostic runner.
 *
 * Two modes that must never be confused with each other:
 *
 *   synthetic - parses authored fixtures. Proves this repository's parsing,
 *               validation and contract checks. Proves nothing about Gemini.
 *   live      - calls the provider. Requires an explicitly configured key and
 *               is the only mode that can produce a live verdict.
 *
 * Neither mode ever prints a credential, a request header, or a raw provider
 * body. Live output is redacted and intended for
 * `artifacts/private/` (gitignored); only summarised, provenance-labelled
 * evidence belongs in a committed artifact.
 */

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { extractEvidence } from "./evidence.mjs";
import { buildProbes } from "./probes.mjs";
import { describeError, generateContent } from "./transport.mjs";
import { runContractChecks } from "./contract-checks.mjs";

const DEFAULT_MODEL = "gemini-2.5-flash";

/** Presence only. The value is never read into a message, artifact or log. */
export function credentialStatus(env = process.env) {
  const names = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
  const present = names.filter((name) => typeof env[name] === "string" && env[name].length > 0);
  return { present, configured: present.length > 0 };
}

function fixturePath(name) {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

async function readFixture(name) {
  return JSON.parse(await readFile(fixturePath(name), "utf8"));
}

/**
 * Parse every fixture and report what the parser made of it.
 *
 * Each result is explicitly `synthetic_fixture`, so no reader can mistake a
 * green line here for provider behaviour.
 */
async function runSynthetic() {
  const directory = fileURLToPath(new URL("../fixtures/", import.meta.url));
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const results = [];

  for (const file of files) {
    const fixture = await readFixture(file);
    if (file.startsWith("application-")) {
      const outcome = runContractChecks(fixture);
      results.push({
        probe: `contract_checks:${file}`,
        evidenceLevel: "synthetic_fixture",
        verdict: outcome.valid === Boolean(fixture.expectValid) ? "pass" : "fail",
        expectation: fixture.expectValid ? "should satisfy contract checks" : "should be rejected",
        failures: outcome.failures,
        checks: outcome.checks,
        limitation: "Local contract validation. Not evidence that Gemini enforces ids, schemas or truth.",
      });
      continue;
    }
    results.push({
      probe: `parser:${file}`,
      evidenceLevel: "synthetic_fixture",
      verdict: "pass",
      extracted: extractEvidence(fixture),
      limitation: "Validates local parsing and provenance labelling only.",
    });
  }

  return results;
}

/**
 * Run the live probes.
 *
 * Every probe is attempted; one failure does not abort the rest, because a
 * compatibility rejection on one probe is itself a result worth recording.
 */
async function runLive() {
  const status = credentialStatus();
  if (!status.configured) {
    const error = new Error(
      "Live mode BLOCKED: no GEMINI_API_KEY or GOOGLE_API_KEY is configured in this environment.",
    );
    error.blocked = true;
    throw error;
  }

  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const model = process.env.GEMINI_DIAGNOSTIC_MODEL ?? DEFAULT_MODEL;
  const secrets = [apiKey];
  const results = [];

  for (const probe of buildProbes()) {
    try {
      const { body, attempts } = await generateContent({ apiKey, model, request: probe.request });
      const extracted = extractEvidence(body);
      results.push({
        probe: probe.id,
        question: probe.question,
        evidenceLevel: "live_provider",
        model,
        attempts,
        responseShape: extracted.shape,
        ...probe.verdict(extracted),
        extracted,
      });
    } catch (error) {
      const described = describeError(error, secrets);
      // Some probes treat a provider rejection as the answer, so the verdict
      // function is still consulted rather than short-circuited.
      const extracted = extractEvidence(null);
      results.push({
        probe: probe.id,
        question: probe.question,
        evidenceLevel: "live_provider",
        model,
        ...probe.verdict(extracted, { error: described }),
        error: described,
      });
    }
  }

  return results;
}

function summarise(results) {
  const counts = { pass: 0, fail: 0, unverified: 0 };
  for (const result of results) {
    if (result.verdict in counts) counts[result.verdict] += 1;
  }
  return counts;
}

async function main() {
  const modeIndex = process.argv.indexOf("--mode");
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "synthetic";
  if (mode !== "live" && mode !== "synthetic") throw new Error(`Unknown mode: ${mode}`);

  const results = mode === "live" ? await runLive() : await runSynthetic();
  const payload = {
    mode,
    generatedAt: new Date().toISOString(),
    credentials: credentialStatus().present.length > 0 ? "configured" : "absent",
    summary: summarise(results),
    results,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

  // A failed probe must not be reported by a zero exit status.
  if (results.some((result) => result.verdict === "fail")) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.blocked ? 2 : 1;
  });
}

export { runSynthetic, runLive };

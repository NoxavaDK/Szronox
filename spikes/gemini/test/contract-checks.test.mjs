/**
 * Application-shaped guards.
 *
 * Every assertion here is about *our* validation. None of it is evidence that
 * Gemini preserves a hook, respects an id, or tells the truth — the point is
 * that the adapter would catch it when the model does not.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkClaimLocations, checkHookAdditionsBounded, checkHooksPreserved,
  checkMemeSuggestion, checkSourceReferences, runContractChecks,
} from "../src/contract-checks.mjs";

const fixture = async (name) =>
  JSON.parse(await readFile(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"));

const hooks = [
  { id: "h1", text: "First", source: "user", position: 0 },
  { id: "h2", text: "Second", source: "ai", position: 1 },
];

// ── Hooks are appended, never rewritten ───────────────────────────────────

test("accepts an appended alternative that leaves existing hooks untouched", () => {
  const outcome = checkHooksPreserved(hooks, [...hooks, { id: "h3", text: "New", source: "ai", position: 2 }]);
  assert.equal(outcome.valid, true);
});

test("rejects a rewritten hook text", () => {
  const outcome = checkHooksPreserved(hooks, [{ ...hooks[0], text: "Rewritten" }, hooks[1]]);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some((message) => message.includes("text was modified")));
});

test("rejects a dropped hook, because generation appends rather than replaces", () => {
  const outcome = checkHooksPreserved(hooks, [hooks[0]]);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some((message) => message.includes("absent from result")));
});

test("rejects a reordered hook", () => {
  const outcome = checkHooksPreserved(hooks, [{ ...hooks[0], position: 5 }, hooks[1]]);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some((message) => message.includes("position changed")));
});

test("rejects a generated hook attributed to the user", () => {
  const outcome = checkHooksPreserved(hooks, [...hooks, { id: "h9", text: "New", source: "user", position: 2 }]);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some((message) => message.includes('source "ai"')));
});

// ── Additions are bounded ─────────────────────────────────────────────────

test("allows up to three additions per call and rejects a fourth", () => {
  // T00: "up to three additions per successful call, not a cap on total hooks".
  assert.equal(checkHookAdditionsBounded(["a", "b", "c"]).valid, true);
  const tooMany = checkHookAdditionsBounded(["a", "b", "c", "d"]);
  assert.equal(tooMany.valid, false);
  assert.ok(tooMany.errors[0].includes("exceeds the bound of 3"));
});

test("rejects empty or non-string additions", () => {
  assert.equal(checkHookAdditionsBounded(["  "]).valid, false);
  assert.equal(checkHookAdditionsBounded([42]).valid, false);
  assert.equal(checkHookAdditionsBounded("not an array").valid, false);
});

// ── At most one meme, and only a real candidate ───────────────────────────

test("accepts null, which is a legitimate result", () => {
  assert.equal(checkMemeSuggestion(null, ["m1"]).valid, true);
});

test("rejects an id the model invented", () => {
  const outcome = checkMemeSuggestion({ memeId: "m404", rationale: "why" }, ["m1", "m2"]);
  assert.equal(outcome.valid, false);
  assert.equal(outcome.accepted, null);
  assert.ok(outcome.errors[0].includes("not among the supplied candidates"));
});

test("rejects more than one suggestion", () => {
  const outcome = checkMemeSuggestion([{ memeId: "m1", rationale: "a" }, { memeId: "m2", rationale: "b" }], ["m1", "m2"]);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors[0].includes("at most one"));
});

test("accepts one in-candidate suggestion with a rationale", () => {
  const outcome = checkMemeSuggestion({ memeId: "m1", rationale: "because" }, ["m1"]);
  assert.equal(outcome.valid, true);
  assert.equal(outcome.accepted.memeId, "m1");
});

test("rejects a suggestion with no rationale", () => {
  assert.equal(checkMemeSuggestion({ memeId: "m1", rationale: "" }, ["m1"]).valid, false);
});

// ── Claims point somewhere real ───────────────────────────────────────────

test("accepts script and known-hook locations", () => {
  const outcome = checkClaimLocations(
    [{ location: { field: "script" } }, { location: { field: "hook", hookId: "h1" } }],
    { hookIds: ["h1"] },
  );
  assert.equal(outcome.valid, true);
});

test("rejects a claim against a hook that was never reviewed", () => {
  const outcome = checkClaimLocations([{ location: { field: "hook", hookId: "ghost" } }], { hookIds: ["h1"] });
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors[0].includes("ghost"));
});

// ── Sources must exist, and "confirmed" must be backed ────────────────────

test("rejects a citation to a source that does not exist", () => {
  const outcome = checkSourceReferences([{ sourceIds: ["missing"], status: "uncertain" }], []);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors[0].includes("does not exist"));
});

test("rejects a confirmed claim with nothing behind it", () => {
  const outcome = checkSourceReferences([{ sourceIds: [], status: "confirmed" }], []);
  assert.equal(outcome.valid, false);
  assert.ok(outcome.errors.some((message) => message.includes("no cited source")));
});

test("counts how many claims rest on an actual excerpt rather than a bare URL", () => {
  const sources = [
    { id: "s1", evidenceKind: "tool_metadata_only" },
    { id: "s2", evidenceKind: "retrieved_excerpt" },
  ];
  const outcome = checkSourceReferences(
    [{ sourceIds: ["s1"], status: "uncertain" }, { sourceIds: ["s2"], status: "confirmed" }],
    sources,
  );
  assert.equal(outcome.valid, true);
  // A URL-only citation is not a quotation, and the difference is reported.
  assert.equal(outcome.claimsWithExcerptBackedSource, 1);
  assert.equal(outcome.claimsTotal, 2);
});

// ── Fixtures behave as labelled ───────────────────────────────────────────

test("the valid application fixture satisfies every guard", async () => {
  const outcome = runContractChecks(await fixture("application-valid.json"));
  assert.equal(outcome.valid, true, `unexpected failures: ${outcome.failures.join(", ")}`);
});

test("the invalid application fixture is rejected by every guard it violates", async () => {
  const outcome = runContractChecks(await fixture("application-invalid.json"));
  assert.equal(outcome.valid, false);
  // Each guard is exercised, so a single over-broad check cannot mask the rest.
  for (const expected of ["hooksPreserved", "hookAdditionsBounded", "memeSuggestion", "claimLocations", "sourceReferences"]) {
    assert.ok(outcome.failures.includes(expected), `expected ${expected} to fail`);
  }
});

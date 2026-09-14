/**
 * Receiver readiness (C02 / R01 F7).
 *
 * The decision table is pure, so registration, activation/control and
 * availability can be asserted without a browser. Whether a real Chrome reaches
 * these states is a separate, still-open gate.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { RECEIVER_STATES, observeReceiver, receiverState } from "../receiver-state.js";

test("an unsupported browser is named as such, and share capture is unavailable", () => {
  const outcome = receiverState({ serviceWorkerSupported: false, registered: false, controlling: false });
  assert.equal(outcome.state, "unsupported");
  assert.equal(outcome.shareCaptureAvailable, false);
});

test("registration failure is distinct from an unsupported browser", () => {
  const outcome = receiverState({ serviceWorkerSupported: true, registered: false, controlling: false });
  assert.equal(outcome.state, "registration_failed");
  assert.equal(outcome.shareCaptureAvailable, false);
});

test("registered but not controlling is its own state, not readiness", () => {
  // Only a controlling worker can intercept POST /share-target, so reporting a
  // registered worker as ready would overclaim.
  const outcome = receiverState({ serviceWorkerSupported: true, registered: true, controlling: false });
  assert.equal(outcome.state, "registered_not_controlling");
  assert.equal(outcome.shareCaptureAvailable, false);
  assert.equal(outcome.severity, "warning");
});

test("only a controlling worker reports ready", () => {
  const outcome = receiverState({ serviceWorkerSupported: true, registered: true, controlling: true });
  assert.equal(outcome.state, "ready");
  assert.equal(outcome.shareCaptureAvailable, true);
});

test("every failing state names share capture rather than offline support", () => {
  // The superseded message said "Nie udało się uruchomić obsługi offline",
  // which named the wrong capability.
  for (const key of ["unsupported", "registration_failed", "registered_not_controlling"]) {
    const { message } = RECEIVER_STATES[key];
    assert.match(message, /udostępnie/i, `${key} must name share capture`);
    assert.ok(!/offline/i.test(message), `${key} must not describe this as an offline problem`);
  }
});

test("no message claims the installed OS share target can be removed", () => {
  // The app cannot unregister an OS-level share entry; saying so would be false.
  for (const [key, { message }] of Object.entries(RECEIVER_STATES)) {
    assert.ok(!/usun|wyłącz|odinstal/i.test(message), `${key} must not claim it removed the system entry`);
  }
});

test("observeReceiver reports unsupported when serviceWorker is absent", async () => {
  const outcome = await observeReceiver({});
  assert.equal(outcome.state, "unsupported");
  assert.equal(await observeReceiver(undefined).then((r) => r.state), "unsupported");
});

test("observeReceiver reports registration_failed when register rejects", async () => {
  const navigatorRef = {
    serviceWorker: { register: async () => { throw new Error("SecurityError"); }, controller: null },
  };
  assert.equal((await observeReceiver(navigatorRef)).state, "registration_failed");
});

test("observeReceiver separates a successful registration from control", async () => {
  const uncontrolled = { serviceWorker: { register: async () => ({}), controller: null } };
  assert.equal((await observeReceiver(uncontrolled)).state, "registered_not_controlling");

  const controlled = { serviceWorker: { register: async () => ({}), controller: {} } };
  assert.equal((await observeReceiver(controlled)).state, "ready");
});

test("receiver messages are Polish diagnostic copy", () => {
  for (const { message } of Object.values(RECEIVER_STATES)) {
    assert.equal(typeof message, "string");
    assert.ok(message.length > 0);
    assert.match(message, /[ąćęłńóśźż]/i, "application-facing copy is Polish");
  }
});

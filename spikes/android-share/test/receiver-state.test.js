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

// ── C02-R3: receiver state stays live ────────────────────────────────────────

/** A navigator double that can actually dispatch controllerchange. */
function eventCapableNavigator({ registerFails = false, controller = null } = {}) {
  const listeners = new Map();
  let registerCalls = 0;
  const container = {
    get controller() { return container._controller; },
    _controller: controller,
    register: async () => { registerCalls += 1; if (registerFails) throw new Error("SecurityError"); return {}; },
    addEventListener: (type, fn) => { listeners.set(type, [...(listeners.get(type) ?? []), fn]); },
    removeEventListener: (type, fn) => { listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn)); },
  };
  return {
    navigatorRef: { serviceWorker: container },
    setController(value) { container._controller = value; for (const fn of listeners.get("controllerchange") ?? []) fn(); },
    listenerCount: (type) => (listeners.get(type) ?? []).length,
    get registerCalls() { return registerCalls; },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("acquiring control after first paint refreshes the visible state", async () => {
  // The reproduced defect: first install reports registered_not_controlling, the
  // worker then activates and claims the client, but the message stayed stale.
  const double = eventCapableNavigator({ controller: null });
  const seen = [];
  const { watchReceiver } = await import("../receiver-state.js");
  const detach = watchReceiver(double.navigatorRef, (s) => seen.push(s.state));
  await flush();
  assert.deepEqual(seen, ["registered_not_controlling"]);

  double.setController({});
  await flush();
  assert.equal(seen.at(-1), "ready", "gaining control must update the state");
  detach();
});

test("losing control is reported too, not left claiming readiness", async () => {
  const double = eventCapableNavigator({ controller: {} });
  const seen = [];
  const { watchReceiver } = await import("../receiver-state.js");
  const detach = watchReceiver(double.navigatorRef, (s) => seen.push(s));
  await flush();
  assert.equal(seen.at(-1).state, "ready");
  assert.equal(seen.at(-1).shareCaptureAvailable, true);

  double.setController(null);
  await flush();
  assert.equal(seen.at(-1).state, "registered_not_controlling");
  assert.equal(seen.at(-1).shareCaptureAvailable, false);
  detach();
});

test("refreshing state never re-registers the worker", async () => {
  const double = eventCapableNavigator({ controller: null });
  const { watchReceiver } = await import("../receiver-state.js");
  const detach = watchReceiver(double.navigatorRef, () => {});
  await flush();
  double.setController({});
  double.setController(null);
  double.setController({});
  await flush();
  assert.equal(double.registerCalls, 1, "register() must run exactly once");
  detach();
});

test("a failed registration stays failed across controller events", async () => {
  const double = eventCapableNavigator({ registerFails: true });
  const seen = [];
  const { watchReceiver } = await import("../receiver-state.js");
  const detach = watchReceiver(double.navigatorRef, (s) => seen.push(s.state));
  await flush();
  assert.equal(seen.at(-1), "registration_failed");
  double.setController({});
  await flush();
  assert.ok(!seen.includes("ready"), "a spurious controller cannot mask a failed registration");
  detach();
});

test("detaching stops further updates and removes the listener", async () => {
  const double = eventCapableNavigator({ controller: null });
  const seen = [];
  const { watchReceiver } = await import("../receiver-state.js");
  const detach = watchReceiver(double.navigatorRef, (s) => seen.push(s.state));
  await flush();
  const before = seen.length;
  detach();
  assert.equal(double.listenerCount("controllerchange"), 0);
  double.setController({});
  await flush();
  assert.equal(seen.length, before, "no updates after detach");
});

test("an unsupported browser reports once and needs no listener", async () => {
  const { watchReceiver } = await import("../receiver-state.js");
  const seen = [];
  const detach = watchReceiver({}, (s) => seen.push(s.state));
  await flush();
  assert.deepEqual(seen, ["unsupported"]);
  detach();
});

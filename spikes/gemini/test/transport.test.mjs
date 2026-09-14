import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderError,
  classifyHttpError,
  classifyTransportError,
  describeError,
  generateContent,
  redact,
  withBoundedRetry,
} from "../src/transport.mjs";

// Shaped like a credential but deliberately not matching a real key prefix, so
// secret scanners do not flag this file.
const SECRET = "FAKE-DIAGNOSTIC-CREDENTIAL-0000000000";

/** Build a fetch stand-in from a queue of scripted outcomes. */
function fakeFetch(outcomes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    if (next.throws) throw next.throws;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => next.body ?? "",
    };
  };
  impl.calls = calls;
  return impl;
}

test("classifies HTTP failures per documented retry guidance", () => {
  assert.equal(classifyHttpError(400).retryable, false);
  assert.equal(classifyHttpError(400).category, "request_or_content");
  assert.equal(classifyHttpError(403).retryable, false);
  assert.equal(classifyHttpError(403).category, "authentication_or_permission");
  assert.equal(classifyHttpError(429).retryable, true);
  assert.equal(classifyHttpError(429).category, "quota_or_rate_limit");
  assert.equal(classifyHttpError(503).retryable, true);
  assert.equal(classifyHttpError(503).category, "provider_transient");
});

test("assigns an explicit retry policy to transport failures", () => {
  const timeout = classifyTransportError(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
  assert.equal(timeout.retryable, true, "a timeout must be retryable by decision, not by default");
  assert.equal(timeout.category, "transport_timeout");

  const reset = classifyTransportError(Object.assign(new Error("socket"), { name: "TypeError", cause: { code: "ECONNRESET" } }));
  assert.equal(reset.retryable, true);
  assert.equal(reset.category, "transport_network");

  const unknown = classifyTransportError(new Error("something new"));
  assert.equal(unknown.retryable, false, "an unnamed failure must stay terminal rather than loop");
  assert.equal(unknown.category, "transport_unknown");
});

test("retries retryable failures a bounded number of times", async () => {
  let calls = 0;
  const sleeps = [];
  const { value, attempts } = await withBoundedRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("transient"), { retryable: true, category: "provider_transient" });
      return "ok";
    },
    { maxAttempts: 3, baseDelayMs: 2, sleep: async (ms) => sleeps.push(ms) },
  );
  assert.equal(value, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [2, 4], "backoff must be exponential");
});

test("stops at the attempt bound instead of retrying forever", async () => {
  let calls = 0;
  await assert.rejects(
    withBoundedRetry(
      async () => {
        calls += 1;
        throw Object.assign(new Error("always transient"), { retryable: true, category: "provider_transient" });
      },
      { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
    ),
    /always transient/,
  );
  assert.equal(calls, 3, "the bound is the safety property");
});

test("never retries a terminal failure", async () => {
  let calls = 0;
  await assert.rejects(
    withBoundedRetry(
      async () => {
        calls += 1;
        throw Object.assign(new Error("bad request"), { retryable: false });
      },
      { maxAttempts: 4, baseDelayMs: 1, sleep: async () => {} },
    ),
    /bad request/,
  );
  assert.equal(calls, 1);
});

test("treats HTTP 200 with an unparseable body as a failure, not an empty success", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: "<html>not json</html>" }]);
  await assert.rejects(
    generateContent({ apiKey: SECRET, model: "m", request: {}, fetchImpl, retry: { maxAttempts: 1 } }),
    (error) => {
      assert.equal(error.code, "MALFORMED_SUCCESS_BODY");
      assert.equal(error.category, "malformed_success");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("treats HTTP 200 with an empty body as its own distinct failure", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: "" }]);
  await assert.rejects(
    generateContent({ apiKey: SECRET, model: "m", request: {}, fetchImpl, retry: { maxAttempts: 1 } }),
    (error) => {
      // Separated from unparseable JSON so an artifact says which one happened.
      assert.equal(error.code, "EMPTY_SUCCESS_BODY");
      assert.equal(error.category, "malformed_success");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("retries a 503 and reports how many attempts it took", async () => {
  const fetchImpl = fakeFetch([
    { status: 503, body: JSON.stringify({ error: { message: "overloaded" } }) },
    { status: 200, body: JSON.stringify({ candidates: [] }) },
  ]);
  const { attempts } = await generateContent({
    apiKey: SECRET, model: "m", request: {}, fetchImpl,
    retry: { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} },
  });
  assert.equal(attempts, 2);
});

test("does not retry a 403 and classifies it as authentication or permission", async () => {
  const fetchImpl = fakeFetch([{ status: 403, body: JSON.stringify({ error: { message: "denied", status: "PERMISSION_DENIED" } }) }]);
  await assert.rejects(
    generateContent({ apiKey: SECRET, model: "m", request: {}, fetchImpl, retry: { maxAttempts: 3, sleep: async () => {} } }),
    (error) => {
      assert.equal(error.category, "authentication_or_permission");
      assert.equal(error.retryable, false);
      assert.equal(error.code, "PERMISSION_DENIED");
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 1, "a terminal auth error must not be retried");
});

test("sends the key only as a header, never in the URL or body", async () => {
  const fetchImpl = fakeFetch([{ status: 200, body: JSON.stringify({ candidates: [] }) }]);
  await generateContent({ apiKey: SECRET, model: "m", request: { contents: [] }, fetchImpl, retry: { maxAttempts: 1 } });
  const [call] = fetchImpl.calls;
  assert.equal(call.init.headers["x-goog-api-key"], SECRET);
  assert.ok(!call.url.includes(SECRET));
  assert.ok(!call.init.body.includes(SECRET));
});

test("redacts a credential the provider echoes back in an error message", async () => {
  // The realistic leak: the provider quotes the request back at us and the
  // message is then written into an artifact.
  const fetchImpl = fakeFetch([{
    status: 400,
    body: JSON.stringify({ error: { message: `API key not valid: ${SECRET}`, status: "INVALID_ARGUMENT" } }),
  }]);
  await assert.rejects(
    generateContent({ apiKey: SECRET, model: "m", request: {}, fetchImpl, retry: { maxAttempts: 1 } }),
    (error) => {
      assert.ok(!error.message.includes(SECRET), "credential must not survive into the error message");
      assert.match(error.message, /\[REDACTED\]/);
      const described = describeError(error, [SECRET]);
      assert.ok(!JSON.stringify(described).includes(SECRET));
      return true;
    },
  );
});

test("omits header-shaped values entirely rather than echoing a masked credential", () => {
  const cleaned = redact(
    { headers: { "x-goog-api-key": SECRET, "content-type": "application/json" }, note: `used ${SECRET}` },
    [SECRET],
  );
  assert.equal(cleaned.headers["x-goog-api-key"], "[OMITTED]");
  assert.equal(cleaned.headers["content-type"], "application/json");
  assert.equal(cleaned.note, "used [REDACTED]");
});

test("redaction survives nested structures and arrays", () => {
  const cleaned = redact({ a: [{ b: `x${SECRET}y` }], c: { d: [SECRET] } }, [SECRET]);
  assert.ok(!JSON.stringify(cleaned).includes(SECRET));
});

test("describeError reports a local failure without inventing provider fields", () => {
  const described = describeError(new ProviderError("boom", { category: "transport_timeout", retryable: true }), []);
  assert.equal(described.status, null);
  assert.equal(described.category, "transport_timeout");
  assert.equal(described.retryable, true);
});

test("a transport timeout is retried and then reported with its attempt log", async () => {
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const fetchImpl = fakeFetch([{ throws: timeout }]);
  await assert.rejects(
    generateContent({
      apiKey: SECRET, model: "m", request: {}, fetchImpl,
      retry: { maxAttempts: 2, baseDelayMs: 1, sleep: async () => {} },
    }),
    (error) => {
      assert.equal(error.category, "transport_timeout");
      assert.equal(error.retryable, true);
      assert.equal(error.attemptLog.length, 2);
      return true;
    },
  );
  assert.equal(fetchImpl.calls.length, 2);
});

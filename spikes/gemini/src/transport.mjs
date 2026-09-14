/**
 * Transport, failure classification and redaction.
 *
 * Load-bearing properties:
 *
 * 1. A 200 is not a success. A body that cannot be read or parsed is a failed
 *    capability, not an empty answer.
 * 2. Failures are classified deliberately, never by a missing field defaulting
 *    to "terminal".
 * 3. Nothing that leaves this module may contain the API key.
 *
 * C03 corrections (T03-independent-review.md G6):
 *
 *  G6a  `response.text()` rejecting was swallowed by `.catch(() => "")`, turning
 *       a body-read timeout into a terminal `malformed_success` after ONE
 *       attempt. The fetch deadline covers body consumption, so a body-read
 *       failure is a transport failure and gets the same bounded retry as a
 *       failure to obtain headers. Genuinely invalid JSON stays distinct.
 *  G6b  HTTP 408 was classified `request_or_content` while being retryable. It
 *       is a timeout and is now `provider_transient`, matching the documented
 *       taxonomy.
 *  G6c  The classifier read `error.name ?? error.code`, so a generic
 *       `name: "Error"` masked a meaningful `code: "ECONNRESET"`. All of name,
 *       code and cause.code are now considered.
 */

import { generateContentUrl } from "./endpoint.mjs";

export { API_ROOT } from "./endpoint.mjs";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Transport-level rejections, named rather than inferred from a missing field. */
const RETRYABLE_TRANSPORT = new Set([
  "TimeoutError",             // AbortSignal.timeout fired, including during body read
  "AbortError",
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

export function classifyHttpError(status) {
  return {
    retryable: RETRYABLE_STATUS.has(status),
    category:
      status === 401 || status === 403
        ? "authentication_or_permission"
        : status === 429
          ? "quota_or_rate_limit"
          // G6b: 408 is a timeout, not a malformed request.
          : status === 408 || status >= 500
            ? "provider_transient"
            : "request_or_content",
  };
}

/**
 * Classify a thrown transport error.
 *
 * G6c: every identifying field is considered, because Node surfaces the useful
 * one in different places depending on the failure. An unrecognised error stays
 * terminal — looping on something we cannot name is how a diagnostic becomes an
 * outage.
 */
export function classifyTransportError(error) {
  const markers = [
    error?.name, error?.code,
    error?.cause?.code, error?.cause?.name,
  ].filter((value) => typeof value === "string");

  const retryable = markers.some((marker) => RETRYABLE_TRANSPORT.has(marker));
  const timeout = markers.some((marker) => /Timeout|TIMEOUT/.test(marker) || marker === "AbortError");

  return {
    retryable,
    category: timeout && retryable ? "transport_timeout" : retryable ? "transport_network" : "transport_unknown",
    markers,
  };
}

/**
 * Remove secrets from anything destined for a log, artifact or stdout.
 * Takes secrets explicitly so this function never reads the environment.
 */
export function redact(value, secrets = []) {
  const present = secrets.filter((secret) => typeof secret === "string" && secret.length >= 8);
  const walk = (input) => {
    if (typeof input === "string") {
      return present.reduce((text, secret) => text.split(secret).join("[REDACTED]"), input);
    }
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([key, entry]) => {
        // Header-shaped keys are dropped whole: a redacted credential still
        // tells a reader one was there.
        if (/^(authorization|x-goog-api-key|api[-_]?key)$/i.test(key)) return [key, "[OMITTED]"];
        return [key, walk(entry)];
      }));
    }
    return input;
  };
  return walk(value);
}

export class ProviderError extends Error {
  constructor(message, { status = null, code = null, retryable = false, category, secrets = [] }) {
    super(redact(message, secrets));
    this.name = "ProviderError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.category = category;
  }
}

function transportError(error, secrets, phase) {
  const classification = classifyTransportError(error);
  const failure = new ProviderError(`Transport failure during ${phase}: ${error?.name ?? "Error"}`, {
    code: error?.name ?? error?.code ?? null,
    retryable: classification.retryable,
    category: classification.category,
    secrets,
  });
  failure.phase = phase;
  return failure;
}

/**
 * Retry a bounded number of times, only for errors explicitly marked retryable.
 * The bound is the safety property.
 */
export async function withBoundedRetry(operation, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = [];
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await operation(attempt);
      return { value, attempts: attempt };
    } catch (error) {
      lastError = error;
      attempts.push({ attempt, retryable: Boolean(error?.retryable), category: error?.category ?? null });
      if (!error?.retryable || attempt === maxAttempts) {
        if (lastError && typeof lastError === "object") lastError.attemptLog = attempts;
        throw lastError;
      }
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

/**
 * One generateContent call.
 *
 * Resolves to `{ body, attempts }` only when the response was HTTP-OK and its
 * body was both readable and valid JSON. Every other outcome throws a classified
 * ProviderError.
 */
export async function generateContent({ apiKey, model, request, fetchImpl = fetch, timeoutMs = 30_000, retry = {} }) {
  const url = generateContentUrl(model);
  const secrets = apiKey ? [apiKey] : [];

  const { value, attempts } = await withBoundedRetry(async () => {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        // The key travels in a header and never in the URL or body, so it cannot
        // reach a redirect, a log line or a shell history entry.
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw transportError(error, secrets, "request");
    }

    // G6a: reading the body is still inside the request deadline. A rejection
    // here is a transport failure and must keep its retry classification rather
    // than collapsing into an empty string.
    let raw;
    try {
      raw = await response.text();
    } catch (error) {
      throw transportError(error, secrets, "body_read");
    }

    if (!response.ok) {
      let parsed = null;
      try { parsed = raw === "" ? null : JSON.parse(raw); } catch { parsed = null; }
      const classification = classifyHttpError(response.status);
      throw new ProviderError(
        parsed?.error?.message ?? `Gemini request failed with HTTP ${response.status}`,
        {
          status: response.status,
          code: parsed?.error?.status ?? parsed?.error?.code ?? null,
          retryable: classification.retryable,
          category: classification.category,
          secrets,
        },
      );
    }

    // Distinct from a transport failure: the server answered completely, and what
    // it said is not JSON. Asking again is unlikely to change a malformed contract.
    let body;
    try {
      body = raw === "" ? null : JSON.parse(raw);
    } catch {
      throw new ProviderError("Provider returned HTTP 200 with a body that is not valid JSON.", {
        status: response.status,
        code: "MALFORMED_SUCCESS_BODY",
        retryable: false,
        category: "malformed_success",
        secrets,
      });
    }
    if (body === null) {
      throw new ProviderError("Provider returned HTTP 200 with an empty body.", {
        status: response.status,
        code: "EMPTY_SUCCESS_BODY",
        retryable: false,
        category: "malformed_success",
        secrets,
      });
    }

    return body;
  }, retry);

  return { body: value, attempts };
}

/** Shape a caught error for an artifact, with secrets already removed. */
export function describeError(error, secrets = []) {
  return redact({
    status: error?.status ?? null,
    code: error?.code ?? null,
    category: error?.category ?? "local_error",
    phase: error?.phase ?? null,
    retryable: Boolean(error?.retryable),
    attempts: error?.attemptLog ?? null,
    message: error?.message ?? String(error),
  }, secrets);
}

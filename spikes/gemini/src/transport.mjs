/**
 * Transport, failure classification and redaction.
 *
 * Three things here are load-bearing for the diagnostic's honesty:
 *
 * 1. A 200 is not a success. `response.json()` failing used to be swallowed
 *    into `{}`, which then flowed onward as a perfectly good empty answer.
 *    Receipt of a response and capability success are now separate outcomes.
 * 2. Transport failures are classified deliberately. An `AbortSignal.timeout`
 *    rejection is a `DOMException` with no `retryable` property, so the old
 *    retry helper treated every timeout as terminal by accident rather than by
 *    decision. Whether that is right is a policy question, so it is written
 *    down and tested instead of emerging from a missing field.
 * 3. Nothing that leaves this module may contain the API key. Providers echo
 *    request context in error bodies, and the key is one string substitution
 *    away from a committed artifact.
 */

export const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** Transport-level rejections, named rather than inferred from a missing field. */
const RETRYABLE_TRANSPORT = new Set([
  "TimeoutError",     // AbortSignal.timeout fired
  "AbortError",       // aborted in flight
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function classifyHttpError(status) {
  return {
    retryable: RETRYABLE_STATUS.has(status),
    category:
      status === 401 || status === 403
        ? "authentication_or_permission"
        : status === 429
          ? "quota_or_rate_limit"
          : status >= 500
            ? "provider_transient"
            : "request_or_content",
  };
}

/**
 * Classify a thrown transport error.
 *
 * A network failure is retryable because retrying can genuinely succeed; this
 * is a decision, and the bound in `withBoundedRetry` is what keeps it safe. An
 * unrecognised error stays terminal: looping on something we cannot name is
 * how a diagnostic turns into an outage.
 */
export function classifyTransportError(error) {
  const marker = error?.name ?? error?.code ?? "";
  const cause = error?.cause?.code ?? error?.cause?.name ?? "";
  const retryable = RETRYABLE_TRANSPORT.has(marker) || RETRYABLE_TRANSPORT.has(cause);
  return {
    retryable,
    category: marker === "TimeoutError" || cause === "UND_ERR_HEADERS_TIMEOUT"
      ? "transport_timeout"
      : retryable
        ? "transport_network"
        : "transport_unknown",
  };
}

/**
 * Remove secrets from anything destined for a log, artifact or test output.
 *
 * Takes the secrets explicitly rather than reaching for `process.env`, so a
 * caller cannot forget which value needed masking, and so the function itself
 * never has a reason to read the environment.
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
        // Header-shaped keys are dropped whole: their value is the credential,
        // and a redacted credential still tells a reader one was there.
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

/**
 * Retry a bounded number of times, only for errors explicitly marked retryable.
 *
 * The bound is the safety property: an unrecognised error is never retried,
 * and a retryable one is attempted a fixed number of times regardless of what
 * the provider keeps saying.
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
 * Returns `{ body, attempts }` on a response that was both HTTP-OK and valid
 * JSON. Every other outcome throws a classified `ProviderError`, including the
 * 200-with-unparseable-body case that previously slipped through as success.
 */
export async function generateContent({ apiKey, model, request, fetchImpl = fetch, timeoutMs = 30_000, retry = {} }) {
  const url = `${API_ROOT}/models/${encodeURIComponent(model)}:generateContent`;
  const secrets = apiKey ? [apiKey] : [];

  const { value, attempts } = await withBoundedRetry(async () => {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        // The key travels in a header and never in the URL or body, so it
        // cannot end up in a redirect, a log line or a shell history entry.
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const classification = classifyTransportError(error);
      throw new ProviderError(`Transport failure: ${error?.name ?? "Error"}`, {
        code: error?.name ?? error?.code ?? null,
        retryable: classification.retryable,
        category: classification.category,
        secrets,
      });
    }

    const raw = await response.text().catch(() => "");
    let body = null;
    let parseFailed = false;
    try {
      body = raw === "" ? null : JSON.parse(raw);
    } catch {
      parseFailed = true;
    }

    if (!response.ok) {
      const classification = classifyHttpError(response.status);
      throw new ProviderError(
        body?.error?.message ?? `Gemini request failed with HTTP ${response.status}`,
        {
          status: response.status,
          code: body?.error?.status ?? body?.error?.code ?? null,
          retryable: classification.retryable,
          category: classification.category,
          secrets,
        },
      );
    }

    if (parseFailed || body === null) {
      // A successful status with a body we cannot read is a failed capability,
      // not an empty result. Not retryable: the server answered, and asking
      // again is unlikely to change a malformed contract.
      throw new ProviderError("Provider returned HTTP 200 with a body that is not valid JSON.", {
        status: response.status,
        code: "MALFORMED_SUCCESS_BODY",
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
    retryable: Boolean(error?.retryable),
    attempts: error?.attemptLog ?? null,
    message: error?.message ?? String(error),
  }, secrets);
}

/**
 * Origin and client-address handling.
 *
 * Both are trust decisions, so both are made in one place with the same rule:
 * only what the server itself can see is used.
 *
 *   - Origin comes from the `Origin` header and is compared literally against the
 *     configured list. Missing, malformed or foreign all fail. No suffix match, no
 *     wildcard, no `Referer` fallback — a suffix rule would accept
 *     `https://evil-host.example` for a configured `host.example`.
 *   - The limiter key comes from `request.ip`. Forwarded headers are never read
 *     here: `X-Forwarded-For` is caller-controlled unless Fastify's `trustProxy`
 *     is configured to the actual reverse proxy, and that configuration belongs
 *     to API startup. If it is not configured, `request.ip` is the socket address,
 *     which is the safe answer rather than a spoofable one.
 *
 * Safe methods are not origin-checked, because they must not mutate anything.
 */

import type { FastifyRequest } from 'fastify';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

export type OriginFailure = 'missing_origin' | 'foreign_origin';

export type OriginCheck = { ok: true } | { ok: false; reason: OriginFailure };

export function checkOrigin(request: FastifyRequest, allowedOrigins: readonly string[]): OriginCheck {
  const header = request.headers.origin;
  if (typeof header !== 'string' || header === '') return { ok: false, reason: 'missing_origin' };
  // `Origin: null` is what an opaque origin sends. It is foreign, not absent.
  return allowedOrigins.includes(header) ? { ok: true } : { ok: false, reason: 'foreign_origin' };
}

/**
 * Accept only JSON on credential-bearing endpoints. A form-encoded or
 * `text/plain` body is what a cross-site form can send without a preflight, so
 * refusing anything else removes that route entirely.
 */
export function isJsonRequest(request: FastifyRequest): boolean {
  const header = request.headers['content-type'];
  if (typeof header !== 'string') return false;
  return header.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

/** Limiter key. Never derived from a header the caller controls. */
export function clientKey(request: FastifyRequest): string {
  return request.ip ?? 'unknown';
}

/**
 * Asymmetric token verification against a JWKS endpoint.
 *
 * T05's first pass implemented HS256 only and recorded asymmetric verification as
 * an open gate, because Supabase projects can be configured for RS256/ES256 and
 * doing that properly needs the project's JWKS plus key rotation. T08 then reported
 * it as a blocker. This closes it.
 *
 * What is real evidence here: the verification path is exercised with genuinely
 * generated RSA and EC keypairs, a served JWKS document, and real signatures — see
 * core.test.ts. `node:crypto` does the signature work, so nothing about the
 * cryptography is stubbed.
 *
 * What is still unverified: this has never run against a specific Supabase
 * project's JWKS. Issuer, audience and the key set itself are configuration.
 *
 * Rotation is handled by refetching on an unknown `kid`, with a floor on how often
 * that can happen so an attacker cannot turn unknown-kid tokens into a fetch
 * amplifier against the auth server.
 */

import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';

import type { AllowlistEntry, TokenVerifier, VerifyOutcome } from './verify.js';

/** Algorithms this verifier accepts. Anything else is refused outright. */
const SUPPORTED_ALGS = new Set(['RS256', 'ES256']);

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  [key: string]: unknown;
}

export interface JwksVerifierOptions {
  jwksUri: string;
  issuer: string;
  audience: string;
  allowlist: AllowlistEntry[];
  fetchImpl?: typeof fetch;
  now?: () => number;
  clockToleranceSeconds?: number;
  /** How long a fetched key set stays fresh. */
  cacheTtlMs?: number;
  /** Minimum gap between refetches triggered by an unknown kid. */
  minRefetchIntervalMs?: number;
}

function base64UrlDecode(segment: string): Buffer {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

function audienceMatches(claim: unknown, expected: string): boolean {
  if (typeof claim === 'string') return claim === expected;
  if (Array.isArray(claim)) return claim.some((entry) => entry === expected);
  return false;
}

/**
 * Verify a signature for the algorithms we accept.
 *
 * ES256 signatures in JWTs are raw `r||s`, not DER, so the verifier is told to
 * expect IEEE-P1363. Getting that wrong rejects every valid EC token, which is the
 * kind of failure that looks like "asymmetric auth is broken".
 */
function signatureValid(alg: string, key: KeyObject, signingInput: string, signature: Buffer): boolean {
  try {
    if (alg === 'RS256') {
      return createVerify('RSA-SHA256').update(signingInput).verify(key, signature);
    }
    if (alg === 'ES256') {
      return createVerify('SHA256').update(signingInput).verify(
        { key, dsaEncoding: 'ieee-p1363' },
        signature,
      );
    }
    return false;
  } catch {
    // A malformed key or signature is a verification failure, never a crash.
    return false;
  }
}

export function createJwksVerifier(options: JwksVerifierOptions): TokenVerifier & {
  /** Exposed for tests and diagnostics; never logs key material. */
  cacheState(): { keyCount: number; fetchedAt: number | null; fetches: number };
} {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const tolerance = options.clockToleranceSeconds ?? 0;
  const cacheTtlMs = options.cacheTtlMs ?? 10 * 60 * 1000;
  const minRefetchIntervalMs = options.minRefetchIntervalMs ?? 30 * 1000;
  const allowlist = new Map(options.allowlist.map((entry) => [entry.id, entry]));

  let keys = new Map<string, { alg: string; key: KeyObject }>();
  let fetchedAt: number | null = null;
  let lastAttemptAt = 0;
  let fetches = 0;
  let inFlight: Promise<void> | null = null;

  async function loadKeys(): Promise<void> {
    // Single-flight: a burst of requests after a rotation must not stampede the
    // auth server with identical JWKS fetches.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      lastAttemptAt = now();
      fetches += 1;
      const response = await fetchImpl(options.jwksUri, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`jwks fetch failed with status ${response.status}`);
      const document = (await response.json()) as { keys?: Jwk[] };
      const next = new Map<string, { alg: string; key: KeyObject }>();
      for (const jwk of document.keys ?? []) {
        // Signing keys only, and only algorithms we actually verify.
        if (jwk.use !== undefined && jwk.use !== 'sig') continue;
        const alg = typeof jwk.alg === 'string' ? jwk.alg : null;
        if (alg === null || !SUPPORTED_ALGS.has(alg)) continue;
        if (typeof jwk.kid !== 'string' || jwk.kid === '') continue;
        try {
          next.set(jwk.kid, { alg, key: createPublicKey({ key: jwk as never, format: 'jwk' }) });
        } catch {
          // An unusable key is skipped rather than failing the whole set: one bad
          // entry must not lock out every other valid key.
        }
      }
      keys = next;
      fetchedAt = now();
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function keyFor(kid: string): Promise<{ alg: string; key: KeyObject } | null> {
    const stale = fetchedAt === null || now() - fetchedAt > cacheTtlMs;
    if (stale) {
      try { await loadKeys(); } catch { /* fall through to the cached set, if any */ }
    }
    const hit = keys.get(kid);
    if (hit) return hit;

    // Unknown kid: this is what a rotation looks like. Refetch, but not more often
    // than the floor allows.
    if (now() - lastAttemptAt >= minRefetchIntervalMs) {
      try { await loadKeys(); } catch { return null; }
      return keys.get(kid) ?? null;
    }
    return null;
  }

  return {
    cacheState: () => ({ keyCount: keys.size, fetchedAt, fetches }),

    async verify(token): Promise<VerifyOutcome> {
      if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'missing_token' };
      const parts = token.split('.');
      if (parts.length !== 3) return { ok: false, reason: 'malformed_token' };
      const [headerSegment, payloadSegment, signatureSegment] = parts;

      let header: { alg?: unknown; kid?: unknown };
      let payload: { sub?: unknown; iss?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown };
      try {
        header = JSON.parse(base64UrlDecode(headerSegment).toString('utf8'));
        payload = JSON.parse(base64UrlDecode(payloadSegment).toString('utf8'));
      } catch {
        return { ok: false, reason: 'malformed_token' };
      }
      if (payload === null || typeof payload !== 'object') return { ok: false, reason: 'malformed_token' };

      if (typeof header.alg !== 'string' || !SUPPORTED_ALGS.has(header.alg)) {
        // Includes `none` and any HMAC alg: an HS256 token must never be verified
        // with a public key, which is the classic algorithm-confusion attack.
        return { ok: false, reason: 'unsupported_algorithm' };
      }
      if (typeof header.kid !== 'string' || header.kid === '') {
        return { ok: false, reason: 'unknown_key' };
      }

      const entry = await keyFor(header.kid);
      if (!entry) return { ok: false, reason: 'unknown_key' };
      // The key's own alg must match the token's, so a token cannot nominate a
      // weaker algorithm for a key published for something else.
      if (entry.alg !== header.alg) return { ok: false, reason: 'unsupported_algorithm' };

      if (!signatureValid(header.alg, entry.key, `${headerSegment}.${payloadSegment}`, base64UrlDecode(signatureSegment))) {
        return { ok: false, reason: 'bad_signature' };
      }

      // Claims are only trusted after the signature check.
      if (payload.iss !== options.issuer) return { ok: false, reason: 'wrong_issuer' };
      if (!audienceMatches(payload.aud, options.audience)) return { ok: false, reason: 'wrong_audience' };

      const seconds = Math.floor(now() / 1000);
      if (typeof payload.exp !== 'number' || seconds > payload.exp + tolerance) {
        return { ok: false, reason: 'expired' };
      }
      if (typeof payload.nbf === 'number' && seconds + tolerance < payload.nbf) {
        return { ok: false, reason: 'not_yet_valid' };
      }
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        return { ok: false, reason: 'missing_subject' };
      }
      const user = allowlist.get(payload.sub);
      if (!user) return { ok: false, reason: 'not_allowlisted' };

      return { ok: true, actor: { id: user.id, name: user.name } };
    },
  };
}

/**
 * Pick a verifier from configuration.
 *
 * A JWKS URI selects asymmetric verification; a shared secret selects HS256. Both
 * configured is a configuration error rather than a silent preference, because
 * accepting either signature type widens the trust boundary invisibly.
 */
export function selectVerifier(config: {
  jwksUri?: string;
  secret?: string;
  issuer: string;
  audience: string;
  allowlist: AllowlistEntry[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}, createHs256: (options: {
  secret: string; issuer: string; audience: string; allowlist: AllowlistEntry[]; now?: () => number;
}) => TokenVerifier): TokenVerifier {
  const hasJwks = typeof config.jwksUri === 'string' && config.jwksUri !== '';
  const hasSecret = typeof config.secret === 'string' && config.secret !== '';
  if (hasJwks && hasSecret) {
    throw new Error('Configure either a JWKS URI or a shared secret, not both');
  }
  if (hasJwks) {
    return createJwksVerifier({
      jwksUri: config.jwksUri as string,
      issuer: config.issuer,
      audience: config.audience,
      allowlist: config.allowlist,
      fetchImpl: config.fetchImpl,
      now: config.now,
    });
  }
  if (hasSecret) {
    return createHs256({
      secret: config.secret as string,
      issuer: config.issuer,
      audience: config.audience,
      allowlist: config.allowlist,
      now: config.now,
    });
  }
  throw new Error('No token verification is configured: supply a JWKS URI or a shared secret');
}

/**
 * Token verification and allowlist enforcement.
 *
 * T00: "JWTs require signature/issuer/audience/expiry validation and membership in
 * the two-user allowlist. No anonymous/third-user API access; no privileged keys in
 * web builds."
 *
 * Scope and honesty about it:
 *
 *   - HS256 verification against the project's JWT secret is implemented here in
 *     full, using `node:crypto` only. That is Supabase's shared-secret model and it
 *     is testable locally with self-issued tokens, so the auth boundary is real
 *     evidence rather than a stub.
 *   - Asymmetric verification via a JWKS endpoint is **not** implemented. Supabase
 *     projects can be configured for RS256/ES256, and doing that properly needs the
 *     project's JWKS URL plus key rotation handling. `TokenVerifier` is an interface
 *     precisely so a JWKS verifier can be added without touching route code, and
 *     the gap is recorded in docs/implementation/T05-result.md rather than papered
 *     over.
 *
 * Nothing here logs a token, a secret or a signature.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AllowlistEntry {
  id: string;
  name: 'NOXAVA' | 'SZRON';
}

export interface VerifiedActor {
  id: string;
  name: 'NOXAVA' | 'SZRON';
}

export type AuthFailureReason =
  | 'missing_token'
  | 'malformed_token'
  | 'unsupported_algorithm'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'missing_subject'
  | 'not_allowlisted';

export type VerifyOutcome =
  | { ok: true; actor: VerifiedActor }
  | { ok: false; reason: AuthFailureReason };

export interface TokenVerifier {
  verify(token: string | undefined): Promise<VerifyOutcome>;
}

export interface Hs256VerifierOptions {
  secret: string;
  issuer: string;
  audience: string;
  allowlist: AllowlistEntry[];
  /** Injected for deterministic expiry tests. */
  now?: () => number;
  /** Seconds of tolerance for clock skew. Defaults to none: expiry means expiry. */
  clockToleranceSeconds?: number;
}

function base64UrlDecode(segment: string): Buffer {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

export function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time comparison that does not leak length through an exception. */
function signaturesMatch(expected: Buffer, actual: Buffer): boolean {
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

interface JwtPayload {
  sub?: unknown;
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
}

/**
 * Audience may legitimately be a string or an array of strings; both are accepted,
 * and anything else is a wrong-audience failure rather than an ignored field.
 */
function audienceMatches(claim: unknown, expected: string): boolean {
  if (typeof claim === 'string') return claim === expected;
  if (Array.isArray(claim)) return claim.some((entry) => entry === expected);
  return false;
}

export function createHs256Verifier(options: Hs256VerifierOptions): TokenVerifier {
  const now = options.now ?? (() => Date.now());
  const tolerance = options.clockToleranceSeconds ?? 0;
  const allowlist = new Map(options.allowlist.map((entry) => [entry.id, entry]));

  return {
    async verify(token) {
      if (typeof token !== 'string' || token.length === 0) return { ok: false, reason: 'missing_token' };

      const parts = token.split('.');
      if (parts.length !== 3) return { ok: false, reason: 'malformed_token' };
      const [headerSegment, payloadSegment, signatureSegment] = parts;

      let header: { alg?: unknown; typ?: unknown };
      let payload: JwtPayload;
      try {
        header = JSON.parse(base64UrlDecode(headerSegment).toString('utf8'));
        payload = JSON.parse(base64UrlDecode(payloadSegment).toString('utf8'));
      } catch {
        return { ok: false, reason: 'malformed_token' };
      }
      if (payload === null || typeof payload !== 'object') return { ok: false, reason: 'malformed_token' };

      // `alg: none` and any asymmetric algorithm are refused outright rather than
      // being verified with the wrong key material.
      if (header.alg !== 'HS256') return { ok: false, reason: 'unsupported_algorithm' };

      const expected = createHmac('sha256', options.secret)
        .update(`${headerSegment}.${payloadSegment}`)
        .digest();
      if (!signaturesMatch(expected, base64UrlDecode(signatureSegment))) {
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
      const entry = allowlist.get(payload.sub);
      // A validly signed token for a third identity is still refused.
      if (!entry) return { ok: false, reason: 'not_allowlisted' };

      return { ok: true, actor: { id: entry.id, name: entry.name } };
    },
  };
}

/** Extract a bearer token without revealing the header's contents on failure. */
export function bearerToken(authorization: string | undefined): string | undefined {
  if (typeof authorization !== 'string') return undefined;
  const match = /^Bearer (.+)$/.exec(authorization.trim());
  return match ? match[1] : undefined;
}

/**
 * Sign an HS256 token. Test and local-fixture helper: it lets the suite prove the
 * verifier accepts genuine tokens and rejects tampered ones without a hosted
 * project. It issues nothing for production use and creates no account.
 */
export function signHs256(
  payload: Record<string, unknown>,
  secret: string,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string {
  const headerSegment = base64UrlEncode(JSON.stringify(header));
  const payloadSegment = base64UrlEncode(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`${headerSegment}.${payloadSegment}`).digest();
  return `${headerSegment}.${payloadSegment}.${base64UrlEncode(signature)}`;
}

/**
 * Opaque session records.
 *
 * The browser holds 32 cryptographically random bytes and nothing else. This
 * module owns the only mapping from that secret to an identity, and it stores
 * only digests:
 *
 *   token_hash      = SHA-256(session secret)
 *   csrf_token_hash = SHA-256(HMAC-SHA-256(csrf secret, session secret))
 *
 * Two consequences worth stating, because they are the reason for the shape:
 *
 *   - A reader of the database cannot mint a usable cookie or a usable CSRF
 *     header. Both stored values are one-way images of material that only ever
 *     existed in the login response.
 *   - Rotating the CSRF secret changes every derivation, so no live session can
 *     present a token matching its stored digest. Rotation therefore invalidates
 *     sessions by construction rather than by a sweep that could be skipped.
 *
 * There is no sliding expiry. `expires_at` is fixed at login, so a session has a
 * real maximum age regardless of activity.
 */

import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

import type { Database, Queryable } from '../db/client.js';

/** URL-safe, no padding: the value travels in a cookie. */
function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const SESSION_SECRET_BYTES = 32;

export function newSessionSecret(): string {
  return base64Url(randomBytes(SESSION_SECRET_BYTES));
}

export function sessionTokenHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Session-bound: the same csrf secret yields a different token per session. */
export function deriveCsrfToken(csrfSecret: string, sessionSecret: string): string {
  return base64Url(createHmac('sha256', csrfSecret).update(sessionSecret, 'utf8').digest());
}

export function csrfTokenHash(csrfToken: string): string {
  return createHash('sha256').update(csrfToken, 'utf8').digest('hex');
}

/**
 * Compare two hex digests without an early exit on the first differing byte.
 * `timingSafeEqual` throws on a length mismatch, so the length is checked first
 * and reported as a plain non-match.
 */
export function digestsMatch(expected: string, actual: string): boolean {
  if (typeof actual !== 'string' || expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'));
}

export interface SessionRow {
  tokenHash: string;
  userId: string;
  csrfTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  userName: 'NOXAVA' | 'SZRON';
}

export type SessionFailure =
  /** No cookie was presented at all. */
  | 'missing_cookie'
  /** The cookie value does not correspond to any stored session. */
  | 'unknown_session'
  | 'expired'
  | 'revoked'
  /** The CSRF secret changed since login, so the session is no longer derivable. */
  | 'csrf_secret_rotated'
  /** The two product users are not both provisioned; no request is served. */
  | 'not_provisioned';

export type SessionLookup =
  | { ok: true; session: SessionRow; csrfToken: string }
  | { ok: false; reason: SessionFailure };

interface RawRow {
  token_hash: string;
  user_id: string;
  csrf_token_hash: string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  user_name: 'NOXAVA' | 'SZRON';
  provisioned_users: string | number;
}

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

export interface SessionStore {
  create(input: { userId: string; csrfSecret: string; lifetimeMs: number }): Promise<{
    secret: string;
    csrfToken: string;
    expiresAt: Date;
  }>;
  /** Resolve a cookie value. Never throws for a bad session; the reason is returned. */
  resolve(secret: string | undefined, csrfSecret: string): Promise<SessionLookup>;
  /** `true` only when a live session was actually revoked by this call. */
  revoke(secret: string): Promise<boolean>;
  revokeAllForUser(userId: string): Promise<number>;
}

export function createSessionStore(db: Database, now: () => number = () => Date.now()): SessionStore {
  return {
    async create({ userId, csrfSecret, lifetimeMs }) {
      const secret = newSessionSecret();
      const expiresAt = new Date(now() + lifetimeMs);
      const csrfToken = deriveCsrfToken(csrfSecret, secret);
      // `created_at` is written explicitly rather than defaulted so the
      // expires_at > created_at constraint is checked against the same clock the
      // lifetime was computed from.
      await db.query(
        `insert into app.auth_sessions (token_hash, user_id, csrf_token_hash, created_at, expires_at)
         values ($1, $2, $3, $4, $5)`,
        [sessionTokenHash(secret), userId, csrfTokenHash(csrfToken), new Date(now()), expiresAt],
      );
      return { secret, csrfToken, expiresAt };
    },

    async resolve(secret, csrfSecret) {
      if (typeof secret !== 'string' || secret === '') return { ok: false, reason: 'missing_cookie' };

      // One statement, so expiry, revocation and both-user provisioning are all
      // decided from the same snapshot. `app.users` is constrained to at most the
      // two named rows, so a count of two means NOXAVA and SZRON both exist.
      const result = await db.query<RawRow>(
        `select s.token_hash, s.user_id, s.csrf_token_hash, s.expires_at, s.revoked_at,
                u.name as user_name,
                (select count(*) from app.users) as provisioned_users
           from app.auth_sessions s
           join app.users u on u.id = s.user_id
          where s.token_hash = $1`,
        [sessionTokenHash(secret)],
      );
      const row = result.rows[0];
      if (!row) return { ok: false, reason: 'unknown_session' };
      if (Number(row.provisioned_users) !== 2) return { ok: false, reason: 'not_provisioned' };
      if (row.revoked_at !== null) return { ok: false, reason: 'revoked' };
      if (asDate(row.expires_at).getTime() <= now()) return { ok: false, reason: 'expired' };

      // Recomputed from the presented secret and the current CSRF secret. A
      // mismatch means the secret was rotated, so the session is refused rather
      // than served without working CSRF protection.
      const csrfToken = deriveCsrfToken(csrfSecret, secret);
      if (!digestsMatch(row.csrf_token_hash, csrfTokenHash(csrfToken))) {
        return { ok: false, reason: 'csrf_secret_rotated' };
      }

      return {
        ok: true,
        csrfToken,
        session: {
          tokenHash: row.token_hash,
          userId: row.user_id,
          csrfTokenHash: row.csrf_token_hash,
          expiresAt: asDate(row.expires_at),
          revokedAt: null,
          userName: row.user_name,
        },
      };
    },

    async revoke(secret) {
      // `revoked_at is null` in the predicate is what makes the boolean truthful:
      // re-revoking an already-revoked session reports false rather than claiming
      // a live session was ended.
      const result = await db.query(
        `update app.auth_sessions set revoked_at = $2
          where token_hash = $1 and revoked_at is null and expires_at > $2`,
        [sessionTokenHash(secret), new Date(now())],
      );
      return result.rowCount > 0;
    },

    async revokeAllForUser(userId) {
      const result = await db.query(
        `update app.auth_sessions set revoked_at = $2
          where user_id = $1 and revoked_at is null and expires_at > $2`,
        [userId, new Date(now())],
      );
      return result.rowCount;
    },
  };
}

/**
 * Remove sessions that can no longer authenticate anything. Expired and revoked
 * rows carry no live capability, so deleting them loses nothing; it is offered as
 * an explicit maintenance call rather than run implicitly on a request path.
 */
export async function pruneDeadSessions(db: Queryable, before: Date): Promise<number> {
  const result = await db.query(
    'delete from app.auth_sessions where expires_at <= $1 or revoked_at is not null',
    [before],
  );
  return result.rowCount;
}

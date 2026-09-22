import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
/**
 * Test-only helpers for session authentication.
 *
 * Nothing in production imports this file. It exists so a test can obtain a real
 * session — a real row in `app.auth_sessions`, a real cookie, a real derived CSRF
 * token — without spending an Argon2id verification on every request, and without
 * any test-only relaxation of the checks being tested. There is no bypass here:
 * the sessions issued below go through the same `SessionStore` the login route
 * uses, and `authenticate` validates them exactly as it validates a real browser's.
 *
 * The password constants are synthetic values used only to write and then verify a
 * hash inside a throwaway in-process database. They are not credentials for
 * anything, and no committed fixture contains a hash of a real password.
 */

import type { FastifyInstance } from 'fastify';

import type { Database } from '../db/client.js';
import { buildAuthConfig, type AuthEnv } from './config.js';
import { createPasswordHasher } from './passwords.js';
import { createAuthService, requestAuthenticator, type AuthService } from './service.js';
import { createSessionStore } from './sessions.js';
import { registerAuthRoutes } from './routes.js';

export const TEST_ORIGIN = 'https://szronox.test';
export const FOREIGN_ORIGIN = 'https://not-szronox.test';

/** Minimum length is enforced by `buildAuthConfig`; this is deliberately over it. */
export const TEST_CSRF_SECRET = 'test-only-csrf-secret-0123456789abcdefghij';

const secretDirectory = mkdtempSync(path.join(tmpdir(), 'szronox-auth-test-'));
let secretSequence = 0;
process.once('exit', () => rmSync(secretDirectory, { recursive: true, force: true }));
export function testSecretFile(value: string): string {
  const file = path.join(secretDirectory, String(secretSequence++));
  writeFileSync(file, value, { mode: 0o600 });
  return file;
}

export const TEST_AUTH_ENV: AuthEnv = {
  APP_ORIGIN: TEST_ORIGIN,
  APP_CSRF_SECRET_FILE: testSecretFile(TEST_CSRF_SECRET),
};

export const TEST_PASSWORDS = {
  NOXAVA: 'synthetic-noxava-password-ĄĘŁŻ-1',
  SZRON: 'synthetic-szron-password-ĄĘŁŻ-2',
} as const;

/**
 * Hash each synthetic password once per process.
 *
 * Argon2id is intentionally slow, so hashing per fixture would dominate the suite.
 * Verification is still performed for real on every login the tests exercise.
 */
const hashedOnce = new Map<string, Promise<string>>();

export function testPasswordHash(password: string): Promise<string> {
  let existing = hashedOnce.get(password);
  if (!existing) {
    existing = createPasswordHasher(1).hash(password);
    hashedOnce.set(password, existing);
  }
  return existing;
}

/** Write credentials for already-seeded users. Does not create user rows. */
export async function provisionTestCredentials(
  db: Database,
  users: ReadonlyArray<{ id: string; name: 'NOXAVA' | 'SZRON' }>,
): Promise<void> {
  for (const user of users) {
    await db.query(
      `insert into app.user_credentials (user_id, password_hash) values ($1, $2)
       on conflict (user_id) do update set password_hash = excluded.password_hash`,
      [user.id, await testPasswordHash(TEST_PASSWORDS[user.name])],
    );
  }
}

export interface IssuedSession {
  secret: string;
  csrfToken: string;
  expiresAt: Date;
}

export interface SessionHarness {
  service: AuthService;
  authenticate: ReturnType<typeof requestAuthenticator>;
  /** Create a live session directly through the store, skipping password work. */
  issue(userId: string): Promise<IssuedSession>;
  /** Headers for a request as `userId`: cookie always, Origin and CSRF when unsafe. */
  headers(session: IssuedSession, method: string): Record<string, string>;
  cookieHeader(secret: string): string;
  register(app: FastifyInstance): void;
}

export interface SessionHarnessOptions {
  env?: AuthEnv;
  now?: () => number;
}

export function sessionHarness(db: Database, options: SessionHarnessOptions = {}): SessionHarness {
  const config = buildAuthConfig({ ...TEST_AUTH_ENV, ...options.env });
  const now = options.now ?? (() => Date.now());
  const hasher = createPasswordHasher(2);
  const sessions = createSessionStore(db, now);
  const service = createAuthService({ db, config, hasher, sessions, now });

  return {
    service,
    authenticate: requestAuthenticator(service),
    async issue(userId) {
      const created = await sessions.create({
        userId,
        csrfSecret: config.csrfSecret,
        lifetimeMs: config.sessionLifetimeMs,
      });
      return { secret: created.secret, csrfToken: created.csrfToken, expiresAt: created.expiresAt };
    },
    cookieHeader: (secret) => `${config.cookieName}=${secret}`,
    headers(session, method) {
      const base: Record<string, string> = { cookie: `${config.cookieName}=${session.secret}` };
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
        base.origin = config.allowedOrigins[0];
        base['x-csrf-token'] = session.csrfToken;
      }
      return base;
    },
    register: (app) => registerAuthRoutes(app, { service }),
  };
}

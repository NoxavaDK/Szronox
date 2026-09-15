/**
 * VPS-01 authentication, end to end against a real PostgreSQL.
 *
 * PGlite is PostgreSQL 18 compiled to WASM, so the reserved migration actually
 * applies, the CHECK constraints on the two new tables actually fire, and session
 * rows are actually read back through SQL. Argon2id hashing and verification are
 * real: no password check is stubbed anywhere in this file.
 *
 * Requests go through `app.inject`, which is Fastify's own request pipeline — real
 * routing, real header parsing, real serialisation. What that cannot show is a
 * browser's own behaviour: whether Chrome honours `__Host-`, `HttpOnly` or
 * `SameSite=Lax` is asserted here only as the emitted header, and the browser
 * acceptance steps remain a VPS-07 gate.
 *
 * Every password in this file is synthetic and exists only inside an in-process
 * database that is discarded when the test ends.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import Fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';

import { buildAuthConfig, SESSION_COOKIE_NAME, MAX_PASSWORD_BYTES, parseOrigins, AuthConfigError } from './auth/config.js';
import { clearedSessionCookie, serializeSessionCookie } from './auth/cookies.js';
import { createPasswordHasher, ARGON2ID_PARAMETERS, PasswordInputError, assertUsablePassword } from './auth/passwords.js';
import { registerAuthRoutes, AUTH_LOG_REDACT_PATHS } from './auth/routes.js';
import { createAuthService, type AuthService } from './auth/service.js';
import { createSessionStore, deriveCsrfToken, pruneDeadSessions } from './auth/sessions.js';
import { createThrottle, DEFAULT_ACCOUNT_THROTTLE, DEFAULT_ADDRESS_THROTTLE } from './auth/throttle.js';
import { assertProvisioned, ProvisioningError, setPassword } from './auth/users.js';
import { passwordFromStdinText, provisionPassword } from './auth/provision.js';
import { TEST_AUTH_ENV, TEST_CSRF_SECRET, testSecretFile, TEST_ORIGIN, FOREIGN_ORIGIN, TEST_PASSWORDS, testPasswordHash } from './auth/test-support.js';
import { registerCoreRoutes } from './core/routes.js';
import { memoryStorageAdapter } from './core/storage.js';
import { type Database, pgliteDatabase } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';

const NOXAVA = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' as const };
const SZRON = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' as const };

interface Fixture {
  db: Database;
  app: FastifyInstance;
  service: AuthService;
  /** Mutable clock, so expiry can be reached without waiting seven days. */
  clock: { ms: number };
  close(): Promise<void>;
}

interface FixtureOptions {
  addressLimit?: number;
  accountLimit?: number;
  csrfSecret?: string;
  lifetimeSeconds?: number;
  /** Provision credentials for these users only. Defaults to both. */
  withCredentials?: ReadonlyArray<{ id: string; name: 'NOXAVA' | 'SZRON' }>;
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const db = pgliteDatabase(await PGlite.create());
  await migrate(db);
  await seedUsers(db, [NOXAVA, SZRON]);

  for (const user of options.withCredentials ?? [NOXAVA, SZRON]) {
    await db.query(
      'insert into app.user_credentials (user_id, password_hash) values ($1, $2)',
      [user.id, await testPasswordHash(TEST_PASSWORDS[user.name])],
    );
  }

  const clock = { ms: Date.UTC(2026, 8, 14, 12, 0, 0) };
  const now = () => clock.ms;
  const config = buildAuthConfig({
    ...TEST_AUTH_ENV,
    ...(options.csrfSecret === undefined ? {} : { APP_CSRF_SECRET_FILE: testSecretFile(options.csrfSecret) }),
    ...(options.lifetimeSeconds === undefined ? {} : { APP_SESSION_TTL_SECONDS: String(options.lifetimeSeconds) }),
  });
  const service = createAuthService({
    db,
    config,
    now,
    hasher: createPasswordHasher(2),
    sessions: createSessionStore(db, now),
    addressThrottle: createThrottle({ limit: options.addressLimit ?? 50, windowMs: 60_000, now }),
    accountThrottle: createThrottle({ limit: options.accountLimit ?? 50, windowMs: 60_000, now }),
  });

  const app = Fastify({ logger: false });
  registerAuthRoutes(app, { service });
  registerCoreRoutes(app, {
    db,
    storage: memoryStorageAdapter(),
    authenticate: (request) => service.authenticate(request),
    allowlist: [{ ...NOXAVA, avatarUrl: null }, { ...SZRON, avatarUrl: null }],
  });
  await app.ready();

  return {
    db, app, service, clock,
    async close() { await app.close(); await db.close(); },
  };
}

/** Pull the single Set-Cookie value, failing loudly rather than picking one silently. */
function setCookieOf(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  assert.ok(typeof header === 'string', `expected exactly one Set-Cookie, got ${JSON.stringify(header)}`);
  return header;
}

function cookieValueOf(setCookie: string): string {
  const first = setCookie.split(';', 1)[0];
  return decodeURIComponent(first.slice(first.indexOf('=') + 1));
}

async function login(
  ctx: Fixture,
  name: 'NOXAVA' | 'SZRON',
  password: string = TEST_PASSWORDS[name],
  over: { origin?: string; ip?: string; cookie?: string } = {},
) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: {
      origin: over.origin ?? TEST_ORIGIN,
      ...(over.cookie === undefined ? {} : { cookie: over.cookie }),
    },
    remoteAddress: over.ip ?? '203.0.113.10',
    payload: { name, password },
  });
}

interface LoggedIn { cookie: string; csrfToken: string; body: Record<string, unknown> }

async function loggedIn(ctx: Fixture, name: 'NOXAVA' | 'SZRON'): Promise<LoggedIn> {
  const response = await login(ctx, name);
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as Record<string, unknown>;
  return {
    cookie: `${SESSION_COOKIE_NAME}=${cookieValueOf(setCookieOf(response))}`,
    csrfToken: body.csrfToken as string,
    body,
  };
}

// ══════════════════════════ login ═══════════════════════════════════════════

test('each provisioned account logs in and receives its own identity, peer and session cookie', async () => {
  const ctx = await fixture();
  try {
    for (const [user, peer] of [[NOXAVA, SZRON], [SZRON, NOXAVA]] as const) {
      const response = await login(ctx, user.name);
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json();

      assert.deepEqual(body.user, { id: user.id, name: user.name, avatarUrl: null });
      assert.deepEqual(body.peer, { id: peer.id, name: peer.name, avatarUrl: null });
      assert.equal(body.expiresAt, new Date(ctx.clock.ms + 7 * 24 * 3600 * 1000).toISOString());
      assert.equal(typeof body.csrfToken, 'string');

      // The response carries metadata only: the session secret is exclusively in
      // the cookie, so a body captured from a log or a cache cannot authenticate.
      const secret = cookieValueOf(setCookieOf(response));
      assert.ok(secret.length >= 40, 'the session secret must be 32 random bytes, base64url');
      assert.ok(!JSON.stringify(body).includes(secret), 'the session secret must not appear in the body');
      assert.equal(response.headers['cache-control'], 'no-store');
    }
  } finally {
    await ctx.close();
  }
});

test('the session cookie carries every attribute the __Host- prefix requires', async () => {
  const ctx = await fixture();
  try {
    const setCookie = setCookieOf(await login(ctx, 'NOXAVA'));
    assert.ok(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`), setCookie);
    assert.match(setCookie, /; Path=\/(;|$)/);
    assert.match(setCookie, /; HttpOnly(;|$)/);
    assert.match(setCookie, /; Secure(;|$)/);
    assert.match(setCookie, /; SameSite=Lax(;|$)/);
    // A Domain attribute would both break the __Host- prefix and widen the cookie
    // to sibling hosts.
    assert.ok(!/Domain=/i.test(setCookie), 'a __Host- cookie must carry no Domain');
    // Max-Age is bounded by the server's own expiry, not an independent value.
    assert.match(setCookie, new RegExp(`; Max-Age=${7 * 24 * 3600}(;|$)`));
  } finally {
    await ctx.close();
  }
});

test('the session secret is stored only as a digest, and the CSRF token only as a digest of a derivation', async () => {
  const ctx = await fixture();
  try {
    const session = await loggedIn(ctx, 'NOXAVA');
    const secret = session.cookie.slice(session.cookie.indexOf('=') + 1);

    const rows = await ctx.db.query<{ token_hash: string; csrf_token_hash: string; user_id: string }>(
      'select token_hash, csrf_token_hash, user_id from app.auth_sessions',
    );
    assert.equal(rows.rows.length, 1);
    const row = rows.rows[0];
    assert.equal(row.user_id, NOXAVA.id);
    // Neither the cookie value nor the CSRF token is recoverable from the table.
    assert.notEqual(row.token_hash, secret);
    assert.notEqual(row.csrf_token_hash, session.csrfToken);
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);
    assert.match(row.csrf_token_hash, /^[0-9a-f]{64}$/);

    // The CSRF token is session-bound: the same secret and a different session
    // secret derive different tokens.
    assert.notEqual(
      deriveCsrfToken(TEST_CSRF_SECRET, secret),
      deriveCsrfToken(TEST_CSRF_SECRET, `${secret}x`),
    );
    assert.equal(deriveCsrfToken(TEST_CSRF_SECRET, secret), session.csrfToken);
  } finally {
    await ctx.close();
  }
});

test('an incorrect password is refused, and the account remains usable with the right one', async () => {
  const ctx = await fixture();
  try {
    const wrong = await login(ctx, 'NOXAVA', 'not-the-password');
    assert.equal(wrong.statusCode, 401);
    assert.deepEqual(wrong.json(), {
      error: { code: 'UNAUTHENTICATED', message: 'Invalid account or password', retryable: false },
    });
    assert.equal(wrong.headers['set-cookie'], undefined, 'a failed login must not set a session cookie');
    assert.equal((await ctx.db.query('select 1 from app.auth_sessions')).rows.length, 0);

    assert.equal((await login(ctx, 'NOXAVA')).statusCode, 200);
  } finally {
    await ctx.close();
  }
});

test('a nonexistent account is indistinguishable from a wrong password', async () => {
  // SZRON is seeded but deliberately has no credential row, which is the other way
  // an account can fail to exist as far as login is concerned.
  const ctx = await fixture({ withCredentials: [NOXAVA] });
  try {
    const wrongPassword = await login(ctx, 'NOXAVA', 'not-the-password');
    const noCredential = await login(ctx, 'SZRON', 'anything-at-all');
    const unknownName = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: TEST_ORIGIN },
      payload: { name: 'INTRUDER', password: 'anything-at-all' },
    });

    // Identical status and identical envelope. Nothing in the response says which
    // of the three situations occurred.
    for (const response of [noCredential, unknownName]) {
      assert.equal(response.statusCode, wrongPassword.statusCode);
      assert.deepEqual(response.json(), wrongPassword.json());
      assert.equal(response.headers['set-cookie'], undefined);
    }
  } finally {
    await ctx.close();
  }
});

test('a password is never truncated, so a longer password is not satisfied by its prefix', async () => {
  const ctx = await fixture();
  try {
    const long = `${'a'.repeat(300)}-koniec-ĄĘŁŻ`;
    await setPassword(ctx.db, createPasswordHasher(1), { userId: NOXAVA.id, password: long });

    assert.equal((await login(ctx, 'NOXAVA', long)).statusCode, 200);
    assert.equal((await login(ctx, 'NOXAVA', 'a'.repeat(300))).statusCode, 401);
    assert.equal((await login(ctx, 'NOXAVA', `${long} `)).statusCode, 401, 'trailing whitespace is part of the password');

    // Over the byte bound is a request-shape refusal, not a silent shortening.
    const oversized = await login(ctx, 'NOXAVA', 'ą'.repeat(MAX_PASSWORD_BYTES));
    assert.equal(oversized.statusCode, 422);
    assert.equal(oversized.json().error.code, 'VALIDATION_ERROR');

    assert.throws(() => assertUsablePassword(''), PasswordInputError);
    assert.throws(() => assertUsablePassword(undefined), PasswordInputError);
  } finally {
    await ctx.close();
  }
});

test('stored hashes are Argon2id with the pinned parameters and a per-password salt', async () => {
  const ctx = await fixture();
  try {
    const hasher = createPasswordHasher(2);
    const first = await hasher.hash('ten-sam-tekst');
    const second = await hasher.hash('ten-sam-tekst');

    assert.ok(first.startsWith('$argon2id$'), first.slice(0, 20));
    assert.notEqual(first, second, 'a per-password random salt must make identical passwords hash differently');
    assert.ok(await hasher.verify(first, 'ten-sam-tekst'));
    assert.ok(!(await hasher.verify(first, 'inny-tekst')));
    // A foreign or corrupt stored hash is a failed verification, never a throw
    // that a route could turn into a 500 on an ordinary wrong-password attempt.
    assert.ok(!(await hasher.verify('not-a-phc-string', 'ten-sam-tekst')));
    assert.equal(await hasher.verifyDummy('cokolwiek'), false);

    assert.equal(ARGON2ID_PARAMETERS.memoryCost, 19456);
    assert.equal(ARGON2ID_PARAMETERS.timeCost, 2);
    assert.equal(ARGON2ID_PARAMETERS.parallelism, 1);

    const stored = await ctx.db.query<{ password_hash: string }>(
      'select password_hash from app.user_credentials where user_id = $1', [NOXAVA.id],
    );
    assert.ok(stored.rows[0].password_hash.startsWith('$argon2id$'));
  } finally {
    await ctx.close();
  }
});

// ══════════════════════════ session lifecycle ═══════════════════════════════

test('a session is recovered after a reload through GET /me', async () => {
  const ctx = await fixture();
  try {
    const session = await loggedIn(ctx, 'SZRON');

    // What a reloaded page does: it holds no state of its own, only the cookie the
    // browser resends.
    const restored = await ctx.app.inject({
      method: 'GET', url: '/api/v1/me', headers: { cookie: session.cookie },
    });
    assert.equal(restored.statusCode, 200);
    const body = restored.json();
    assert.deepEqual(body.user, { id: SZRON.id, name: 'SZRON', avatarUrl: null });
    assert.deepEqual(body.peer, { id: NOXAVA.id, name: 'NOXAVA', avatarUrl: null });
    assert.equal(body.expiresAt, session.body.expiresAt);
    // The CSRF token is recomputed, so a page that lost its memory can act again.
    assert.equal(body.csrfToken, session.csrfToken);
    assert.equal(restored.headers['cache-control'], 'no-store');
    assert.equal(restored.headers['set-cookie'], undefined, 'a successful bootstrap must not rotate the cookie');
  } finally {
    await ctx.close();
  }
});

test('a bootstrap with no cookie is a clean anonymous 401 rather than an error', async () => {
  const ctx = await fixture();
  try {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/me' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'UNAUTHENTICATED');
    assert.equal(response.headers['cache-control'], 'no-store');
  } finally {
    await ctx.close();
  }
});

test('a forged cookie is refused and clears itself, whatever shape it takes', async () => {
  const ctx = await fixture();
  try {
    const real = await loggedIn(ctx, 'NOXAVA');
    const secret = real.cookie.slice(real.cookie.indexOf('=') + 1);

    const forged = [
      `${SESSION_COOKIE_NAME}=${randomUUID()}`,
      // One byte changed: the digest lookup misses, so there is no near-match path.
      `${SESSION_COOKIE_NAME}=${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`,
      `${SESSION_COOKIE_NAME}=`,
      // A digest presented as if it were the secret: the stored value is not a key.
      `${SESSION_COOKIE_NAME}=${await ctx.db.query<{ token_hash: string }>('select token_hash from app.auth_sessions')
        .then((r) => r.rows[0].token_hash)}`,
      // A different cookie name cannot stand in for the session cookie.
      `szronox_session=${secret}`,
    ];
    for (const cookie of forged) {
      const bootstrap = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
      assert.equal(bootstrap.statusCode, 401, cookie);
      assert.equal(setCookieOf(bootstrap), clearedSessionCookie(), 'an unusable cookie is cleared');

      const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
      assert.equal(me.statusCode, 401, cookie);
    }

    // The genuine cookie still works: nothing above invalidated it.
    assert.equal(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: real.cookie } })).statusCode,
      200,
    );
  } finally {
    await ctx.close();
  }
});

test('an expired session is refused, and expiry is absolute rather than extended by use', async () => {
  const ctx = await fixture({ lifetimeSeconds: 3600 });
  try {
    const session = await loggedIn(ctx, 'NOXAVA');
    const expiresAt = Date.parse(session.body.expiresAt as string);

    // Used repeatedly, close to the boundary. A sliding expiry would push the
    // deadline out; an absolute one does not.
    ctx.clock.ms = expiresAt - 1000;
    assert.equal(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: session.cookie } })).statusCode,
      200,
    );
    const stillSame = await ctx.app.inject({
      method: 'GET', url: '/api/v1/me', headers: { cookie: session.cookie },
    });
    assert.equal(stillSame.json().expiresAt, session.body.expiresAt, 'expiry must not move');

    ctx.clock.ms = expiresAt;
    const atBoundary = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: session.cookie } });
    assert.equal(atBoundary.statusCode, 401, 'the expiry instant itself is already expired');

    ctx.clock.ms = expiresAt + 60_000;
    assert.equal(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: session.cookie } })).statusCode,
      401,
    );

    // The row is still present; expiry is decided by the server's clock, not by
    // deletion having happened.
    assert.equal((await ctx.db.query('select 1 from app.auth_sessions')).rows.length, 1);
  } finally {
    await ctx.close();
  }
});

test('logout revokes the session server-side and the cookie stops working', async () => {
  const ctx = await fixture();
  try {
    const session = await loggedIn(ctx, 'NOXAVA');

    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: session.cookie, origin: TEST_ORIGIN, 'x-csrf-token': session.csrfToken },
    });
    assert.equal(logout.statusCode, 204);
    assert.equal(logout.body, '', 'logout returns no JSON body');
    assert.equal(setCookieOf(logout), clearedSessionCookie());
    assert.equal(logout.headers['cache-control'], 'no-store');

    // Revoked in the database, not merely forgotten by the browser.
    const row = await ctx.db.query<{ revoked_at: Date | null }>('select revoked_at from app.auth_sessions');
    assert.notEqual(row.rows[0].revoked_at, null);

    // Replaying the same cookie — which an attacker who captured it would do —
    // fails, so logout is a server-side revocation and not a client-side gesture.
    for (const url of ['/api/v1/me', '/api/v1/me']) {
      assert.equal(
        (await ctx.app.inject({ method: 'GET', url, headers: { cookie: session.cookie } })).statusCode,
        401,
        url,
      );
    }
  } finally {
    await ctx.close();
  }
});

test('logout without a live session reports 401 rather than claiming a revocation', async () => {
  const ctx = await fixture();
  try {
    const session = await loggedIn(ctx, 'NOXAVA');
    const headers = { cookie: session.cookie, origin: TEST_ORIGIN, 'x-csrf-token': session.csrfToken };

    assert.equal((await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers })).statusCode, 204);

    // A second logout with the same cookie: there is nothing live to revoke.
    const again = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers });
    assert.equal(again.statusCode, 401);
    assert.equal(again.json().error.code, 'UNAUTHENTICATED');
    assert.equal(setCookieOf(again), clearedSessionCookie());

    // And with no cookie at all.
    const bare = await ctx.app.inject({
      method: 'POST', url: '/api/v1/auth/logout', headers: { origin: TEST_ORIGIN, 'x-csrf-token': 'anything' },
    });
    assert.equal(bare.statusCode, 401);
  } finally {
    await ctx.close();
  }
});

test('logging in again invalidates the session the browser presented', async () => {
  const ctx = await fixture();
  try {
    const first = await loggedIn(ctx, 'NOXAVA');
    const second = await login(ctx, 'NOXAVA', TEST_PASSWORDS.NOXAVA, { cookie: first.cookie });
    assert.equal(second.statusCode, 200);
    const secondCookie = `${SESSION_COOKIE_NAME}=${cookieValueOf(setCookieOf(second))}`;
    assert.notEqual(secondCookie, first.cookie);

    // The replaced session is dead, so a captured older cookie does not accumulate
    // as a second usable credential.
    assert.equal(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: first.cookie } })).statusCode,
      401,
    );
    assert.equal(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: secondCookie } })).statusCode,
      200,
    );
  } finally {
    await ctx.close();
  }
});

test('rotating the CSRF secret invalidates every live session', async () => {
  const ctx = await fixture();
  try {
    const session = await loggedIn(ctx, 'NOXAVA');
    assert.equal(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: session.cookie } })).statusCode,
      200,
    );

    // A second service over the same database with a different CSRF secret: the
    // derivation no longer matches the stored digest.
    const rotated = createAuthService({
      db: ctx.db,
      config: buildAuthConfig({ ...TEST_AUTH_ENV, APP_CSRF_SECRET_FILE: testSecretFile('a-completely-different-csrf-secret-value') }),
      hasher: createPasswordHasher(1),
      now: () => ctx.clock.ms,
    });
    const store = createSessionStore(ctx.db, () => ctx.clock.ms);
    const lookup = await store.resolve(
      session.cookie.slice(session.cookie.indexOf('=') + 1),
      'a-completely-different-csrf-secret-value',
    );
    assert.equal(lookup.ok, false);
    assert.equal(!lookup.ok && lookup.reason, 'csrf_secret_rotated');

    await assert.rejects(
      rotated.authenticate({ method: 'GET', headers: { cookie: session.cookie } } as never),
      /Authentication required/,
    );
  } finally {
    await ctx.close();
  }
});

test('a session is refused when the two product users are not both provisioned', async () => {
  const ctx = await fixture();
  try {
    const session = await loggedIn(ctx, 'NOXAVA');
    assert.equal(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: session.cookie } })).statusCode,
      200,
    );

    // Deleting the peer leaves a half-provisioned deployment. Serving requests then
    // would mean editor selection and verification silently lost their other party.
    await ctx.db.query('delete from app.users where id = $1', [SZRON.id]);
    assert.equal(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: session.cookie } })).statusCode,
      401,
    );
  } finally {
    await ctx.close();
  }
});

test('expired and revoked sessions can be pruned, and pruning removes no live session', async () => {
  const ctx = await fixture({ lifetimeSeconds: 3600 });
  try {
    const dead = await loggedIn(ctx, 'NOXAVA');
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: dead.cookie, origin: TEST_ORIGIN, 'x-csrf-token': dead.csrfToken },
    });
    const live = await loggedIn(ctx, 'SZRON');

    const removed = await pruneDeadSessions(ctx.db, new Date(ctx.clock.ms));
    assert.equal(removed, 1);
    assert.equal(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: live.cookie } })).statusCode,
      200,
    );
  } finally {
    await ctx.close();
  }
});

// ══════════════════════════ authoritative identity ══════════════════════════

test('/me reports the identity the server resolved, not anything the client stated', async () => {
  const ctx = await fixture();
  try {
    const session = await loggedIn(ctx, 'SZRON');
    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: session.cookie } });
    assert.equal(me.statusCode, 200);
    assert.deepEqual(me.json(), {
      user: { id: SZRON.id, name: 'SZRON', avatarUrl: null },
      peer: { id: NOXAVA.id, name: 'NOXAVA', avatarUrl: null },
      expiresAt: me.json().expiresAt,
      csrfToken: session.csrfToken,
    });

    // A mutation carrying an actor claim in its body is still attributed to the
    // session's user: there is no client-supplied actor field to honour.
    const reelId = randomUUID();
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/reels',
      headers: { cookie: session.cookie, origin: TEST_ORIGIN, 'x-csrf-token': session.csrfToken },
      payload: {
        operationId: randomUUID(),
        reelId,
        input: { text: 'Notatka', images: [] },
        createdBy: NOXAVA.id,
        actorId: NOXAVA.id,
        userId: NOXAVA.id,
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().createdBy, SZRON.id, 'the body claim must be ignored');
  } finally {
    await ctx.close();
  }
});

test('no domain or auth response carries credential or session material', async () => {
  const ctx = await fixture();
  try {
    const session = await loggedIn(ctx, 'NOXAVA');
    const secret = session.cookie.slice(session.cookie.indexOf('=') + 1);
    const hash = (await ctx.db.query<{ password_hash: string }>(
      'select password_hash from app.user_credentials where user_id = $1', [NOXAVA.id],
    )).rows[0].password_hash;
    const tokenHash = (await ctx.db.query<{ token_hash: string }>(
      'select token_hash from app.auth_sessions',
    )).rows[0].token_hash;

    const reelId = randomUUID();
    await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/reels',
      headers: { cookie: session.cookie, origin: TEST_ORIGIN, 'x-csrf-token': session.csrfToken },
      payload: { operationId: randomUUID(), reelId, input: { text: 'Notatka', images: [] } },
    });

    for (const url of ['/api/v1/me', '/api/v1/reels', `/api/v1/reels/${reelId}`, '/api/v1/me']) {
      const body = (await ctx.app.inject({ method: 'GET', url, headers: { cookie: session.cookie } })).body;
      for (const forbidden of [secret, hash, tokenHash, '$argon2id$', 'password_hash', 'token_hash']) {
        assert.ok(!body.includes(forbidden), `${url} must not expose ${forbidden.slice(0, 12)}`);
      }
    }
  } finally {
    await ctx.close();
  }
});

// ══════════════════════════ Origin and CSRF ═════════════════════════════════

test('login refuses a foreign or missing Origin and a non-JSON content type', async () => {
  const ctx = await fixture();
  try {
    for (const origin of [FOREIGN_ORIGIN, 'null', `${TEST_ORIGIN}.evil.test`, `${TEST_ORIGIN}:8443`]) {
      const response = await login(ctx, 'NOXAVA', TEST_PASSWORDS.NOXAVA, { origin });
      assert.equal(response.statusCode, 403, origin);
      assert.equal(response.json().error.code, 'FORBIDDEN');
    }

    // No Origin at all fails closed rather than being treated as same-origin.
    const missing = await ctx.app.inject({
      method: 'POST', url: '/api/v1/auth/login', payload: { name: 'NOXAVA', password: TEST_PASSWORDS.NOXAVA },
    });
    assert.equal(missing.statusCode, 403);

    // A cross-site HTML form can send these without a preflight; JSON it cannot.
    for (const contentType of ['application/x-www-form-urlencoded', 'text/plain', 'multipart/form-data']) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: TEST_ORIGIN, 'content-type': contentType },
        payload: `name=NOXAVA&password=${TEST_PASSWORDS.NOXAVA}`,
      });
      assert.ok(response.statusCode >= 400, `${contentType} must not be accepted`);
      assert.equal(response.headers['set-cookie'], undefined);
    }

    assert.equal((await ctx.db.query('select 1 from app.auth_sessions')).rows.length, 0);
  } finally {
    await ctx.close();
  }
});

test('an authenticated mutation requires the exact Origin and the session CSRF token', async () => {
  const ctx = await fixture();
  try {
    const session = await loggedIn(ctx, 'NOXAVA');
    const other = await loggedIn(ctx, 'SZRON');
    const body = () => ({ operationId: randomUUID(), reelId: randomUUID(), input: { text: 'x', images: [] } });

    const rejected: Array<[string, Record<string, string>]> = [
      ['no CSRF header', { cookie: session.cookie, origin: TEST_ORIGIN }],
      ['empty CSRF header', { cookie: session.cookie, origin: TEST_ORIGIN, 'x-csrf-token': '' }],
      ['wrong CSRF token', { cookie: session.cookie, origin: TEST_ORIGIN, 'x-csrf-token': randomUUID() }],
      // Another live session's token: valid in itself, but not bound to this session.
      ['another session\'s CSRF token', { cookie: session.cookie, origin: TEST_ORIGIN, 'x-csrf-token': other.csrfToken }],
      ['foreign origin', { cookie: session.cookie, origin: FOREIGN_ORIGIN, 'x-csrf-token': session.csrfToken }],
      ['no origin', { cookie: session.cookie, 'x-csrf-token': session.csrfToken }],
    ];
    for (const [label, headers] of rejected) {
      const response = await ctx.app.inject({ method: 'POST', url: '/api/v1/reels', headers, payload: body() });
      assert.equal(response.statusCode, 403, label);
      assert.equal(response.json().error.code, 'FORBIDDEN', label);
    }
    // Nothing was written by any refused attempt.
    assert.equal((await ctx.db.query('select 1 from app.reels')).rows.length, 0);

    // A CSRF token alone authenticates nothing.
    const tokenOnly = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/reels',
      headers: { origin: TEST_ORIGIN, 'x-csrf-token': session.csrfToken },
      payload: body(),
    });
    assert.equal(tokenOnly.statusCode, 401);

    const accepted = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/reels',
      headers: { cookie: session.cookie, origin: TEST_ORIGIN, 'x-csrf-token': session.csrfToken },
      payload: body(),
    });
    assert.equal(accepted.statusCode, 201, accepted.body);
  } finally {
    await ctx.close();
  }
});

test('every unsafe domain method is CSRF-protected, while reads need no Origin', async () => {
  const ctx = await fixture();
  try {
    const session = await loggedIn(ctx, 'NOXAVA');
    const id = randomUUID();
    const unsafe: Array<[string, string]> = [
      ['POST', '/api/v1/reels'],
      ['PATCH', `/api/v1/reels/${id}`],
      ['POST', `/api/v1/reels/${id}/delete`],
      ['POST', `/api/v1/reels/${id}/restore`],
      ['POST', `/api/v1/reels/${id}/hooks`],
      ['PATCH', `/api/v1/reels/${id}/hooks/${randomUUID()}`],
      ['DELETE', `/api/v1/reels/${id}/hooks/${randomUUID()}`],
      ['POST', `/api/v1/reels/${id}/current-export`],
      ['POST', `/api/v1/reels/${id}/verification`],
      ['POST', `/api/v1/reels/${id}/attachments/initiate`],
      ['POST', `/api/v1/reels/${id}/attachments/${randomUUID()}/complete`],
      ['POST', '/api/v1/auth/logout'],
    ];
    for (const [method, url] of unsafe) {
      const response = await ctx.app.inject({
        method: method as never, url, headers: { cookie: session.cookie }, payload: {},
      });
      assert.equal(response.statusCode, 403, `${method} ${url} must refuse without Origin and CSRF`);
    }

    // Reads carry no CSRF requirement, because they mutate nothing.
    for (const url of ['/api/v1/me', '/api/v1/reels', '/api/v1/me']) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: { cookie: session.cookie } });
      assert.equal(response.statusCode, 200, url);
    }
  } finally {
    await ctx.close();
  }
});

test('origin parsing refuses anything that is not an exact https origin', () => {
  assert.throws(() => parseOrigins('https://a.test, https://b.test'), /one exact origin/);
  assert.deepEqual(parseOrigins('http://localhost:5173'), ['http://localhost:5173']);
  for (const bad of ['', 'a.test', 'https://a.test/path', 'http://a.test', '*', 'https://', 'https://a.test?x=1']) {
    assert.throws(() => parseOrigins(bad), AuthConfigError, bad);
  }
  assert.throws(() => buildAuthConfig({ APP_ORIGIN: 'https://a.test' }), /APP_CSRF_SECRET_FILE is required/);
  assert.throws(() => buildAuthConfig({ APP_ORIGIN: 'https://a.test', APP_CSRF_SECRET_FILE: testSecretFile('short') }), /at least 32/);
  assert.throws(() => buildAuthConfig({ APP_CSRF_SECRET_FILE: testSecretFile('x'.repeat(40)) }), /APP_ORIGIN is required/);
});

// ══════════════════════════ throttling ══════════════════════════════════════

test('login throttling bounds attempts per address and reports Retry-After', async () => {
  const ctx = await fixture({ addressLimit: 3 });
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await login(ctx, 'NOXAVA', 'wrong', { ip: '198.51.100.7' });
      assert.equal(response.statusCode, 401, `attempt ${attempt}`);
    }
    const blocked = await login(ctx, 'NOXAVA', 'wrong', { ip: '198.51.100.7' });
    assert.equal(blocked.statusCode, 429);
    assert.deepEqual(blocked.json().error.code, 'RATE_LIMITED');
    assert.equal(blocked.json().error.retryable, true);
    assert.match(String(blocked.headers['retry-after']), /^\d+$/);

    // Even the correct password is refused while the window is open, so throttling
    // cannot be sidestepped by finally guessing right.
    assert.equal((await login(ctx, 'NOXAVA', TEST_PASSWORDS.NOXAVA, { ip: '198.51.100.7' })).statusCode, 429);

    // A different address is unaffected: this is a bound, not a global outage.
    assert.equal((await login(ctx, 'NOXAVA', TEST_PASSWORDS.NOXAVA, { ip: '198.51.100.8' })).statusCode, 200);

    // The window expires rather than locking the address out permanently.
    ctx.clock.ms += 61_000;
    assert.equal((await login(ctx, 'NOXAVA', TEST_PASSWORDS.NOXAVA, { ip: '198.51.100.7' })).statusCode, 200);
  } finally {
    await ctx.close();
  }
});

test('account throttling counts all attempts across addresses', async () => {
  const ctx = await fixture({ accountLimit: 2 });
  try {
    // Distinct addresses, so only the account counter can be what stops this.
    assert.equal((await login(ctx, 'NOXAVA', 'wrong', { ip: '198.51.100.1' })).statusCode, 401);
    assert.equal((await login(ctx, 'NOXAVA', 'wrong', { ip: '198.51.100.2' })).statusCode, 401);
    const third = await login(ctx, 'NOXAVA', 'wrong', { ip: '198.51.100.3' });
    assert.equal(third.statusCode, 429);
    assert.match(String(third.headers['retry-after']), /^\d+$/);

    // The other account is not collateral damage.
    assert.equal((await login(ctx, 'SZRON', TEST_PASSWORDS.SZRON, { ip: '198.51.100.4' })).statusCode, 200);

    ctx.clock.ms += 61_000;
    assert.equal((await login(ctx, 'NOXAVA', TEST_PASSWORDS.NOXAVA, { ip: '198.51.100.5' })).statusCode, 200);
    // A successful login also counts toward the approved attempt limit.
    assert.equal((await login(ctx, 'NOXAVA', 'wrong', { ip: '198.51.100.6' })).statusCode, 401);
    assert.equal((await login(ctx, 'NOXAVA', 'wrong', { ip: '198.51.100.6' })).statusCode, 429);
  } finally {
    await ctx.close();
  }
});

test('the throttle table is bounded and forgets expired windows', () => {
  let ms = 0;
  const throttle = createThrottle({ limit: 1, windowMs: 1000, maxKeys: 4, now: () => ms });
  for (let index = 0; index < 50; index += 1) throttle.consume(`key-${index}`);
  assert.ok(throttle.size() <= 4, `bounded, got ${throttle.size()}`);

  assert.equal(throttle.consume('a').allowed, true);
  assert.equal(throttle.consume('a').allowed, false);
  ms += 1001;
  assert.equal(throttle.consume('a').allowed, true, 'the window must expire');

  // `peek` must not consume, or a blocked caller would extend its own block.
  assert.equal(throttle.consume('b').allowed, true);
  const before = throttle.peek('b');
  assert.deepEqual(throttle.peek('b'), before);

  assert.equal(DEFAULT_ADDRESS_THROTTLE.limit, 10);
  assert.equal(DEFAULT_ACCOUNT_THROTTLE.limit, 5);
});

// ══════════════════════════ provisioning ════════════════════════════════════

test('provisioning sets a password for an existing user and refuses to invent one', async () => {
  const ctx = await fixture({ withCredentials: [] });
  try {
    await assert.rejects(
      assertProvisioned(ctx.db, [NOXAVA, SZRON]),
      (error: Error) => error instanceof ProvisioningError && /no password is set for/.test(error.message),
    );

    await provisionPassword(ctx.db, { name: 'NOXAVA', password: 'nowe-hasło-ĄĘŁŻ' });
    await provisionPassword(ctx.db, { name: 'SZRON', password: 'drugie-hasło-ĄĘŁŻ' });
    const report = await assertProvisioned(ctx.db, [NOXAVA, SZRON]);
    assert.deepEqual(report.users.map((entry) => entry.name), ['NOXAVA', 'SZRON']);
    assert.ok(report.users.every((entry) => entry.credentialSet));

    assert.equal((await login(ctx, 'NOXAVA', 'nowe-hasło-ĄĘŁŻ')).statusCode, 200);

    // A configured id that disagrees with the stored one is refused: the existing
    // UUID is authoritative and must never be silently replaced.
    await assert.rejects(
      assertProvisioned(ctx.db, [{ id: randomUUID(), name: 'NOXAVA' }, SZRON]),
      /must not be replaced/,
    );

    // There is no third account to provision.
    await assert.rejects(
      provisionPassword(ctx.db, { name: 'INTRUDER' as never, password: 'x' }),
      /must be NOXAVA or SZRON/,
    );
  } finally {
    await ctx.close();
  }
});

test('changing a password revokes that account\'s live sessions and leaves the peer alone', async () => {
  const ctx = await fixture();
  try {
    const mine = await loggedIn(ctx, 'NOXAVA');
    const peer = await loggedIn(ctx, 'SZRON');

    await provisionPassword(ctx.db, { name: 'NOXAVA', password: 'zmienione-hasło' });

    assert.equal(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: mine.cookie } })).statusCode,
      401,
      'a password change must not leave old cookies working',
    );
    assert.equal(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: peer.cookie } })).statusCode,
      200,
      'the other account is unaffected',
    );
    assert.equal((await login(ctx, 'NOXAVA', 'zmienione-hasło')).statusCode, 200);
    assert.equal((await login(ctx, 'NOXAVA', TEST_PASSWORDS.NOXAVA)).statusCode, 401);
  } finally {
    await ctx.close();
  }
});

test('the operator entry point takes the password from a stream, not an argument', () => {
  // Exactly one trailing newline is removed, because that is what a terminal or a
  // `printf` pipeline adds. Everything else is part of the password.
  assert.equal(passwordFromStdinText('hasło\n'), 'hasło');
  assert.equal(passwordFromStdinText('hasło\r\n'), 'hasło');
  assert.equal(passwordFromStdinText('hasło\n\n'), 'hasło\n');
  assert.equal(passwordFromStdinText('hasło  '), 'hasło  ');
  assert.equal(passwordFromStdinText('hasło'), 'hasło');
});

// ══════════════════════════ residual surface ════════════════════════════════

test('no bearer-token authorization path remains', async () => {
  const ctx = await fixture();
  try {
    // A request presenting only an Authorization header is anonymous. If bearer
    // parsing had survived anywhere, this would be the shape that found it.
    for (const authorization of ['Bearer anything', 'Bearer ', 'Basic Tk9YQVZBOng=']) {
      const response = await ctx.app.inject({
        method: 'GET', url: '/api/v1/me', headers: { authorization },
      });
      assert.equal(response.statusCode, 401, authorization);
    }

    // The auth module exposes no verifier and no bearer parser to import.
    const module = await import('./auth/index.js') as Record<string, unknown>;
    for (const removed of ['createHs256Verifier', 'createJwksVerifier', 'selectVerifier', 'bearerToken', 'signHs256']) {
      assert.equal(module[removed], undefined, `${removed} must no longer be exported`);
    }
  } finally {
    await ctx.close();
  }
});

test('the redaction list covers every credential-bearing header the API handles', () => {
  for (const path of ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'req.body.password']) {
    assert.ok(AUTH_LOG_REDACT_PATHS.includes(path as never), `${path} must be redacted`);
  }
});

test('cookie serialisation refuses a nonsensical lifetime', () => {
  assert.throws(() => serializeSessionCookie('value', 0), RangeError);
  assert.throws(() => serializeSessionCookie('value', -1), RangeError);
  assert.throws(() => serializeSessionCookie('value', 1.5), RangeError);
  assert.ok(serializeSessionCookie('value', 1).includes('Max-Age=1'));
});

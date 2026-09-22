/**
 * Proxy trust, and what it does to the login throttle.
 *
 * The reason this needs its own tests: the defect it guards against is invisible until the
 * application sits behind a reverse proxy. A direct-exposure test suite passes either way,
 * and the two possible mistakes have opposite signs — trusting nothing turns the
 * per-address throttle into one global counter, and trusting everything lets a client pick
 * its own counter with a header. Both are exercised below against real Fastify routing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';

import { buildApp } from './app.js';
import { createPasswordHasher } from './auth/passwords.js';
import { registerAuthRoutes } from './auth/routes.js';
import { createAuthService } from './auth/service.js';
import { buildAuthConfig } from './auth/config.js';
import { createThrottle } from './auth/throttle.js';
import { clientKey } from './auth/origin.js';
import { TEST_AUTH_ENV, TEST_ORIGIN, TEST_PASSWORDS } from './auth/test-support.js';
import { provisionUsers } from './auth/users.js';
import { pgliteDatabase } from './db/client.js';
import { migrate } from './db/migrate.js';
import { describeTrustedProxies, parseTrustedProxies, ProxyConfigError } from './runtime/proxy.js';

const NOXAVA = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' as const };
const SZRON = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' as const };

// ══════════════════════ configuration ══════════════════════════════════════

test('trusted proxies are literal addresses, and nothing that means "everyone"', () => {
  assert.equal(parseTrustedProxies({}), false, 'absent configuration trusts nothing');
  assert.equal(parseTrustedProxies({ APP_TRUSTED_PROXIES: '   ' }), false);

  assert.deepEqual(parseTrustedProxies({ APP_TRUSTED_PROXIES: '172.18.0.1' }), ['172.18.0.1']);
  assert.deepEqual(
    parseTrustedProxies({ APP_TRUSTED_PROXIES: '172.18.0.0/16, 127.0.0.1' }),
    ['172.18.0.0/16', '127.0.0.1'],
  );
  assert.deepEqual(parseTrustedProxies({ APP_TRUSTED_PROXIES: '::1' }), ['::1']);
  assert.deepEqual(parseTrustedProxies({ APP_TRUSTED_PROXIES: 'fd00::/8' }), ['fd00::/8']);

  // Every shape that would mean "believe any client".
  for (const everyone of ['true', '*', 'all', '0.0.0.0/0', '::/0', '0.0.0.0']) {
    assert.throws(
      () => parseTrustedProxies({ APP_TRUSTED_PROXIES: everyone }),
      ProxyConfigError,
      `${everyone} must be refused`,
    );
  }
  // A hostname would let a DNS change re-decide who is believed.
  assert.throws(() => parseTrustedProxies({ APP_TRUSTED_PROXIES: 'caddy' }), /not hostnames/);
  assert.throws(() => parseTrustedProxies({ APP_TRUSTED_PROXIES: 'proxy.internal' }), /not hostnames/);
  // Malformed input is an error, never a silent downgrade to trusting nothing.
  for (const bad of ['172.18.0.300', '10.0.0.1/33', '10.0.0.1/0', 'not-an-address', '10.0.0.1,']) {
    assert.throws(() => parseTrustedProxies({ APP_TRUSTED_PROXIES: bad }), ProxyConfigError, bad);
  }

  // The startup summary must say which failure mode is in effect rather than staying quiet.
  const none = describeTrustedProxies(false);
  assert.equal(none.trustProxy, 'none');
  assert.match(String((none as { note?: string }).note), /single shared counter/);
  assert.deepEqual(describeTrustedProxies(['172.18.0.1']), {
    trustProxy: 'configured', proxies: ['172.18.0.1'],
  });
});

// ══════════════════════ what request.ip becomes ═════════════════════════════

/** A bare app that reports what the framework decided the client address is. */
function addressProbe(trustProxy: false | string[]) {
  const app = buildApp({ trustProxy });
  app.get('/__probe/ip', async (request) => ({ ip: request.ip }));
  return app;
}

test('a forwarded address is believed only from a configured proxy', async () => {
  const untrusting = addressProbe(false);
  try {
    await untrusting.ready();
    const spoofed = await untrusting.inject({
      method: 'GET',
      url: '/__probe/ip',
      remoteAddress: '172.18.0.1',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    // The header is ignored: a client that could choose this value could choose its own
    // throttle bucket.
    assert.equal(spoofed.json().ip, '172.18.0.1');
  } finally {
    await untrusting.close();
  }

  const trusting = addressProbe(['172.18.0.1']);
  try {
    await trusting.ready();
    // From the real proxy, the forwarded address is the client's.
    const viaProxy = await trusting.inject({
      method: 'GET',
      url: '/__probe/ip',
      remoteAddress: '172.18.0.1',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    assert.equal(viaProxy.json().ip, '203.0.113.9');

    // From anywhere else, it is not. This is the half that `trustProxy: true` would lose.
    const direct = await trusting.inject({
      method: 'GET',
      url: '/__probe/ip',
      remoteAddress: '198.51.100.4',
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    assert.equal(direct.json().ip, '198.51.100.4', 'a forwarded header from an untrusted peer must be ignored');
  } finally {
    await trusting.close();
  }
});

test('the limiter key follows request.ip, so proxy trust decides the throttle bucket', async () => {
  // `clientKey` is what the login throttle keys on, and it reads `request.ip` and nothing
  // else. Pinning that here means a future change to read a header directly fails.
  const keys: string[] = [];
  const app = buildApp({ trustProxy: ['172.18.0.1'] });
  app.get('/__probe/key', async (request) => {
    keys.push(clientKey(request));
    return { key: clientKey(request) };
  });
  try {
    await app.ready();
    await app.inject({
      method: 'GET', url: '/__probe/key', remoteAddress: '172.18.0.1',
      headers: { 'x-forwarded-for': '203.0.113.1' },
    });
    await app.inject({
      method: 'GET', url: '/__probe/key', remoteAddress: '172.18.0.1',
      headers: { 'x-forwarded-for': '203.0.113.2' },
    });
    // Two different clients behind the same proxy get two different buckets. Without
    // trusted-proxy configuration both of these would be '172.18.0.1'.
    assert.deepEqual(keys, ['203.0.113.1', '203.0.113.2']);
  } finally {
    await app.close();
  }
});

// ══════════════════════ the throttle, end to end ════════════════════════════

async function loginFixture(trustProxy: false | string[], addressLimit: number) {
  const db = pgliteDatabase(await PGlite.create());
  await migrate(db);
  await provisionUsers(db, createPasswordHasher(1), {
    allowlist: [NOXAVA, SZRON],
    passwords: { NOXAVA: TEST_PASSWORDS.NOXAVA, SZRON: TEST_PASSWORDS.SZRON },
  });
  const service = createAuthService({
    db,
    config: buildAuthConfig(TEST_AUTH_ENV),
    hasher: createPasswordHasher(2),
    addressThrottle: createThrottle({ limit: addressLimit, windowMs: 60_000 }),
    accountThrottle: createThrottle({ limit: 50, windowMs: 60_000 }),
  });
  const app = Fastify({ logger: false, trustProxy });
  registerAuthRoutes(app, { service });
  await app.ready();

  const attempt = (client: string) => app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    // Always arriving from the proxy, as it would in the deployment.
    remoteAddress: '172.18.0.1',
    headers: { origin: TEST_ORIGIN, 'x-forwarded-for': client },
    payload: { name: 'NOXAVA', password: 'wrong-password' },
  });

  return { app, db, attempt, async close() { await app.close(); await db.close(); } };
}

test('behind a trusted proxy, one client exhausting the throttle does not lock out the other', async () => {
  const context = await loginFixture(['172.18.0.1'], 2);
  try {
    assert.equal((await context.attempt('203.0.113.1')).statusCode, 401);
    assert.equal((await context.attempt('203.0.113.1')).statusCode, 401);
    // That client is now throttled.
    assert.equal((await context.attempt('203.0.113.1')).statusCode, 429);
    // The other client is unaffected, which is the whole point of per-address limiting.
    assert.equal((await context.attempt('203.0.113.7')).statusCode, 401);
  } finally {
    await context.close();
  }
});

test('with proxy trust unconfigured, the same traffic throttles every client at once', async () => {
  // Not a bug being asserted as correct — it is the consequence of the safe default, shown
  // explicitly so the cost of leaving APP_TRUSTED_PROXIES unset is on the record rather
  // than discovered when both users are locked out.
  const context = await loginFixture(false, 2);
  try {
    assert.equal((await context.attempt('203.0.113.1')).statusCode, 401);
    assert.equal((await context.attempt('203.0.113.1')).statusCode, 401);
    assert.equal((await context.attempt('203.0.113.1')).statusCode, 429);
    const otherClient = await context.attempt('203.0.113.7');
    assert.equal(
      otherClient.statusCode,
      429,
      'every request shares the proxy address as its key, so the limit is global',
    );
  } finally {
    await context.close();
  }
});

test('a successful login still works through the proxy, with the origin unchanged', async () => {
  const db = pgliteDatabase(await PGlite.create());
  const service = createAuthService({
    db,
    config: buildAuthConfig(TEST_AUTH_ENV),
    hasher: createPasswordHasher(2),
  });
  const app = Fastify({ logger: false, trustProxy: ['172.18.0.1'] });
  registerAuthRoutes(app, { service });
  try {
    await migrate(db);
    await provisionUsers(db, createPasswordHasher(1), {
      allowlist: [NOXAVA, SZRON],
      passwords: { NOXAVA: TEST_PASSWORDS.NOXAVA, SZRON: TEST_PASSWORDS.SZRON },
    });
    await app.ready();

    // The browser sends the public HTTPS origin; TLS terminates at the proxy and the
    // application sees plain HTTP internally. Origin checking compares the header against
    // APP_ORIGIN, so it is unaffected — and the cookie is still emitted with Secure.
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '172.18.0.1',
      headers: { origin: TEST_ORIGIN, 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' },
      payload: { name: 'NOXAVA', password: TEST_PASSWORDS.NOXAVA },
    });
    assert.equal(login.statusCode, 200, login.body);
    const setCookie = String(login.headers['set-cookie']);
    assert.match(setCookie, /^__Host-szronox_session=/);
    assert.match(setCookie, /; Secure(;|$)/);

    // And a forged origin is still refused through the proxy.
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      remoteAddress: '172.18.0.1',
      headers: { origin: 'https://evil.test', 'x-forwarded-for': '203.0.113.9' },
      payload: { name: 'NOXAVA', password: TEST_PASSWORDS.NOXAVA },
    });
    assert.equal(foreign.statusCode, 403);
  } finally {
    await app.close();
    await db.close();
  }
});

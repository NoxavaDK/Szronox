/**
 * STREAM-LIVE-01: live messages and the `live_feed` device key (T00 section STREAM-LIVE-01).
 *
 * Pins: per-kind validation and limits; idempotent create; own-message isolation; the feed's
 * cursor order, limit, "start at now" and read-only behaviour; the key accepted only on the two
 * device routes and refused with a cookie or Origin; revoked/unknown keys; the status transition
 * table; rate limits; and the operator key command.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import Fastify, { type FastifyInstance } from 'fastify';

import { sessionHarness, TEST_ORIGIN, type IssuedSession } from './auth/test-support.js';
import { createThrottle } from './auth/throttle.js';
import { registerCoreRoutes } from './core/routes.js';
import { memoryStorageAdapter } from './core/storage.js';
import { type Database, pgliteDatabase } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';
import { createAccessKey, listAccessKeys, revokeAccessKey } from './live/key-admin.js';
import { registerLiveRoutes } from './live/routes.js';
import { runAccessKeyCommand } from './runtime/access-key-cli.js';

const NOXAVA = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' as const };
const SZRON = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' as const };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface InjectResponse { statusCode: number; headers: Record<string, unknown>; json: () => any }

interface Fixture {
  db: Database;
  app: FastifyInstance;
  kuba: IssuedSession;
  szron: IssuedSession;
  key: string;
  send: (session: IssuedSession, body: Record<string, unknown>) => Promise<InjectResponse>;
  mine: (session: IssuedSession) => Promise<Array<Record<string, unknown>>>;
  feed: (query?: string, headers?: Record<string, string>) => Promise<InjectResponse>;
  status: (body: unknown, headers?: Record<string, string>) => Promise<InjectResponse>;
  harness: ReturnType<typeof sessionHarness>;
  close: () => Promise<void>;
}

async function fixture(options: { sendLimit?: number; deviceLimit?: number } = {}): Promise<Fixture> {
  const db = pgliteDatabase(await PGlite.create());
  await migrate(db);
  await seedUsers(db, [NOXAVA, SZRON]);
  const harness = sessionHarness(db);
  const app = Fastify({ logger: false });
  harness.register(app);
  // Core routes too, so the test can prove a device key does not open them.
  registerCoreRoutes(app, {
    db, storage: memoryStorageAdapter(), authenticate: harness.authenticate,
    allowlist: [{ ...NOXAVA, avatarUrl: null }, { ...SZRON, avatarUrl: null }],
  });
  registerLiveRoutes(app, {
    db, authenticate: harness.authenticate,
    ...(options.sendLimit ? { sendThrottle: createThrottle({ limit: options.sendLimit, windowMs: 60_000 }) } : {}),
    ...(options.deviceLimit ? { deviceThrottle: createThrottle({ limit: options.deviceLimit, windowMs: 60_000 }) } : {}),
  });
  await app.ready();
  const kuba = await harness.issue(NOXAVA.id);
  const szron = await harness.issue(SZRON.id);
  const { secret: key } = await createAccessKey(db, 'StreamControl PC');
  const bearer = { authorization: `Bearer ${key}` };
  return {
    db, app, kuba, szron, key, harness,
    send: async (session, body) => app.inject({ method: 'POST', url: '/api/v1/live/messages', headers: harness.headers(session, 'POST'), payload: body as never }),
    mine: async (session) => (await app.inject({ method: 'GET', url: '/api/v1/live/messages/mine', headers: harness.headers(session, 'GET') })).json().items,
    feed: async (query = '', headers = bearer) => app.inject({ method: 'GET', url: `/api/v1/live/feed${query}`, headers }),
    status: async (body, headers = bearer) => app.inject({ method: 'POST', url: '/api/v1/live/status', headers, payload: body as never }),
    close: async () => { await app.close(); await db.close(); },
  };
}

const quote = (text: string, source?: string) => ({ operationId: randomUUID(), kind: 'quote', text, ...(source === undefined ? {} : { source }) });

test('both users send quotes, signals and cancels; validation and limits per kind', async () => {
  const f = await fixture();
  try {
    const created = await f.send(f.szron, quote('  Deficyt wzrośnie o 14 procent.  ', ' portal.pl '));
    assert.equal(created.statusCode, 201);
    const message = created.json();
    assert.equal(message.kind, 'quote');
    assert.equal(message.text, 'Deficyt wzrośnie o 14 procent.');
    assert.equal(message.source, 'portal.pl');
    assert.equal(message.level, null);
    assert.equal(message.status, 'sent');
    assert.equal(message.statusAt, null);
    assert.equal((await f.send(f.kuba, quote('x'.repeat(400)))).statusCode, 201, '400 characters is allowed');
    assert.equal((await f.send(f.kuba, quote('Bez źródła', ''))).json().source, null, 'empty source is stored as none');
    assert.equal((await f.send(f.szron, { operationId: randomUUID(), kind: 'signal', level: 'urgent' })).statusCode, 201);
    assert.equal((await f.send(f.szron, { operationId: randomUUID(), kind: 'signal', level: 'moment' })).statusCode, 201);
    assert.equal((await f.send(f.szron, { operationId: randomUUID(), kind: 'signal_cancel' })).statusCode, 201);

    const invalid: Array<Record<string, unknown>> = [
      quote('   '),
      quote('x'.repeat(401)),
      quote('ok', 'y'.repeat(121)),
      { ...quote('ok'), level: 'urgent' },
      { operationId: randomUUID(), kind: 'quote' },
      { operationId: randomUUID(), kind: 'signal' },
      { operationId: randomUUID(), kind: 'signal', level: 'loud' },
      { operationId: randomUUID(), kind: 'signal', level: 'urgent', text: 'x' },
      { operationId: randomUUID(), kind: 'signal_cancel', level: 'urgent' },
      { operationId: randomUUID(), kind: 'shout' },
      { operationId: 'nie-uuid', kind: 'signal_cancel' },
    ];
    for (const body of invalid) {
      const response = await f.send(f.szron, body);
      assert.equal(response.statusCode, 422, JSON.stringify(body).slice(0, 80));
      assert.equal(response.json().error.code, 'VALIDATION_ERROR');
    }
  } finally { await f.close(); }
});

test('create is idempotent on operationId and needs session, Origin and CSRF', async () => {
  const f = await fixture();
  try {
    const body = quote('Raz');
    const first = (await f.send(f.szron, body)).json();
    const again = await f.send(f.szron, body);
    assert.equal(again.statusCode, 201);
    assert.deepEqual(again.json(), first);
    assert.equal((await f.mine(f.szron)).length, 1, 'a replay creates nothing');
    const conflict = await f.send(f.szron, { ...body, text: 'Inny tekst' });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');

    const url = '/api/v1/live/messages';
    assert.equal((await f.app.inject({ method: 'POST', url, payload: quote('anon') as never })).statusCode, 401);
    const cookieOnly = { cookie: f.harness.headers(f.szron, 'GET').cookie };
    assert.equal((await f.app.inject({ method: 'POST', url, headers: cookieOnly, payload: quote('no csrf') as never })).statusCode >= 400, true);
    const noCsrf = { ...f.harness.headers(f.szron, 'POST') };
    delete noCsrf['x-csrf-token'];
    assert.notEqual((await f.app.inject({ method: 'POST', url, headers: noCsrf, payload: quote('no csrf') as never })).statusCode, 201);
    const foreign = { ...f.harness.headers(f.szron, 'POST'), origin: 'https://not-szronox.test' };
    assert.notEqual((await f.app.inject({ method: 'POST', url, headers: foreign, payload: quote('foreign') as never })).statusCode, 201);
    // A device key is not a user: it cannot send.
    assert.equal((await f.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${f.key}`, origin: TEST_ORIGIN }, payload: quote('key') as never })).statusCode, 401);
    assert.equal((await f.mine(f.szron)).length, 1);
  } finally { await f.close(); }
});

test('each user lists only their own messages, newest first', async () => {
  const f = await fixture();
  try {
    await f.send(f.szron, quote('Szron 1'));
    await f.send(f.kuba, quote('Kuba 1'));
    await f.send(f.szron, { operationId: randomUUID(), kind: 'signal', level: 'moment' });
    const szron = await f.mine(f.szron);
    assert.deepEqual(szron.map((item) => item.kind), ['signal', 'quote']);
    assert.equal(szron[1].text, 'Szron 1');
    const kuba = await f.mine(f.kuba);
    assert.deepEqual(kuba.map((item) => item.text), ['Kuba 1']);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/live/messages/mine' })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/live/messages/mine', headers: { authorization: `Bearer ${f.key}` } })).statusCode, 401);
  } finally { await f.close(); }
});

test('the feed starts at now, pages oldest-first from a cursor, names authors and changes nothing', async () => {
  const f = await fixture();
  try {
    await f.send(f.szron, quote('Z poprzedniego streamu'));
    const start = await f.feed();
    assert.equal(start.statusCode, 200);
    assert.deepEqual(start.json().items, [], 'a new reader does not replay earlier broadcasts');
    const cursor = start.json().cursor;

    await f.send(f.szron, quote('Pierwszy'));
    await f.send(f.kuba, quote('Drugi'));
    await f.send(f.szron, { operationId: randomUUID(), kind: 'signal', level: 'urgent' });
    const page = (await f.feed(`?after=${cursor}&limit=2`)).json();
    assert.deepEqual(page.items.map((item: { text: string | null }) => item.text), ['Pierwszy', 'Drugi']);
    assert.deepEqual(page.items.map((item: { authorName: string }) => item.authorName), ['SZRON', 'NOXAVA']);
    const rest = (await f.feed(`?after=${page.cursor}`)).json();
    assert.deepEqual(rest.items.map((item: { kind: string; level: string | null }) => [item.kind, item.level]), [['signal', 'urgent']]);
    const empty = (await f.feed(`?after=${rest.cursor}`)).json();
    assert.deepEqual(empty, { items: [], cursor: rest.cursor }, 'an idle poll keeps the cursor');
    assert.ok((await f.mine(f.szron)).every((item) => item.status === 'sent'), 'reading the feed changes no status');

    for (const query of ['?after=abc', '?after=-1', '?after=1&limit=0', '?after=1&limit=101', '?after=1&limit=x']) {
      assert.equal((await f.feed(query)).statusCode, 422, query);
    }
  } finally { await f.close(); }
});

test('the device key works only on the two device routes, never with a cookie or Origin, and not after revocation', async () => {
  const f = await fixture();
  try {
    const bearer = `Bearer ${f.key}`;
    assert.equal((await f.feed('', {})).statusCode, 401, 'no key');
    assert.equal((await f.feed('', { authorization: 'Bearer short' })).statusCode, 401, 'malformed key');
    assert.equal((await f.feed('', { authorization: `Bearer ${'A'.repeat(43)}` })).statusCode, 401, 'unknown key');
    assert.equal((await f.feed('', { authorization: bearer, origin: TEST_ORIGIN })).statusCode, 401, 'browser Origin');
    assert.equal((await f.feed('', { authorization: bearer, cookie: f.harness.headers(f.szron, 'GET').cookie })).statusCode, 401, 'with a session cookie');
    // A session alone is not a device either.
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/live/feed', headers: f.harness.headers(f.szron, 'GET') })).statusCode, 401);
    // Domain routes do not accept the key.
    for (const url of ['/api/v1/reels', '/api/v1/me']) {
      const response = await f.app.inject({ method: 'GET', url, headers: { authorization: bearer } });
      assert.equal(response.statusCode, 401, url);
    }
    assert.equal((await listAccessKeys(f.db))[0].lastUsedAt, null, 'refused calls do not stamp the key');
    assert.equal((await f.feed()).statusCode, 200);
    const keys = await listAccessKeys(f.db);
    assert.ok(keys[0].lastUsedAt, 'a successful call stamps last_used_at');
    assert.equal(await revokeAccessKey(f.db, keys[0].id), true);
    assert.equal((await f.feed()).statusCode, 401, 'revoked');
    assert.equal(await revokeAccessKey(f.db, keys[0].id), false, 'revoking twice reports nothing to revoke');
  } finally { await f.close(); }
});

test('status reports follow the transition table; same status is a no-op', async () => {
  const f = await fixture();
  try {
    const q = (await f.send(f.szron, quote('Do kolejki'))).json();
    const s = (await f.send(f.szron, { operationId: randomUUID(), kind: 'signal', level: 'urgent' })).json();
    const c = (await f.send(f.szron, { operationId: randomUUID(), kind: 'signal_cancel' })).json();
    const report = async (id: string, status: string) => f.status({ id, status });

    assert.equal((await report(q.id, 'delivered')).statusCode, 204);
    assert.equal((await report(q.id, 'waiting')).statusCode, 204);
    assert.equal((await report(q.id, 'waiting')).statusCode, 204, 'repeat is a no-op');
    assert.equal((await report(q.id, 'shown')).statusCode, 204);
    const invalid = await report(q.id, 'waiting');
    assert.equal(invalid.statusCode, 422);
    assert.equal(invalid.json().error.details.reason, 'invalid_transition');
    assert.equal((await report(q.id, 'seen')).statusCode, 422, 'a quote is never "seen"');

    assert.equal((await report(s.id, 'seen')).statusCode, 204, 'the PC may report only the outcome');
    assert.equal((await report(s.id, 'expired')).statusCode, 422, 'terminal');
    assert.equal((await report(c.id, 'delivered')).statusCode, 204);
    assert.equal((await report(c.id, 'seen')).statusCode, 422, 'a cancel stops at delivered');

    assert.equal((await report(randomUUID(), 'delivered')).statusCode, 404);
    assert.equal((await report('nie-uuid', 'delivered')).statusCode, 422);
    assert.equal((await report(q.id, 'sent')).statusCode, 422, 'sent is not reportable');
    assert.equal((await f.status({})).statusCode, 422);
    assert.equal((await f.status({ id: q.id, status: 'shown' }, {})).statusCode, 401, 'needs the key');

    const mine = await f.mine(f.szron);
    const byId = new Map(mine.map((item) => [item.id, item]));
    assert.equal(byId.get(q.id)!.status, 'shown');
    assert.ok(byId.get(q.id)!.statusAt, 'status time is recorded');
    assert.equal(byId.get(s.id)!.status, 'seen');
    assert.equal(byId.get(c.id)!.status, 'delivered');
  } finally { await f.close(); }
});

test('sends and device calls are rate limited with Retry-After', async () => {
  const f = await fixture({ sendLimit: 2, deviceLimit: 2 });
  try {
    await f.send(f.szron, quote('1'));
    await f.send(f.szron, quote('2'));
    const limited = await f.send(f.szron, quote('3'));
    assert.equal(limited.statusCode, 429);
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    assert.equal((await f.send(f.kuba, quote('Kuba ma własny limit'))).statusCode, 201);
    await f.feed();
    await f.feed();
    const deviceLimited = await f.feed();
    assert.equal(deviceLimited.statusCode, 429);
    assert.equal(deviceLimited.json().error.code, 'RATE_LIMITED');
  } finally { await f.close(); }
});

test('the operator command creates, lists and revokes keys and shows the secret only once', async () => {
  const db = pgliteDatabase(await PGlite.create());
  try {
    await migrate(db);
    const created = await runAccessKeyCommand(db, ['create', 'StreamControl — PC']);
    const secret = /secret \(shown once, store it now\): ([A-Za-z0-9_-]{43})/.exec(created)?.[1];
    assert.ok(secret, 'the secret is printed once on create');
    const listed = await runAccessKeyCommand(db, ['list']);
    assert.ok(listed.includes('StreamControl — PC') && listed.includes('active'));
    assert.ok(!listed.includes(secret!), 'list never prints a secret');
    const stored = await db.query<{ token_hash: string }>('select token_hash from app.access_keys');
    assert.notEqual(stored.rows[0].token_hash, secret, 'only the digest is stored');
    const id = (await listAccessKeys(db))[0].id;
    assert.equal(await runAccessKeyCommand(db, ['revoke', id]), `revoked ${id}`);
    assert.ok((await runAccessKeyCommand(db, ['list'])).includes('revoked'));
    for (const argv of [[], ['create'], ['create', ' '], ['revoke', 'nie-uuid'], ['drop', 'x'], ['list', 'extra']]) {
      await assert.rejects(runAccessKeyCommand(db, argv), Error, argv.join(' '));
    }
  } finally { await db.close(); }
});

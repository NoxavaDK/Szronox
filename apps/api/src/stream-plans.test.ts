/**
 * STREAM-PLAN-01: stream plans (T00 section STREAM-PLAN-01).
 *
 * Pins: create/list/get; whole-document update with validation and limits; version check and
 * idempotent replay; topics picked only from existing Reels, never changing them, with their
 * live status; one current plan at a time; soft delete; recent-first candidates; session, Origin
 * and CSRF on unsafe routes; and the device read through the live_feed key.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import Fastify, { type FastifyInstance } from 'fastify';

import { sessionHarness, type IssuedSession } from './auth/test-support.js';
import { memoryStorageAdapter } from './core/storage.js';
import { type Database, pgliteDatabase } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';
import { createAccessKey } from './live/key-admin.js';
import { registerLiveRoutes } from './live/routes.js';
import { registerStreamPlanRoutes } from './stream-plans/routes.js';

const NOXAVA = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' as const };
const SZRON = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' as const };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface InjectResponse { statusCode: number; json: () => any }

interface Fixture {
  db: Database;
  app: FastifyInstance;
  kuba: IssuedSession;
  szron: IssuedSession;
  key: string;
  call: (session: IssuedSession, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => Promise<InjectResponse>;
  reel: (fields?: { title?: string; format?: 'reel' | 'stream'; sourceLink?: string; updatedAt?: string }) => Promise<string>;
  harness: ReturnType<typeof sessionHarness>;
  close: () => Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const db = pgliteDatabase(await PGlite.create());
  await migrate(db);
  await seedUsers(db, [NOXAVA, SZRON]);
  const harness = sessionHarness(db);
  const app = Fastify({ logger: false });
  harness.register(app);
  const core = { db, storage: memoryStorageAdapter(), authenticate: harness.authenticate, allowlist: [{ ...NOXAVA, avatarUrl: null }, { ...SZRON, avatarUrl: null }] };
  registerStreamPlanRoutes(app, core);
  registerLiveRoutes(app, { db, authenticate: harness.authenticate });
  await app.ready();
  const kuba = await harness.issue(NOXAVA.id);
  const szron = await harness.issue(SZRON.id);
  const { secret: key } = await createAccessKey(db, 'StreamControl PC');
  return {
    db, app, kuba, szron, key, harness,
    call: async (session, method, url, body) => app.inject({
      method, url: `/api/v1${url}`, headers: harness.headers(session, method), ...(body === undefined ? {} : { payload: body as never }),
    }),
    reel: async (fields = {}) => {
      const id = randomUUID();
      await db.query(
        `insert into app.reels (id, format, title, original_input, created_by, source_link, updated_at)
         values ($1, $2, $3, '{"text":"Notatka"}', $4, $5, coalesce($6::timestamptz, now()))`,
        [id, fields.format ?? 'reel', fields.title ?? '', NOXAVA.id, fields.sourceLink ?? null, fields.updatedAt ?? null],
      );
      return id;
    },
    close: async () => { await app.close(); await db.close(); },
  };
}

const topic = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(), reelId: null, title: 'Spór o budżet', mainLink: 'https://example.pl/budzet', extraLinks: [], points: ['Liczby', 'Co dalej'], ...overrides,
});

async function createPlan(f: Fixture, title = 'Podsumowanie tygodnia 18.10', scheduledFor: string | null = '2026-10-18') {
  const response = await f.call(f.kuba, 'POST', '/stream-plans', { operationId: randomUUID(), id: randomUUID(), title, scheduledFor });
  assert.equal(response.statusCode, 201);
  return response.json();
}

function save(f: Fixture, plan: { id: string; version: number }, fields: Record<string, unknown>, session = f.kuba, operationId = randomUUID()) {
  return f.call(session, 'PUT', `/stream-plans/${plan.id}`, {
    operationId, expectedVersion: plan.version, title: 'Podsumowanie tygodnia 18.10', scheduledFor: '2026-10-18', commentsSession: null, topics: [], ...fields,
  });
}

test('create, list and get a plan; it is not a Reel', async () => {
  const f = await fixture();
  try {
    const plan = await createPlan(f);
    assert.equal(plan.title, 'Podsumowanie tygodnia 18.10');
    assert.equal(plan.scheduledFor, '2026-10-18');
    assert.deepEqual(plan.topics, []);
    assert.equal(plan.isCurrent, false);
    assert.equal(plan.version, 1);
    const older = await createPlan(f, 'Poprzedni', '2026-10-11');
    const undated = await createPlan(f, 'Bez daty', null);
    const list = (await f.call(f.szron, 'GET', '/stream-plans')).json().items;
    assert.deepEqual(list.map((item: { id: string }) => item.id), [plan.id, older.id, undated.id]);
    assert.equal((await f.call(f.szron, 'GET', `/stream-plans/${plan.id}`)).json().title, plan.title);
    const reels = await f.db.query<{ count: string }>('select count(*)::text as count from app.reels');
    assert.equal(reels.rows[0].count, '0');
    for (const bad of [{ title: '  ' }, { title: 'x'.repeat(121) }, { title: 'Ok', scheduledFor: '2026-02-30' }, { title: 'Ok', scheduledFor: '18.10.2026' }]) {
      const response = await f.call(f.kuba, 'POST', '/stream-plans', { operationId: randomUUID(), id: randomUUID(), ...bad });
      assert.equal(response.statusCode, 422, JSON.stringify(bad));
    }
    assert.equal((await f.call(f.kuba, 'GET', `/stream-plans/${randomUUID()}`)).statusCode, 404);
  } finally {
    await f.close();
  }
});

test('update saves topics, links and points; picking a Reel never changes it and shows its live status', async () => {
  const f = await fixture();
  try {
    const reelId = await f.reel({ title: 'Budżet 2027' });
    const before = await f.db.query('select * from app.reels where id = $1', [reelId]);
    const plan = await createPlan(f);
    const saved = await save(f, plan, {
      commentsSession: 'AbC_12-x',
      topics: [
        topic({ reelId, title: '  Budżet 2027  ', extraLinks: [{ url: 'https://gus.gov.pl', label: 'GUS' }], points: ['Deficyt', '  ', 'Długi'] }),
        topic({ title: 'Pytania od widzów', mainLink: null, points: [] }),
      ],
    });
    assert.equal(saved.statusCode, 200);
    const body = saved.json();
    assert.equal(body.version, 2);
    assert.equal(body.commentsSession, 'AbC_12-x');
    assert.equal(body.topics[0].title, 'Budżet 2027');
    assert.deepEqual(body.topics[0].points, ['Deficyt', 'Długi']);
    assert.deepEqual(body.topics[0].reel, { id: reelId, status: 'idea', deleted: false });
    assert.equal(body.topics[1].reel, null);
    const after = await f.db.query('select * from app.reels where id = $1', [reelId]);
    assert.deepEqual(after.rows, before.rows);

    // A deleted Reel stays in the plan, flagged; it can no longer be added anew.
    await f.db.query('update app.reels set deleted_at = now() where id = $1', [reelId]);
    const reread = (await f.call(f.kuba, 'GET', `/stream-plans/${plan.id}`)).json();
    assert.equal(reread.topics[0].reel.deleted, true);
    const kept = await save(f, reread, { topics: reread.topics.map(({ reel: _reel, ...rest }: { reel: unknown }) => rest) });
    assert.equal(kept.statusCode, 200);
    const other = await createPlan(f, 'Inny');
    const refused = await save(f, other, { topics: [topic({ reelId })] });
    assert.equal(refused.statusCode, 422);
    assert.equal(refused.json().error.details.reason, 'reel_unavailable');
  } finally {
    await f.close();
  }
});

test('validation: limits, links, duplicates, streams and unknown Reels are refused', async () => {
  const f = await fixture();
  try {
    const plan = await createPlan(f);
    const stream = await f.reel({ title: 'Stary stream', format: 'stream' });
    const reelId = await f.reel();
    const cases: Array<[string, Record<string, unknown>]> = [
      ['nine topics', { topics: Array.from({ length: 9 }, () => topic()) }],
      ['empty topic title', { topics: [topic({ title: ' ' })] }],
      ['long topic title', { topics: [topic({ title: 'x'.repeat(181) })] }],
      ['bad main link', { topics: [topic({ mainLink: 'javascript:alert(1)' })] }],
      ['relative link', { topics: [topic({ extraLinks: [{ url: '/artykul', label: '' }] })] }],
      ['too many extra links', { topics: [topic({ extraLinks: Array.from({ length: 12 }, () => ({ url: 'https://a.pl', label: '' })) })] }],
      ['long label', { topics: [topic({ extraLinks: [{ url: 'https://a.pl', label: 'x'.repeat(121) }] })] }],
      ['too many points', { topics: [topic({ points: Array.from({ length: 13 }, (_, i) => `Punkt ${i}`) })] }],
      ['long point', { topics: [topic({ points: ['x'.repeat(201)] })] }],
      ['duplicate topic id', (() => { const one = topic(); return { topics: [one, { ...one, title: 'Inny' }] }; })()],
      ['duplicate Reel', { topics: [topic({ reelId }), topic({ reelId })] }],
      ['stream as topic', { topics: [topic({ reelId: stream })] }],
      ['unknown Reel', { topics: [topic({ reelId: randomUUID() })] }],
      ['bad SSN session', { commentsSession: 'https://socialstream.ninja/dock.html?session=x' }],
    ];
    for (const [name, fields] of cases) {
      const response = await save(f, plan, fields);
      assert.equal(response.statusCode, 422, name);
      assert.equal(response.json().error.code, 'VALIDATION_ERROR', name);
    }
    const unchanged = (await f.call(f.kuba, 'GET', `/stream-plans/${plan.id}`)).json();
    assert.equal(unchanged.version, 1);
  } finally {
    await f.close();
  }
});

test('stale versions conflict without writing; the same operation replays; a different payload conflicts', async () => {
  const f = await fixture();
  try {
    const plan = await createPlan(f);
    const operationId = randomUUID();
    const first = await save(f, plan, { topics: [topic({ title: 'A' })] }, f.kuba, operationId);
    assert.equal(first.statusCode, 200);
    const replay = await save(f, plan, { topics: first.json().topics.map(({ reel: _reel, ...rest }: { reel: unknown }) => rest) }, f.kuba, operationId);
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json(), first.json());
    const different = await save(f, plan, { title: 'Inny tytuł' }, f.kuba, operationId);
    assert.equal(different.statusCode, 409);
    assert.equal(different.json().error.code, 'IDEMPOTENCY_CONFLICT');
    const stale = await save(f, plan, { title: 'Z innego okna' }, f.szron);
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'EDIT_CONFLICT');
    assert.equal(stale.json().error.currentVersion, 2);
    assert.equal((await f.call(f.kuba, 'GET', `/stream-plans/${plan.id}`)).json().title, 'Podsumowanie tygodnia 18.10');
  } finally {
    await f.close();
  }
});

test('one current plan at a time; the device reads it without Reel data; delete clears it', async () => {
  const f = await fixture();
  try {
    const device = (headers: Record<string, string> = { authorization: `Bearer ${f.key}` }) =>
      f.app.inject({ method: 'GET', url: '/api/v1/live/stream', headers });
    assert.deepEqual((await device()).json(), { plan: null });

    const reelId = await f.reel({ title: 'Budżet' });
    const first = await createPlan(f, 'Pierwszy');
    const second = await createPlan(f, 'Drugi');
    const filled = (await save(f, first, { title: 'Pierwszy', topics: [topic({ reelId, title: 'Budżet', extraLinks: [{ url: 'https://gus.gov.pl', label: 'GUS' }] })] })).json();
    const marked = await f.call(f.kuba, 'PUT', `/stream-plans/${first.id}/current`, { operationId: randomUUID(), expectedVersion: filled.version, current: true });
    assert.equal(marked.statusCode, 200);
    assert.equal(marked.json().isCurrent, true);

    const read = (await device()).json().plan;
    assert.equal(read.id, first.id);
    assert.equal(read.title, 'Pierwszy');
    assert.deepEqual(read.topics, [{ id: filled.topics[0].id, title: 'Budżet', mainLink: 'https://example.pl/budzet', extraLinks: [{ url: 'https://gus.gov.pl', label: 'GUS' }], points: ['Liczby', 'Co dalej'] }]);
    assert.equal(JSON.stringify(read).includes(reelId), false);

    const switched = await f.call(f.szron, 'PUT', `/stream-plans/${second.id}/current`, { operationId: randomUUID(), expectedVersion: second.version, current: true });
    assert.equal(switched.statusCode, 200);
    assert.equal((await device()).json().plan.id, second.id);
    const list = (await f.call(f.kuba, 'GET', '/stream-plans')).json().items;
    assert.deepEqual(list.filter((item: { isCurrent: boolean }) => item.isCurrent).map((item: { id: string }) => item.id), [second.id]);

    const removed = await f.call(f.kuba, 'DELETE', `/stream-plans/${second.id}`, { operationId: randomUUID(), expectedVersion: switched.json().version });
    assert.equal(removed.statusCode, 200);
    assert.deepEqual((await device()).json(), { plan: null });
    assert.equal((await f.call(f.kuba, 'GET', `/stream-plans/${second.id}`)).statusCode, 404);
    assert.equal((await f.call(f.kuba, 'GET', '/stream-plans')).json().items.length, 1);

    // The key is a device principal: no cookie, no Origin, and it opens no user route.
    assert.equal((await device({ authorization: `Bearer ${f.key}`, origin: 'https://evil.example' })).statusCode, 401);
    assert.equal((await device({})).statusCode, 401);
    const asKey = await f.app.inject({ method: 'GET', url: '/api/v1/stream-plans', headers: { authorization: `Bearer ${f.key}` } });
    assert.equal(asKey.statusCode, 401);
  } finally {
    await f.close();
  }
});

test('candidates: recent Reels first with their source link; streams, absorbed and deleted excluded', async () => {
  const f = await fixture();
  try {
    const old = await f.reel({ title: 'Stary temat', updatedAt: '2026-01-01T00:00:00Z' });
    const recent = await f.reel({ title: 'Nowy temat', sourceLink: 'https://portal.pl/a' });
    await f.reel({ title: 'Stream', format: 'stream' });
    const deleted = await f.reel({ title: 'Usunięty' });
    await f.db.query('update app.reels set deleted_at = now() where id = $1', [deleted]);
    const items = (await f.call(f.kuba, 'GET', '/stream-plans/candidates')).json().items;
    assert.deepEqual(items.map((item: { id: string }) => item.id), [recent, old]);
    assert.equal(items[0].sourceLink, 'https://portal.pl/a');
    const searched = (await f.call(f.kuba, 'GET', '/stream-plans/candidates?q=stary')).json().items;
    assert.deepEqual(searched.map((item: { id: string }) => item.id), [old]);
    assert.deepEqual((await f.call(f.kuba, 'GET', '/stream-plans/candidates?q=100%25')).json().items, []);
  } finally {
    await f.close();
  }
});

test('unsafe routes need a session, the exact Origin and the CSRF token', async () => {
  const f = await fixture();
  try {
    const body = { operationId: randomUUID(), id: randomUUID(), title: 'Stream' };
    const anonymous = await f.app.inject({ method: 'POST', url: '/api/v1/stream-plans', payload: body });
    assert.equal(anonymous.statusCode, 401);
    const headers = f.harness.headers(f.kuba, 'POST') as Record<string, string>;
    const noCsrf = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'x-csrf-token'));
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/stream-plans', headers: noCsrf, payload: body })).statusCode, 403);
    const foreign = { ...headers, origin: 'https://evil.example' };
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/stream-plans', headers: foreign, payload: body })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/stream-plans' })).statusCode, 401);
  } finally {
    await f.close();
  }
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import Fastify, { type FastifyInstance } from 'fastify';

import { sessionHarness, type IssuedSession } from './auth/test-support.js';
import { registerCoreRoutes } from './core/routes.js';
import { memoryStorageAdapter } from './core/storage.js';
import { type Database, pgliteDatabase } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';
import { createAccessKey } from './live/key-admin.js';
import { runAccessKeyCommand } from './runtime/access-key-cli.js';
import { canonicalPostUrl } from './monitor/canonical-url.js';
import { registerMonitorRoutes } from './monitor/routes.js';

const NOXAVA = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' as const };
const SZRON = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' as const };
const POST_ID = '88888888-8888-4888-8888-888888888881';

interface Fixture {
  db: Database;
  app: FastifyInstance;
  harness: ReturnType<typeof sessionHarness>;
  session: IssuedSession;
  bearer: Record<string, string>;
  liveBearer: Record<string, string>;
  close(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const db = pgliteDatabase(await PGlite.create());
  await migrate(db);
  await seedUsers(db, [NOXAVA, SZRON]);
  const harness = sessionHarness(db);
  const app = Fastify({ logger: false });
  harness.register(app);
  registerCoreRoutes(app, {
    db, storage: memoryStorageAdapter(), authenticate: harness.authenticate,
    allowlist: [{ ...NOXAVA, avatarUrl: null }, { ...SZRON, avatarUrl: null }],
  });
  registerMonitorRoutes(app, {
    db, authenticate: harness.authenticate, storage: memoryStorageAdapter(),
    allowlist: [{ ...NOXAVA, avatarUrl: null }, { ...SZRON, avatarUrl: null }],
  });
  await app.ready();
  const session = await harness.issue(NOXAVA.id);
  const { secret } = await createAccessKey(db, 'Monitor PC', 'monitor_collect');
  const { secret: liveSecret } = await createAccessKey(db, 'Stream PC', 'live_feed');
  return {
    db, app, harness, session, bearer: { authorization: `Bearer ${secret}` },
    liveBearer: { authorization: `Bearer ${liveSecret}` },
    close: async () => { await app.close(); await db.close(); },
  };
}

function sourceRequest(profileUrl = 'https://x.com/KONFEDERACJA_') {
  return { operationId: randomUUID(), sourceId: randomUUID(), name: 'Konfederacja', groupLabel: 'Konfederacja', platform: 'x', profileUrl };
}

function collectedPost(over: Record<string, unknown> = {}) {
  return {
    url: 'https://mobile.twitter.com/KONFEDERACJA_/status/123/photo/1?ref=timeline',
    author: 'Konfederacja', publishedAt: '2026-11-06T07:10:00Z', text: 'Ceny energii rosną.',
    media: ['https://pbs.twimg.com/media/a.jpg'], engagement: { likes: '12' }, isRepost: false, isPinned: false, ...over,
  };
}

test('canonical URLs follow T00 for Facebook and X', () => {
  const cases: Array<[string, 'facebook' | 'x', string | null]> = [
    ['http://m.facebook.com/jan/posts/123/?__cft__=a&__tn__=b#comments', 'facebook', 'https://www.facebook.com/jan/posts/123'],
    ['https://web.facebook.com/permalink.php?__cft__=a&id=42&story_fbid=99&ref=feed', 'facebook', 'https://www.facebook.com/permalink.php?story_fbid=99&id=42'],
    ['https://m.facebook.com/photo/?fbid=12345&set=a.456&__cft__=x#photo', 'facebook', 'https://www.facebook.com/photo?fbid=12345'],
    ['https://www.facebook.com/photo.php?fbid=54321&id=100&set=album', 'facebook', 'https://www.facebook.com/photo.php?fbid=54321'],
    ['https://web.facebook.com/watch/?v=98765&ref=sharing', 'facebook', 'https://www.facebook.com/watch?v=98765'],
    ['https://www.facebook.com/photo/?set=a.123', 'facebook', null],
    ['https://www.facebook.com/watch/?ref=sharing', 'facebook', null],
    ['https://www.facebook.com/story.php?id=42&story_fbid=99&comment_id=2', 'facebook', null],
    ['https://mobile.twitter.com/KONFEDERACJA/status/123/photo/1?ref=timeline#x', 'x', 'https://x.com/KONFEDERACJA/status/123'],
    ['https://twitter.com/user/status/456/analytics', 'x', 'https://x.com/user/status/456'],
    ['https://x.com/user/analytics', 'x', null],
  ];
  for (const [input, platform, expected] of cases) {
    const result = canonicalPostUrl(input, platform);
    assert.equal(result.ok ? result.url : null, expected, input);
  }
});

test('monitor posts list filters by the platform of their source', async () => {
  const f = await fixture();
  try {
    const xSource = await f.app.inject({ method: 'POST', url: '/api/v1/monitor/sources',
      headers: f.harness.headers(f.session, 'POST'), payload: sourceRequest('https://x.com/source') });
    const facebookSource = await f.app.inject({ method: 'POST', url: '/api/v1/monitor/sources',
      headers: f.harness.headers(f.session, 'POST'), payload: { ...sourceRequest('https://facebook.com/source'), platform: 'facebook' } });
    assert.equal(xSource.statusCode, 201, xSource.body);
    assert.equal(facebookSource.statusCode, 201, facebookSource.body);
    const runId = randomUUID();
    const started = await f.app.inject({ method: 'POST', url: '/api/v1/monitor/collect/runs', headers: f.bearer, payload: { runId } });
    const addPost = (sourceId: string, post: Record<string, unknown>) => f.app.inject({
      method: 'POST', url: '/api/v1/monitor/collect/posts', headers: f.bearer,
      payload: { runId, sourceId, posts: [post] },
    });
    assert.equal((await addPost(xSource.json().id, collectedPost({ url: 'https://x.com/source/status/701' }))).statusCode, 200);
    assert.equal((await addPost(facebookSource.json().id, collectedPost({
      url: 'https://www.facebook.com/photo/?fbid=702', text: 'Zdjęcie z wydarzenia.',
    }))).statusCode, 200);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(started.json().startedAt));

    const xList = await f.app.inject({ method: 'GET', url: `/api/v1/monitor/posts?date=${day}&platform=x`, headers: f.harness.headers(f.session, 'GET') });
    assert.equal(xList.statusCode, 200, xList.body);
    assert.equal(xList.json().items.length, 1);
    assert.equal(xList.json().items[0].platform, 'x');
    assert.equal(xList.json().items[0].url, 'https://x.com/source/status/701');

    const facebookList = await f.app.inject({ method: 'GET', url: `/api/v1/monitor/posts?date=${day}&platform=facebook`, headers: f.harness.headers(f.session, 'GET') });
    assert.equal(facebookList.statusCode, 200, facebookList.body);
    assert.equal(facebookList.json().items.length, 1);
    assert.equal(facebookList.json().items[0].platform, 'facebook');
    assert.equal(facebookList.json().items[0].url, 'https://www.facebook.com/photo?fbid=702');
  } finally { await f.close(); }
});

test('monitor keys are isolated to collect routes; cookies and Origin are refused', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/monitor/collect/sources', headers: f.bearer })).statusCode, 200);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/monitor/collect/sources', headers: f.liveBearer })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/monitor/collect/sources', headers: { ...f.bearer, origin: 'https://attacker.test' } })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/monitor/collect/sources', headers: { ...f.bearer, cookie: 'szronox_session=synthetic' } })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/reels', headers: f.bearer })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'GET', url: '/api/v1/monitor/sources', headers: f.bearer })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/monitor/collect/runs', headers: f.liveBearer, payload: { runId: randomUUID() } })).statusCode, 401);
    const cli = await runAccessKeyCommand(f.db, ['create', 'New monitor', '--scope', 'monitor_collect']);
    assert.match(cli, /^created monitor_collect key /);
    assert.match(await runAccessKeyCommand(f.db, ['create', 'Legacy key']), /^created live_feed key /);
  } finally { await f.close(); }
});

test('both users manage versioned sources; duplicate profile URLs are rejected', async () => {
  const f = await fixture();
  try {
    const first = sourceRequest();
    const created = await f.app.inject({ method: 'POST', url: '/api/v1/monitor/sources',
      headers: f.harness.headers(f.session, 'POST'), payload: first });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().active, true);
    assert.equal(created.json().version, 1);

    const duplicate = await f.app.inject({ method: 'POST', url: '/api/v1/monitor/sources',
      headers: f.harness.headers(f.session, 'POST'), payload: { ...sourceRequest(), profileUrl: first.profileUrl } });
    assert.equal(duplicate.statusCode, 422);
    assert.equal(duplicate.json().error.details.reason, 'duplicate_profile');

    const secondSession = await f.harness.issue(SZRON.id);
    const patched = await f.app.inject({ method: 'PATCH', url: `/api/v1/monitor/sources/${first.sourceId}`,
      headers: f.harness.headers(secondSession, 'PATCH'), payload: {
        operationId: randomUUID(), expectedVersion: 1, changes: { active: false, name: 'Profil wyłączony' },
      } });
    assert.equal(patched.statusCode, 200);
    assert.equal(patched.json().active, false);
    assert.equal(patched.json().version, 2);
    const conflict = await f.app.inject({ method: 'PATCH', url: `/api/v1/monitor/sources/${first.sourceId}`,
      headers: f.harness.headers(f.session, 'PATCH'), payload: {
        operationId: randomUUID(), expectedVersion: 1, changes: { name: 'Stara wersja' },
      } });
    assert.equal(conflict.statusCode, 409);
  } finally { await f.close(); }
});

test('collector upserts canonical posts; engagement-only changes do not rewrite stored content', async () => {
  const f = await fixture();
  try {
    const sourceBody = sourceRequest('https://x.com/source');
    const sourceResponse = await f.app.inject({ method: 'POST', url: '/api/v1/monitor/sources',
      headers: f.harness.headers(f.session, 'POST'), payload: sourceBody });
    const sourceId = sourceResponse.json().id as string;
    const runId = randomUUID();
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/v1/monitor/collect/runs', headers: f.bearer, payload: { runId } })).statusCode, 201);
    const send = (post: Record<string, unknown>) => f.app.inject({ method: 'POST', url: '/api/v1/monitor/collect/posts',
      headers: f.bearer, payload: { runId, sourceId, posts: [post] } });
    const first = await send(collectedPost());
    assert.deepEqual(first.json(), { inserted: 1, updated: 0, unchanged: 0, rejected: [] });
    const unchanged = await send(collectedPost({ engagement: { likes: '13' } }));
    assert.equal(unchanged.json().unchanged, 1);
    const revised = await send(collectedPost({ text: 'Ceny energii rosną szybko.', engagement: { likes: '14' }, isPinned: true }));
    assert.equal(revised.json().updated, 1);
    const rows = await f.db.query<{ url: string; text: string; engagement: Record<string, string>; first_seen_at: Date; source_id: string; is_pinned: boolean }>(
      'select url,text,engagement,first_seen_at,source_id,is_pinned from app.monitor_posts',
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0].url, 'https://x.com/KONFEDERACJA_/status/123');
    assert.equal(rows.rows[0].text, 'Ceny energii rosną szybko.');
    assert.deepEqual(rows.rows[0].engagement, { likes: '14' });
    assert.equal(rows.rows[0].source_id, sourceId);
    assert.equal(rows.rows[0].is_pinned, true);

    const invalid = await send(collectedPost({ url: 'https://x.com/user/home' }));
    assert.equal(invalid.json().rejected[0].reason, 'not_a_post');
  } finally { await f.close(); }
});

test('run finish queues a Warsaw-day report and is idempotent; Zrób rolkę uses capture once', async () => {
  const f = await fixture();
  try {
    const sourceBody = sourceRequest('https://x.com/source');
    const source = await f.app.inject({ method: 'POST', url: '/api/v1/monitor/sources', headers: f.harness.headers(f.session, 'POST'), payload: sourceBody });
    const sourceId = source.json().id as string;
    const runId = randomUUID();
    const started = await f.app.inject({ method: 'POST', url: '/api/v1/monitor/collect/runs', headers: f.bearer, payload: { runId } });
    assert.equal(started.statusCode, 201);
    await f.app.inject({ method: 'POST', url: '/api/v1/monitor/collect/posts', headers: f.bearer,
      payload: { runId, sourceId, posts: [collectedPost({ url: 'https://x.com/source/status/7', text: 'Tekst z posta.' })] } });
    const finished = await f.app.inject({ method: 'POST', url: `/api/v1/monitor/collect/runs/${runId}/finish`, headers: f.bearer,
      payload: { results: [{ sourceId, status: 'ok', seen: 1, new: 1 }] } });
    assert.equal(finished.statusCode, 204);
    const reportResponse = await f.app.inject({ method: 'GET', url: '/api/v1/monitor/reports/2026-11-06', headers: f.harness.headers(f.session, 'GET') });
    // The report date is derived from the run's actual Europe/Warsaw start time, including boundary cases.
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(started.json().startedAt));
    const actualReport = reportResponse.statusCode === 200 ? reportResponse.json()
      : (await f.app.inject({ method: 'GET', url: `/api/v1/monitor/reports/${day}`, headers: f.harness.headers(f.session, 'GET') })).json();
    assert.equal(actualReport.date, day);
    assert.equal(actualReport.state, 'queued');
    assert.equal(actualReport.postCount, 1);
    assert.equal(actualReport.sources[0].status, 'ok');
    const repeated = await f.app.inject({ method: 'POST', url: `/api/v1/monitor/collect/runs/${runId}/finish`, headers: f.bearer,
      payload: { results: [{ sourceId, status: 'error', seen: 0, new: 0 }] } });
    assert.equal(repeated.statusCode, 204);
    assert.equal((await f.app.inject({ method: 'GET', url: `/api/v1/monitor/reports/${day}`, headers: f.harness.headers(f.session, 'GET') })).json().sources[0].status, 'ok');

    const list = await f.app.inject({ method: 'GET', url: `/api/v1/monitor/posts?date=${day}`, headers: f.harness.headers(f.session, 'GET') });
    assert.equal(list.statusCode, 200, list.body);
    const postId = list.json().items[0].id as string;
    const reelId = randomUUID();
    const request = { operationId: randomUUID(), reelId };
    const create = () => f.app.inject({ method: 'POST', url: `/api/v1/monitor/posts/${postId}/reel`,
      headers: f.harness.headers(f.session, 'POST'), payload: request });
    const reel = await create();
    assert.equal(reel.statusCode, 201);
    assert.equal(reel.json().originalInput.url, 'https://x.com/source/status/7');
    assert.equal((await create()).json().id, reelId);
    const second = await f.app.inject({ method: 'POST', url: `/api/v1/monitor/posts/${postId}/reel`,
      headers: f.harness.headers(f.session, 'POST'), payload: { operationId: randomUUID(), reelId: randomUUID() } });
    assert.equal(second.statusCode, 422);
    assert.equal(second.json().error.details.reason, 'already_has_reel');
    assert.equal((await f.db.query('select id from app.reels')).rows.length, 1);
  } finally { await f.close(); }
});

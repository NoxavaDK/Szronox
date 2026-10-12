/**
 * STREAM-01 root integration checks (after STREAM-01a merge):
 *   - topic-candidates finds untitled Reels by their capture, matches LIKE wildcards literally,
 *     orders newest first and carries the material for a derived label;
 *   - a topic's live source carries the selected hook text;
 *   - meme attach/detach on an absorbed idea is refused like every other direct mutation.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import Fastify from 'fastify';

import { registerLibraryRoutes } from './ai/library.js';
import { sessionHarness } from './auth/test-support.js';
import { CoreRepository, type Actor } from './core/repository.js';
import { memoryStorageAdapter } from './core/storage.js';
import { pgliteDatabase } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';
import { StreamsRepository } from './streams/repository.js';

const NOXAVA: Actor = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' };
const SZRON: Actor = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' };

async function fixture() {
  const db = pgliteDatabase(await PGlite.create());
  await migrate(db);
  await seedUsers(db, [NOXAVA, SZRON]);
  const core = new CoreRepository(db);
  return { db, core, streams: new StreamsRepository(db, core) };
}

const stream = (core: CoreRepository, title: string) =>
  core.createReel(NOXAVA, { operationId: randomUUID(), reelId: randomUUID(), input: { images: [] }, format: 'stream', title });

const idea = (core: CoreRepository, text: string, over: Record<string, unknown> = {}) =>
  core.createReel(NOXAVA, { operationId: randomUUID(), reelId: randomUUID(), input: { text, images: [] }, ...over });

test('topic-candidates finds untitled Reels by capture, escapes wildcards, newest first, with label material', async () => {
  const { db, core, streams } = await fixture();
  try {
    const s = await stream(core, 'Stream');
    const older = await idea(core, 'Mentzen kpi z policjantek');
    const newer = await idea(core, 'Kolejny pomysł o Mentzenie', { initialHook: 'Kobiety Konfederacji - do pracy, czy do garów?' });
    const withHook = await core.getReel(newer.id);
    await core.selectHook(NOXAVA, newer.id, { operationId: randomUUID(), expectedVersion: withHook.version, hookId: withHook.hooks[0].id });
    const percent = await idea(core, 'Wzrost o 100% w rok');

    const found = await streams.topicCandidates(s.id, 'mentzen');
    const ids = found.items.map((item) => item.id);
    assert.deepEqual(ids, [newer.id, older.id], 'untitled Reels match on capture text, newest first');
    const hooked = found.items[0];
    assert.equal(hooked.title, '');
    assert.equal(hooked.selectedHookText, 'Kobiety Konfederacji - do pracy, czy do garów?');
    assert.equal(hooked.originalInput.text, 'Kolejny pomysł o Mentzenie');
    assert.equal(typeof hooked.script, 'string');

    const literal = await streams.topicCandidates(s.id, '%');
    assert.deepEqual(literal.items.map((item) => item.id), [percent.id], '% is matched literally, not as a wildcard');

    const byHook = await streams.topicCandidates(s.id, 'do garów');
    assert.deepEqual(byHook.items.map((item) => item.id), [newer.id], 'the selected hook is searchable');
  } finally { await db.close(); }
});

test('a topic source carries the selected hook text of its Reel', async () => {
  const { db, core, streams } = await fixture();
  try {
    const s = await stream(core, 'Stream');
    const draft = await idea(core, 'Pomysł', { initialHook: 'Austriacy wymyślili Ukraińców?' });
    const loaded = await core.getReel(draft.id);
    const selected = await core.selectHook(NOXAVA, draft.id, { operationId: randomUUID(), expectedVersion: loaded.version, hookId: loaded.hooks[0].id });
    const linked = await streams.addTopic(NOXAVA, s.id, { operationId: randomUUID(), expectedVersion: s.version, mode: 'link', reelId: draft.id });
    assert.equal(linked.topics[0].source.selectedHookText, 'Austriacy wymyślili Ukraińców?');
    assert.equal(selected.id, draft.id);

    const plain = await idea(core, 'Bez haka');
    const withPlain = await streams.addTopic(NOXAVA, s.id, { operationId: randomUUID(), expectedVersion: linked.version, mode: 'absorb', reelId: plain.id });
    assert.equal(withPlain.topics[1].source.selectedHookText, null);
  } finally { await db.close(); }
});

test('meme attach and detach on an absorbed idea are refused with absorbed_into_stream', async () => {
  const { db, core, streams } = await fixture();
  const harness = sessionHarness(db);
  const app = Fastify({ logger: false });
  harness.register(app);
  registerLibraryRoutes(app, {
    db, storage: memoryStorageAdapter(), authenticate: harness.authenticate,
    allowlist: [{ ...NOXAVA, avatarUrl: null }, { ...SZRON, avatarUrl: null }],
  });
  await app.ready();
  try {
    const s = await stream(core, 'Stream');
    const draft = await idea(core, 'Pomysł');
    await streams.addTopic(NOXAVA, s.id, { operationId: randomUUID(), expectedVersion: s.version, mode: 'absorb', reelId: draft.id });
    const hidden = await core.getReel(draft.id);
    const session = await harness.issue(NOXAVA.id);
    const memeId = randomUUID();

    const attach = await app.inject({
      method: 'POST', url: `/api/v1/reels/${draft.id}/memes`, headers: harness.headers(session, 'POST'),
      payload: { operationId: randomUUID(), expectedVersion: hidden.version, memeId },
    });
    assert.equal(attach.statusCode, 422);
    assert.equal(attach.json().error.details.reason, 'absorbed_into_stream');

    const detach = await app.inject({
      method: 'DELETE', url: `/api/v1/reels/${draft.id}/memes/${memeId}`, headers: harness.headers(session, 'DELETE'),
      payload: { operationId: randomUUID(), expectedVersion: hidden.version },
    });
    assert.equal(detach.statusCode, 422);
    assert.equal(detach.json().error.details.reason, 'absorbed_into_stream');
  } finally { await app.close(); await db.close(); }
});

/**
 * STREAM-01a: streams and topics (T00 section STREAM-01), against real PostgreSQL via PGlite.
 *
 * Pins: the four new Reel wire fields; stream creation through POST /reels; absorb/link/new,
 * PATCH, Odłącz/remove-reference, reorder and topic-candidates; every T00 refusal reason;
 * version-checked idempotency on the stream's own version; hidden absorbed ideas and the
 * `absorbed_into_stream` refusal on every other mutation route; the stream/absorbed-idea
 * delete-restore cascade; the AI `not_available_for_stream` refusal; and session/Origin/CSRF
 * on every new unsafe route.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import Fastify, { type FastifyInstance } from 'fastify';

import { AiService } from './ai/service.js';
import { sessionHarness, TEST_ORIGIN, type IssuedSession } from './auth/test-support.js';
import { CoreError } from './core/errors.js';
import { CoreRepository, type Actor } from './core/repository.js';
import { registerCoreRoutes } from './core/routes.js';
import { memoryStorageAdapter } from './core/storage.js';
import { type Database, pgliteDatabase } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';
import { SourceMetadataService } from './source/metadata.js';
import { StreamsRepository } from './streams/repository.js';
import { registerStreamRoutes } from './streams/routes.js';

const NOXAVA: Actor = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' };
const SZRON: Actor = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' };

interface Fixture { db: Database; core: CoreRepository; streams: StreamsRepository }

async function fixture(): Promise<Fixture> {
  const db = pgliteDatabase(await PGlite.create());
  await migrate(db);
  await seedUsers(db, [NOXAVA, SZRON]);
  const core = new CoreRepository(db);
  return { db, core, streams: new StreamsRepository(db, core) };
}

/** Assert a CoreError with an exact contract code. */
async function expectCode(body: () => Promise<unknown>, code: string, status?: number): Promise<CoreError> {
  try {
    await body();
  } catch (error) {
    assert.ok(error instanceof CoreError, `expected CoreError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return error;
  }
  throw new Error(`expected ${code} but the call succeeded`);
}

/** Assert a 422 VALIDATION_ERROR carrying the exact T00 refusal reason. */
async function expectReason(body: () => Promise<unknown>, reason: string): Promise<void> {
  const error = await expectCode(body, 'VALIDATION_ERROR', 422);
  assert.equal(error.details?.reason, reason);
}

const stream = (core: CoreRepository, actor: Actor, title: string, over: Record<string, unknown> = {}) =>
  core.createReel(actor, {
    operationId: randomUUID(), reelId: randomUUID(), input: { images: [] }, format: 'stream', title, ...over,
  });

const idea = (core: CoreRepository, actor: Actor, text = 'Pomysł', over: Record<string, unknown> = {}) =>
  core.createReel(actor, { operationId: randomUUID(), reelId: randomUUID(), input: { text, images: [] }, ...over });

// ══════════════════════════ Acceptance 1: wire ══════════════════════════════

test('every Reel carries format, absorbedInto, topics and inStreams', async () => {
  const { db, core } = await fixture();
  try {
    const plain = await idea(core, NOXAVA);
    assert.equal(plain.format, 'reel');
    assert.equal(plain.absorbedInto, null);
    assert.deepEqual(plain.topics, []);
    assert.deepEqual(plain.inStreams, []);

    const s = await stream(core, NOXAVA, 'Stream');
    assert.equal(s.format, 'stream');
    assert.equal(s.absorbedInto, null);
    assert.deepEqual(s.topics, []);
  } finally { await db.close(); }
});

// ══════════════════════════ Acceptance 2: stream creation ══════════════════

test('POST /reels creates a stream with title and optional capture; refuses script/hook/plain-reel title', async () => {
  const { db, core } = await fixture();
  try {
    const empty = await stream(core, NOXAVA, 'Pusty stream');
    assert.equal(empty.title, 'Pusty stream');
    assert.equal(empty.format, 'stream');

    const withCapture = await core.createReel(NOXAVA, {
      operationId: randomUUID(), reelId: randomUUID(), format: 'stream', title: 'Z notatką',
      input: { text: 'Kontekst', images: [] },
    });
    assert.equal(withCapture.title, 'Z notatką');
    assert.equal(withCapture.originalInput.text, 'Kontekst');

    await expectCode(() => core.createReel(NOXAVA, {
      operationId: randomUUID(), reelId: randomUUID(), input: { images: [] }, format: 'stream', title: '  ',
    }), 'VALIDATION_ERROR', 422);

    // Omitting format defaults to a plain reel, and that still needs no title.
    const plain = await core.createReel(NOXAVA, { operationId: randomUUID(), reelId: randomUUID(), input: { text: 'X', images: [] } });
    assert.equal(plain.format, 'reel');
  } finally { await db.close(); }
});

test('a stream refuses initialScript/initialHook; a reel refuses a title; existing reel capture unchanged', async () => {
  const { db, core } = await fixture();
  try {
    await expectCode(() => core.createReel(NOXAVA, {
      operationId: randomUUID(), reelId: randomUUID(), input: { text: 'X', images: [] },
      format: 'stream', title: 'S', initialScript: 'X',
    }), 'VALIDATION_ERROR', 422);
    await expectCode(() => core.createReel(NOXAVA, {
      operationId: randomUUID(), reelId: randomUUID(), input: { images: [] },
      format: 'stream', title: 'S', initialHook: 'Hak',
    }), 'VALIDATION_ERROR', 422);
    await expectCode(() => core.createReel(NOXAVA, {
      operationId: randomUUID(), reelId: randomUUID(), input: { text: 'Notatka', images: [] }, title: 'Nie wolno',
    }), 'VALIDATION_ERROR', 422);

    // The existing plain-reel capture path (no format/title) still works exactly as before.
    const plain = await core.createReel(NOXAVA, {
      operationId: randomUUID(), reelId: randomUUID(), input: { text: 'Zwykła notatka', images: [] },
      initialHook: 'Pierwszy hak',
    });
    assert.equal(plain.format, 'reel');
    assert.equal(plain.title, '');
    assert.equal(plain.hooks.length, 1);
  } finally { await db.close(); }
});

// ══════════════════════════ Acceptance 3 & 4: topic routes and refusals ═════

test('absorb copies title/inputNote/script and hides the idea', async () => {
  const { db, core, streams } = await fixture();
  try {
    const s = await stream(core, NOXAVA, 'Stream');
    const draft = await idea(core, NOXAVA, 'Pomysł do wchłonięcia');
    const edited = await core.patchReel(NOXAVA, draft.id, {
      operationId: randomUUID(), expectedVersion: draft.version,
      changes: { title: 'Tytuł pomysłu', inputNote: 'Notatka', script: 'Skrypt roboczy' },
    });

    const result = await streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: s.version, mode: 'absorb', reelId: edited.id,
    });
    assert.equal(result.version, s.version + 1);
    assert.equal(result.topics.length, 1);
    const topic = result.topics[0];
    assert.equal(topic.kind, 'absorbed');
    assert.equal(topic.position, 0);
    assert.equal(topic.title, 'Tytuł pomysłu');
    assert.equal(topic.notes, 'Notatka');
    assert.equal(topic.script, 'Skrypt roboczy');
    assert.equal(topic.source.reelId, edited.id);

    // The idea is hidden from both list visibilities.
    assert.equal((await core.listReels({})).items.some((item) => item.id === edited.id), false);
    assert.equal((await core.listReels({ visibility: 'deleted' })).items.some((item) => item.id === edited.id), false);
    const raw = await core.getReel(edited.id);
    assert.equal(raw.absorbedInto, s.id);
  } finally { await db.close(); }
});

test('link stores no copy and reads the source live', async () => {
  const { db, core, streams } = await fixture();
  try {
    const s = await stream(core, NOXAVA, 'Stream');
    const target = await idea(core, NOXAVA, 'Rolka referencyjna');
    await core.patchReel(NOXAVA, target.id, {
      operationId: randomUUID(), expectedVersion: target.version, changes: { publicationSource: 'Autor X' },
    });

    const result = await streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: s.version, mode: 'link', reelId: target.id,
    });
    const topic = result.topics[0];
    assert.equal(topic.kind, 'linked');
    assert.equal(topic.title, '');
    assert.equal(topic.notes, '');
    assert.equal(topic.script, '');
    // D4: publicationSource is suppressed on a linked topic even though the Reel has one.
    assert.equal(topic.source.publicationSource, null);
    // But sourceLine (the real effective attribution) still reflects it.
    assert.equal(topic.source.sourceLine, 'Autor X');

    // The idea is NOT hidden: linking stores only a reference.
    assert.equal((await core.listReels({})).items.some((item) => item.id === target.id), true);
    assert.equal((await core.getReel(target.id)).absorbedInto, null);

    // D6: inStreams on the linked Reel names the active stream.
    const linkedReel = await core.getReel(target.id);
    assert.deepEqual(linkedReel.inStreams, [{ id: s.id, title: 'Stream' }]);
  } finally { await db.close(); }
});

test('+ Nowy temat creates a hidden absorbed idea and its topic in one write', async () => {
  const { db, core, streams } = await fixture();
  try {
    const s = await stream(core, NOXAVA, 'Stream');
    const topicId = randomUUID();
    const reelId = randomUUID();
    const result = await streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: s.version, mode: 'new',
      topicId, reelId, title: 'Nowy temat', link: 'https://example.com/a', note: 'Kontekst',
    });
    assert.equal(result.topics.length, 1);
    const topic = result.topics[0];
    assert.equal(topic.id, topicId);
    assert.equal(topic.kind, 'absorbed');
    assert.equal(topic.title, 'Nowy temat');
    assert.equal(topic.notes, 'Kontekst');
    assert.equal(topic.source.reelId, reelId);
    assert.equal(topic.source.originalInput?.url, 'https://example.com/a');
    assert.equal(topic.source.sourceMetadata?.state, 'pending');

    const raw = await core.getReel(reelId);
    assert.equal(raw.status, 'idea');
    assert.equal(raw.absorbedInto, s.id);
    assert.equal(raw.title, 'Nowy temat');
    assert.equal(raw.inputNote, 'Kontekst');

    // Without a link, capture is { images: [] } and metadata is no_url.
    const withoutLink = await streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: result.version, mode: 'new',
      topicId: randomUUID(), reelId: randomUUID(), title: 'Bez linku',
    });
    const second = withoutLink.topics[1];
    assert.deepEqual(second.source.originalInput?.images, []);
    assert.equal(second.source.sourceMetadata?.state, 'no_url');

    await expectCode(() => streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: withoutLink.version, mode: 'new',
      topicId: randomUUID(), reelId: randomUUID(), title: '   ',
    }), 'VALIDATION_ERROR', 422);
    await expectCode(() => streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: withoutLink.version, mode: 'new',
      topicId: randomUUID(), reelId: randomUUID(), title: 'Złe URL', link: 'ftp://nope',
    }), 'VALIDATION_ERROR', 422);
  } finally { await db.close(); }
});

test('PATCH edits an absorbed copy and the publicationSource of the idea; refused on a linked topic', async () => {
  const { db, core, streams } = await fixture();
  try {
    const s = await stream(core, NOXAVA, 'Stream');
    const draft = await idea(core, NOXAVA, 'Pomysł');
    const absorbed = await streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: s.version, mode: 'absorb', reelId: draft.id,
    });
    const topicId = absorbed.topics[0].id;

    const patched = await streams.patchTopic(NOXAVA, s.id, topicId, {
      operationId: randomUUID(), expectedVersion: absorbed.version,
      changes: { title: 'Nowy tytuł', notes: 'Nowe notatki', script: 'Nowy skrypt', publicationSource: 'Ręczny autor' },
    });
    assert.equal(patched.version, absorbed.version + 1);
    const topic = patched.topics[0];
    assert.equal(topic.title, 'Nowy tytuł');
    assert.equal(topic.notes, 'Nowe notatki');
    assert.equal(topic.script, 'Nowy skrypt');
    assert.equal(topic.source.publicationSource, 'Ręczny autor');
    assert.equal((await core.getReel(draft.id)).publicationSource, 'Ręczny autor');

    await expectCode(() => streams.patchTopic(NOXAVA, s.id, topicId, {
      operationId: randomUUID(), expectedVersion: patched.version, changes: {},
    }), 'VALIDATION_ERROR', 422);

    const target = await idea(core, NOXAVA, 'Referencja');
    const linked = await streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: patched.version, mode: 'link', reelId: target.id,
    });
    const linkedTopicId = linked.topics.find((t) => t.kind === 'linked')!.id;
    await expectReason(() => streams.patchTopic(NOXAVA, s.id, linkedTopicId, {
      operationId: randomUUID(), expectedVersion: linked.version, changes: { title: 'Nope' },
    }), 'topic_not_absorbed');
  } finally { await db.close(); }
});

test('Odłącz writes the copy back, bumps scriptRevision only when the script changed, un-hides and renumbers', async () => {
  const { db, core, streams } = await fixture();
  try {
    const s = await stream(core, NOXAVA, 'Stream');
    const a = await idea(core, NOXAVA, 'A');
    const b = await idea(core, NOXAVA, 'B');
    const c = await idea(core, NOXAVA, 'C');
    let current = await streams.addTopic(NOXAVA, s.id, { operationId: randomUUID(), expectedVersion: s.version, mode: 'absorb', reelId: a.id });
    current = await streams.addTopic(NOXAVA, s.id, { operationId: randomUUID(), expectedVersion: current.version, mode: 'absorb', reelId: b.id });
    current = await streams.addTopic(NOXAVA, s.id, { operationId: randomUUID(), expectedVersion: current.version, mode: 'absorb', reelId: c.id });
    const [topicA, topicB, topicC] = current.topics;

    const patched = await streams.patchTopic(NOXAVA, s.id, topicB.id, {
      operationId: randomUUID(), expectedVersion: current.version, changes: { script: 'Zmieniony skrypt' },
    });

    const released = await streams.removeTopic(NOXAVA, s.id, topicB.id, {
      operationId: randomUUID(), expectedVersion: patched.version,
    });
    assert.equal(released.topics.length, 2);
    assert.deepEqual(released.topics.map((t) => t.id), [topicA.id, topicC.id]);
    assert.deepEqual(released.topics.map((t) => t.position), [0, 1]);

    const ideaB = await core.getReel(b.id);
    assert.equal(ideaB.absorbedInto, null);
    assert.equal(ideaB.script, 'Zmieniony skrypt');
    assert.equal(ideaB.scriptRevision, 1, 'script text changed, so scriptRevision advances');
    assert.equal(ideaB.version, b.version + 1);
    assert.equal((await core.listReels({})).items.some((item) => item.id === b.id), true, 'the idea returns to the list');

    // Odłącz topic A without editing its script: scriptRevision stays at 0.
    const releasedA = await streams.removeTopic(NOXAVA, s.id, topicA.id, {
      operationId: randomUUID(), expectedVersion: released.version,
    });
    void releasedA;
    const ideaA = await core.getReel(a.id);
    assert.equal(ideaA.scriptRevision, 0);
  } finally { await db.close(); }
});

test('remove reference on a linked topic removes only the reference', async () => {
  const { db, core, streams } = await fixture();
  try {
    const s = await stream(core, NOXAVA, 'Stream');
    const target = await idea(core, NOXAVA, 'Referencja');
    const linked = await streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: s.version, mode: 'link', reelId: target.id,
    });
    const removed = await streams.removeTopic(NOXAVA, s.id, linked.topics[0].id, {
      operationId: randomUUID(), expectedVersion: linked.version,
    });
    assert.deepEqual(removed.topics, []);
    const reel = await core.getReel(target.id);
    assert.equal(reel.absorbedInto, null);
    assert.deepEqual(reel.inStreams, []);
  } finally { await db.close(); }
});

test('reorder takes the complete topic ID set; any other set is topic_set_mismatch', async () => {
  const { db, core, streams } = await fixture();
  try {
    const s = await stream(core, NOXAVA, 'Stream');
    const a = await idea(core, NOXAVA, 'A');
    const b = await idea(core, NOXAVA, 'B');
    let current = await streams.addTopic(NOXAVA, s.id, { operationId: randomUUID(), expectedVersion: s.version, mode: 'absorb', reelId: a.id });
    current = await streams.addTopic(NOXAVA, s.id, { operationId: randomUUID(), expectedVersion: current.version, mode: 'absorb', reelId: b.id });
    const [topicA, topicB] = current.topics;

    const reordered = await streams.reorderTopics(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: current.version, topicIds: [topicB.id, topicA.id],
    });
    assert.deepEqual(reordered.topics.map((t) => t.id), [topicB.id, topicA.id]);
    assert.deepEqual(reordered.topics.map((t) => t.position), [0, 1]);

    await expectReason(() => streams.reorderTopics(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: reordered.version, topicIds: [topicA.id],
    }), 'topic_set_mismatch');
    await expectReason(() => streams.reorderTopics(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: reordered.version, topicIds: [topicA.id, topicB.id, randomUUID()],
    }), 'topic_set_mismatch');
  } finally { await db.close(); }
});

// ══════════════════════════ Acceptance 4: every refusal reason ══════════════

test('every T00 refusal reason for addTopic has a direct test', async () => {
  const { db, core, streams } = await fixture();
  try {
    const s = await stream(core, NOXAVA, 'Stream');
    const otherStream = await stream(core, NOXAVA, 'Inny stream');
    const plain = await idea(core, NOXAVA, 'Zwykła rolka');

    // not_a_stream: the :id in the URL is not a stream.
    await expectReason(() => streams.addTopic(NOXAVA, plain.id, {
      operationId: randomUUID(), expectedVersion: plain.version, mode: 'link', reelId: s.id,
    }), 'not_a_stream');

    // source_is_stream: a stream cannot be a topic (including itself).
    await expectReason(() => streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: s.version, mode: 'link', reelId: otherStream.id,
    }), 'source_is_stream');
    await expectReason(() => streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: s.version, mode: 'link', reelId: s.id,
    }), 'source_is_stream');

    // source_deleted
    const deletable = await idea(core, NOXAVA, 'Do usunięcia');
    const deleted = await core.setDeleted(NOXAVA, deletable.id, { operationId: randomUUID(), expectedVersion: deletable.version }, true);
    void deleted;
    await expectReason(() => streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: s.version, mode: 'link', reelId: deletable.id,
    }), 'source_deleted');

    // absorb_requires_idea: a later-status Reel can be linked but not absorbed.
    const toRecord = await idea(core, NOXAVA, 'W produkcji');
    await core.patchReel(NOXAVA, toRecord.id, { operationId: randomUUID(), expectedVersion: toRecord.version, changes: { status: 'to_record' } });
    await expectReason(() => streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: s.version, mode: 'absorb', reelId: toRecord.id,
    }), 'absorb_requires_idea');
    // ...but linking it works.
    const linkedLater = await streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: s.version, mode: 'link', reelId: toRecord.id,
    });

    // already_in_stream: duplicates within the same stream, either kind.
    await expectReason(() => streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: linkedLater.version, mode: 'link', reelId: toRecord.id,
    }), 'already_in_stream');
    await expectReason(() => streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: linkedLater.version, mode: 'absorb', reelId: toRecord.id,
    }), 'already_in_stream');

    // absorbed_elsewhere
    const absorbedIdea = await idea(core, NOXAVA, 'Wchłonięty gdzie indziej');
    await streams.addTopic(NOXAVA, otherStream.id, { operationId: randomUUID(), expectedVersion: otherStream.version, mode: 'absorb', reelId: absorbedIdea.id });
    await expectReason(() => streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: linkedLater.version, mode: 'link', reelId: absorbedIdea.id,
    }), 'absorbed_elsewhere');
    await expectReason(() => streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: linkedLater.version, mode: 'absorb', reelId: absorbedIdea.id,
    }), 'absorbed_elsewhere');

    // linked_elsewhere
    const linkedIdea = await idea(core, NOXAVA, 'Połączony gdzie indziej');
    await streams.addTopic(NOXAVA, otherStream.id, { operationId: randomUUID(), expectedVersion: (await core.getReel(otherStream.id)).version, mode: 'link', reelId: linkedIdea.id });
    await expectReason(() => streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: linkedLater.version, mode: 'absorb', reelId: linkedIdea.id,
    }), 'linked_elsewhere');
    await expectReason(() => streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: linkedLater.version, mode: 'link', reelId: linkedIdea.id,
    }), 'linked_elsewhere');
  } finally { await db.close(); }
});

// ══════════════════════════ Acceptance 5: conflict and idempotency ═════════

test('every topic mutation is version-checked, idempotent and bumps the stream version by exactly one', async () => {
  const { db, core, streams } = await fixture();
  try {
    const s = await stream(core, NOXAVA, 'Stream');
    const draft = await idea(core, NOXAVA, 'Pomysł');
    const operationId = randomUUID();
    const payload = { operationId, expectedVersion: s.version, mode: 'absorb' as const, reelId: draft.id };

    const first = await streams.addTopic(NOXAVA, s.id, payload);
    assert.equal(first.version, s.version + 1);

    // Stale expectedVersion: 409 EDIT_CONFLICT, no partial write.
    const otherDraft = await idea(core, NOXAVA, 'Inny pomysł');
    const conflict = await expectCode(() => streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: s.version, mode: 'absorb', reelId: otherDraft.id,
    }), 'EDIT_CONFLICT', 409);
    assert.equal(conflict.toEnvelope().error.currentVersion, first.version);
    assert.equal((await core.getReel(s.id)).topics.length, 1, 'the conflicting write left no partial state');

    // Same operationId + same payload replays the original result.
    const replay = await streams.addTopic(NOXAVA, s.id, payload);
    assert.deepEqual(replay, first);
    assert.equal((await core.getReel(s.id)).topics.length, 1, 'a replay does not re-apply');

    // Same operationId + different payload is IDEMPOTENCY_CONFLICT.
    await expectCode(() => streams.addTopic(NOXAVA, s.id, {
      operationId, expectedVersion: s.version, mode: 'absorb', reelId: otherDraft.id,
    }), 'IDEMPOTENCY_CONFLICT', 409);
  } finally { await db.close(); }
});

// ══════════════════════════ Acceptance 6: hidden absorbed ideas ═════════════

test('an absorbed idea is excluded from every list and topic-candidates, but GET by id and SOURCE-01 refresh still work', async () => {
  const { db, core, streams } = await fixture();
  try {
    const s = await stream(core, NOXAVA, 'Stream');
    const draft = await idea(core, NOXAVA, 'Pomysł');
    await streams.addTopic(NOXAVA, s.id, { operationId: randomUUID(), expectedVersion: s.version, mode: 'absorb', reelId: draft.id });

    assert.equal((await core.listReels({})).items.some((item) => item.id === draft.id), false);
    const candidates = await streams.topicCandidates(s.id, undefined);
    assert.equal(candidates.items.some((item) => item.id === draft.id), false);

    // GET /reels/:id is still allowed.
    const detail = await core.getReel(draft.id);
    assert.equal(detail.absorbedInto, s.id);

    // SOURCE-01 refresh is still allowed on an absorbed idea.
    const service = new SourceMetadataService(db, async (url) => ({ finalUrl: url, contentType: 'text/html', bytes: Buffer.from('') }), false);
    const refreshed = await service.refresh(NOXAVA.id, draft.id, randomUUID());
    assert.ok(refreshed.metadata);
  } finally { await db.close(); }
});

test('every other mutation route on an absorbed idea is refused with absorbed_into_stream', async () => {
  const { db, core, streams } = await fixture();
  try {
    const s = await stream(core, NOXAVA, 'Stream');
    const draft = await idea(core, NOXAVA, 'Pomysł', { initialHook: 'Hak' });
    const absorbed = await streams.addTopic(NOXAVA, s.id, { operationId: randomUUID(), expectedVersion: s.version, mode: 'absorb', reelId: draft.id });
    const idea1 = await core.getReel(draft.id);
    const hookId = idea1.hooks[0].id;

    await expectReason(() => core.patchReel(NOXAVA, draft.id, {
      operationId: randomUUID(), expectedVersion: idea1.version, changes: { title: 'Nope' },
    }), 'absorbed_into_stream');
    await expectReason(() => core.setDeleted(NOXAVA, draft.id, { operationId: randomUUID(), expectedVersion: idea1.version }, true), 'absorbed_into_stream');
    await expectReason(() => core.addHook(NOXAVA, draft.id, { operationId: randomUUID(), expectedVersion: idea1.version, text: 'Nowy' }), 'absorbed_into_stream');
    await expectReason(() => core.editHook(NOXAVA, draft.id, hookId, { operationId: randomUUID(), expectedVersion: idea1.version, text: 'Zmiana' }), 'absorbed_into_stream');
    await expectReason(() => core.removeHook(NOXAVA, draft.id, hookId, { operationId: randomUUID(), expectedVersion: idea1.version }), 'absorbed_into_stream');
    await expectReason(() => core.selectHook(NOXAVA, draft.id, { operationId: randomUUID(), expectedVersion: idea1.version, hookId }), 'absorbed_into_stream');
    await expectReason(() => core.replaceExport(NOXAVA, draft.id, { operationId: randomUUID(), expectedVersion: idea1.version, export: { url: 'https://x', label: 'x' } }), 'absorbed_into_stream');
    await expectReason(() => core.verifyExport(NOXAVA, draft.id, { operationId: randomUUID(), expectedVersion: idea1.version, exportRevision: 1 }), 'absorbed_into_stream');

    // AI routes on an absorbed idea.
    const ai = new AiService(db);
    await expectReason(() => ai.enqueue(NOXAVA, draft.id, { operationId: randomUUID(), expectedVersion: idea1.version, action: 'develop' }), 'absorbed_into_stream');

    void absorbed;
  } finally { await db.close(); }
});

// ══════════════════════════ Acceptance 7: delete/restore lifecycle ══════════

test('deleting a stream soft-deletes its absorbed ideas; restoring brings them back with topics and order intact', async () => {
  const { db, core, streams } = await fixture();
  try {
    const s = await stream(core, NOXAVA, 'Stream');
    const a = await idea(core, NOXAVA, 'A');
    const b = await idea(core, NOXAVA, 'B');
    let current = await streams.addTopic(NOXAVA, s.id, { operationId: randomUUID(), expectedVersion: s.version, mode: 'absorb', reelId: a.id });
    current = await streams.addTopic(NOXAVA, s.id, { operationId: randomUUID(), expectedVersion: current.version, mode: 'absorb', reelId: b.id });

    const deletedStream = await core.setDeleted(NOXAVA, s.id, { operationId: randomUUID(), expectedVersion: current.version }, true);
    assert.ok(deletedStream.deletedAt);
    const deletedA = await core.getReel(a.id, { includeDeleted: true });
    const deletedB = await core.getReel(b.id, { includeDeleted: true });
    assert.ok(deletedA.deletedAt);
    assert.ok(deletedB.deletedAt);

    // Topic mutations on a deleted stream are refused.
    await expectCode(() => streams.addTopic(NOXAVA, s.id, {
      operationId: randomUUID(), expectedVersion: deletedStream.version, mode: 'link', reelId: a.id,
    }), 'NOT_FOUND', 404);

    const restoredStream = await core.setDeleted(NOXAVA, s.id, { operationId: randomUUID(), expectedVersion: deletedStream.version }, false);
    assert.equal(restoredStream.deletedAt, null);
    assert.deepEqual(restoredStream.topics.map((t) => t.source.reelId), [a.id, b.id]);
    assert.deepEqual(restoredStream.topics.map((t) => t.position), [0, 1]);
    const restoredA = await core.getReel(a.id);
    assert.equal(restoredA.deletedAt, null);
    assert.equal(restoredA.absorbedInto, s.id);
  } finally { await db.close(); }
});

test('deleting a linked Reel never touches the stream, and shows source.deletedAt on the topic', async () => {
  const { db, core, streams } = await fixture();
  try {
    const s = await stream(core, NOXAVA, 'Stream');
    const target = await idea(core, NOXAVA, 'Referencja');
    const linked = await streams.addTopic(NOXAVA, s.id, { operationId: randomUUID(), expectedVersion: s.version, mode: 'link', reelId: target.id });

    await core.setDeleted(NOXAVA, target.id, { operationId: randomUUID(), expectedVersion: target.version }, true);
    const after = await core.getReel(s.id);
    assert.equal(after.deletedAt, null, 'the stream itself is untouched');
    assert.equal(after.version, linked.version, 'deleting the linked Reel does not touch the stream');
    assert.ok(after.topics[0].source.deletedAt, 'the topic shows the deleted source');

    // The now-deleted linked Reel no longer lists the stream as active in inStreams.
    const deletedTarget = await core.getReel(target.id, { includeDeleted: true });
    assert.deepEqual(deletedTarget.inStreams, []);
  } finally { await db.close(); }
});

// ══════════════════════════ Acceptance 8: no AI on a stream ═════════════════

test('POST /reels/:id/ai-runs on a stream is refused with not_available_for_stream; nothing is enqueued', async () => {
  const { db, core } = await fixture();
  try {
    const s = await stream(core, NOXAVA, 'Stream');
    const ai = new AiService(db);
    await expectReason(() => ai.enqueue(NOXAVA, s.id, { operationId: randomUUID(), expectedVersion: s.version, action: 'develop' }), 'not_available_for_stream');
    const runs = await db.query('select count(*)::int as count from app.ai_runs');
    assert.equal((runs.rows[0] as { count: number }).count, 0);
  } finally { await db.close(); }
});

// ══════════════════════════ Acceptance 9: topic-candidates ══════════════════

test('topic-candidates filters, flags inThisStream and matches titles case-insensitively', async () => {
  const { db, core, streams } = await fixture();
  try {
    const s = await stream(core, NOXAVA, 'Stream');
    const match = await idea(core, NOXAVA, 'cokolwiek');
    await core.patchReel(NOXAVA, match.id, { operationId: randomUUID(), expectedVersion: match.version, changes: { title: 'Wielki Temat' } });
    const noMatch = await idea(core, NOXAVA, 'cokolwiek');
    await core.patchReel(NOXAVA, noMatch.id, { operationId: randomUUID(), expectedVersion: noMatch.version, changes: { title: 'Zupełnie inny' } });
    const deletedCandidate = await idea(core, NOXAVA, 'usunięty');
    const titledDeleted = await core.patchReel(NOXAVA, deletedCandidate.id, { operationId: randomUUID(), expectedVersion: deletedCandidate.version, changes: { title: 'wielki usunięty' } });
    await core.setDeleted(NOXAVA, deletedCandidate.id, { operationId: randomUUID(), expectedVersion: titledDeleted.version }, true);
    const absorbedElsewhere = await idea(core, NOXAVA, 'cokolwiek');
    const other = await stream(core, NOXAVA, 'Inny stream');
    await core.patchReel(NOXAVA, absorbedElsewhere.id, { operationId: randomUUID(), expectedVersion: absorbedElsewhere.version, changes: { title: 'wielki wchłonięty' } });
    await streams.addTopic(NOXAVA, other.id, { operationId: randomUUID(), expectedVersion: other.version, mode: 'absorb', reelId: absorbedElsewhere.id });

    const linked = await streams.addTopic(NOXAVA, s.id, { operationId: randomUUID(), expectedVersion: s.version, mode: 'link', reelId: match.id });
    void linked;

    const found = await streams.topicCandidates(s.id, 'WIELKI');
    const ids = found.items.map((item) => item.id);
    assert.ok(ids.includes(match.id), 'case-insensitive title match');
    assert.equal(ids.includes(noMatch.id), false);
    assert.equal(ids.includes(deletedCandidate.id), false, 'deleted Reels are excluded');
    assert.equal(ids.includes(absorbedElsewhere.id), false, 'absorbed-elsewhere ideas are excluded');
    const matchCandidate = found.items.find((item) => item.id === match.id)!;
    assert.equal(matchCandidate.inThisStream, true);

    const empty = await streams.topicCandidates(s.id, undefined);
    assert.ok(empty.items.length >= 1);

    await expectReason(() => streams.topicCandidates(match.id, undefined), 'not_a_stream');
  } finally { await db.close(); }
});

// ══════════════════════════ Acceptance 11: session / Origin / CSRF ══════════

interface HttpFixture {
  db: Database;
  app: FastifyInstance;
  session: IssuedSession;
  harness: ReturnType<typeof sessionHarness>;
  close: () => Promise<void>;
}

async function httpFixture(): Promise<HttpFixture> {
  const db = pgliteDatabase(await PGlite.create());
  await migrate(db);
  await seedUsers(db, [NOXAVA, SZRON]);
  const harness = sessionHarness(db);
  const app = Fastify({ logger: false });
  harness.register(app);
  const core = { db, storage: memoryStorageAdapter(), authenticate: harness.authenticate, allowlist: [{ ...NOXAVA, avatarUrl: null }, { ...SZRON, avatarUrl: null }] };
  registerCoreRoutes(app, core);
  registerStreamRoutes(app, core);
  await app.ready();
  const session = await harness.issue(NOXAVA.id);
  return { db, app, session, harness, close: async () => { await app.close(); await db.close(); } };
}

test('each new unsafe stream route requires a session, exact Origin and CSRF', async () => {
  const f = await httpFixture();
  try {
    const created = await f.app.inject({
      method: 'POST', url: '/api/v1/reels', headers: f.harness.headers(f.session, 'POST'),
      payload: { operationId: randomUUID(), reelId: randomUUID(), input: { images: [] }, format: 'stream', title: 'Stream' } as never,
    });
    const streamId = created.json().id as string;
    const streamVersion = created.json().version as number;

    const topicIdea = await f.app.inject({
      method: 'POST', url: '/api/v1/reels', headers: f.harness.headers(f.session, 'POST'),
      payload: { operationId: randomUUID(), reelId: randomUUID(), input: { text: 'X', images: [] } } as never,
    });
    const reelId = topicIdea.json().id as string;

    const routes: Array<{ method: 'POST' | 'PATCH' | 'DELETE' | 'PUT'; url: string; payload: Record<string, unknown> }> = [
      { method: 'POST', url: `/api/v1/reels/${streamId}/topics`, payload: { operationId: randomUUID(), expectedVersion: streamVersion, mode: 'link', reelId } },
      { method: 'PUT', url: `/api/v1/reels/${streamId}/topic-order`, payload: { operationId: randomUUID(), expectedVersion: streamVersion, topicIds: [] } },
    ];

    for (const route of routes) {
      const anon = await f.app.inject({ method: route.method, url: route.url, payload: route.payload as never });
      assert.equal(anon.statusCode, 401, `${route.method} ${route.url} without a session`);

      const noCsrf = { ...f.harness.headers(f.session, route.method) };
      delete noCsrf['x-csrf-token'];
      const missingCsrf = await f.app.inject({ method: route.method, url: route.url, headers: noCsrf, payload: route.payload as never });
      assert.notEqual(missingCsrf.statusCode, 200, `${route.method} ${route.url} without CSRF`);
      assert.notEqual(missingCsrf.statusCode, 201, `${route.method} ${route.url} without CSRF`);

      const foreignOrigin = { ...f.harness.headers(f.session, route.method), origin: 'https://not-szronox.test' };
      const foreign = await f.app.inject({ method: route.method, url: route.url, headers: foreignOrigin, payload: route.payload as never });
      assert.notEqual(foreign.statusCode, 200, `${route.method} ${route.url} with a foreign Origin`);
      assert.notEqual(foreign.statusCode, 201, `${route.method} ${route.url} with a foreign Origin`);
    }

    // Now actually add the topic for real, so PATCH/DELETE have a topicId to exercise.
    const add = await f.app.inject({
      method: 'POST', url: `/api/v1/reels/${streamId}/topics`, headers: f.harness.headers(f.session, 'POST'),
      payload: { operationId: randomUUID(), expectedVersion: streamVersion, mode: 'link', reelId } as never,
    });
    assert.equal(add.statusCode, 201);
    const addedStream = add.json();
    const topicId = addedStream.topics[0].id as string;

    for (const route of [
      { method: 'PATCH' as const, url: `/api/v1/reels/${streamId}/topics/${topicId}`, payload: { operationId: randomUUID(), expectedVersion: addedStream.version, changes: { title: 'x' } } },
      { method: 'DELETE' as const, url: `/api/v1/reels/${streamId}/topics/${topicId}`, payload: { operationId: randomUUID(), expectedVersion: addedStream.version } },
    ]) {
      const anon = await f.app.inject({ method: route.method, url: route.url, payload: route.payload as never });
      assert.equal(anon.statusCode, 401, `${route.method} ${route.url} without a session`);
      const noCsrf = { ...f.harness.headers(f.session, route.method) };
      delete noCsrf['x-csrf-token'];
      const missingCsrf = await f.app.inject({ method: route.method, url: route.url, headers: noCsrf, payload: route.payload as never });
      assert.ok(missingCsrf.statusCode >= 400, `${route.method} ${route.url} without CSRF`);
      const foreignOrigin = { ...f.harness.headers(f.session, route.method), origin: 'https://not-szronox.test' };
      const foreign = await f.app.inject({ method: route.method, url: route.url, headers: foreignOrigin, payload: route.payload as never });
      assert.ok(foreign.statusCode >= 400, `${route.method} ${route.url} with a foreign Origin`);
    }
  } finally { await f.close(); }
});

test('topic-candidates is reachable over HTTP and requires a session', async () => {
  const f = await httpFixture();
  try {
    const created = await f.app.inject({
      method: 'POST', url: '/api/v1/reels', headers: f.harness.headers(f.session, 'POST'),
      payload: { operationId: randomUUID(), reelId: randomUUID(), input: { images: [] }, format: 'stream', title: 'Stream' } as never,
    });
    const streamId = created.json().id as string;
    const anon = await f.app.inject({ method: 'GET', url: `/api/v1/reels/${streamId}/topic-candidates` });
    assert.equal(anon.statusCode, 401);
    const ok = await f.app.inject({ method: 'GET', url: `/api/v1/reels/${streamId}/topic-candidates?q=`, headers: f.harness.headers(f.session, 'GET') });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json(), { items: [] });
  } finally { await f.close(); }
});

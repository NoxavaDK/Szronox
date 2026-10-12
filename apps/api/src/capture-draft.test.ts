/**
 * CAPTURE-DRAFT-01 acceptance 3–5, against real PostgreSQL via PGlite.
 *
 * 3. Capture enqueues exactly one `trigger='capture'` develop run in the same transaction. An
 *    idempotent replay enqueues nothing more. Streams, a new stream topic, AI disabled and an
 *    exhausted daily limit each enqueue nothing, and capture still succeeds either way. The
 *    limit counts only runs created since the start of the current Europe/Warsaw day.
 * 4. Auto-draft results never change title, script, selectedHookId or priority; hooks are
 *    appended unselected; the Detail "Użyj" action (the existing, version-checked `apply`)
 *    still works against a capture-triggered run exactly as it does against a user one.
 * 5. `Reel.autoDraft` reflects queued/running/succeeded/failed, and goes stale on a live edit
 *    that no longer matches the run's own snapshot.
 *
 * Label-chain rungs (title/hook/autoDraft/headline) are covered by
 * apps/web/src/data/tests/reel-label.test.mjs; headline extraction fixtures live in
 * packages/source-fetch/src/metadata.test.ts. This file is the API-side behaviour only.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';

import { AiService } from './ai/service.js';
import { CoreRepository, type Actor } from './core/repository.js';
import { type Database, pgliteDatabase } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';
import { StreamsRepository } from './streams/repository.js';

const NOXAVA: Actor = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' };
const SZRON: Actor = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' };

interface AutoDraftConfigLike { enabled: boolean; dailyLimit: number }

interface Fixture { db: Database; core: CoreRepository; ai: AiService }

/** A fresh database plus a `CoreRepository` wired to the capture-draft hook exactly as
 * `registerCoreRoutes` wires it, under the given guard config. */
async function fixture(config: AutoDraftConfigLike = { enabled: true, dailyLimit: 50 }): Promise<Fixture> {
  const db = pgliteDatabase(await PGlite.create());
  await migrate(db);
  await seedUsers(db, [NOXAVA, SZRON]);
  const ai = new AiService(db);
  const core = new CoreRepository(db, (tx, actor, reel) => ai.enqueueCaptureDraft(tx, actor, reel, config));
  return { db, core, ai };
}

const capture = (over: Record<string, unknown> = {}) => ({
  operationId: randomUUID(),
  reelId: randomUUID(),
  input: { text: 'Notatka z przechwycenia', images: [] as unknown[] },
  ...over,
});

async function captureRuns(db: Database, reelId: string) {
  const rows = await db.query<{ id: string; action: string; trigger: string; state: string }>(
    "select id, action, trigger, state from app.ai_runs where reel_id=$1 and trigger='capture'", [reelId],
  );
  return rows.rows;
}

const DEVELOP_RESULT = {
  titleSuggestion: 'Propozycja tytułu AI', eventSummary: 'Podsumowanie', verificationIssues: [] as string[],
  hookAdditions: ['Nowy hook AI'], scriptSuggestion: 'Nowy skrypt zaproponowany przez AI.',
  possibleProgrammeConnection: null, prioritySuggestion: null, memeSuggestion: null,
};

// ══════════════════════ Acceptance 3: enqueue and its guards ══════════════════════

test('capture enqueues exactly one trigger=capture develop run in the same transaction', async () => {
  const { db, core } = await fixture();
  try {
    const reel = await core.createReel(NOXAVA, capture() as never);
    const runs = await captureRuns(db, reel.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].action, 'develop');
    assert.equal(runs[0].state, 'queued');
    assert.equal(reel.autoDraft?.runId, runs[0].id);
    assert.equal(reel.autoDraft?.state, 'queued');
    assert.equal(reel.autoDraft?.titleSuggestion, null);
  } finally { await db.close(); }
});

test('an idempotent replay enqueues no additional draft', async () => {
  const { db, core } = await fixture();
  try {
    const request = capture();
    const first = await core.createReel(NOXAVA, request as never);
    const replay = await core.createReel(NOXAVA, request as never);
    assert.equal(replay.id, first.id);
    assert.equal((await captureRuns(db, request.reelId)).length, 1);
  } finally { await db.close(); }
});

test('AI_AUTO_DRAFT_ENABLED off enqueues nothing; capture still succeeds', async () => {
  const { db, core } = await fixture({ enabled: false, dailyLimit: 50 });
  try {
    const reel = await core.createReel(NOXAVA, capture() as never);
    assert.equal(reel.autoDraft, null);
    assert.equal((await captureRuns(db, reel.id)).length, 0);
  } finally { await db.close(); }
});

test('the daily limit blocks further captures once reached; capture still succeeds', async () => {
  const { db, core } = await fixture({ enabled: true, dailyLimit: 1 });
  try {
    const first = await core.createReel(NOXAVA, capture() as never);
    assert.equal((await captureRuns(db, first.id)).length, 1);

    const second = await core.createReel(NOXAVA, capture() as never);
    assert.equal(second.autoDraft, null);
    assert.equal((await captureRuns(db, second.id)).length, 0);
  } finally { await db.close(); }
});

test('the daily limit counts only runs created since the start of the Europe/Warsaw day', async () => {
  const db = pgliteDatabase(await PGlite.create());
  await migrate(db);
  await seedUsers(db, [NOXAVA, SZRON]);
  try {
    const ai = new AiService(db);
    // No hook: this Reel holds no capture draft of its own, so it can host a fabricated
    // "yesterday" run without tripping the one-capture-draft-per-Reel unique index.
    const quiet = new CoreRepository(db);
    const host = await quiet.createReel(NOXAVA, capture() as never);

    // created_at is immutable on UPDATE (the ai_runs_immutable_input trigger), so an
    // already-elapsed day has to be set at INSERT time.
    await db.query(
      `insert into app.ai_runs
         (id, reel_id, requested_by, action, trigger, input_snapshot, input_hash, model, prompt_id, prompt_stage, created_at)
       values ($1,$2,$3,'develop','capture','{}'::jsonb,$4,'m','p','development_provisional', now() - interval '2 days')`,
      [randomUUID(), host.id, NOXAVA.id, 'a'.repeat(64)],
    );

    const limited = new CoreRepository(db, (tx, actor, reel) => ai.enqueueCaptureDraft(tx, actor, reel, { enabled: true, dailyLimit: 1 }));
    const fresh = await limited.createReel(NOXAVA, capture() as never);
    assert.equal(
      (await captureRuns(db, fresh.id)).length, 1,
      "yesterday's fabricated run must not count toward today's limit",
    );
  } finally { await db.close(); }
});

test('a stream never gets a capture draft', async () => {
  const { db, core } = await fixture();
  try {
    const stream = await core.createReel(NOXAVA, {
      operationId: randomUUID(), reelId: randomUUID(), input: { images: [] }, format: 'stream', title: 'Strumień',
    } as never);
    assert.equal(stream.autoDraft, null);
    assert.equal((await captureRuns(db, stream.id)).length, 0);
  } finally { await db.close(); }
});

test('a new stream topic (+ Nowy temat) never gets a capture draft', async () => {
  const { db, core } = await fixture();
  try {
    const streams = new StreamsRepository(db, core);
    const stream = await core.createReel(NOXAVA, {
      operationId: randomUUID(), reelId: randomUUID(), input: { images: [] }, format: 'stream', title: 'Strumień',
    } as never);
    const topicId = randomUUID();
    const reelId = randomUUID();
    await streams.addTopic(NOXAVA, stream.id, {
      operationId: randomUUID(), expectedVersion: stream.version, mode: 'new',
      topicId, reelId, title: 'Nowy temat', link: 'https://example.com/a', note: 'Kontekst',
    } as never);
    assert.equal((await captureRuns(db, reelId)).length, 0);
  } finally { await db.close(); }
});

// ══════════════════════ Acceptance 4: results never auto-apply ══════════════════════

test('auto-draft results never change title/script/selectedHookId/priority; hooks are appended unselected; Detail "Użyj" still applies the title with a version check', async () => {
  const { db, core, ai } = await fixture();
  try {
    const reel0 = await core.createReel(NOXAVA, capture({ initialHook: 'Hook autora' }) as never);
    const runId = (await captureRuns(db, reel0.id))[0].id;

    // Simulate the worker completing the capture-triggered develop run, including appending
    // an AI hook alternative — exactly what a user-requested develop run also does.
    await db.query(
      "update app.ai_runs set state='succeeded', result=$2, completed_at=now() where id=$1",
      [runId, JSON.stringify(DEVELOP_RESULT)],
    );
    await db.query(
      "insert into app.reel_hooks (id, reel_id, text, source, position) values ($1,$2,$3,'ai',1)",
      [randomUUID(), reel0.id, 'Nowy hook AI'],
    );

    const after = await core.getReel(reel0.id);
    assert.equal(after.title, '', 'title is untouched by the auto-draft result');
    assert.equal(after.script, '', 'script is untouched');
    assert.equal(after.selectedHookId, null, 'no hook is auto-selected');
    assert.equal(after.priority, 'normal', 'priority is untouched');
    assert.equal(after.hooks.some((hook) => hook.text === 'Nowy hook AI' && hook.source === 'ai'), true, 'the AI hook is appended');
    assert.equal(after.autoDraft?.state, 'succeeded');
    assert.equal(after.autoDraft?.titleSuggestion, 'Propozycja tytułu AI');

    // The Detail "Użyj" action is the existing apply('title'), unchanged by this task.
    const applied = await ai.apply(NOXAVA, runId, {
      operationId: randomUUID(), expectedVersion: after.version, selection: 'title', text: 'Propozycja tytułu AI',
    });
    assert.equal(applied.title, 'Propozycja tytułu AI');

    // The version check still guards it: a stale expectedVersion is refused.
    await assert.rejects(
      ai.apply(NOXAVA, runId, { operationId: randomUUID(), expectedVersion: applied.version, selection: 'title', text: 'Inny tytuł' }),
      (error: { code?: string }) => error.code === 'STALE_FACT_CLAIM', // the title has already changed since the snapshot
    );
  } finally { await db.close(); }
});

// ══════════════════════ Acceptance 5: Reel.autoDraft state ══════════════════════

test('Reel.autoDraft reflects queued, running and succeeded, and goes stale on a live edit', async () => {
  const { db, core } = await fixture();
  try {
    const reel0 = await core.createReel(NOXAVA, capture() as never);
    const runId = (await captureRuns(db, reel0.id))[0].id;
    assert.equal((await core.getReel(reel0.id)).autoDraft?.state, 'queued');

    await db.query(
      "update app.ai_runs set state='running', lease_token=$2, lease_expires_at=now() + interval '1 minute' where id=$1",
      [runId, randomUUID()],
    );
    const running = await core.getReel(reel0.id);
    assert.equal(running.autoDraft?.state, 'running');
    assert.equal(running.autoDraft?.titleSuggestion, null);

    await db.query(
      "update app.ai_runs set state='succeeded', result=$2, completed_at=now(), lease_token=null, lease_expires_at=null where id=$1",
      [runId, JSON.stringify(DEVELOP_RESULT)],
    );
    let reel = await core.getReel(reel0.id);
    assert.equal(reel.autoDraft?.state, 'succeeded');
    assert.equal(reel.autoDraft?.titleSuggestion, 'Propozycja tytułu AI');
    assert.equal(reel.autoDraft?.isStale, false);

    // A live edit that no longer matches the run's own snapshot makes it stale, without
    // changing its state — exactly as for a user-requested run.
    reel = await core.patchReel(NOXAVA, reel0.id, {
      operationId: randomUUID(), expectedVersion: reel.version, changes: { script: 'Inny skrypt' },
    });
    assert.equal(reel.autoDraft?.isStale, true);
    assert.equal(reel.autoDraft?.state, 'succeeded');
  } finally { await db.close(); }
});

test('a failed capture draft carries no title suggestion', async () => {
  const { db, core } = await fixture();
  try {
    const reel0 = await core.createReel(NOXAVA, capture() as never);
    const runId = (await captureRuns(db, reel0.id))[0].id;
    await db.query(
      "update app.ai_runs set state='failed', error=$2, completed_at=now() where id=$1",
      [runId, JSON.stringify({ code: 'PROVIDER_UNAVAILABLE', message: 'Dostawca niedostępny' })],
    );
    const reel = await core.getReel(reel0.id);
    assert.equal(reel.autoDraft?.state, 'failed');
    assert.equal(reel.autoDraft?.titleSuggestion, null);
  } finally { await db.close(); }
});

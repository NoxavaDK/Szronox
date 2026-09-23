/**
 * HOOKS-SELECT-EDIT: one explicit, optional selected hook per Reel, against PGlite.
 *
 * PGlite runs the committed migrations on real PostgreSQL, so the composite foreign key and
 * its ON DELETE SET NULL action genuinely fire here. Like core.test.ts it has a single
 * connection: overlapping sessions are exercised as stale-version interleavings, and the
 * database-level reference is asserted directly so no interleaving can bypass it.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';

import { AiService } from './ai/service.js';
import { sessionHarness } from './auth/test-support.js';
import { CoreError } from './core/errors.js';
import { CoreRepository } from './core/repository.js';
import { memoryStorageAdapter } from './core/storage.js';
import { type Database, pgliteDatabase } from './db/client.js';
import { defaultMigrationsDir, migrate, seedUsers } from './db/migrate.js';

const NOXAVA = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' as const };
const SZRON = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' as const };

async function fixture(): Promise<{ db: Database; repo: CoreRepository }> {
  const db = pgliteDatabase(await PGlite.create());
  await migrate(db);
  await seedUsers(db, [NOXAVA, SZRON]);
  return { db, repo: new CoreRepository(db) };
}

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

/** A Reel with an initial user hook plus two more hooks, as capture and add create them. */
async function reelWithHooks(repo: CoreRepository, texts = ['Pierwszy', 'Drugi', 'Trzeci']) {
  const reelId = randomUUID();
  let reel = await repo.createReel(NOXAVA, {
    operationId: randomUUID(), reelId, input: { text: 'Notatka', images: [] }, initialHook: texts[0],
  });
  for (const text of texts.slice(1)) {
    reel = (await repo.addHook(NOXAVA, reelId, { operationId: randomUUID(), expectedVersion: reel.version, text })).reel;
  }
  return reel;
}

const select = (repo: CoreRepository, reel: { id: string; version: number }, hookId: string | null, operationId = randomUUID()) =>
  repo.selectHook(NOXAVA, reel.id, { operationId, expectedVersion: reel.version, hookId });

test('capture and hook addition never select; null selection is valid with zero or many hooks', async () => {
  const { db, repo } = await fixture();
  try {
    const empty = await repo.createReel(NOXAVA, { operationId: randomUUID(), reelId: randomUUID(), input: { text: 'Bez hooka', images: [] } });
    assert.equal(empty.selectedHookId, null);
    assert.equal(empty.hooks.length, 0);
    const reel = await reelWithHooks(repo);
    assert.equal(reel.hooks.length, 3);
    assert.equal(reel.selectedHookId, null, 'the initial user hook is not selected automatically');
    assert.equal((await repo.getReel(reel.id)).selectedHookId, null);
    // Clearing an already-empty selection is a valid explicit mutation.
    assert.equal((await select(repo, empty, null)).selectedHookId, null);
  } finally { await db.close(); }
});

test('select any hook, switch to another, and read it back from detail and list', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await reelWithHooks(repo);
    const [first, second, third] = reel.hooks;
    const picked = await select(repo, reel, second.id);
    assert.equal(picked.selectedHookId, second.id);
    assert.equal(picked.version, reel.version + 1);
    assert.equal(picked.scriptRevision, reel.scriptRevision, 'selection is not a script change');
    assert.deepEqual(picked.hooks, reel.hooks, 'hooks, provenance and order are untouched');

    const switched = await select(repo, picked, third.id);
    assert.equal(switched.selectedHookId, third.id);
    assert.equal((await repo.getReel(reel.id)).selectedHookId, third.id);
    const listed = (await repo.listReels({})).items.find((item) => item.id === reel.id);
    assert.equal(listed?.selectedHookId, third.id);

    // The selected text is always the referenced row's text; there is no second copy.
    const own = await select(repo, switched, first.id);
    assert.equal(own.hooks.find((hook) => hook.id === own.selectedHookId)?.source, 'user',
      'a selected own hook keeps user provenance');
    const cleared = await select(repo, own, null);
    assert.equal(cleared.selectedHookId, null);
    assert.equal(cleared.hooks.length, 3);
  } finally { await db.close(); }
});

test('unknown, deleted and other-Reel hooks cannot be selected', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await reelWithHooks(repo);
    const other = await reelWithHooks(repo, ['Obcy']);
    await expectCode(() => select(repo, reel, randomUUID()), 'NOT_FOUND', 404);
    await expectCode(() => select(repo, reel, other.hooks[0].id), 'NOT_FOUND', 404);

    const removed = await repo.removeHook(NOXAVA, reel.id, reel.hooks[1].id, { operationId: randomUUID(), expectedVersion: reel.version });
    await expectCode(() => select(repo, removed, reel.hooks[1].id), 'NOT_FOUND', 404);

    // A refused selection is rolled back entirely: no version bump, no ledger entry.
    const after = await repo.getReel(reel.id);
    assert.equal(after.version, removed.version);
    assert.equal(after.selectedHookId, null);

    // The database itself refuses the reference, whatever path writes it.
    await assert.rejects(db.query('update app.reels set selected_hook_id = $1 where id = $2', [other.hooks[0].id, reel.id]),
      (error: { code?: string }) => error.code === '23503');
    await assert.rejects(db.query('update app.reels set selected_hook_id = $1 where id = $2', [randomUUID(), reel.id]),
      (error: { code?: string }) => error.code === '23503');
  } finally { await db.close(); }
});

test('selection is version-checked, idempotent and refused on a deleted Reel', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await reelWithHooks(repo);
    const [first, second] = reel.hooks;
    const operationId = randomUUID();
    const original = await select(repo, reel, first.id, operationId);

    const conflict = await expectCode(() => select(repo, reel, second.id), 'EDIT_CONFLICT', 409);
    assert.equal(conflict.toEnvelope().error.currentVersion, original.version);

    // Same operation and payload replays the recorded result, even after a later change.
    const later = await select(repo, original, second.id);
    const replay = await repo.selectHook(NOXAVA, reel.id, { operationId, expectedVersion: reel.version, hookId: first.id });
    assert.deepEqual(replay, original);
    assert.equal((await repo.getReel(reel.id)).selectedHookId, second.id, 'a replay does not re-apply');
    // Reusing the ID with another payload is an idempotency conflict, as on every route.
    await expectCode(() => repo.selectHook(NOXAVA, reel.id, { operationId, expectedVersion: reel.version, hookId: second.id }),
      'IDEMPOTENCY_CONFLICT', 409);

    const deleted = await repo.setDeleted(NOXAVA, reel.id, { operationId: randomUUID(), expectedVersion: later.version }, true);
    await expectCode(() => select(repo, deleted, first.id), 'NOT_FOUND', 404);
  } finally { await db.close(); }
});

test('delete of an unselected hook keeps the selection; delete of the selected one clears it', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await reelWithHooks(repo);
    const [first, second, third] = reel.hooks;
    const picked = await select(repo, reel, second.id);

    const keep = await repo.removeHook(NOXAVA, reel.id, third.id, { operationId: randomUUID(), expectedVersion: picked.version });
    assert.equal(keep.selectedHookId, second.id);

    const clear = await repo.removeHook(NOXAVA, reel.id, second.id, { operationId: randomUUID(), expectedVersion: keep.version });
    assert.equal(clear.selectedHookId, null, 'no replacement is guessed');
    assert.deepEqual(clear.hooks.map((hook) => hook.id), [first.id]);
    assert.equal(clear.version, keep.version + 1, 'clearing is part of the same versioned delete');
  } finally { await db.close(); }
});

test('interleaved select and delete on one version leave no dangling selection', async () => {
  const { db, repo } = await fixture();
  try {
    // Delete lands first: the selection written against the old version is refused.
    const a = await reelWithHooks(repo);
    await repo.removeHook(NOXAVA, a.id, a.hooks[0].id, { operationId: randomUUID(), expectedVersion: a.version });
    await expectCode(() => select(repo, a, a.hooks[0].id), 'EDIT_CONFLICT', 409);
    assert.equal((await repo.getReel(a.id)).selectedHookId, null);

    // Selection lands first: the stale delete is refused, and a fresh delete clears it.
    const b = await reelWithHooks(repo);
    const picked = await select(repo, b, b.hooks[0].id);
    await expectCode(() => repo.removeHook(NOXAVA, b.id, b.hooks[0].id, { operationId: randomUUID(), expectedVersion: b.version }),
      'EDIT_CONFLICT', 409);
    assert.equal((await repo.getReel(b.id)).selectedHookId, b.hooks[0].id);
    const removed = await repo.removeHook(NOXAVA, b.id, b.hooks[0].id, { operationId: randomUUID(), expectedVersion: picked.version });
    assert.equal(removed.selectedHookId, null);

    // Whatever path deletes the row, the reference cannot outlive it.
    const c = await reelWithHooks(repo);
    await select(repo, c, c.hooks[2].id);
    await db.query('delete from app.reel_hooks where id = $1', [c.hooks[2].id]);
    assert.equal((await repo.getReel(c.id)).selectedHookId, null);
  } finally { await db.close(); }
});

test('editing selected and unselected hooks keeps ID, provenance, position and selection', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await reelWithHooks(repo);
    const picked = await select(repo, reel, reel.hooks[0].id);
    const editedSelected = await repo.editHook(NOXAVA, reel.id, reel.hooks[0].id,
      { operationId: randomUUID(), expectedVersion: picked.version, text: 'Pierwszy poprawiony' });
    const editedOther = await repo.editHook(NOXAVA, reel.id, reel.hooks[2].id,
      { operationId: randomUUID(), expectedVersion: editedSelected.version, text: 'Trzeci poprawiony' });
    assert.equal(editedOther.selectedHookId, reel.hooks[0].id);
    assert.deepEqual(editedOther.hooks.map(({ id, source, position, createdAt }) => ({ id, source, position, createdAt })),
      reel.hooks.map(({ id, source, position, createdAt }) => ({ id, source, position, createdAt })));
    assert.deepEqual(editedOther.hooks.map((hook) => hook.text), ['Pierwszy poprawiony', 'Drugi', 'Trzeci poprawiony']);
    assert.equal(editedOther.scriptRevision, reel.scriptRevision);

    // A stale edit is refused without touching the text.
    await expectCode(() => repo.editHook(NOXAVA, reel.id, reel.hooks[0].id,
      { operationId: randomUUID(), expectedVersion: picked.version, text: 'Za późno' }), 'EDIT_CONFLICT', 409);
    assert.equal((await repo.getReel(reel.id)).hooks[0].text, 'Pierwszy poprawiony');
  } finally { await db.close(); }
});

test('the worker hook append leaves the selection alone', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await reelWithHooks(repo);
    const picked = await select(repo, reel, reel.hooks[1].id);
    // The exact statements jobs.ts runs when a generate_hooks/develop run appends.
    await db.query("insert into app.reel_hooks(id,reel_id,text,source,position) values($1,$2,'Nowy AI','ai',3)", [randomUUID(), reel.id]);
    await db.query('update app.reels set version=version+1,updated_at=now() where id=$1', [reel.id]);
    const after = await repo.getReel(reel.id);
    assert.equal(after.hooks.length, 4);
    assert.equal(after.selectedHookId, picked.selectedHookId);
  } finally { await db.close(); }
});

test('AI runs snapshot the selection; fact check keeps all hooks; selecting does not stale a run', async () => {
  const { db, repo } = await fixture();
  try {
    const service = new AiService(db);
    const reel = await reelWithHooks(repo);
    const picked = await select(repo, reel, reel.hooks[2].id);

    const develop = await service.enqueue(NOXAVA, reel.id, { operationId: randomUUID(), expectedVersion: picked.version, action: 'develop' });
    const developRun = await service.get(NOXAVA, develop.id);
    assert.equal(developRun.input.selectedHookId, reel.hooks[2].id);
    assert.equal(developRun.input.hooks.length, 3, 'the full shortlist is still snapshotted');

    const check = await service.enqueue(NOXAVA, reel.id, { operationId: randomUUID(), expectedVersion: picked.version, action: 'fact_check' });
    assert.deepEqual((await service.get(NOXAVA, check.id)).input.hooks.map((hook) => hook.id), reel.hooks.map((hook) => hook.id));

    // Choosing another candidate afterwards does not block explicit Zastosuj of the proposal.
    await select(repo, picked, reel.hooks[0].id);
    assert.equal((await service.get(NOXAVA, develop.id)).isStale, false);
    assert.equal((await service.get(NOXAVA, check.id)).isStale, false);

    // A run recorded before this correction has no selectedHookId and stays readable.
    const legacyId = randomUUID();
    await db.query(`insert into app.ai_runs (id,reel_id,requested_by,action,input_snapshot,input_hash,model,prompt_id,prompt_stage)
      select $2,reel_id,requested_by,action,input_snapshot - 'selectedHookId',input_hash,model,
             'gemini-02-development-provisional-v2',prompt_stage from app.ai_runs where id = $1`, [develop.id, legacyId]);
    const legacy = await service.get(NOXAVA, legacyId);
    assert.equal(legacy.input.selectedHookId, undefined);
    assert.equal(legacy.isStale, false);
  } finally { await db.close(); }
});

test('migration 0010 keeps every existing Reel unselected, including Reels with hooks', async () => {
  const db = pgliteDatabase(await PGlite.create());
  const staged = await mkdtemp(path.join(tmpdir(), 'szronox-migrations-'));
  try {
    const all = (await readdir(defaultMigrationsDir())).filter((name) => name.endsWith('.sql')).sort();
    for (const name of all.filter((name) => name < '0010')) await copyFile(path.join(defaultMigrationsDir(), name), path.join(staged, name));
    await migrate(db, staged);
    await seedUsers(db, [NOXAVA, SZRON]);
    const reelId = randomUUID();
    await db.query("insert into app.reels(id,original_input,created_by) values($1,'{}',$2)", [reelId, NOXAVA.id]);
    await db.query("insert into app.reel_hooks(id,reel_id,text,source,position) values($1,$2,'Stary','user',0)", [randomUUID(), reelId]);

    const applied = await migrate(db);
    assert.deepEqual(applied.filter((item) => !item.alreadyApplied).map((item) => item.name), ['0010_selected_hook.sql']);
    const row = (await db.query<{ selected_hook_id: string | null; version: number }>(
      'select selected_hook_id, version from app.reels where id = $1', [reelId])).rows[0];
    assert.deepEqual(row, { selected_hook_id: null, version: 1 });
    assert.equal((await migrate(db)).every((item) => item.alreadyApplied), true);
  } finally {
    await rm(staged, { recursive: true, force: true });
    await db.close();
  }
});

test('the selection route is authenticated, validated and returns the authoritative Reel', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerCoreRoutes } = await import('./core/routes.js');
  const { db, repo } = await fixture();
  const harness = sessionHarness(db);
  const app = Fastify({ logger: false });
  harness.register(app);
  registerCoreRoutes(app, {
    db, storage: memoryStorageAdapter(), authenticate: harness.authenticate,
    allowlist: [{ ...NOXAVA, avatarUrl: null }, { ...SZRON, avatarUrl: null }],
  });
  await app.ready();
  try {
    const session = await harness.issue(SZRON.id);
    const reel = await reelWithHooks(repo);
    const url = `/api/v1/reels/${reel.id}/selected-hook`;
    const put = (payload: unknown, headers = harness.headers(session, 'PUT')) =>
      app.inject({ method: 'PUT', url, headers, payload: payload as never });

    assert.equal((await app.inject({ method: 'PUT', url, payload: { operationId: randomUUID(), expectedVersion: reel.version, hookId: null } })).statusCode, 401);
    const missing = await put({ operationId: randomUUID(), expectedVersion: reel.version });
    assert.equal(missing.statusCode, 422);
    const malformed = await put({ operationId: randomUUID(), expectedVersion: reel.version, hookId: 'nie-uuid' });
    assert.equal(malformed.json().error.code, 'VALIDATION_ERROR');
    const unknown = await put({ operationId: randomUUID(), expectedVersion: reel.version, hookId: randomUUID() });
    assert.equal(unknown.statusCode, 404);

    const ok = await put({ operationId: randomUUID(), expectedVersion: reel.version, hookId: reel.hooks[1].id });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().selectedHookId, reel.hooks[1].id);
    assert.equal(ok.json().version, reel.version + 1);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/reels/${reel.id}`, headers: harness.headers(session, 'GET') });
    assert.equal(detail.json().selectedHookId, reel.hooks[1].id);

    const stale = await put({ operationId: randomUUID(), expectedVersion: reel.version, hookId: reel.hooks[0].id });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'EDIT_CONFLICT');
  } finally {
    await app.close();
    await db.close();
  }
});

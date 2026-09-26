/**
 * CONTENT-PLANNER-01: the publication plan is two nullable columns on the Reel, written only
 * through the ordinary version-checked PATCH. These tests pin that it is one state per Reel
 * (never a second record), that the time is optional detail of a date, that planning never
 * moves status, and that migration 0011 leaves every existing Reel valid and unplanned.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';

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

async function newReel(repo: CoreRepository) {
  return repo.createReel(NOXAVA, {
    operationId: randomUUID(), reelId: randomUUID(), input: { text: 'Pomysł', images: [] },
  } as never);
}

async function expectValidation(body: () => Promise<unknown>): Promise<void> {
  await assert.rejects(body, (error) => error instanceof CoreError && error.code === 'VALIDATION_ERROR');
}

test('a new Reel is unplanned', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await newReel(repo);
    assert.equal(reel.plannedPublicationDate, null);
    assert.equal(reel.plannedPublicationSlot, null);
  } finally { await db.close(); }
});

test('a date alone is a valid plan; the slot is optional; status and scriptRevision are untouched', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await newReel(repo);
    const planned = await repo.patchReel(NOXAVA, reel.id, {
      operationId: randomUUID(), expectedVersion: reel.version, changes: { plannedPublicationDate: '2026-09-28' },
    });
    assert.equal(planned.plannedPublicationDate, '2026-09-28');
    assert.equal(planned.plannedPublicationSlot, null);
    assert.equal(planned.status, reel.status);
    assert.equal(planned.scriptRevision, reel.scriptRevision);
    assert.equal(planned.version, reel.version + 1);

    const timed = await repo.patchReel(NOXAVA, reel.id, {
      operationId: randomUUID(), expectedVersion: planned.version, changes: { plannedPublicationSlot: 'evening' },
    });
    assert.equal(timed.plannedPublicationSlot, 'evening');
    // Persisted: an independent read sees the same plan (the "reload" case).
    const reread = await repo.getReel(reel.id);
    assert.equal(reread.plannedPublicationDate, '2026-09-28');
    assert.equal(reread.plannedPublicationSlot, 'evening');
  } finally { await db.close(); }
});

test('moving a Reel changes its one plan; no second Reel or record appears', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await newReel(repo);
    const first = await repo.patchReel(NOXAVA, reel.id, {
      operationId: randomUUID(), expectedVersion: reel.version,
      changes: { plannedPublicationDate: '2026-09-28', plannedPublicationSlot: 'morning' },
    });
    const moved = await repo.patchReel(SZRON, reel.id, {
      operationId: randomUUID(), expectedVersion: first.version, changes: { plannedPublicationDate: '2026-10-01' },
    });
    assert.equal(moved.plannedPublicationDate, '2026-10-01');
    assert.equal(moved.plannedPublicationSlot, 'morning', 'moving the day keeps an explicit slot');
    const count = await db.query<{ n: number }>('select count(*)::int as n from app.reels');
    assert.equal(count.rows[0].n, 1);
    const list = await repo.listReels({});
    assert.deepEqual(list.items.map((item) => [item.id, item.plannedPublicationDate]), [[reel.id, '2026-10-01']]);
  } finally { await db.close(); }
});

test('clearing the date unschedules completely, including the slot', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await newReel(repo);
    const planned = await repo.patchReel(NOXAVA, reel.id, {
      operationId: randomUUID(), expectedVersion: reel.version,
      changes: { plannedPublicationDate: '2026-09-28', plannedPublicationSlot: 'evening' },
    });
    const cleared = await repo.patchReel(NOXAVA, reel.id, {
      operationId: randomUUID(), expectedVersion: planned.version, changes: { plannedPublicationDate: null },
    });
    assert.equal(cleared.plannedPublicationDate, null);
    assert.equal(cleared.plannedPublicationSlot, null);
    assert.equal(cleared.status, reel.status);
  } finally { await db.close(); }
});

test('invalid plans are refused and change nothing', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await newReel(repo);
    const attempt = (changes: Record<string, unknown>) => () => repo.patchReel(NOXAVA, reel.id, {
      operationId: randomUUID(), expectedVersion: reel.version, changes,
    });
    await expectValidation(attempt({ plannedPublicationSlot: 'morning' }));
    await expectValidation(attempt({ plannedPublicationDate: null, plannedPublicationSlot: 'morning' }));
    await expectValidation(attempt({ plannedPublicationDate: '2026-02-30' }));
    await expectValidation(attempt({ plannedPublicationDate: '28.09.2026' }));
    await expectValidation(attempt({ plannedPublicationDate: '2026-09-28T10:00:00Z' }));
    await expectValidation(attempt({ plannedPublicationDate: 20260928 }));
    // Only the three slots exist: no free clock time, no other label.
    await expectValidation(attempt({ plannedPublicationDate: '2026-09-28', plannedPublicationSlot: '18:30' }));
    await expectValidation(attempt({ plannedPublicationDate: '2026-09-28', plannedPublicationSlot: 'night' }));
    await expectValidation(attempt({ plannedPublicationDate: '2026-09-28', plannedPublicationSlot: 'Wieczór' }));
    // The former free-time field is no longer writable at all.
    await expectValidation(attempt({ plannedPublicationDate: '2026-09-28', plannedPublicationTime: '18:30' }));
    const after = await repo.getReel(reel.id);
    assert.equal(after.version, reel.version);
    assert.equal(after.plannedPublicationDate, null);
    // The schema holds the same invariant for any writer that bypasses the API.
    // A slot without a date cannot be stored: the trigger drops it (so a writer that only knows
    // the date, like the previous release, can still unschedule) and nothing dangles.
    await db.query("update app.reels set planned_publication_slot = 'morning' where id = $1", [reel.id]);
    assert.equal((await repo.getReel(reel.id)).plannedPublicationSlot, null);
    await db.query("update app.reels set planned_publication_date = '2026-09-28', planned_publication_slot = 'evening' where id = $1", [reel.id]);
    await db.query('update app.reels set planned_publication_date = null where id = $1', [reel.id]);
    assert.equal((await db.query<{ s: string | null }>('select planned_publication_slot as s from app.reels where id = $1', [reel.id])).rows[0].s, null);
    await assert.rejects(db.query("update app.reels set planned_publication_date = '2026-09-28', planned_publication_slot = 'noon' where id = $1", [reel.id]));
  } finally { await db.close(); }
});

test('a plan change is version-checked like every other patch', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await newReel(repo);
    await repo.patchReel(NOXAVA, reel.id, { operationId: randomUUID(), expectedVersion: reel.version, changes: { title: 'A' } });
    await assert.rejects(
      repo.patchReel(SZRON, reel.id, { operationId: randomUUID(), expectedVersion: reel.version, changes: { plannedPublicationDate: '2026-09-28' } }),
      (error) => error instanceof CoreError && error.code === 'EDIT_CONFLICT',
    );
  } finally { await db.close(); }
});

test('planning a published Reel is allowed and does not reopen it', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await newReel(repo);
    const published = await repo.patchReel(NOXAVA, reel.id, {
      operationId: randomUUID(), expectedVersion: reel.version, changes: { status: 'published', feedCoverDone: true },
    });
    const planned = await repo.patchReel(NOXAVA, reel.id, {
      operationId: randomUUID(), expectedVersion: published.version, changes: { plannedPublicationDate: '2026-09-25' },
    });
    assert.equal(planned.status, 'published');
  } finally { await db.close(); }
});

test('the plan round-trips over HTTP PATCH and GET', async () => {
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
    const session = await harness.issue(NOXAVA.id);
    const reel = await newReel(repo);
    const patched = await app.inject({
      method: 'PATCH', url: `/api/v1/reels/${reel.id}`, headers: harness.headers(session, 'PATCH'),
      payload: { operationId: randomUUID(), expectedVersion: reel.version, changes: { plannedPublicationDate: '2026-09-30', plannedPublicationSlot: 'morning' } },
    });
    assert.equal(patched.statusCode, 200);
    const read = await app.inject({ method: 'GET', url: `/api/v1/reels/${reel.id}`, headers: harness.headers(session, 'GET') });
    assert.equal(read.json().plannedPublicationDate, '2026-09-30');
    assert.equal(read.json().plannedPublicationSlot, 'morning');
    const bad = await app.inject({
      method: 'PATCH', url: `/api/v1/reels/${reel.id}`, headers: harness.headers(session, 'PATCH'),
      payload: { operationId: randomUUID(), expectedVersion: patched.json().version, changes: { plannedPublicationDate: 'jutro' } },
    });
    assert.equal(bad.statusCode, 422);
  } finally {
    await app.close();
    await db.close();
  }
});

test('migration 0011 leaves every existing Reel valid and unplanned', async () => {
  const db = pgliteDatabase(await PGlite.create());
  const staged = await mkdtemp(path.join(tmpdir(), 'szronox-migrations-'));
  try {
    const all = (await readdir(defaultMigrationsDir())).filter((name) => name.endsWith('.sql')).sort();
    assert.ok(all.includes('0011_planned_publication.sql'));
    for (const name of all.filter((name) => name < '0011')) await copyFile(path.join(defaultMigrationsDir(), name), path.join(staged, name));
    await migrate(db, staged);
    await seedUsers(db, [NOXAVA, SZRON]);
    const reelId = randomUUID();
    await db.query("insert into app.reels(id,original_input,created_by,status) values($1,'{}',$2,'ready')", [reelId, NOXAVA.id]);

    await copyFile(path.join(defaultMigrationsDir(), '0011_planned_publication.sql'), path.join(staged, '0011_planned_publication.sql'));
    const applied = await migrate(db, staged);
    assert.deepEqual(applied.filter((item) => !item.alreadyApplied).map((item) => item.name), ['0011_planned_publication.sql']);
    await migrate(db);
    const reel = await new CoreRepository(db).getReel(reelId);
    assert.equal(reel.plannedPublicationDate, null);
    assert.equal(reel.plannedPublicationSlot, null);
    assert.equal(reel.version, 1);
    assert.equal(reel.status, 'ready');
  } finally {
    await rm(staged, { recursive: true, force: true });
    await db.close();
  }
});

test('migration 0012 converts any recorded time to its slot and clears the time', async () => {
  const db = pgliteDatabase(await PGlite.create());
  const staged = await mkdtemp(path.join(tmpdir(), 'szronox-migrations-'));
  try {
    const all = (await readdir(defaultMigrationsDir())).filter((name) => name.endsWith('.sql')).sort();
    for (const name of all.filter((name) => name < '0012')) await copyFile(path.join(defaultMigrationsDir(), name), path.join(staged, name));
    await migrate(db, staged);
    await seedUsers(db, [NOXAVA, SZRON]);
    const rows: Array<[string, string | null, string | null]> = [
      [randomUUID(), '2026-09-28', '08:00'], [randomUUID(), '2026-09-28', '11:59'], [randomUUID(), '2026-09-28', '12:00'],
      [randomUUID(), '2026-09-28', '16:59'], [randomUUID(), '2026-09-28', '17:00'], [randomUUID(), '2026-09-28', '23:30'],
      [randomUUID(), '2026-09-28', null], [randomUUID(), null, null],
    ];
    for (const [id, date, time] of rows) {
      await db.query('insert into app.reels(id,original_input,created_by,planned_publication_date,planned_publication_time) values($1,$2,$3,$4,$5)',
        [id, '{}', NOXAVA.id, date, time]);
    }
    const applied = await migrate(db);
    assert.deepEqual(applied.filter((item) => !item.alreadyApplied).map((item) => item.name), ['0012_publication_slot.sql']);
    const repo = new CoreRepository(db);
    const slots = [];
    for (const [id] of rows) slots.push((await repo.getReel(id)).plannedPublicationSlot);
    assert.deepEqual(slots, ['morning', 'morning', 'afternoon', 'afternoon', 'evening', 'evening', null, null]);
    const leftover = await db.query<{ n: number }>('select count(*)::int as n from app.reels where planned_publication_time is not null');
    assert.equal(leftover.rows[0].n, 0);
    const reel = await repo.getReel(rows[0][0]);
    assert.equal(reel.plannedPublicationDate, '2026-09-28');
    assert.equal(reel.version, 1, 'conversion is not a user edit');
  } finally {
    await rm(staged, { recursive: true, force: true });
    await db.close();
  }
});

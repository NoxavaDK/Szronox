/*
 * Real PostgreSQL evidence harness.
 *
 * Two independent node-postgres pools and the production
 * CoreRepository/pgPoolDatabase boundary. Not a PGlite test, and it does not fake
 * simultaneous writes by sequencing one connection.
 *
 * VPS-04 strengthened the race evidence. The previous version launched both writers with
 * `Promise.all` and asserted that exactly one won — a real outcome, but not proof of a
 * race: the two transactions may simply have run one after the other. Independent
 * connections show the writers *could* overlap, not that they *did*.
 *
 * The version-conflict and idempotency cases now hold the first writer inside its open
 * transaction and ask PostgreSQL, from a third connection, whether the second writer is
 * blocked on it (`pg_blocking_pids`). Only after the server confirms the contention is
 * the first writer released. If the overlap is never observed the harness fails, because
 * the assertion it would otherwise fall back to is the one that was insufficient.
 *
 * Execution remains the VPS-06 gate. Without a reachable PostgreSQL this file prints an
 * explicit UNVERIFIED line and claims nothing.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

import { pgPoolDatabase } from '../../dist/db/client.js';
import { migrate, seedUsers } from '../../dist/db/migrate.js';
import { CoreError } from '../../dist/core/errors.js';
import { CoreRepository } from '../../dist/core/repository.js';
import { withProvenOverlap } from './overlap.mjs';

const NOXAVA = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' };
const SZRON = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' };

const hasDatabaseConfig = process.env.DATABASE_URL || process.env.DATABASE_HOST;
if (!hasDatabaseConfig) {
  console.log('UNVERIFIED: database connection is not configured; real PostgreSQL harness was not run.');
  process.exit(0);
}

const databasePassword = process.env.DATABASE_PASSWORD_FILE
  ? await readFile(process.env.DATABASE_PASSWORD_FILE, 'utf8').then((value) => value.trim())
  : process.env.DATABASE_PASSWORD;
const databaseOptions = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT ?? 5432),
      database: process.env.DATABASE_NAME,
      user: process.env.DATABASE_USER,
      password: databasePassword,
    };

const poolA = new Pool({
  ...databaseOptions,
  max: 4,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
  lock_timeout: 10_000,
  idle_in_transaction_session_timeout: 60_000,
});
const poolB = new Pool({
  ...databaseOptions,
  max: 4,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
  lock_timeout: 10_000,
  idle_in_transaction_session_timeout: 60_000,
});

// A third pool, used only to ask PostgreSQL about the other two. It must be separate:
// an observer sharing a pool with a paused writer could be handed that writer's own
// blocked connection and would then wait forever.
const poolObserver = new Pool({
  ...databaseOptions,
  max: 2,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
  lock_timeout: 10_000,
  idle_in_transaction_session_timeout: 60_000,
});

const dbA = pgPoolDatabase(poolA);
const dbObserver = pgPoolDatabase(poolObserver);
const dbB = pgPoolDatabase(poolB);
const repoA = new CoreRepository(dbA);
const repoB = new CoreRepository(dbB);
const testReelIds = [];
const testOperationIds = [];

const capture = (reelId = randomUUID(), text = 'VPS-03 harness capture') => ({
  operationId: randomUUID(),
  reelId,
  input: { text, images: [] },
});

function codeOf(error) {
  return error instanceof CoreError ? error.code : error?.code;
}

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.equal(codeOf(error), code, `expected ${code}, got ${String(error)}`);
    return;
  }
  assert.fail(`expected ${code}`);
}

async function main() {
  // Two migration jobs overlap on purpose. The runner's advisory lock makes this
  // safe even when both pools are connected at the same time.
  const migrationResults = await Promise.all([migrate(dbA), migrate(dbB)]);
  assert.equal(migrationResults.length, 2);
  assert.deepEqual(migrationResults[0].map(({ name }) => name), ['0001_core_schema.sql', '0002_script_revision.sql', '0003_vps_auth.sql', '0004_vps_storage.sql']);
  assert.deepEqual(migrationResults[1].map(({ name }) => name), ['0001_core_schema.sql', '0002_script_revision.sql', '0003_vps_auth.sql', '0004_vps_storage.sql']);
  assert.deepEqual((await migrate(dbA)).map(({ alreadyApplied }) => alreadyApplied), [true, true, true, true]);

  await seedUsers(dbA, [NOXAVA, SZRON]);
  const pids = await Promise.all([
    dbA.query('select pg_backend_pid() as pid'),
    dbB.query('select pg_backend_pid() as pid'),
  ]);
  assert.notEqual(pids[0].rows[0].pid, pids[1].rows[0].pid, 'API and worker probes must use different sessions');

  // ── Version conflict, with the overlap proven ────────────────────────────────
  //
  // Writer A is paused after its guarded UPDATE, transaction open and row lock held.
  // Writer B's identical guarded UPDATE must then block on that lock; the observer
  // confirms it from a third connection before A is released. That is what makes the
  // single-winner outcome below evidence of a race rather than of two sequential writes.
  const race = capture();
  testReelIds.push(race.reelId);
  testOperationIds.push(race.operationId);
  const created = await repoA.createReel(NOXAVA, race);
  const raceOperationA = randomUUID();
  const raceOperationB = randomUUID();
  testOperationIds.push(raceOperationA, raceOperationB);

  const versionRace = await withProvenOverlap({
    firstDatabase: dbA,
    secondDatabase: dbB,
    observer: dbObserver,
    // The statement that takes the row lock. Matched on the guard itself, so an
    // unrelated select cannot be mistaken for it.
    pauseAfter: (sql) => /update app\.reels set /i.test(sql) && /version = \$/i.test(sql),
    firstWriter: (db) => new CoreRepository(db).patchReel(NOXAVA, race.reelId, {
      operationId: raceOperationA, expectedVersion: created.version, changes: { title: 'winner A' },
    }),
    secondWriter: (db) => new CoreRepository(db).patchReel(SZRON, race.reelId, {
      operationId: raceOperationB, expectedVersion: created.version, changes: { title: 'winner B' },
    }),
  });
  const raceResults = [versionRace.first, versionRace.second];
  assert.equal(raceResults.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(raceResults.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(codeOf(raceResults.find((result) => result.status === 'rejected').reason), 'EDIT_CONFLICT');
  assert.equal((await repoA.getReel(race.reelId)).version, created.version + 1);
  // The server's own account of the contention, recorded rather than assumed.
  assert.equal(versionRace.overlap.waitEventType, 'Lock', JSON.stringify(versionRace.overlap));
  console.log(`  overlap: ${JSON.stringify(versionRace.overlap)}`);

  // ── Idempotency ledger conflict, with the overlap proven ─────────────────────
  //
  // Same operation id and payload from two sessions. Writer A is paused after its ledger
  // insert, so its transaction holds both the uncommitted Reel row and the uncommitted
  // ledger row. Writer B blocks on whichever primary key it reaches first — the Reel row,
  // since `createReel` inserts it before the ledger — and the observer records the actual
  // wait. When A commits, B's insert raises a unique violation, the replay guard finds
  // A's recorded result, and B returns it. One domain effect and one replay is then a
  // demonstrated property of the constraint, not a timing accident.
  const duplicate = capture();
  testReelIds.push(duplicate.reelId);
  testOperationIds.push(duplicate.operationId);
  const duplicateRace = await withProvenOverlap({
    firstDatabase: dbA,
    secondDatabase: dbB,
    observer: dbObserver,
    pauseAfter: (sql) => /insert into app\.operations/i.test(sql),
    firstWriter: (db) => new CoreRepository(db).createReel(NOXAVA, duplicate),
    secondWriter: (db) => new CoreRepository(db).createReel(NOXAVA, duplicate),
  });
  const duplicateResults = [duplicateRace.first, duplicateRace.second];
  assert.deepEqual(duplicateResults.map((result) => result.status).sort(), ['fulfilled', 'fulfilled']);
  const duplicateCount = await dbA.query('select count(*)::int as count from app.reels where id = $1', [duplicate.reelId]);
  assert.equal(duplicateCount.rows[0].count, 1);
  assert.equal(duplicateRace.overlap.waitEventType, 'Lock', JSON.stringify(duplicateRace.overlap));
  console.log(`  overlap: ${JSON.stringify(duplicateRace.overlap)}`);

  // Reusing the operation id with a different payload is rejected.
  await expectCode(
    repoB.createReel(NOXAVA, { ...duplicate, input: { text: 'different payload', images: [] } }),
    'IDEMPOTENCY_CONFLICT',
  );

  // An exception after both a domain row and ledger row are staged rolls back
  // both writes together. This is deliberately a disposable transaction probe.
  const rollbackReelId = randomUUID();
  const rollbackOperationId = randomUUID();
  await assert.rejects(dbA.transaction(async (tx) => {
    await tx.query(
      'insert into app.reels (id, original_input, created_by) values ($1, $2, $3)',
      [rollbackReelId, JSON.stringify({ text: 'rollback', images: [] }), NOXAVA.id],
    );
    await tx.query(
      `insert into app.operations (operation_id, actor_id, route, payload_hash, result)
       values ($1, $2, 'harness/rollback', 'hash', '{}')`,
      [rollbackOperationId, NOXAVA.id],
    );
    throw new Error('intentional rollback probe');
  }), /intentional rollback probe/);
  const rollbackRows = await dbA.query(
    `select
       (select count(*) from app.reels where id = $1)::int as reels,
       (select count(*) from app.operations where operation_id = $2)::int as operations`,
    [rollbackReelId, rollbackOperationId],
  );
  assert.deepEqual(rollbackRows.rows[0], { reels: 0, operations: 0 });

  console.log('PASS: real PostgreSQL migrations, independent pools, PROVEN-OVERLAP version race, PROVEN-OVERLAP idempotency race, payload conflict, rollback');
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND') || message.includes('timeout')) {
    console.error(`UNVERIFIED: disposable PostgreSQL is unavailable (${message})`);
  } else {
    console.error(`FAIL: ${message}`);
  }
  process.exitCode = 1;
} finally {
  if (testReelIds.length > 0) {
    await dbA.query('delete from app.reels where id = any($1::uuid[])', [testReelIds]).catch(() => undefined);
  }
  if (testOperationIds.length > 0) {
    await dbA.query('delete from app.operations where operation_id = any($1::uuid[])', [testOperationIds]).catch(() => undefined);
  }
  await Promise.all([poolA.end(), poolB.end(), poolObserver.end()]);
}

/*
 * VPS-03 real PostgreSQL evidence harness.
 *
 * This file intentionally uses two independent node-postgres pools and the
 * production CoreRepository/pgPoolDatabase boundary. It is not a PGlite test,
 * and it does not fake simultaneous writes by sequencing one connection.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

import { pgPoolDatabase } from '../../dist/db/client.js';
import { migrate, seedUsers } from '../../dist/db/migrate.js';
import { CoreError } from '../../dist/core/errors.js';
import { CoreRepository } from '../../dist/core/repository.js';

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

const dbA = pgPoolDatabase(poolA);
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
  assert.deepEqual(migrationResults[0].map(({ name }) => name), ['0001_core_schema.sql', '0002_script_revision.sql']);
  assert.deepEqual(migrationResults[1].map(({ name }) => name), ['0001_core_schema.sql', '0002_script_revision.sql']);
  assert.deepEqual((await migrate(dbA)).map(({ alreadyApplied }) => alreadyApplied), [true, true]);

  await seedUsers(dbA, [NOXAVA, SZRON]);
  const pids = await Promise.all([
    dbA.query('select pg_backend_pid() as pid'),
    dbB.query('select pg_backend_pid() as pid'),
  ]);
  assert.notEqual(pids[0].rows[0].pid, pids[1].rows[0].pid, 'API and worker probes must use different sessions');

  // Overlapping writers against one expected version: PostgreSQL row locking
  // leaves exactly one UPDATE match and one authoritative conflict.
  const race = capture();
  testReelIds.push(race.reelId);
  testOperationIds.push(race.operationId);
  const created = await repoA.createReel(NOXAVA, race);
  const raceOperationA = randomUUID();
  const raceOperationB = randomUUID();
  const writes = [
    repoA.patchReel(NOXAVA, race.reelId, {
      operationId: raceOperationA, expectedVersion: created.version, changes: { title: 'winner A' },
    }),
    repoB.patchReel(SZRON, race.reelId, {
      operationId: raceOperationB, expectedVersion: created.version, changes: { title: 'winner B' },
    }),
  ];
  testOperationIds.push(raceOperationA, raceOperationB);
  const raceResults = await Promise.allSettled(writes);
  assert.equal(raceResults.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(raceResults.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(codeOf(raceResults.find((result) => result.status === 'rejected').reason), 'EDIT_CONFLICT');
  assert.equal((await repoA.getReel(race.reelId)).version, created.version + 1);

  // Same operation and payload concurrently: one domain effect, one replay.
  const duplicate = capture();
  testReelIds.push(duplicate.reelId);
  testOperationIds.push(duplicate.operationId);
  const duplicateResults = await Promise.allSettled([
    repoA.createReel(NOXAVA, duplicate),
    repoB.createReel(NOXAVA, duplicate),
  ]);
  assert.deepEqual(duplicateResults.map((result) => result.status).sort(), ['fulfilled', 'fulfilled']);
  const duplicateCount = await dbA.query('select count(*)::int as count from app.reels where id = $1', [duplicate.reelId]);
  assert.equal(duplicateCount.rows[0].count, 1);

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

  console.log('PASS: real PostgreSQL migrations, independent pools, version race, idempotency race, payload conflict, rollback');
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
  await Promise.all([poolA.end(), poolB.end()]);
}

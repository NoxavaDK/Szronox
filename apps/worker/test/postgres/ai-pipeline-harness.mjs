/** Run only against a disposable PostgreSQL database, never a populated DEV database. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { claimNext, finishRun } from '../../dist/ai/jobs.js';

if (process.env.AI_TEST_DISPOSABLE !== 'yes' || process.env.DATABASE_NAME !== 'ai_pipeline_disposable') {
  throw new Error('AI_TEST_DISPOSABLE=yes and DATABASE_NAME=ai_pipeline_disposable are required');
}

const pool = new Pool({ host: process.env.DATABASE_HOST, port: Number(process.env.DATABASE_PORT ?? 5432),
  database: process.env.DATABASE_NAME, user: process.env.DATABASE_USER, password: process.env.DATABASE_PASSWORD,
  max: 4, connectionTimeoutMillis: 5000 });
const migrationRoot = new URL('../../../../database/migrations/', import.meta.url);
const userId = randomUUID();
const reelId = randomUUID();

async function run(action = 'generate_hooks') {
  const id = randomUUID();
  const snapshot = { memeCandidates: [], script: 'Tekst.', hooks: [], reelVersion: 1 };
  await pool.query(`insert into app.ai_runs
    (id,reel_id,requested_by,action,input_snapshot,input_hash,model,prompt_id,prompt_stage)
    values($1,$2,$3,$4,$5,$6,'gemini-3.8-flash','test','development_provisional')`,
  [id, reelId, userId, action, JSON.stringify(snapshot), 'a'.repeat(64)]);
  return id;
}

try {
  for (const file of ['0001_core_schema.sql', '0002_script_revision.sql', '0003_vps_auth.sql',
    '0004_vps_storage.sql', '0005_ai_pipeline.sql']) {
    await pool.query(await readFile(new URL(file, migrationRoot), 'utf8'));
  }
  await pool.query("insert into app.users(id,name) values($1,'NOXAVA')", [userId]);
  await pool.query('insert into app.reels(id,original_input,created_by) values($1,$2,$3)',
    [reelId, JSON.stringify({ text: 'Test.' }), userId]);

  const firstId = await run();
  const [claimA, claimB] = await Promise.all([claimNext(pool), claimNext(pool)]);
  assert.equal([claimA, claimB].filter(Boolean).length, 1, 'one claim across competing workers');
  const first = claimA ?? claimB;
  assert.equal(first.id, firstId);
  assert.equal(await finishRun(pool, first, { result: { hookAdditions: ['A', 'B'] }, warnings: [], provenance: {} }), true);
  assert.equal(await finishRun(pool, first, { result: { hookAdditions: ['C'] }, warnings: [], provenance: {} }), false);
  const hooks = await pool.query('select text,position from app.reel_hooks where reel_id=$1 order by position', [reelId]);
  assert.deepEqual(hooks.rows, [{ text: 'A', position: 0 }, { text: 'B', position: 1 }], 'hooks append once');

  const secondId = await run();
  const old = await claimNext(pool);
  assert.equal(old.id, secondId);
  await pool.query("update app.ai_runs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1", [secondId]);
  assert.equal(await finishRun(pool, old, { result: { hookAdditions: ['late'] }, warnings: [], provenance: {} }), false,
    'expired owner cannot finalize');
  const replacement = await claimNext(pool);
  assert.equal(replacement.id, secondId);
  assert.notEqual(replacement.lease_token, old.lease_token);
  assert.equal(await finishRun(pool, old, { result: { hookAdditions: ['late'] }, warnings: [], provenance: {} }), false,
    'stale token is fenced');
  assert.equal(await finishRun(pool, replacement, { result: { hookAdditions: ['fresh'] }, warnings: [], provenance: {} }), true);
  const finalHooks = await pool.query('select text from app.reel_hooks where reel_id=$1 order by position', [reelId]);
  assert.deepEqual(finalHooks.rows.map((row) => row.text), ['A', 'B', 'fresh']);

  const thirdId = await run();
  await assert.rejects(pool.query("update app.ai_runs set input_snapshot='{}'::jsonb where id=$1", [thirdId]),
    /AI run input is immutable/);
  process.stdout.write('PASS: concurrent claim, append-once, expired lease, stale token, immutable snapshot\n');
} finally {
  await pool.end();
}

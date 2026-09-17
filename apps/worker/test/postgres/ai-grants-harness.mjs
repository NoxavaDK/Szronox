/** Role-grant assertion against a fresh, disposable PostgreSQL database only. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { composeWorkerRuntime } from '../../dist/runtime.js';

if (process.env.AI_TEST_DISPOSABLE !== 'yes' || process.env.DATABASE_NAME !== 'ai_pipeline_disposable') {
  throw new Error('AI_TEST_DISPOSABLE=yes and DATABASE_NAME=ai_pipeline_disposable are required');
}
const env = process.env;
const owner = new Pool({ host: env.DATABASE_HOST, database: env.DATABASE_NAME, user: 'postgres', max: 2 });
try {
  await owner.query('create role szronox_api login');
  await owner.query('create role szronox_worker login');
  const migrationRoot = new URL('../../../../database/migrations/', import.meta.url);
  for (const file of ['0001_core_schema.sql', '0002_script_revision.sql', '0003_vps_auth.sql',
    '0004_vps_storage.sql', '0005_ai_pipeline.sql']) {
    await owner.query(await readFile(new URL(file, migrationRoot), 'utf8'));
  }
  await owner.query('create table public.schema_migrations (id text primary key)');
  await owner.query(await readFile(new URL('../../../../deploy/vps/postgres/grants.sql', import.meta.url), 'utf8'));

  const runtime = await composeWorkerRuntime({ DATABASE_HOST: env.DATABASE_HOST,
    DATABASE_NAME: env.DATABASE_NAME, DATABASE_USER: 'szronox_worker', DATABASE_PASSWORD: 'disposable-trust',
    APP_ENFORCE_DB_PRIVILEGES: 'true', AI_ENABLED: 'false' });
  try {
    assert.deepEqual(runtime.privilegeViolations, []);
    await assert.rejects(runtime.pool.query('select * from app.user_credentials'), /permission denied/);
    await assert.rejects(runtime.pool.query("update app.reels set script='bad' where false"), /permission denied/);
    await runtime.pool.query("update app.ai_runs set state='queued' where false");
    await runtime.pool.query("insert into app.reel_hooks(id,reel_id,text,source,position) select null,null,null,null,null where false");
  } finally { await runtime.close(); }
  process.stdout.write('PASS: worker role starts with narrow AI grants and cannot read credentials or edit Reel script\n');
} finally { await owner.end(); }

/**
 * One-shot development migration entry point.
 *
 * The API and worker deliberately do not call this module during startup. The
 * Compose `migrate` service runs it before the API is allowed to start.
 */

import { readFile } from 'node:fs/promises';

import { Pool } from 'pg';

import { pgPoolDatabase } from './client.js';
import { migrate } from './migrate.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function password(): Promise<string> {
  const file = process.env.DATABASE_PASSWORD_FILE?.trim();
  if (file) return (await readFile(file, 'utf8')).trim();
  return required('DATABASE_PASSWORD');
}

const pool = new Pool({
  host: required('DATABASE_HOST'),
  port: Number(process.env.DATABASE_PORT ?? 5432),
  database: required('DATABASE_NAME'),
  user: required('DATABASE_USER'),
  password: await password(),
  max: 2,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
  lock_timeout: 10_000,
  idle_in_transaction_session_timeout: 60_000,
});

try {
  const db = pgPoolDatabase(pool);
  const applied = await migrate(db, process.env.MIGRATIONS_DIR);
  const appliedNow = applied.filter((entry) => !entry.alreadyApplied).map((entry) => entry.name);
  process.stdout.write(`Migration runner complete (${applied.length} files checked; ${appliedNow.length} applied)\n`);
  await db.close();
} catch (error) {
  await pool.end().catch(() => undefined);
  process.stderr.write(`Migration runner failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

/**
 * Migration runner.
 *
 * Applies `database/migrations/*.sql` in filename order and records each one, so a
 * second run is a no-op. The runner is deliberately independent from the API and
 * worker startup paths: Compose invokes the migration CLI as a one-shot job.
 *
 * A PostgreSQL advisory transaction lock serialises concurrent migration jobs. The
 * ledger check, SQL script and ledger insert run in one transaction, so a failed
 * file cannot be recorded as applied. The lock is intentionally on the same
 * transaction as the ledger work, which also makes the PGlite fallback honest.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Database } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository-root-relative migrations directory, resolved from the compiled file. */
export function defaultMigrationsDir(): string {
  // dist/db -> apps/api -> apps -> repository root
  return path.resolve(here, '../../../../database/migrations');
}

/** Stable lock key shared by every local/dev migration runner. */
export const MIGRATION_ADVISORY_LOCK_KEY = '735000031';

export interface AppliedMigration {
  name: string;
  alreadyApplied: boolean;
}

export async function migrate(
  db: Database,
  migrationsDir: string = defaultMigrationsDir(),
): Promise<AppliedMigration[]> {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  const applied: AppliedMigration[] = [];
  for (const name of files) {
    const result = await db.transaction(async (tx) => {
      // The ledger lives outside `app` on purpose: dropping the application schema
      // during development should not silently make migrations look unapplied.
      // The lock is held for this file's transaction, keeping the SQL script and
      // ledger insert atomic while serialising concurrent migration jobs.
      await tx.query('select pg_advisory_xact_lock($1::bigint)', [MIGRATION_ADVISORY_LOCK_KEY]);
      await tx.query(`
        create table if not exists public.schema_migrations (
          name       text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      const existing = await tx.query<{ name: string }>(
        'select name from public.schema_migrations where name = $1',
        [name],
      );
      if (existing.rows.length > 0) {
        return { name, alreadyApplied: true };
      }

      const sql = await readFile(path.join(migrationsDir, name), 'utf8');
      await tx.execScript(sql);
      await tx.query('insert into public.schema_migrations (name) values ($1)', [name]);
      return { name, alreadyApplied: false };
    });
    applied.push(result);
  }
  return applied;
}

/**
 * Seed the two allowlisted product users. Provisioning only — no signup, no
 * invitation, no hosted auth change. Ids are supplied so fixtures and tokens can
 * agree on them.
 */
export async function seedUsers(
  db: Database,
  users: Array<{ id: string; name: 'NOXAVA' | 'SZRON'; avatarUrl?: string | null }>,
): Promise<void> {
  for (const user of users) {
    await db.query(
      `insert into app.users (id, name, avatar_url) values ($1, $2, $3)
       on conflict (id) do update set name = excluded.name, avatar_url = excluded.avatar_url`,
      [user.id, user.name, user.avatarUrl ?? null],
    );
  }
}

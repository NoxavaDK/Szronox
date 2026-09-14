/**
 * Migration runner.
 *
 * Applies `supabase/migrations/*.sql` in filename order and records each one, so a
 * second run is a no-op. Deliberately minimal: the point is that the committed SQL
 * is what gets applied, with no ORM translating it into something else.
 *
 * Statements are executed as one script per file, inside a transaction, so a
 * partially-applied migration cannot be recorded as done.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Database } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository-root-relative migrations directory, resolved from the compiled file. */
export function defaultMigrationsDir(): string {
  // dist/db -> apps/api -> apps -> repo root
  return path.resolve(here, '../../../../supabase/migrations');
}

export interface AppliedMigration {
  name: string;
  alreadyApplied: boolean;
}

export async function migrate(
  db: Database,
  migrationsDir: string = defaultMigrationsDir(),
): Promise<AppliedMigration[]> {
  // The ledger lives outside `app` on purpose: dropping the application schema
  // during development should not silently make migrations look unapplied.
  await db.query(`
    create table if not exists public.schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  const applied: AppliedMigration[] = [];

  for (const name of files) {
    const existing = await db.query<{ name: string }>(
      'select name from public.schema_migrations where name = $1',
      [name],
    );
    if (existing.rows.length > 0) {
      applied.push({ name, alreadyApplied: true });
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, name), 'utf8');
    await db.transaction(async (tx) => {
      await tx.execScript(sql);
      await tx.query('insert into public.schema_migrations (name) values ($1)', [name]);
    });
    applied.push({ name, alreadyApplied: false });
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

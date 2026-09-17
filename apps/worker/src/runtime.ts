/**
 * Worker runtime composition.
 *
 * The worker is a second process against the same database, with its own bounded
 * pool, its own credentials and its own deliberately narrow grants. When enabled,
 * it dispatches the durable GEMINI-02 jobs through the AI module.
 *
 * The privilege assertion is the substantive part. A worker that can read
 * `app.user_credentials` or `app.auth_sessions` turns any compromise of background
 * processing into a compromise of both accounts' logins, so this process refuses to
 * start once it discovers it can.
 *
 * Duplication, stated rather than hidden: `apps/api/src/runtime/database.ts` and
 * `runtime/privileges.ts` answer the same questions for the API. The worker cannot
 * import them — `@szronox/worker` does not depend on `@szronox/api`, and adding that
 * dependency is a workspace-manifest change VPS-04 is not allowed to make. The two
 * copies are therefore kept intentionally small and are noted in VPS-04-result.md as
 * a shared-extraction candidate for root. The pool bounds and the privilege rules
 * below must stay in step with the API's until that extraction happens.
 */

import { readFile } from 'node:fs/promises';

import { Pool } from 'pg';
import { tickAi } from './ai/jobs.js';

export class WorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerConfigError';
  }
}

export class WorkerPrivilegeError extends Error {
  readonly violations: readonly string[];
  constructor(role: string, violations: readonly string[]) {
    super(`worker database role ${role} has privileges it must not have: ${violations.join('; ')}`);
    this.name = 'WorkerPrivilegeError';
    this.violations = violations;
  }
}

export interface WorkerEnv {
  DATABASE_HOST?: string;
  DATABASE_PORT?: string;
  DATABASE_NAME?: string;
  DATABASE_USER?: string;
  DATABASE_PASSWORD_FILE?: string;
  DATABASE_PASSWORD?: string;
  DATABASE_POOL_MAX?: string;
  WORKER_POLL_MS?: string;
  APP_ENFORCE_DB_PRIVILEGES?: string;
  AI_ENABLED?: string;
  GEMINI_API_KEY_FILE?: string;
  APP_STORAGE_ROOT?: string;
}

const present = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim() !== '';

export function databaseConfigured(env: WorkerEnv): boolean {
  return ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_USER',
    'DATABASE_PASSWORD_FILE', 'DATABASE_PASSWORD', 'DATABASE_POOL_MAX']
    .some((key) => present(env[key as keyof WorkerEnv]));
}

function required(env: WorkerEnv, key: 'DATABASE_HOST' | 'DATABASE_NAME' | 'DATABASE_USER'): string {
  if (!present(env[key])) throw new WorkerConfigError(`${key} is required`);
  return (env[key] as string).trim();
}

function bounded(raw: string | undefined, field: string, fallback: number, min: number, max: number): number {
  if (!present(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new WorkerConfigError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function boolish(raw: string | undefined, field: string, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') return fallback;
  if (value === 'false' || value === '0' || value === 'no') return false;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  throw new WorkerConfigError(`${field} must be true or false`);
}

/**
 * Read the password from a mounted file.
 *
 * A file readable only by this UID beats an environment variable, which is visible in
 * `/proc/<pid>/environ`, inherited by children and printed by anything that dumps the
 * environment. `DATABASE_PASSWORD` remains accepted for a throwaway local run only.
 */
async function resolvePassword(env: WorkerEnv): Promise<string> {
  if (present(env.DATABASE_PASSWORD_FILE) && present(env.DATABASE_PASSWORD)) {
    throw new WorkerConfigError('Set exactly one of DATABASE_PASSWORD_FILE or DATABASE_PASSWORD');
  }
  if (present(env.DATABASE_PASSWORD_FILE)) {
    const file = env.DATABASE_PASSWORD_FILE.trim();
    let raw: string;
    try { raw = await readFile(file, 'utf8'); }
    catch { throw new WorkerConfigError(`DATABASE_PASSWORD_FILE could not be read: ${file}`); }
    const value = raw.replace(/\r?\n$/, '');
    if (value === '') throw new WorkerConfigError('DATABASE_PASSWORD_FILE is empty');
    return value;
  }
  if (present(env.DATABASE_PASSWORD)) return env.DATABASE_PASSWORD;
  throw new WorkerConfigError('DATABASE_PASSWORD_FILE is required (DATABASE_PASSWORD is accepted only for a local run)');
}

export interface WorkerRuntime {
  pool: Pool;
  pollMs: number;
  role: string;
  privilegeViolations: readonly string[];
  privilegeEnforcement: 'enforced' | 'reported_only';
  describe(): Record<string, unknown>;
  /** Bounded, read-only transactional probe. Used at startup and by each tick. */
  probe(): Promise<void>;
  tick(): Promise<void>;
  close(): Promise<void>;
}

const FORBIDDEN_TABLES = ['app.user_credentials', 'app.auth_sessions'] as const;

/**
 * Ask PostgreSQL what this role may actually do.
 *
 * Reading the real grant state rather than trusting a configuration file is the only
 * check that catches "we pointed the worker at the owner role because it was
 * quicker". `has_table_privilege` with an explicit table raises on a missing table,
 * so a dropped table cannot masquerade as a revoked grant.
 */
async function privilegeViolations(pool: Pool): Promise<{ role: string; violations: string[] }> {
  const summary = await pool.query<{
    role: string; is_superuser: boolean; can_create_db: boolean;
    can_create_role: boolean; can_create_schema: boolean;
  }>(
    `select current_user as role,
            (select rolsuper from pg_roles where rolname = current_user) as is_superuser,
            (select rolcreatedb from pg_roles where rolname = current_user) as can_create_db,
            (select rolcreaterole from pg_roles where rolname = current_user) as can_create_role,
            pg_catalog.has_schema_privilege(current_user, 'app', 'CREATE') as can_create_schema`,
  );
  const row = summary.rows[0];
  const violations: string[] = [];
  if (row.is_superuser) violations.push('it is a superuser');
  if (row.can_create_db) violations.push('it has CREATEDB');
  if (row.can_create_role) violations.push('it has CREATEROLE');
  if (row.can_create_schema) violations.push('it may CREATE in schema app');

  for (const table of FORBIDDEN_TABLES) {
    const grants = await pool.query<{ any_access: boolean }>(
      `select (pg_catalog.has_table_privilege($1, 'SELECT')
            or pg_catalog.has_table_privilege($1, 'INSERT')
            or pg_catalog.has_table_privilege($1, 'UPDATE')
            or pg_catalog.has_table_privilege($1, 'DELETE')) as any_access`,
      [table],
    );
    if (grants.rows[0].any_access) violations.push(`it may access ${table}`);
  }
  const users = await pool.query<{ writes: boolean }>(
    `select (pg_catalog.has_table_privilege('app.users', 'INSERT')
          or pg_catalog.has_table_privilege('app.users', 'UPDATE')
          or pg_catalog.has_table_privilege('app.users', 'DELETE')) as writes`,
  );
  if (users.rows[0].writes) violations.push('it may write app.users');

  const ai = await pool.query<{ can_read: boolean; can_update: boolean; can_insert: boolean; can_delete: boolean }>(
    `select has_table_privilege('app.ai_runs','SELECT') as can_read,
            has_table_privilege('app.ai_runs','UPDATE') as can_update,
            has_table_privilege('app.ai_runs','INSERT') as can_insert,
            has_table_privilege('app.ai_runs','DELETE') as can_delete`);
  if (!ai.rows[0].can_read || !ai.rows[0].can_update) violations.push('it cannot process app.ai_runs');
  if (ai.rows[0].can_insert || ai.rows[0].can_delete) violations.push('it may create or delete AI runs');
  const domain = await pool.query<{ reels_unrelated_write: boolean; hooks_unrelated_write: boolean; programme_write: boolean }>(
    `select (has_column_privilege('app.reels','script','UPDATE')
             or has_column_privilege('app.reels','publication_description','UPDATE')
             or has_column_privilege('app.reels','original_input','UPDATE')) as reels_unrelated_write,
            (has_table_privilege('app.reel_hooks','UPDATE') or has_table_privilege('app.reel_hooks','DELETE')) as hooks_unrelated_write,
            (has_table_privilege('app.programme_versions','INSERT')
             or has_table_privilege('app.programme_proposals','UPDATE')
             or has_table_privilege('app.programme_chunks','DELETE')) as programme_write`);
  if (domain.rows[0].reels_unrelated_write) violations.push('it may rewrite Reel content');
  if (domain.rows[0].hooks_unrelated_write) violations.push('it may edit or delete hooks');
  if (domain.rows[0].programme_write) violations.push('it may alter approved programme evidence');
  return { role: row.role, violations };
}

export async function composeWorkerRuntime(env: WorkerEnv): Promise<WorkerRuntime> {
  const pollMs = bounded(env.WORKER_POLL_MS, 'WORKER_POLL_MS', 30_000, 1_000, 3_600_000);
  const enforce = boolish(env.APP_ENFORCE_DB_PRIVILEGES, 'APP_ENFORCE_DB_PRIVILEGES', true);
  const aiEnabled = boolish(env.AI_ENABLED, 'AI_ENABLED', false);
  if (aiEnabled && (!present(env.GEMINI_API_KEY_FILE) || !present(env.APP_STORAGE_ROOT))) {
    throw new WorkerConfigError('AI_ENABLED requires GEMINI_API_KEY_FILE and APP_STORAGE_ROOT');
  }
  // Two connections is enough for one tick plus a probe. A larger worker pool would
  // compete with the API for a small development server's connection slots.
  const pool = new Pool({
    host: required(env, 'DATABASE_HOST'),
    port: bounded(env.DATABASE_PORT, 'DATABASE_PORT', 5432, 1, 65535),
    database: required(env, 'DATABASE_NAME'),
    user: required(env, 'DATABASE_USER'),
    password: await resolvePassword(env),
    max: bounded(env.DATABASE_POOL_MAX, 'DATABASE_POOL_MAX', 2, 1, 8),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: 'szronox-worker',
    statement_timeout: 15_000,
    lock_timeout: 10_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  // Without this, a backend terminated by the server raises an unhandled 'error'
  // event on an idle client and takes the process down.
  pool.on('error', () => undefined);

  try {
    // A real statement, because a successful connect says nothing about whether this
    // role can execute anything.
    await pool.query('select 1 as ok');
    const { role, violations } = await privilegeViolations(pool);
    if (enforce && violations.length > 0) throw new WorkerPrivilegeError(role, violations);

    /**
     * Development-only transactional probe.
     *
     * A real transaction, so grants and transaction handling are exercised rather
     * than assumed, and a read only, so a poll tick can never mutate application
     * data. This is not a job claim: proving exactly-once work needs the AI
     * lifecycle, which is not implemented.
     */
    async function probe(): Promise<void> {
      const client = await pool.connect();
      try {
        await client.query('begin read only');
        const reels = await client.query<{ count: number }>('select count(*)::int as count from app.reels');
        await client.query('commit');
        if (typeof reels.rows[0]?.count !== 'number') throw new Error('worker probe returned no count');
      } catch (error) {
        await client.query('rollback').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }

    await probe();

    let closed = false;
    return {
      pool,
      pollMs,
      role,
      probe,
      async tick() {
        if (aiEnabled) await tickAi(pool, env);
        else await probe();
      },
      privilegeViolations: violations,
      privilegeEnforcement: enforce ? 'enforced' : 'reported_only',
      describe: () => ({
        database: {
          host: required(env, 'DATABASE_HOST'),
          database: required(env, 'DATABASE_NAME'),
          role,
          poolMax: bounded(env.DATABASE_POOL_MAX, 'DATABASE_POOL_MAX', 2, 1, 8),
          passwordSource: present(env.DATABASE_PASSWORD_FILE) ? 'file' : 'environment',
        },
        pollMs,
        privilegeEnforcement: enforce ? 'enforced' : 'reported_only',
        privilegeViolations: violations,
        aiLifecycle: aiEnabled ? 'enabled' : 'disabled',
      }),
      async close() {
        if (closed) return;
        closed = true;
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}

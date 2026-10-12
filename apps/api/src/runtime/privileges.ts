/**
 * Runtime privilege assertions.
 *
 * Grants live in the environment, not in the application, so the application cannot
 * grant itself anything. What it *can* do is refuse to run when it discovers it has
 * more authority than its job needs — which is the only check that actually catches
 * "we deployed the API as the database owner because it was quicker".
 *
 * Every assertion below is a question PostgreSQL answers about the connected role,
 * so it reflects the real grant state rather than a configuration file's intent.
 *
 * These are deliberately refusals rather than warnings. A warning in a log nobody
 * reads is how a superuser API survives to production.
 */

import type { Queryable } from '../db/client.js';

export class PrivilegeError extends Error {
  readonly violations: readonly string[];
  constructor(role: string, violations: readonly string[]) {
    super(`database role ${role} has privileges it must not have: ${violations.join('; ')}`);
    this.name = 'PrivilegeError';
    this.violations = violations;
  }
}

export interface RoleFacts {
  role: string;
  isSuperuser: boolean;
  canCreateDb: boolean;
  canCreateRole: boolean;
  canCreateInAppSchema: boolean;
  /** Per-table privileges the assertions below care about. */
  privileges: Record<string, { select: boolean; insert: boolean; update: boolean; delete: boolean }>;
}

const WATCHED_TABLES = [
  'app.users',
  'app.user_credentials',
  'app.auth_sessions',
  'app.reels',
  // STREAM-LIVE-01
  'app.live_messages',
  'app.access_keys',
  // STREAM-01
  'app.stream_topics',
] as const;

interface FactsRow {
  role: string;
  is_superuser: boolean;
  can_create_db: boolean;
  can_create_role: boolean;
  can_create_schema: boolean;
}

/**
 * Read what the connected role may do.
 *
 * `has_table_privilege` is used with the two-argument form so a missing table raises
 * rather than silently reporting `false` — a dropped table must not look like a
 * revoked grant.
 */
export async function readRoleFacts(db: Queryable): Promise<RoleFacts> {
  const summary = await db.query<FactsRow>(
    `select current_user as role,
            (select rolsuper from pg_roles where rolname = current_user) as is_superuser,
            (select rolcreatedb from pg_roles where rolname = current_user) as can_create_db,
            (select rolcreaterole from pg_roles where rolname = current_user) as can_create_role,
            pg_catalog.has_schema_privilege(current_user, 'app', 'CREATE') as can_create_schema`,
  );
  const row = summary.rows[0];
  const privileges: RoleFacts['privileges'] = {};
  for (const table of WATCHED_TABLES) {
    const grants = await db.query<{ s: boolean; i: boolean; u: boolean; d: boolean }>(
      `select pg_catalog.has_table_privilege($1, 'SELECT') as s,
              pg_catalog.has_table_privilege($1, 'INSERT') as i,
              pg_catalog.has_table_privilege($1, 'UPDATE') as u,
              pg_catalog.has_table_privilege($1, 'DELETE') as d`,
      [table],
    );
    const grant = grants.rows[0];
    privileges[table] = { select: grant.s, insert: grant.i, update: grant.u, delete: grant.d };
  }
  return {
    role: row.role,
    isSuperuser: row.is_superuser === true,
    canCreateDb: row.can_create_db === true,
    canCreateRole: row.can_create_role === true,
    canCreateInAppSchema: row.can_create_schema === true,
    privileges,
  };
}

/** Shared by both runtime processes: neither may administer the cluster or the schema. */
function baseViolations(facts: RoleFacts): string[] {
  const violations: string[] = [];
  if (facts.isSuperuser) violations.push('it is a superuser');
  if (facts.canCreateDb) violations.push('it has CREATEDB');
  if (facts.canCreateRole) violations.push('it has CREATEROLE');
  if (facts.canCreateInAppSchema) violations.push('it may CREATE in schema app');
  return violations;
}

/**
 * The API reads credentials to verify a password and writes sessions to issue and
 * revoke them. It must not be able to add, rename or remove a user: the two-user
 * roster is an operator decision, and an API that could rewrite `app.users` could
 * replace an identity and orphan every Reel that references it.
 */
export function apiPrivilegeViolations(facts: RoleFacts): string[] {
  const violations = baseViolations(facts);
  const users = facts.privileges['app.users'];
  if (users.insert) violations.push('it may INSERT into app.users');
  if (users.update) violations.push('it may UPDATE app.users');
  if (users.delete) violations.push('it may DELETE from app.users');
  const credentials = facts.privileges['app.user_credentials'];
  if (credentials.insert || credentials.update || credentials.delete) {
    violations.push('it may write app.user_credentials');
  }
  if (!credentials.select) violations.push('it cannot SELECT app.user_credentials, so no login can succeed');
  const sessions = facts.privileges['app.auth_sessions'];
  if (!sessions.select || !sessions.insert || !sessions.update) {
    violations.push('it cannot issue or revoke sessions in app.auth_sessions');
  }
  // STREAM-LIVE-01. Keys are minted and revoked by the operator only: an API that could insert
  // one could grant itself device access, and one that could update the row could un-revoke a
  // key. Its only write is the column grant on last_used_at, which has_table_privilege does not
  // report as table-level UPDATE.
  const live = facts.privileges['app.live_messages'];
  if (!live.select || !live.insert || !live.update) violations.push('it cannot use app.live_messages');
  const keys = facts.privileges['app.access_keys'];
  if (!keys.select) violations.push('it cannot SELECT app.access_keys, so no device can authenticate');
  if (keys.insert || keys.update || keys.delete) violations.push('it may mint, alter or delete app.access_keys');
  return violations;
}

/**
 * The worker never authenticates anybody, so it has no reason to read a password
 * hash or a session token digest. If it can, a compromise of the worker becomes a
 * compromise of both accounts.
 */
export function workerPrivilegeViolations(facts: RoleFacts): string[] {
  const violations = baseViolations(facts);
  // STREAM-01: STREAM-02 is what will give the worker any access to stream_topics.
  for (const table of ['app.user_credentials', 'app.auth_sessions', 'app.live_messages', 'app.access_keys', 'app.stream_topics'] as const) {
    const grant = facts.privileges[table];
    if (grant.select || grant.insert || grant.update || grant.delete) {
      violations.push(`it may access ${table}`);
    }
  }
  const users = facts.privileges['app.users'];
  if (users.insert || users.update || users.delete) violations.push('it may write app.users');
  return violations;
}

export type PrivilegeProfile = 'api' | 'worker';

/**
 * Assert and report.
 *
 * `enforce: false` exists for a single-role local run where a developer has not
 * created separate roles yet. It still reads and reports the facts, so the report
 * says plainly that separation was not verified rather than implying it was.
 */
export async function assertRolePrivileges(
  db: Queryable,
  profile: PrivilegeProfile,
  options: { enforce: boolean },
): Promise<{ facts: RoleFacts; violations: string[]; enforced: boolean }> {
  const facts = await readRoleFacts(db);
  const violations = profile === 'api' ? apiPrivilegeViolations(facts) : workerPrivilegeViolations(facts);
  if (options.enforce && violations.length > 0) throw new PrivilegeError(facts.role, violations);
  return { facts, violations, enforced: options.enforce };
}

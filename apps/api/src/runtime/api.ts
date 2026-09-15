/**
 * API composition root.
 *
 * Everything the process needs is built here, in one order, with one failure rule:
 * if a dependency is missing, unreadable or inconsistent, composition throws and the
 * process never listens. There is no partial mode in which the API serves domain
 * routes against a database it could not reach or a storage root it could not write.
 *
 * The order is not arbitrary:
 *
 *   1. Configuration is parsed first, so a typo fails before anything is opened.
 *   2. The pool is opened and a real statement is executed, so "the host resolves"
 *      is not mistaken for "we can query".
 *   3. Role privileges are asserted, so the API refuses to run as an identity that
 *      could rewrite the user roster or the credential table.
 *   4. `storage.initialize()` is awaited, so the private root's ownership, modes and
 *      writability are proven before an upload can be accepted.
 *   5. The two-user roster is asserted, so the API never serves a half-provisioned
 *      deployment where one account can never log in.
 *
 * Only then is readiness marked and the caller allowed to listen.
 *
 * `close()` drains in the reverse order and is safe to call twice, because the
 * shutdown path can be reached from a signal and from a startup failure.
 */

import { buildCoreDependencies, parseAllowlist, type CoreEnv } from '../core/config.js';
import { parseOrigins } from '../auth/config.js';
import { assertProvisioned } from '../auth/users.js';
import type { BuildAppOptions } from '../app.js';
import { openDatabase, type DatabaseEnv, type OpenDatabase, describeDatabase } from './database.js';
import { assertRolePrivileges, type RoleFacts } from './privileges.js';
import type { ProxyEnv } from './proxy.js';
import { runtimeReadiness, storageRootProbe, type ReadinessTracker } from './readiness.js';

export interface ApiRuntimeEnv extends CoreEnv, DatabaseEnv, ProxyEnv {
  /**
   * Refuse to start as an over-privileged database role. Defaults to on; the only
   * reason to turn it off is a single-role local run that has not created separate
   * identities yet, and the runtime reports when it was off.
   */
  APP_ENFORCE_DB_PRIVILEGES?: string;
}

export interface ApiRuntime {
  options: BuildAppOptions;
  readiness: ReadinessTracker;
  database: OpenDatabase;
  /** What was composed. Identities, bounds and modes; never a secret. */
  describe(): Record<string, unknown>;
  privileges: { role: string; violations: readonly string[]; enforced: boolean; facts: RoleFacts };
  close(): Promise<void>;
}

function enforcePrivileges(env: ApiRuntimeEnv): boolean {
  const raw = env.APP_ENFORCE_DB_PRIVILEGES?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  throw new Error('APP_ENFORCE_DB_PRIVILEGES must be true or false');
}

export async function composeApiRuntime(env: ApiRuntimeEnv): Promise<ApiRuntime> {
  // Parse the security boundary before opening a pool. APP_ORIGIN is required even
  // though storage and authentication both consume it later: a missing or malformed
  // value is a startup error, never something discovered after contacting PostgreSQL.
  const allowlist = parseAllowlist(env.APP_ALLOWLIST);
  parseOrigins(env.APP_ORIGIN);
  const database = await openDatabase(env, { poolMax: 6, applicationName: 'szronox-api' });

  try {
    // A real statement, not a connection callback: `connect` succeeding says nothing
    // about whether this role can execute anything.
    await database.db.query('select 1 as ok');

    const privileges = await assertRolePrivileges(database.db, 'api', { enforce: enforcePrivileges(env) });

    const core = buildCoreDependencies(database.db, env);
    // Awaited before listening, per the runtime contract: ownership, modes, the
    // same-filesystem requirement and an fsync probe all run here, not on the first
    // upload where the failure would surface as a user-visible error.
    await core.storage.initialize();

    // Compared, never written. The API cannot provision, so a mismatch is an
    // operator problem to fix with the provisioning command, not something to repair
    // silently at startup.
    const roster = await assertProvisioned(database.db, allowlist);

    const readiness = runtimeReadiness({
      db: database.db,
      expectedUsers: allowlist,
      probes: env.STORAGE_DRIVER === 'memory' || !env.APP_STORAGE_ROOT
        ? {}
        : { storage: storageRootProbe(env.APP_STORAGE_ROOT) },
      // The response carries only a code; the operator still needs the cause. VPS-06 found
      // /ready returning the driver's own message to unauthenticated public callers, so the
      // detail goes here instead of into the body.
      onFailure(check, detail) {
        process.stderr.write(`readiness check ${check} failed: ${detail}\n`);
      },
    });

    let closed = false;
    return {
      readiness,
      database,
      privileges: { ...privileges, role: privileges.facts.role },
      options: { auth: { service: core.auth.service }, core, readiness },
      describe: () => ({
        database: describeDatabase(database.settings),
        storage: env.STORAGE_DRIVER === 'memory' ? 'memory' : 'filesystem',
        storageRoot: env.APP_STORAGE_ROOT ?? null,
        origin: env.APP_ORIGIN ?? null,
        roster: roster.users.map((user) => ({ name: user.name, credentialSet: user.credentialSet })),
        databaseRole: privileges.facts.role,
        privilegeEnforcement: privileges.enforced ? 'enforced' : 'reported_only',
        privilegeViolations: privileges.violations,
      }),
      async close() {
        if (closed) return;
        closed = true;
        readiness.markStopping();
        await database.close();
      },
    };
  } catch (error) {
    // The pool is released even when composition fails, so a failed start does not
    // leave a connection held against a development database.
    await database.close().catch(() => undefined);
    throw error;
  }
}

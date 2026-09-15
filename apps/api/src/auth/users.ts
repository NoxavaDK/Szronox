/**
 * The two provisioned users and their credentials.
 *
 * Provisioning, never registration. The UUIDs are supplied by the operator and
 * must already exist; nothing in this module generates an id, so a deployment or a
 * login cannot replace NOXAVA's or SZRON's identity with a fresh one and silently
 * orphan every row that references it.
 *
 * `app.users` is constrained by 0001 to at most the two named rows (unique name
 * plus a two-value CHECK), so "exactly two rows" is the same statement as "both
 * NOXAVA and SZRON are provisioned".
 *
 * Passwords arrive as function arguments from an operator entry point that reads
 * them from protected input. Nothing here accepts a password from argv, writes one
 * to a log, or ships one as a fixture.
 */

import type { User } from '@szronox/contracts';

import type { Database } from '../db/client.js';
import type { PasswordHasher } from './passwords.js';

export class ProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

export interface ProvisionedUser {
  id: string;
  name: 'NOXAVA' | 'SZRON';
  avatarUrl: string | null;
}

interface UserRow { id: string; name: 'NOXAVA' | 'SZRON'; avatar_url: string | null }

/** Read the roster. Ordered by name so the pair is stable across calls. */
export async function loadUsers(db: Database): Promise<ProvisionedUser[]> {
  const result = await db.query<UserRow>('select id, name, avatar_url from app.users order by name');
  return result.rows.map((row) => ({ id: row.id, name: row.name, avatarUrl: row.avatar_url }));
}

export interface UserPair { user: User; peer: User }

/**
 * Resolve the signed-in user and the other one.
 *
 * The peer is not optional in `AuthSessionResponse`, so a roster that does not
 * contain exactly two rows is an error here rather than a response with a
 * fabricated or null peer.
 */
export async function userPair(db: Database, actorId: string): Promise<UserPair> {
  const users = await loadUsers(db);
  if (users.length !== 2) {
    throw new ProvisioningError(`expected exactly two provisioned users, found ${users.length}`);
  }
  const user = users.find((entry) => entry.id === actorId);
  const peer = users.find((entry) => entry.id !== actorId);
  if (!user || !peer) throw new ProvisioningError('the authenticated actor is not one of the provisioned users');
  return { user, peer };
}

export async function findUserByName(
  db: Database,
  name: 'NOXAVA' | 'SZRON',
): Promise<{ id: string; passwordHash: string | null } | null> {
  const result = await db.query<{ id: string; password_hash: string | null }>(
    `select u.id, c.password_hash
       from app.users u
       left join app.user_credentials c on c.user_id = u.id
      where u.name = $1`,
    [name],
  );
  const row = result.rows[0];
  return row ? { id: row.id, passwordHash: row.password_hash } : null;
}

/**
 * Set a provisioned user's password.
 *
 * The user row must already exist: an `insert` here would be the one place that
 * could invent a third identity or a replacement UUID, so the credential write is
 * an update against an existing id and nothing else.
 *
 * Live sessions for that account are revoked in the same transaction as the new
 * hash. A password change that left old cookies working would not be a password
 * change.
 */
export async function setPassword(
  db: Database,
  hasher: PasswordHasher,
  input: { userId: string; password: string },
): Promise<void> {
  const passwordHash = await hasher.hash(input.password);
  await db.transaction(async (tx) => {
    const existing = await tx.query<{ id: string }>('select id from app.users where id = $1', [input.userId]);
    if (existing.rows.length === 0) {
      throw new ProvisioningError('no provisioned user has that id; provision the user row first');
    }
    await tx.query(
      `insert into app.user_credentials (user_id, password_hash, updated_at)
       values ($1, $2, now())
       on conflict (user_id) do update set password_hash = excluded.password_hash, updated_at = now()`,
      [input.userId, passwordHash],
    );
    await tx.query(
      'update app.auth_sessions set revoked_at = now() where user_id = $1 and revoked_at is null',
      [input.userId],
    );
  });
}

/**
 * Provision exactly the two configured users, atomically.
 *
 * What "atomically" has to mean here, because a half-applied run is the dangerous
 * case: the roster insert, every credential write and every session revocation happen
 * in one transaction, serialised against a concurrent run by an advisory lock on the
 * same transaction. Either the deployment ends with two users who can both log in, or
 * it ends exactly as it started.
 *
 * Rerun safety is the second requirement. An ordinary rerun must not change anything
 * it does not have to:
 *
 *   - an existing user row keeps its UUID; the configured id is *compared*, and a
 *     mismatch aborts rather than rewriting the row, because replacing NOXAVA's id
 *     would orphan every Reel that references it;
 *   - an existing credential keeps its hash, so rerunning the command does not
 *     silently rotate a password and does not need one supplied;
 *   - sessions are revoked only for an account whose credential actually changed.
 *
 * Replacement is therefore explicit: an account only appears in `replace` when the
 * operator asked for it, and only those accounts lose their live sessions.
 */
export interface ProvisionPlanInput {
  /** The configured pair. Ids are supplied by the operator, never generated here. */
  allowlist: ReadonlyArray<{ id: string; name: 'NOXAVA' | 'SZRON' }>;
  /** Passwords for accounts being created or explicitly replaced. */
  passwords: Partial<Record<'NOXAVA' | 'SZRON', string>>;
  /** Accounts whose credential must be replaced even though one already exists. */
  replace?: ReadonlyArray<'NOXAVA' | 'SZRON'>;
}

export type ProvisionAction =
  /** The user row did not exist and was created with the configured id. */
  | 'user_created'
  /** The user row existed with the configured id and was left untouched. */
  | 'user_unchanged';

export type CredentialAction = 'credential_created' | 'credential_unchanged' | 'credential_replaced';

export interface ProvisionOutcome {
  name: 'NOXAVA' | 'SZRON';
  id: string;
  user: ProvisionAction;
  credential: CredentialAction;
  /** Live sessions revoked for this account. Non-zero only on replacement. */
  sessionsRevoked: number;
}

/** Shared by every provisioning run so two concurrent operators serialise. */
export const PROVISIONING_ADVISORY_LOCK_KEY = '735000047';

export async function provisionUsers(
  db: Database,
  hasher: PasswordHasher,
  input: ProvisionPlanInput,
): Promise<ProvisionOutcome[]> {
  const names = input.allowlist.map((entry) => entry.name);
  if (input.allowlist.length !== 2 || !names.includes('NOXAVA') || !names.includes('SZRON')) {
    throw new ProvisioningError('provisioning requires exactly the two configured users, NOXAVA and SZRON');
  }
  if (input.allowlist[0].id === input.allowlist[1].id) {
    throw new ProvisioningError('the two configured users must have distinct ids');
  }
  const replace = new Set(input.replace ?? []);
  for (const name of replace) {
    if (!names.includes(name)) throw new ProvisioningError(`${name} is not one of the configured users`);
  }

  // Hashing happens before the transaction opens. Argon2id is intentionally slow, and
  // holding a transaction — and its advisory lock — across two 19 MiB hashes would
  // block a concurrent operator for no reason.
  const hashes = new Map<'NOXAVA' | 'SZRON', string>();
  for (const [name, password] of Object.entries(input.passwords) as Array<['NOXAVA' | 'SZRON', string]>) {
    if (typeof password !== 'string' || password === '') continue;
    hashes.set(name, await hasher.hash(password));
  }

  return db.transaction(async (tx) => {
    await tx.query('select pg_advisory_xact_lock($1::bigint)', [PROVISIONING_ADVISORY_LOCK_KEY]);

    const existing = await tx.query<{ id: string; name: 'NOXAVA' | 'SZRON'; has_credential: boolean }>(
      `select u.id, u.name, (c.user_id is not null) as has_credential
         from app.users u
         left join app.user_credentials c on c.user_id = u.id`,
    );

    const outcomes: ProvisionOutcome[] = [];
    for (const configured of [...input.allowlist].sort((a, b) => a.name.localeCompare(b.name))) {
      const byName = existing.rows.find((row) => row.name === configured.name);
      const byId = existing.rows.find((row) => row.id === configured.id);

      // Both directions are checked. A configured id already belonging to the other
      // account is just as wrong as a configured name holding a different id, and
      // only one of the two checks would catch a swapped pair.
      if (byName && byName.id !== configured.id) {
        throw new ProvisioningError(
          `${configured.name} already exists with a different id; the stored id is authoritative `
          + 'and must not be replaced. Fix APP_ALLOWLIST to match the database.',
        );
      }
      if (byId && byId.name !== configured.name) {
        throw new ProvisioningError(
          `the id configured for ${configured.name} already belongs to ${byId.name}; `
          + 'refusing to reassign an existing identity',
        );
      }

      let userAction: ProvisionAction = 'user_unchanged';
      if (!byName) {
        await tx.query('insert into app.users (id, name) values ($1, $2)', [configured.id, configured.name]);
        userAction = 'user_created';
      }

      const hasCredential = byName?.has_credential === true;
      const supplied = hashes.get(configured.name);
      let credentialAction: CredentialAction = 'credential_unchanged';
      let sessionsRevoked = 0;

      if (!hasCredential) {
        if (supplied === undefined) {
          throw new ProvisioningError(
            `${configured.name} has no password set; supply one for this account to complete provisioning`,
          );
        }
        await tx.query(
          'insert into app.user_credentials (user_id, password_hash) values ($1, $2)',
          [configured.id, supplied],
        );
        credentialAction = 'credential_created';
      } else if (replace.has(configured.name)) {
        if (supplied === undefined) {
          throw new ProvisioningError(`replacement was requested for ${configured.name} but no password was supplied`);
        }
        await tx.query(
          'update app.user_credentials set password_hash = $2, updated_at = now() where user_id = $1',
          [configured.id, supplied],
        );
        // Only this account's sessions. A credential change that left old cookies
        // working would not be a credential change; revoking the peer's would be an
        // unasked-for logout.
        const revoked = await tx.query(
          'update app.auth_sessions set revoked_at = now() where user_id = $1 and revoked_at is null',
          [configured.id],
        );
        sessionsRevoked = revoked.rowCount;
        credentialAction = 'credential_replaced';
      } else if (supplied !== undefined) {
        // A password was supplied for an account that already has one, without asking
        // for replacement. Silently ignoring it would let an operator believe a
        // rotation happened; silently applying it would rotate a password nobody
        // asked to rotate.
        throw new ProvisioningError(
          `${configured.name} already has a password; pass --replace ${configured.name} to change it`,
        );
      }

      outcomes.push({
        name: configured.name,
        id: configured.id,
        user: userAction,
        credential: credentialAction,
        sessionsRevoked,
      });
    }

    // Checked inside the same transaction, so a stray third row — which the 0001
    // CHECK and unique name should already prevent — cannot survive a run.
    const final = await tx.query<{ count: number }>('select count(*)::int as count from app.users');
    if (final.rows[0].count !== 2) {
      throw new ProvisioningError(`provisioning would leave ${final.rows[0].count} users; expected exactly two`);
    }
    return outcomes;
  });
}

export interface ReadinessReport {
  users: Array<{ name: 'NOXAVA' | 'SZRON'; id: string; credentialSet: boolean }>;
}

/**
 * Startup readiness. Verifies both users exist, that their ids match the
 * operator-supplied pairs exactly, and that both have a credential — an API that
 * accepted requests while one account could never log in would be half-deployed
 * without saying so.
 *
 * `expected` is compared, never written. This function provisions nothing.
 */
export async function assertProvisioned(
  db: Database,
  expected: ReadonlyArray<{ id: string; name: 'NOXAVA' | 'SZRON' }>,
): Promise<ReadinessReport> {
  const rows = await db.query<{ id: string; name: 'NOXAVA' | 'SZRON'; has_credential: boolean }>(
    `select u.id, u.name, (c.user_id is not null) as has_credential
       from app.users u
       left join app.user_credentials c on c.user_id = u.id
      order by u.name`,
  );
  if (rows.rows.length !== 2) {
    throw new ProvisioningError(`expected exactly two provisioned users, found ${rows.rows.length}`);
  }
  for (const entry of expected) {
    const row = rows.rows.find((candidate) => candidate.name === entry.name);
    if (!row) throw new ProvisioningError(`${entry.name} is not provisioned`);
    if (row.id !== entry.id) {
      throw new ProvisioningError(
        `${entry.name} is provisioned with a different id than configured; `
        + 'the existing id is authoritative and must not be replaced',
      );
    }
  }
  const missing = rows.rows.filter((row) => !row.has_credential).map((row) => row.name);
  if (missing.length > 0) {
    throw new ProvisioningError(`no password is set for: ${missing.join(', ')}`);
  }
  return {
    users: rows.rows.map((row) => ({ name: row.name, id: row.id, credentialSet: row.has_credential })),
  };
}

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

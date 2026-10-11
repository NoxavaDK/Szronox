/**
 * Operator-side access key management. Runs with the owner identity (the API role cannot
 * insert or revoke keys, by grant). The secret exists only in the return value of
 * `createAccessKey`, which the CLI prints once; only its digest is stored.
 */

import { randomUUID } from 'node:crypto';

import type { Queryable } from '../db/client.js';
import { type AccessKeyScope, digestOf, newKeySecret } from './keys.js';

export interface AccessKeySummary {
  id: string;
  label: string;
  scope: AccessKeyScope;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export class AccessKeyInputError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);

export async function createAccessKey(db: Queryable, label: string, scope: AccessKeyScope = 'live_feed'): Promise<{ id: string; secret: string }> {
  const trimmed = label.trim();
  if (trimmed.length < 1 || trimmed.length > 80) throw new AccessKeyInputError('label must be 1–80 characters');
  const id = randomUUID();
  const secret = newKeySecret();
  await db.query('insert into app.access_keys (id, label, scope, token_hash) values ($1, $2, $3, $4)', [id, trimmed, scope, digestOf(secret)]);
  return { id, secret };
}

/** Revocation is recorded, not deleted, so a revoked key is distinguishable from an unknown one. */
export async function revokeAccessKey(db: Queryable, id: string): Promise<boolean> {
  if (!UUID.test(id)) throw new AccessKeyInputError('id must be a UUID');
  const result = await db.query<{ id: string }>(
    'update app.access_keys set revoked_at = now() where id = $1 and revoked_at is null returning id', [id],
  );
  return result.rows.length === 1;
}

export async function listAccessKeys(db: Queryable): Promise<AccessKeySummary[]> {
  const result = await db.query<{ id: string; label: string; scope: AccessKeyScope; created_at: unknown; revoked_at: unknown; last_used_at: unknown }>(
    'select id, label, scope, created_at, revoked_at, last_used_at from app.access_keys order by created_at',
  );
  return result.rows.map((row) => ({
    id: row.id, label: row.label, scope: row.scope,
    createdAt: iso(row.created_at)!, revokedAt: iso(row.revoked_at), lastUsedAt: iso(row.last_used_at),
  }));
}

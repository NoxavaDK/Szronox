/**
 * STREAM-LIVE-01 access keys: the device principal.
 *
 * A key is not a user. It resolves to a `DeviceKey`, never a `VerifiedActor`, so it cannot
 * reach any route that asks for an actor. The three live device routes (feed, status and, since
 * STREAM-PLAN-01, the current stream plan) are the only callers of
 * `authenticateDevice`, and T00 pins that list.
 *
 * Shape follows sessions: 32 random bytes handed out once, only their SHA-256 digest stored.
 * The lookup is by digest, so the database comparison never sees the secret, and the final
 * equality is constant-time anyway.
 *
 * Browser use is refused: a request carrying a session cookie or an Origin header is not a
 * device request. Together with CORS being disabled, that keeps a key pasted into a web page
 * from becoming a second way into the API.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import { unauthenticated } from '../core/errors.js';
import type { Queryable } from '../db/client.js';

export type AccessKeyScope = 'live_feed';

export interface DeviceKey {
  id: string;
  label: string;
  scope: AccessKeyScope;
}

/** `last_used_at` is diagnostic; stamping it on every 2-second poll would only churn rows. */
const LAST_USED_RESOLUTION_MS = 60_000;

export function digestOf(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** 32 random bytes, base64url: 43 characters, no padding, safe in a header. */
export function newKeySecret(): string {
  return randomBytes(32).toString('base64url');
}

const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function bearerOf(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match && SECRET_SHAPE.test(match[1]) ? match[1] : null;
}

/**
 * Resolve the device key on a request, or throw the same 401 an anonymous request gets.
 * Nothing in the error says whether the key was unknown, revoked or malformed.
 */
export async function authenticateDevice(
  db: Queryable, request: FastifyRequest, scope: AccessKeyScope, now: () => number = Date.now,
): Promise<DeviceKey> {
  if (request.headers.cookie !== undefined || request.headers.origin !== undefined) throw unauthenticated();
  const secret = bearerOf(request);
  if (!secret) throw unauthenticated();
  const digest = digestOf(secret);
  const result = await db.query<{ id: string; label: string; scope: AccessKeyScope; token_hash: string; last_used_at: unknown }>(
    `select id, label, scope, token_hash, last_used_at from app.access_keys
     where token_hash = $1 and revoked_at is null`,
    [digest],
  );
  const row = result.rows[0];
  if (!row || row.scope !== scope
    || !timingSafeEqual(Buffer.from(row.token_hash, 'hex'), Buffer.from(digest, 'hex'))) {
    throw unauthenticated();
  }
  const lastUsed = row.last_used_at ? new Date(row.last_used_at as string).getTime() : 0;
  if (now() - lastUsed >= LAST_USED_RESOLUTION_MS) {
    await db.query('update app.access_keys set last_used_at = $2 where id = $1', [row.id, new Date(now()).toISOString()]);
  }
  return { id: row.id, label: row.label, scope: row.scope };
}

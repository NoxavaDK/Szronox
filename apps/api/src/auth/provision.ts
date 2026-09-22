/**
 * Operator password provisioning.
 *
 * VPS-00: passwords arrive "through protected input, never command arguments, logs
 * or committed fixtures". So:
 *
 *   - The account name is an argument, because a name is not a secret and there are
 *     only two of them.
 *   - The password is read from stdin and nothing else. An argv password would be
 *     visible in the process table to every local user and would land in shell
 *     history; an environment variable would be readable from /proc and inherited
 *     by children.
 *   - Nothing is echoed back. The only output is which account was updated.
 *
 * This file provides the operation, not a bound executable: constructing a
 * PostgreSQL pool belongs to `apps/api/src/db/**`, which is VPS-03's scope. VPS-03
 * or VPS-04 supplies the `Database` and the one-shot command entry point, using the
 * same connection material as the migration job.
 */

import type { Database } from '../db/client.js';
import { createPasswordHasher, type PasswordHasher } from './passwords.js';
import { ProvisioningError, setPassword } from './users.js';

/** Read the whole of a stream as UTF-8 without buffering it anywhere else. */
export async function readAll(stream: AsyncIterable<string | Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Strip exactly one trailing newline, which is what a terminal or a `printf`
 * pipeline adds. Anything else is part of the password: trimming whitespace would
 * silently change a password that legitimately ends in a space.
 */
export function passwordFromStdinText(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n')) return text.slice(0, -1);
  return text;
}

export interface ProvisionInput {
  name: 'NOXAVA' | 'SZRON';
  /** Already-read password text. The caller owns how it was obtained. */
  password: string;
  hasher?: PasswordHasher;
}

/**
 * Set one provisioned account's password.
 *
 * The user row must already exist with its established UUID. This deliberately
 * cannot create a user: creating one here is how a deployment would end up with a
 * replacement UUID for NOXAVA and a set of orphaned Reels.
 */
export async function provisionPassword(db: Database, input: ProvisionInput): Promise<{ userId: string }> {
  if (input.name !== 'NOXAVA' && input.name !== 'SZRON') {
    throw new ProvisioningError('account name must be NOXAVA or SZRON');
  }
  const existing = await db.query<{ id: string }>('select id from app.users where name = $1', [input.name]);
  const row = existing.rows[0];
  if (!row) {
    throw new ProvisioningError(
      `${input.name} has no row in app.users; provision the user with its established id first`,
    );
  }
  await setPassword(db, input.hasher ?? createPasswordHasher(1), { userId: row.id, password: input.password });
  return { userId: row.id };
}

/**
 * Read the password from a stream and apply it. Returned rather than printed, so
 * the caller decides what, if anything, is written where.
 */
export async function provisionPasswordFromStream(
  db: Database,
  name: 'NOXAVA' | 'SZRON',
  stream: AsyncIterable<string | Buffer>,
  hasher?: PasswordHasher,
): Promise<{ userId: string }> {
  const password = passwordFromStdinText(await readAll(stream));
  if (password === '') throw new ProvisioningError('no password was supplied on stdin');
  return provisionPassword(db, { name, password, hasher });
}

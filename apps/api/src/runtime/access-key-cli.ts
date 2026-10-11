/**
 * STREAM-LIVE-01 operator command for access keys. Run as a one-shot job with the
 * migration/provisioning database identity, like provision-cli.
 *
 *   node apps/api/dist/runtime/access-key-cli.js create "StreamControl — PC"
 *   node apps/api/dist/runtime/access-key-cli.js list
 *   node apps/api/dist/runtime/access-key-cli.js revoke <id>
 *
 * `create` prints the secret exactly once. It is not stored anywhere except as a digest, so
 * copy it into StreamControl's configuration immediately. The label is not secret.
 */

import { AccessKeyInputError, createAccessKey, listAccessKeys, revokeAccessKey } from '../live/key-admin.js';
import type { Queryable } from '../db/client.js';
import { openDatabase, RuntimeConfigError, type DatabaseEnv } from './database.js';

export async function runAccessKeyCommand(db: Queryable, argv: readonly string[]): Promise<string> {
  const [command, argument, ...rest] = argv;
  if (rest.length > 0) throw new AccessKeyInputError('too many arguments');
  if (command === 'create' && argument !== undefined) {
    const { id, secret } = await createAccessKey(db, argument);
    return `created live_feed key ${id} (${argument.trim()})\nsecret (shown once, store it now): ${secret}`;
  }
  if (command === 'revoke' && argument !== undefined) {
    return (await revokeAccessKey(db, argument)) ? `revoked ${argument}` : `no active key ${argument}`;
  }
  if (command === 'list' && argument === undefined) {
    const keys = await listAccessKeys(db);
    if (keys.length === 0) return 'no access keys';
    return keys.map((key) => `${key.id}  ${key.scope}  ${key.revokedAt ? `revoked ${key.revokedAt}` : 'active'}  `
      + `last used ${key.lastUsedAt ?? 'never'}  ${key.label}`).join('\n');
  }
  throw new AccessKeyInputError('usage: create "<label>" | list | revoke <id>');
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const database = await openDatabase(process.env as DatabaseEnv, { poolMax: 1, applicationName: 'szronox-access-keys' });
    try {
      process.stdout.write(`${await runAccessKeyCommand(database.db, process.argv.slice(2))}\n`);
    } finally {
      await database.close();
    }
  } catch (error) {
    const known = error instanceof AccessKeyInputError || error instanceof RuntimeConfigError;
    process.stderr.write(`access key command failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = known ? 2 : 1;
  }
}

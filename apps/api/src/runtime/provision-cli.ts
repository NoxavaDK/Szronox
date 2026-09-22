/**
 * Operator provisioning command.
 *
 * Run as a one-shot job with the migration/provisioning database identity — the only
 * role permitted to write `app.users` and `app.user_credentials`. The API role cannot
 * do this, by grant, which is the point.
 *
 *   node apps/api/dist/runtime/provision-cli.js            # create what is missing
 *   node apps/api/dist/runtime/provision-cli.js --replace NOXAVA
 *
 * Input, and why it is shaped this way:
 *
 *   - Account names come from `APP_ALLOWLIST`, the same variable the API reads, so the
 *     command cannot provision a pair the API would then reject.
 *   - Passwords arrive as one bounded JSON object on **stdin** and nowhere else. Not
 *     argv: the process table is world-readable and shell history keeps it. Not a
 *     file: a file persists until somebody remembers to delete it. Not an environment
 *     variable: `/proc/<pid>/environ` and every child process inherit it.
 *   - JSON rather than newline-delimited pairs, because a password may legitimately
 *     contain whitespace or a newline and JSON escapes it unambiguously.
 *   - Input is capped, so a mistaken `cat` of a large file is refused rather than
 *     buffered.
 *
 *     printf '%s' '{"NOXAVA":"…","SZRON":"…"}' | node apps/api/dist/runtime/provision-cli.js
 *
 * Output names accounts and what happened to each. It never prints a password, a hash,
 * a session token or the JSON it read.
 */

import { createPasswordHasher } from '../auth/passwords.js';
import { assertUsablePassword } from '../auth/passwords.js';
import { provisionUsers, ProvisioningError, type ProvisionOutcome } from '../auth/users.js';
import { parseAllowlist } from '../core/config.js';
import { openDatabase, RuntimeConfigError, type DatabaseEnv } from './database.js';

/** 8 KiB: far more than two passwords, far less than a file somebody piped by mistake. */
export const MAX_PROVISION_INPUT_BYTES = 8 * 1024;

export class ProvisionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisionInputError';
  }
}

/** Read stdin with a hard byte cap, so the process cannot be made to buffer a file. */
export async function readBoundedInput(
  stream: AsyncIterable<string | Buffer>,
  maxBytes = MAX_PROVISION_INPUT_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    total += buffer.length;
    if (total > maxBytes) throw new ProvisionInputError(`provisioning input exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parse the password object.
 *
 * Only the two known names are accepted, and a third key is an error rather than
 * something to ignore: an operator who typed `NOXAWA` must be told, not silently left
 * with an unprovisioned account.
 */
export function parsePasswordInput(text: string): Partial<Record<'NOXAVA' | 'SZRON', string>> {
  const trimmed = text.trim();
  if (trimmed === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // The input is never echoed, so the message describes the shape, not the value.
    throw new ProvisionInputError('provisioning input must be a JSON object such as {"NOXAVA":"…","SZRON":"…"}');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ProvisionInputError('provisioning input must be a JSON object');
  }
  const passwords: Partial<Record<'NOXAVA' | 'SZRON', string>> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key !== 'NOXAVA' && key !== 'SZRON') {
      throw new ProvisionInputError(`provisioning input contains an unknown account name: ${key}`);
    }
    // The same bound the login route enforces, so provisioning cannot create a
    // password that could never be used.
    passwords[key] = assertUsablePassword(value);
  }
  return passwords;
}

/** `--replace NOXAVA --replace SZRON`. Names only; a name is not a secret. */
export function parseReplaceArguments(argv: readonly string[]): Array<'NOXAVA' | 'SZRON'> {
  const replace: Array<'NOXAVA' | 'SZRON'> = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--replace') {
      throw new ProvisionInputError(`unknown argument: ${argument}`);
    }
    const name = argv[index + 1];
    if (name !== 'NOXAVA' && name !== 'SZRON') {
      throw new ProvisionInputError('--replace requires NOXAVA or SZRON');
    }
    if (!replace.includes(name)) replace.push(name);
    index += 1;
  }
  return replace;
}

export function formatOutcomes(outcomes: readonly ProvisionOutcome[]): string {
  return outcomes
    .map((outcome) => {
      const revoked = outcome.sessionsRevoked > 0 ? `, ${outcome.sessionsRevoked} session(s) revoked` : '';
      return `${outcome.name}: ${outcome.user}, ${outcome.credential}${revoked}`;
    })
    .join('\n');
}

export interface ProvisionCliEnv extends DatabaseEnv {
  APP_ALLOWLIST?: string;
}

export async function runProvisionCli(options: {
  env: ProvisionCliEnv;
  argv: readonly string[];
  stdin: AsyncIterable<string | Buffer>;
}): Promise<string> {
  const allowlist = parseAllowlist(options.env.APP_ALLOWLIST);
  const replace = parseReplaceArguments(options.argv);
  const passwords = parsePasswordInput(await readBoundedInput(options.stdin));

  // One connection: this is a one-shot job, and a larger pool would only hold extra
  // slots on a small development server while Argon2id runs.
  const database = await openDatabase(options.env, { poolMax: 1, applicationName: 'szronox-provision' });
  try {
    const outcomes = await provisionUsers(database.db, createPasswordHasher(1), {
      allowlist,
      passwords,
      replace,
    });
    return formatOutcomes(outcomes);
  } finally {
    await database.close();
  }
}

// Executed only when this file is the entry point, so the functions above stay
// importable by a test without opening a connection or reading stdin.
if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    process.stdout.write(`${await runProvisionCli({
      env: process.env as ProvisionCliEnv,
      argv: process.argv.slice(2),
      stdin: process.stdin,
    })}\n`);
  } catch (error) {
    const known = error instanceof ProvisionInputError
      || error instanceof ProvisioningError
      || error instanceof RuntimeConfigError;
    // A known configuration or input problem prints its message, which never contains
    // a password. Anything else prints its message only — never a stack, which could
    // include a query and its parameters.
    process.stderr.write(`provisioning failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = known ? 2 : 1;
  }
}

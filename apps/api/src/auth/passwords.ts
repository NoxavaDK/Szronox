/**
 * Password hashing and verification.
 *
 * Argon2id with the parameters VPS-00 pinned from the OWASP password-storage
 * guidance: memoryCost 19456 KiB, timeCost 2, parallelism 1, per-password random
 * salt. The salt and the parameters travel inside the PHC string, so a later
 * increase applies to rows written after it without invalidating older ones.
 *
 * Three properties this module exists to guarantee:
 *
 *   - Verification cost is bounded. Argon2id allocates 19 MiB per call; an
 *     unbounded number of concurrent logins would be a memory-exhaustion lever,
 *     so calls queue behind a small semaphore instead of running in parallel.
 *   - A password is never silently shortened. Over the byte limit is a rejection,
 *     because truncating would make a long password and its prefix equivalent.
 *   - An unknown account still costs a verification. `verifyDummy` runs the same
 *     work against a throwaway hash so response time does not reveal whether an
 *     account exists.
 *
 * Nothing here logs, returns or throws a password, a hash or a salt.
 */

import { randomBytes } from 'node:crypto';

import argon2 from 'argon2';

import { MAX_PASSWORD_BYTES } from './config.js';

export const ARGON2ID_PARAMETERS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export class PasswordInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordInputError';
  }
}

/**
 * Reject rather than repair. The byte length is what matters, not the character
 * count: Polish text is multi-byte, so a 1024-character limit and a 1024-byte
 * limit are different limits and only one of them bounds the work done.
 */
export function assertUsablePassword(password: unknown): string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new PasswordInputError('password must be a non-empty string');
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new PasswordInputError(`password must not exceed ${MAX_PASSWORD_BYTES} bytes`);
  }
  return password;
}

/** Minimal FIFO semaphore. Bounded concurrency, unbounded queue length is the caller's concern. */
function semaphore(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  };
  return async function run<T>(body: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => { waiting.push(resolve); });
    }
    active += 1;
    try {
      return await body();
    } finally {
      release();
    }
  };
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(storedHash: string, password: string): Promise<boolean>;
  /**
   * Spend a comparable amount of work with no account behind it, so an unknown
   * name and a wrong password are not distinguishable by timing.
   */
  verifyDummy(password: string): Promise<false>;
}

export function createPasswordHasher(concurrency = 2): PasswordHasher {
  const run = semaphore(concurrency);
  // Built once, lazily, from random bytes that are then dropped. Nothing can
  // verify against it, which is the point: it only exists to be compared.
  let dummyHash: Promise<string> | null = null;

  const hash = (password: string) =>
    argon2.hash(assertUsablePassword(password), ARGON2ID_PARAMETERS);

  return {
    hash: (password) => run(() => hash(password)),

    async verify(storedHash, password) {
      const candidate = assertUsablePassword(password);
      return run(async () => {
        try {
          return await argon2.verify(storedHash, candidate);
        } catch {
          // A malformed or foreign stored hash is a failed verification, not an
          // error the caller can distinguish from a wrong password.
          return false;
        }
      });
    },

    async verifyDummy(password) {
      const candidate = assertUsablePassword(password);
      dummyHash ??= argon2.hash(`unassigned:${randomBytes(32).toString('hex')}`, ARGON2ID_PARAMETERS);
      const reference = await dummyHash;
      await run(async () => {
        try {
          await argon2.verify(reference, candidate);
        } catch { /* the outcome is fixed; only the work matters */ }
      });
      return false;
    },
  };
}

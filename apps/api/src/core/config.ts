/**
 * Composition from environment.
 *
 * T08 reported "real Storage adapter/configuration" as a blocker. This is that
 * wiring: it turns environment variables into the verifier and storage adapter the
 * core routes need, refusing ambiguous or incomplete configuration rather than
 * quietly degrading.
 *
 * What it deliberately does NOT do is choose a database driver. `Database` is
 * passed in, so `pg` stays out of this package's dependency graph and the
 * composition root keeps that decision. C01's shutdown path is untouched.
 *
 * Nothing here logs a secret. `describeConfig` exists so a startup line can state
 * what was configured without printing any of it.
 */

import { createHs256Verifier, type AllowlistEntry, type TokenVerifier } from '../auth/verify.js';
import { selectVerifier } from '../auth/jwks.js';
import type { Database } from '../db/client.js';
import type { CoreDependencies } from './routes.js';
import {
  memoryStorageAdapter,
  type StorageAdapter,
} from './storage.js';
import { filesystemStorageAdapter } from '../storage/filesystem.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface CoreEnv {
  SUPABASE_JWT_SECRET?: string;
  SUPABASE_JWKS_URL?: string;
  SUPABASE_JWT_ISSUER?: string;
  SUPABASE_JWT_AUDIENCE?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_STORAGE_BUCKET?: string;
  /** Absolute private filesystem root. */
  APP_STORAGE_ROOT?: string;
  /** Same-origin base used to construct absolute upload transport URLs. */
  APP_ORIGIN?: string;
  APP_UPLOAD_TICKET_TTL_SECONDS?: string;
  /** Comma-separated `NAME:uuid` pairs for the two allowlisted users. */
  APP_ALLOWLIST?: string;
  /** Opt-in, development only: use the in-memory storage adapter. */
  STORAGE_DRIVER?: string;
}

const present = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * Parse the two allowlisted users. Exactly two are expected, because the product
 * has exactly two; a third or a missing one is a configuration error rather than
 * something to tolerate.
 */
export function parseAllowlist(raw: string | undefined): AllowlistEntry[] {
  if (!present(raw)) throw new ConfigError('APP_ALLOWLIST is required, as "NOXAVA:<uuid>,SZRON:<uuid>"');
  const entries = raw.split(',').map((pair) => pair.trim()).filter((pair) => pair !== '');
  const parsed: AllowlistEntry[] = [];
  for (const pair of entries) {
    const [name, id] = pair.split(':').map((part) => part?.trim());
    if (name !== 'NOXAVA' && name !== 'SZRON') {
      throw new ConfigError(`APP_ALLOWLIST contains an unknown user name: ${String(name)}`);
    }
    if (!present(id)) throw new ConfigError(`APP_ALLOWLIST entry for ${name} has no id`);
    parsed.push({ id, name });
  }
  if (parsed.length !== 2) {
    throw new ConfigError(`APP_ALLOWLIST must list exactly two users, found ${parsed.length}`);
  }
  if (parsed[0].id === parsed[1].id) throw new ConfigError('APP_ALLOWLIST users must have distinct ids');
  if (parsed[0].name === parsed[1].name) throw new ConfigError('APP_ALLOWLIST must list NOXAVA and SZRON');
  return parsed;
}

/**
 * Build the storage adapter.
 *
 * Production storage is always the private VPS filesystem. The memory adapter is
 * an explicit local/test choice and is never an implicit fallback.
 */
export function buildStorage(env: CoreEnv): StorageAdapter {
  if (env.STORAGE_DRIVER === 'memory') return memoryStorageAdapter();
  if (!present(env.APP_STORAGE_ROOT)) throw new ConfigError('APP_STORAGE_ROOT is required');
  if (!present(env.APP_ORIGIN)) throw new ConfigError('APP_ORIGIN is required for upload transport URLs');
  const rawTtl = env.APP_UPLOAD_TICKET_TTL_SECONDS;
  const ttl = rawTtl === undefined ? 300 : Number(rawTtl);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 900) {
    throw new ConfigError('APP_UPLOAD_TICKET_TTL_SECONDS must be an integer from 1 to 900');
  }
  return filesystemStorageAdapter({
    root: env.APP_STORAGE_ROOT,
    appOrigin: env.APP_ORIGIN,
    defaultExpiresInSeconds: ttl,
  });
}

/** Build the token verifier. HS256 or JWKS, never both. */
export function buildVerifier(env: CoreEnv, allowlist: AllowlistEntry[]): TokenVerifier {
  if (!present(env.SUPABASE_JWT_ISSUER)) throw new ConfigError('SUPABASE_JWT_ISSUER is required');
  if (!present(env.SUPABASE_JWT_AUDIENCE)) throw new ConfigError('SUPABASE_JWT_AUDIENCE is required');
  return selectVerifier({
    jwksUri: env.SUPABASE_JWKS_URL,
    secret: env.SUPABASE_JWT_SECRET,
    issuer: env.SUPABASE_JWT_ISSUER,
    audience: env.SUPABASE_JWT_AUDIENCE,
    allowlist,
  }, createHs256Verifier);
}

export function buildCoreDependencies(db: Database, env: CoreEnv = process.env as CoreEnv): CoreDependencies {
  const allowlist = parseAllowlist(env.APP_ALLOWLIST);
  return {
    db,
    verifier: buildVerifier(env, allowlist),
    storage: buildStorage(env),
    allowlist: allowlist.map((entry) => ({ ...entry, avatarUrl: null })),
  };
}

/** Startup summary with no secret values. */
export function describeConfig(env: CoreEnv = process.env as CoreEnv) {
  return {
    verification: present(env.SUPABASE_JWKS_URL)
      ? 'asymmetric_jwks'
      : present(env.SUPABASE_JWT_SECRET) ? 'hs256_shared_secret' : 'unconfigured',
    issuerConfigured: present(env.SUPABASE_JWT_ISSUER),
    audienceConfigured: present(env.SUPABASE_JWT_AUDIENCE),
    storage: env.STORAGE_DRIVER === 'memory' ? 'memory' : present(env.APP_STORAGE_ROOT) ? 'filesystem' : 'unconfigured',
    storageRootConfigured: present(env.APP_STORAGE_ROOT),
    allowlistConfigured: present(env.APP_ALLOWLIST),
  };
}

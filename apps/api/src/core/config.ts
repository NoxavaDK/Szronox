/**
 * Composition from environment.
 *
 * T08 reported "real Storage adapter/configuration" as a blocker. This is that
 * wiring: it turns environment variables into the storage adapter and the
 * authentication seam the core routes need, refusing ambiguous or incomplete
 * configuration rather than quietly degrading.
 *
 * What it deliberately does NOT do is choose a database driver. `Database` is
 * passed in, so `pg` stays out of this package's dependency graph and the
 * composition root keeps that decision. C01's shutdown path is untouched.
 *
 * VPS-01 removed the JWT half of this file. There is no issuer, audience, JWKS URL
 * or shared signing secret to configure any more; `apps/api/src/auth/config.ts`
 * owns the session, CSRF and throttling settings instead.
 *
 * Nothing here logs a secret. `describeConfig` exists so a startup line can state
 * what was configured without printing any of it.
 */

import { buildAuthDependencies } from '../auth/compose.js';
import { type AuthEnv, describeAuthConfig } from '../auth/config.js';
import type { Database } from '../db/client.js';
import type { CoreDependencies } from './routes.js';
import {
  memoryStorageAdapter,
  type StorageAdapter,
} from './storage.js';
import { filesystemStorageAdapter } from '../storage/filesystem.js';

/** The two provisioned users, as configured. Ids are supplied, never generated. */
export interface AllowlistEntry {
  id: string;
  name: 'NOXAVA' | 'SZRON';
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface CoreEnv extends AuthEnv {
  AI_ENABLED?: string;
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

/**
 * Build the core dependency set, including the session authentication seam.
 *
 * The auth service is returned alongside the dependencies because the composition
 * root needs it for `registerAuthRoutes`, while the core routes only need the
 * narrower `authenticate` function.
 */
export function buildCoreDependencies(
  db: Database,
  env: CoreEnv = process.env as CoreEnv,
): CoreDependencies & { auth: ReturnType<typeof buildAuthDependencies> } {
  const allowlist = parseAllowlist(env.APP_ALLOWLIST);
  const auth = buildAuthDependencies(db, env);
  return {
    db,
    authenticate: auth.authenticate,
    storage: buildStorage(env),
    allowlist: allowlist.map((entry) => ({ ...entry, avatarUrl: null })),
    aiEnabled: env.AI_ENABLED === 'true',
    auth,
  };
}

/** Startup summary with no secret values. */
export function describeConfig(env: CoreEnv = process.env as CoreEnv) {
  return {
    authentication: describeAuthConfig(env),
    storage: env.STORAGE_DRIVER === 'memory' ? 'memory' : present(env.APP_STORAGE_ROOT) ? 'filesystem' : 'unconfigured',
    storageRootConfigured: present(env.APP_STORAGE_ROOT),
    allowlistConfigured: present(env.APP_ALLOWLIST),
  };
}

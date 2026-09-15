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
  supabaseStorageAdapter,
} from './storage.js';

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
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_STORAGE_BUCKET?: string;
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
 * Supabase is selected when a URL, service-role key and bucket are all present.
 * A partial Supabase configuration is an error, never a silent fallback to
 * in-memory — that would make uploads appear to work while storing nothing.
 */
export function buildStorage(env: CoreEnv): StorageAdapter {
  if (env.STORAGE_DRIVER === 'memory') return memoryStorageAdapter();

  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = env.SUPABASE_STORAGE_BUCKET;
  const supplied = [url, key, bucket].filter(present).length;
  if (supplied === 0) {
    throw new ConfigError(
      'No storage is configured. Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and '
      + 'SUPABASE_STORAGE_BUCKET, or STORAGE_DRIVER=memory for local development.',
    );
  }
  if (supplied !== 3) {
    throw new ConfigError(
      'Supabase storage is partially configured. All of SUPABASE_URL, '
      + 'SUPABASE_SERVICE_ROLE_KEY and SUPABASE_STORAGE_BUCKET are required.',
    );
  }
  return supabaseStorageAdapter({
    url: url as string,
    serviceRoleKey: key as string,
    bucket: bucket as string,
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
    auth,
  };
}

/** Startup summary with no secret values. */
export function describeConfig(env: CoreEnv = process.env as CoreEnv) {
  return {
    authentication: describeAuthConfig(env),
    storage: env.STORAGE_DRIVER === 'memory'
      ? 'memory'
      : present(env.SUPABASE_URL) && present(env.SUPABASE_SERVICE_ROLE_KEY) && present(env.SUPABASE_STORAGE_BUCKET)
        ? 'supabase'
        : 'unconfigured',
    bucket: present(env.SUPABASE_STORAGE_BUCKET) ? env.SUPABASE_STORAGE_BUCKET : null,
    allowlistConfigured: present(env.APP_ALLOWLIST),
  };
}

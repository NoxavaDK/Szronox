/**
 * Bounded PostgreSQL pools for the API, the worker and one-shot operator jobs.
 *
 * One module owns every connection decision so the three processes cannot drift
 * into different timeouts or different credential sources. What it deliberately
 * does not do is decide *which* identity a process uses: that arrives in the
 * environment, because the whole point of separating migration, provisioning, API
 * and worker roles is that the process cannot choose its own privileges.
 *
 * Passwords are read from a file, not an environment variable. A value in the
 * environment is visible in `/proc/<pid>/environ`, is inherited by every child
 * process, and is printed by any well-meaning diagnostic that dumps `process.env`.
 * A mounted file is readable only by the process's own UID. `DATABASE_PASSWORD` is
 * still accepted for a throwaway local run, and saying so is the point — it is not
 * the deployment path.
 *
 * Nothing here logs a password, a connection string or a role's credentials.
 * `describeDatabase` exists so startup can state what it connected as without
 * printing what it connected with.
 */

import { readFile } from 'node:fs/promises';

import { Pool, type PoolConfig } from 'pg';

import { type Database, pgPoolDatabase } from '../db/client.js';

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeConfigError';
  }
}

export interface DatabaseEnv {
  DATABASE_HOST?: string;
  DATABASE_PORT?: string;
  DATABASE_NAME?: string;
  DATABASE_USER?: string;
  /** Preferred: a mounted file readable only by this process's UID. */
  DATABASE_PASSWORD_FILE?: string;
  /** Accepted for a throwaway local run only. */
  DATABASE_PASSWORD?: string;
  DATABASE_POOL_MAX?: string;
  DATABASE_CONNECT_TIMEOUT_MS?: string;
  DATABASE_STATEMENT_TIMEOUT_MS?: string;
}

/** Every key this module reads, so "configured at all" is a single decidable question. */
export const DATABASE_ENV_KEYS = [
  'DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_USER',
  'DATABASE_PASSWORD_FILE', 'DATABASE_PASSWORD', 'DATABASE_POOL_MAX',
  'DATABASE_CONNECT_TIMEOUT_MS', 'DATABASE_STATEMENT_TIMEOUT_MS',
] as const satisfies ReadonlyArray<keyof DatabaseEnv>;

const present = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim() !== '';

export function databaseConfigured(env: DatabaseEnv): boolean {
  return DATABASE_ENV_KEYS.some((key) => present(env[key]));
}

function bounded(raw: string | undefined, field: string, fallback: number, min: number, max: number): number {
  if (!present(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RuntimeConfigError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function required(env: DatabaseEnv, key: 'DATABASE_HOST' | 'DATABASE_NAME' | 'DATABASE_USER'): string {
  const value = env[key];
  if (!present(value)) throw new RuntimeConfigError(`${key} is required`);
  return value.trim();
}

export interface PoolBounds {
  /** Small by default: two processes sharing one small development server. */
  max: number;
  connectionTimeoutMillis: number;
  statementTimeoutMs: number;
}

export interface DatabaseSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  bounds: PoolBounds;
  passwordSource: 'file' | 'environment';
  passwordFile: string | null;
}

/**
 * Resolve settings without reading the password.
 *
 * Split from `openDatabase` so a startup summary, a readiness report and a test can
 * all inspect the configuration without any of them touching the secret.
 */
export function readDatabaseSettings(
  env: DatabaseEnv,
  defaults: { poolMax: number },
): DatabaseSettings {
  if (!present(env.DATABASE_PASSWORD_FILE) && !present(env.DATABASE_PASSWORD)) {
    throw new RuntimeConfigError('DATABASE_PASSWORD_FILE is required (DATABASE_PASSWORD is accepted only for a local run)');
  }
  if (present(env.DATABASE_PASSWORD_FILE) && present(env.DATABASE_PASSWORD)) {
    // Two sources means one of them is stale, and guessing which would decide the
    // process's privileges by accident.
    throw new RuntimeConfigError('Set exactly one of DATABASE_PASSWORD_FILE or DATABASE_PASSWORD');
  }
  return {
    host: required(env, 'DATABASE_HOST'),
    port: bounded(env.DATABASE_PORT, 'DATABASE_PORT', 5432, 1, 65535),
    database: required(env, 'DATABASE_NAME'),
    user: required(env, 'DATABASE_USER'),
    bounds: {
      max: bounded(env.DATABASE_POOL_MAX, 'DATABASE_POOL_MAX', defaults.poolMax, 1, 16),
      connectionTimeoutMillis: bounded(env.DATABASE_CONNECT_TIMEOUT_MS, 'DATABASE_CONNECT_TIMEOUT_MS', 5_000, 250, 60_000),
      statementTimeoutMs: bounded(env.DATABASE_STATEMENT_TIMEOUT_MS, 'DATABASE_STATEMENT_TIMEOUT_MS', 15_000, 250, 120_000),
    },
    passwordSource: present(env.DATABASE_PASSWORD_FILE) ? 'file' : 'environment',
    passwordFile: present(env.DATABASE_PASSWORD_FILE) ? env.DATABASE_PASSWORD_FILE.trim() : null,
  };
}

async function readPassword(settings: DatabaseSettings, env: DatabaseEnv): Promise<string> {
  if (settings.passwordFile !== null) {
    let raw: string;
    try {
      raw = await readFile(settings.passwordFile, 'utf8');
    } catch {
      // The path is named, the contents never are.
      throw new RuntimeConfigError(`DATABASE_PASSWORD_FILE could not be read: ${settings.passwordFile}`);
    }
    const value = raw.replace(/\r?\n$/, '');
    if (value === '') throw new RuntimeConfigError('DATABASE_PASSWORD_FILE is empty');
    return value;
  }
  return env.DATABASE_PASSWORD as string;
}

export interface OpenDatabase {
  db: Database;
  pool: Pool;
  settings: DatabaseSettings;
  /** Drain in-flight work and release every connection. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * Open a bounded pool.
 *
 * `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` are
 * set as connection parameters rather than left to the server default, so one stuck
 * query cannot hold a connection — or a row lock — indefinitely and starve the other
 * process sharing the same small server.
 */
export async function openDatabase(
  env: DatabaseEnv,
  options: { poolMax: number; applicationName: string },
): Promise<OpenDatabase> {
  const settings = readDatabaseSettings(env, { poolMax: options.poolMax });
  const config: PoolConfig = {
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.user,
    password: await readPassword(settings, env),
    max: settings.bounds.max,
    connectionTimeoutMillis: settings.bounds.connectionTimeoutMillis,
    idleTimeoutMillis: 30_000,
    application_name: options.applicationName,
    statement_timeout: settings.bounds.statementTimeoutMs,
    lock_timeout: 10_000,
    idle_in_transaction_session_timeout: 60_000,
  };
  const pool = new Pool(config);
  // Without this, a backend terminated by the server (restart, admin action) raises
  // an unhandled 'error' event on an idle client and takes the process down.
  pool.on('error', () => undefined);

  let closed = false;
  return {
    pool,
    settings,
    db: pgPoolDatabase(pool),
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}

/** Startup summary. Identity and bounds only; never the password or its contents. */
export function describeDatabase(settings: DatabaseSettings) {
  return {
    host: settings.host,
    port: settings.port,
    database: settings.database,
    role: settings.user,
    poolMax: settings.bounds.max,
    statementTimeoutMs: settings.bounds.statementTimeoutMs,
    passwordSource: settings.passwordSource,
  };
}

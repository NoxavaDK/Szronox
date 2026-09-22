/**
 * One-call composition for the API startup path.
 *
 * `core/config.ts` builds storage and the allowlist; this builds the auth half, so
 * the two concerns stay in their own files and VPS-02's storage work does not have
 * to move around auth wiring.
 *
 * Nothing here opens a database or reads a password. The `Database` arrives from
 * the caller, exactly as `buildCoreDependencies` already expects.
 */

import type { Database } from '../db/client.js';
import { buildAuthConfig, type AuthEnv } from './config.js';
import { createPasswordHasher, type PasswordHasher } from './passwords.js';
import { createAuthService, requestAuthenticator, type AuthService, type RequestAuthenticator } from './service.js';

export type AuthCompositionEnv = AuthEnv;

export interface AuthDependencies {
  service: AuthService;
  /** The seam `registerCoreRoutes` consumes for every domain request. */
  authenticate: RequestAuthenticator;
  hasher: PasswordHasher;
}

export function buildAuthDependencies(
  db: Database,
  env: AuthCompositionEnv = process.env as AuthCompositionEnv,
): AuthDependencies {
  const config = buildAuthConfig(env);
  const hasher = createPasswordHasher(config.passwordConcurrency);
  const service = createAuthService({ db, config, hasher });
  return { service, authenticate: requestAuthenticator(service), hasher };
}

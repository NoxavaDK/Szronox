/**
 * The auth module's public surface.
 *
 * Everything the composition root needs is here; nothing else in the API reaches
 * past this barrel into the internals. There is no token verifier and no bearer
 * parsing to export, because opaque session cookies are the only authorization
 * path.
 */

export {
  AuthConfigError,
  DEFAULT_SESSION_LIFETIME_SECONDS,
  MAX_PASSWORD_BYTES,
  SESSION_COOKIE_NAME,
  buildAuthConfig,
  describeAuthConfig,
  parseOrigins,
  type AuthConfig,
  type AuthEnv,
} from './config.js';

export { clearedSessionCookie, noStore, readSessionCookie, serializeSessionCookie } from './cookies.js';

export {
  ARGON2ID_PARAMETERS,
  PasswordInputError,
  assertUsablePassword,
  createPasswordHasher,
  type PasswordHasher,
} from './passwords.js';

export {
  createSessionStore,
  deriveCsrfToken,
  pruneDeadSessions,
  type SessionFailure,
  type SessionStore,
} from './sessions.js';

export {
  DEFAULT_ACCOUNT_THROTTLE,
  DEFAULT_ADDRESS_THROTTLE,
  createThrottle,
  type Throttle,
} from './throttle.js';

export { checkOrigin, clientKey, isJsonRequest, isSafeMethod } from './origin.js';

export {
  ProvisioningError,
  assertProvisioned,
  loadUsers,
  setPassword,
  userPair,
  type ProvisionedUser,
} from './users.js';

export {
  CSRF_HEADER,
  createAuthService,
  rateLimited,
  requestAuthenticator,
  type AuthService,
  type RequestAuthenticator,
  type VerifiedActor,
} from './service.js';

export { AUTH_LOG_REDACT_PATHS, registerAuthRoutes, type AuthRouteDependencies } from './routes.js';

export { buildAuthDependencies, type AuthCompositionEnv } from './compose.js';

export {
  passwordFromStdinText,
  provisionPassword,
  provisionPasswordFromStream,
} from './provision.js';

/**
 * Authentication configuration from environment.
 *
 * Every value that decides how a session is accepted arrives here and nowhere
 * else, so there is no second place that could quietly relax a check. Nothing in
 * this module logs, returns or serialises a secret value; `describeAuthConfig`
 * exists so a startup line can say what was configured without printing it.
 *
 * Deliberately absent: any JWT issuer, audience, JWKS URL or shared signing
 * secret. Sessions are opaque and application-owned, so there is no token to
 * verify and no second authorization path to configure.
 */

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

/**
 * Pinned by VPS-00. The `__Host-` prefix is not decoration: a browser only
 * accepts it when the cookie is Secure, Path=/ and has no Domain, which means a
 * cookie for this name cannot have been set by a sibling host or a plaintext
 * response. Because the prefix requires Secure, there is no plaintext-HTTP
 * development mode — HTTPS is a prerequisite, not an option.
 */
export const SESSION_COOKIE_NAME = '__Host-szronox_session';

/** Seven days, absolute. VPS-00: "no automatic indefinite extension". */
export const DEFAULT_SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

/**
 * Bounds on what a login request may contain. A password over the limit is
 * rejected, never truncated: silently trimming would make a long password
 * behave as a shorter one, so two different passwords could authenticate the
 * same account.
 */
export const MAX_PASSWORD_BYTES = 1024;

export interface AuthEnv {
  /** Comma-separated exact origins allowed to send credentialed requests. */
  APP_ORIGIN?: string;
  /** Separate from any other secret; rotating it invalidates live sessions. */
  AUTH_CSRF_SECRET?: string;
  AUTH_SESSION_LIFETIME_SECONDS?: string;
  /** Concurrent Argon2id verifications. Bounded so login cannot exhaust memory. */
  AUTH_PASSWORD_CONCURRENCY?: string;
}

export interface AuthConfig {
  cookieName: string;
  csrfSecret: string;
  sessionLifetimeMs: number;
  /** Exact origins, scheme and host included. Compared literally, never by suffix. */
  allowedOrigins: readonly string[];
  passwordConcurrency: number;
}

const present = (value: string | undefined): value is string =>
  typeof value === 'string' && value.trim() !== '';

function positiveInteger(raw: string | undefined, field: string, fallback: number): number {
  if (!present(raw)) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new AuthConfigError(`${field} must be a positive integer`);
  }
  return value;
}

/**
 * Parse the allowed origins.
 *
 * An origin is scheme + host + optional port and nothing else. A value carrying
 * a path, or one that the URL parser does not accept, is a configuration error
 * rather than something to normalise, because a mistake here is what decides
 * whether a foreign site can act as a logged-in user.
 */
export function parseOrigins(raw: string | undefined): string[] {
  if (!present(raw)) {
    throw new AuthConfigError('APP_ORIGIN is required, as the exact origin such as "https://host.example"');
  }
  const parsed: string[] = [];
  for (const candidate of raw.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '')) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new AuthConfigError(`APP_ORIGIN entry is not a valid absolute origin: ${candidate}`);
    }
    if (url.origin === 'null' || `${url.origin}${url.pathname}` !== `${url.origin}/` || url.search !== '' || url.hash !== '') {
      throw new AuthConfigError(`APP_ORIGIN entry must be an origin with no path: ${candidate}`);
    }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new AuthConfigError(`APP_ORIGIN entry must use https: ${candidate}`);
    }
    if (!parsed.includes(url.origin)) parsed.push(url.origin);
  }
  if (parsed.length === 0) throw new AuthConfigError('APP_ORIGIN listed no usable origin');
  return parsed;
}

export function buildAuthConfig(env: AuthEnv = process.env as AuthEnv): AuthConfig {
  if (!present(env.AUTH_CSRF_SECRET)) {
    throw new AuthConfigError('AUTH_CSRF_SECRET is required and must be environment-specific');
  }
  // A short secret would make the derived CSRF token guessable, which is the one
  // property CSRF protection depends on.
  if (env.AUTH_CSRF_SECRET.length < 32) {
    throw new AuthConfigError('AUTH_CSRF_SECRET must be at least 32 characters');
  }
  return {
    cookieName: SESSION_COOKIE_NAME,
    csrfSecret: env.AUTH_CSRF_SECRET,
    sessionLifetimeMs: positiveInteger(
      env.AUTH_SESSION_LIFETIME_SECONDS,
      'AUTH_SESSION_LIFETIME_SECONDS',
      DEFAULT_SESSION_LIFETIME_SECONDS,
    ) * 1000,
    allowedOrigins: parseOrigins(env.APP_ORIGIN),
    passwordConcurrency: positiveInteger(env.AUTH_PASSWORD_CONCURRENCY, 'AUTH_PASSWORD_CONCURRENCY', 2),
  };
}

/**
 * Startup summary. Presence and shape only; no secret and no derived value.
 *
 * This never throws, even on configuration it would refuse to run with: a
 * diagnostic line that fails to render is the least useful thing to have when the
 * configuration is wrong. `buildAuthConfig` is the gate; this only describes.
 */
export function describeAuthConfig(env: AuthEnv = process.env as AuthEnv) {
  let originsConfigured = 0;
  let originsValid = false;
  if (present(env.APP_ORIGIN)) {
    try {
      originsConfigured = parseOrigins(env.APP_ORIGIN).length;
      originsValid = true;
    } catch { /* reported as invalid rather than raised from a log line */ }
  }
  let sessionLifetimeSeconds: number | null = null;
  try {
    sessionLifetimeSeconds = positiveInteger(
      env.AUTH_SESSION_LIFETIME_SECONDS,
      'AUTH_SESSION_LIFETIME_SECONDS',
      DEFAULT_SESSION_LIFETIME_SECONDS,
    );
  } catch { /* null means "not a usable value", not a default */ }
  return {
    mechanism: 'opaque_session_cookie' as const,
    cookieName: SESSION_COOKIE_NAME,
    csrfSecretConfigured: present(env.AUTH_CSRF_SECRET),
    originsConfigured,
    originsValid,
    sessionLifetimeSeconds,
  };
}

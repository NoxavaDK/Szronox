/**
 * Logger options for the real processes.
 *
 * VPS-01 exported the redaction paths and left applying them to the composition
 * root, because a module that does not own startup cannot set logger options. This
 * is that application.
 *
 * Redaction is configured here rather than relied upon at every call site. The
 * failure mode it prevents is not a developer writing `log.info(password)` — it is
 * Fastify's own request serialiser writing the whole header set, which contains the
 * session cookie and the CSRF token on every authenticated request. One
 * misconfigured `logger: true` without this would write live credentials to disk on
 * the first request.
 */

import { AUTH_LOG_REDACT_PATHS } from '../auth/routes.js';

/** Header and body paths that must never reach a log line. */
export const REDACT_PATHS: readonly string[] = [
  ...AUTH_LOG_REDACT_PATHS,
  // Database and CSRF secrets arrive through files, but a diagnostic that dumps the
  // environment would still print the paths and any accidentally-set inline values.
  'DATABASE_PASSWORD',
  'env.DATABASE_PASSWORD',
  'connectionString',
  'password',
  'passwordHash',
  'password_hash',
  'csrfToken',
  'csrfSecret',
  'tokenHash',
  'token_hash',
];

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

const LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

export function parseLogLevel(raw: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (!LEVELS.includes(value as LogLevel)) {
    throw new Error(`LOG_LEVEL must be one of: ${LEVELS.join(', ')}`);
  }
  return value as LogLevel;
}

export interface LoggerOptions extends Record<string, unknown> {
  level: LogLevel;
  redact: { paths: string[]; censor: string; remove: boolean };
  serializers: Record<string, (value: never) => unknown>;
}

/**
 * Build Fastify's logger options.
 *
 * `remove: true` drops the field entirely rather than replacing it with a censor
 * marker. A `[Redacted]` placeholder still tells a log reader that a cookie was
 * present and how the request was shaped; removing it is both smaller and less
 * informative to anyone reading the logs later.
 *
 * The request serialiser is narrowed to method, url and the remote address on
 * purpose. Allow-listing four fields is safer than redacting an open-ended header
 * map, because a header added later is excluded by default instead of being logged
 * until somebody notices.
 */
export function buildLoggerOptions(level: LogLevel): LoggerOptions | false {
  if (level === 'silent') return false;
  return {
    level,
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]', remove: true },
    serializers: {
      req: (request: never) => {
        const value = request as unknown as {
          method?: string; url?: string; ip?: string; id?: string;
        };
        // The query string is dropped with the rest: `?token=` in a URL is exactly
        // the kind of thing that ends up in logs by accident.
        return {
          id: value.id,
          method: value.method,
          url: typeof value.url === 'string' ? value.url.split('?', 1)[0] : undefined,
          remoteAddress: value.ip,
        };
      },
      res: (reply: never) => {
        const value = reply as unknown as { statusCode?: number };
        return { statusCode: value.statusCode };
      },
    },
  };
}

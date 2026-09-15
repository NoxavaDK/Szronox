/**
 * The three authentication endpoints, under /api/v1.
 *
 *   POST /auth/login    → 200 AuthSessionResponse + session cookie
 *   GET  /me  → 200 AuthSessionResponse, 401 when there is no live session
 *   POST /auth/logout   → 204, session revoked and cookie cleared
 *
 * Registered as `registerAuthRoutes(app, { service })` for the composition root,
 * the same shape `registerCoreRoutes` already uses. No plugin is registered and
 * nothing global is touched, so this can be added to a bare Fastify instance or to
 * the real app without an ordering constraint.
 *
 * Every response here carries `Cache-Control: no-store`, including failures: an
 * intermediary caching a login response or a session bootstrap would hand one
 * user's identity to the other.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { CoreError, internalError } from '../core/errors.js';
import { clearedSessionCookie, noStore } from './cookies.js';
import type { AuthService } from './service.js';
import { retryAfterOf } from './service.js';

export interface AuthRouteDependencies {
  service: AuthService;
}

/**
 * Pino redaction paths for API startup.
 *
 * Exported rather than applied: logger options belong to the composition root,
 * which this module does not own. Without these, a request-logging configuration
 * would write the session cookie and the CSRF token to disk.
 */
export const AUTH_LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'req.headers["x-upload-token"]',
  'res.headers["set-cookie"]',
  'req.body.password',
  'password',
] as const;

export function registerAuthRoutes(app: FastifyInstance, dependencies: AuthRouteDependencies): void {
  const { service } = dependencies;

  /**
   * One funnel, so no auth route can answer outside the shared envelope and no
   * driver message or stack can escape. `clearCookie` is applied on failure only
   * where a stale cookie is the likely cause, never as a blanket side effect.
   */
  function handle(
    body: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
    options: { clearCookieOnUnauthenticated?: boolean } = {},
  ) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      noStore(reply);
      try {
        return await body(request, reply);
      } catch (error) {
        if (error instanceof CoreError) {
          const retryAfter = retryAfterOf(error);
          if (retryAfter !== null) reply.header('retry-after', String(retryAfter));
          if (options.clearCookieOnUnauthenticated && error.status === 401) {
            // The presented cookie cannot authenticate anything, so dropping it
            // stops the browser from resending it on every later request.
            reply.header('set-cookie', service.clearedCookie());
          }
          return reply.code(error.status).send(error.toEnvelope());
        }
        request.log.error(error);
        return reply.code(500).send(internalError().toEnvelope());
      }
    };
  }

  app.post('/api/v1/auth/login', { bodyLimit: 4096 }, handle(async (request, reply) => {
    const outcome = await service.login(request, request.body);
    reply.header('set-cookie', outcome.setCookie);
    return reply.code(200).send(outcome.response);
  }));

  app.get('/api/v1/me', handle(
    async (request, reply) => reply.code(200).send(await service.bootstrap(request)),
    { clearCookieOnUnauthenticated: true },
  ));

  app.post('/api/v1/auth/logout', handle(
    async (request, reply) => {
      await service.logout(request);
      // Cleared only after the revocation succeeded, so a 204 means both the
      // server record and the browser cookie are gone. A database failure leaves
      // the cookie in place rather than claiming a revocation that did not happen.
      reply.header('set-cookie', service.clearedCookie());
      return reply.code(204).send();
    },
    { clearCookieOnUnauthenticated: true },
  ));
}

/** Exported for a composition root that needs the header without the service. */
export { clearedSessionCookie };

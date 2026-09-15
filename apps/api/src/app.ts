import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { ApiError, ErrorResponse } from '@szronox/contracts';

import { registerAuthRoutes, type AuthRouteDependencies } from './auth/routes.js';
import { type CoreDependencies, registerCoreRoutes } from './core/routes.js';
import { type ReadinessTracker, unconfiguredReadiness } from './runtime/readiness.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function notFoundEnvelope(message: string): ErrorResponse {
  const error: ApiError = { code: 'NOT_FOUND', message, retryable: false };
  return { error };
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

export interface BuildAppOptions {
  auth?: AuthRouteDependencies;
  /**
   * Core API dependencies. Supplied here rather than constructed inside app.ts so
   * the composition root stays explicit and a test can compose the same routes
   * against its own database, verifier and storage.
   *
   * Omitting it yields the static/health-only app, which is what the SPA fallback
   * and shutdown tests need. Core routes are then simply absent — they are never
   * half-registered against a missing database.
   */
  core?: CoreDependencies;
  /**
   * Application readiness. Omitting it means this app is a scaffold, and
   * `/api/v1/ready` says so: a scaffold can never report ready, so a healthy
   * liveness response cannot be mistaken for a working application.
   */
  readiness?: ReadinessTracker;
  /**
   * Fastify logger options. `false` — the default — keeps the historical silent app
   * that the existing suites expect. The real process passes redacting options from
   * `runtime/logging.ts`; a plain `true` here would log whole header sets, session
   * cookie included.
   */
  logger?: BuildAppLoggerOptions;
  /**
   * Addresses this process believes about a client's real address, or `false` to trust
   * nothing. Never `true`: see runtime/proxy.ts for why both extremes are wrong.
   */
  trustProxy?: false | string[];
}

/** Whatever Fastify accepts for `logger`. Narrowed only to keep app.ts driver-free. */
export type BuildAppLoggerOptions = false | Record<string, unknown>;

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: (options.logger ?? false) as never,
    // Decides what `request.ip` means, and therefore what the login throttle keys on.
    trustProxy: options.trustProxy ?? false,
  });

  // Liveness. Answers only "this process is serving HTTP", which is all it has ever
  // answered; the scaffold answers it too, which is why readiness is separate.
  app.get('/api/v1/health', async () => ({ status: 'ok' as const }));

  // Readiness. 503 until the runtime composed successfully, and 503 again if a
  // dependency stops answering afterwards. Deliberately unauthenticated: a probe
  // cannot hold a session, and the body carries no identity, roster or secret —
  // only a machine-readable reason and per-check outcomes.
  const readiness = options.readiness ?? unconfiguredReadiness();
  app.get('/api/v1/ready', async (_request, reply) => {
    const report = await readiness.report();
    return reply.code(report.status === 'ready' ? 200 : 503).header('cache-control', 'no-store').send(report);
  });

  // Registered BEFORE the static plugins and the not-found handler, so a core route
  // is matched by its own handler rather than falling through to the SPA fallback.
  if (options.auth) registerAuthRoutes(app, options.auth);
  if (options.core) registerCoreRoutes(app, options.core);

  const webRoot = path.resolve(here, '../../web/dist');
  // Root registration only supplies the reply.sendFile decorator used for the SPA fallback below.
  app.register(fastifyStatic, { root: webRoot, wildcard: false });
  // Vite emits hashed build output under /assets/; scoping real static serving to that
  // prefix lets missing bundle files 404 without a fragile "path looks like a file" heuristic
  // that could reject a legitimate future navigation path.
  app.register(fastifyStatic, {
    root: path.join(webRoot, 'assets'),
    prefix: '/assets/',
    decorateReply: false,
  });

  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split('?', 1)[0];

    if (isApiPath(pathname)) {
      reply.code(404);
      return request.method === 'HEAD' ? reply.send() : reply.send(notFoundEnvelope('Route not found'));
    }

    if (pathname.startsWith('/assets/')) {
      return reply.code(404).send();
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(404).send();
    }

    reply.code(200);
    return request.method === 'HEAD' ? reply.send() : reply.sendFile('index.html');
  });

  return app;
}

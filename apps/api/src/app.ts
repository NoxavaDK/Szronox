import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { ApiError, ErrorResponse } from '@szronox/contracts';

import { type CoreDependencies, registerCoreRoutes } from './core/routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function notFoundEnvelope(message: string): ErrorResponse {
  const error: ApiError = { code: 'NOT_FOUND', message, retryable: false };
  return { error };
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

export interface BuildAppOptions {
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
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: false });
  app.get('/api/v1/health', async () => ({ status: 'ok' as const }));

  // Registered BEFORE the static plugins and the not-found handler, so a core route
  // is matched by its own handler rather than falling through to the SPA fallback.
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

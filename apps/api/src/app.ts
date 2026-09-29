import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { ApiError, ErrorResponse } from '@szronox/contracts';

import { registerAuthRoutes, type AuthRouteDependencies } from './auth/routes.js';
import { registerAiRoutes } from './ai/routes.js';
import { registerLibraryRoutes } from './ai/library.js';
import { type CoreDependencies, registerCoreRoutes } from './core/routes.js';
import { registerKdriveRoutes } from './kdrive/routes.js';
import { registerKdriveUploadRoutes } from './kdrive/upload-routes.js';
import { type ReadinessTracker, unconfiguredReadiness } from './runtime/readiness.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function notFoundEnvelope(message: string): ErrorResponse {
  const error: ApiError = { code: 'NOT_FOUND', message, retryable: false };
  return { error };
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/**
 * Paths that must never be answered with the SPA document.
 *
 * The fallback exists so a deep link like `/reels/<id>` reaches the app. These are not
 * navigations — a browser fetches them expecting a script, a manifest or an image, and a
 * `200 text/html` is the worst possible answer: registration fails with a MIME-type error
 * that names neither the missing file nor the fallback that produced it, and installability
 * silently degrades. When one of these is absent, the honest answer is 404.
 *
 * The list is explicit rather than a "looks like a file" heuristic, which would also have to
 * guess about future navigation paths. Every entry is a resource this application actually
 * publishes at the origin root; `/service-worker.js` and `/manifest.json` are included
 * because browsers and tooling probe those conventional names.
 */
const NON_DOCUMENT_ROOT_PATHS: ReadonlySet<string> = new Set([
  '/sw.js',
  '/service-worker.js',
  '/manifest.webmanifest',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
]);

/**
 * The manifest's `share_target.action`. Handled by the service worker in a normal install;
 * this constant exists so the server can answer honestly when no worker was there to take it.
 */
const SHARE_TARGET_PATH = '/share-target';

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
  if (options.core) { registerCoreRoutes(app, options.core); registerAiRoutes(app, options.core); registerLibraryRoutes(app, options.core); registerKdriveRoutes(app, options.core); registerKdriveUploadRoutes(app, options.core); }

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

  /**
   * The Android Share Target POST, when no service worker took it.
   *
   * The worker owns this path; reaching the server means the app was never installed, the
   * registration failed, or the worker was evicted. The server cannot store the share — the
   * payload belongs in the device's own IndexedDB, and there is no account behind this
   * request — so it says so instead of pretending. A 303 turns the POST into a GET of the
   * app, which then shows a Polish explanation rather than a raw browser error.
   *
   * Registered inside its own encapsulated scope so the multipart parser below applies to
   * this route alone and cannot change how any other route reads a body.
   */
  app.register(async (scope) => {
    scope.addContentTypeParser('multipart/form-data', (_request, payload, done) => {
      // The body is discarded, not parsed. It is still drained — up to a bound — because a
      // response sent while a request body is outstanding can be lost when the socket is
      // torn down, and a lost redirect would look like a crash to whoever shared.
      let seen = 0;
      let settled = false;
      const finish = () => { if (!settled) { settled = true; done(null, undefined); } };
      payload.on('data', (chunk: Buffer) => {
        seen += chunk.length;
        // Far beyond anything the fallback needs to read; the share is not being kept.
        if (seen > 1024 * 1024) payload.destroy();
      });
      payload.on('end', finish);
      payload.on('close', finish);
      payload.on('error', finish);
    });
    scope.post(SHARE_TARGET_PATH, (_request, reply) =>
      reply
        .code(303)
        .header('location', '/?shareError=worker_unavailable')
        .header('cache-control', 'no-store')
        .send(),
    );
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

    // A missing worker, manifest or icon fails as a missing file — never as the SPA document.
    // Applies to every method, GET and HEAD included, since a HEAD probe is exactly how a
    // deployment gets checked.
    if (NON_DOCUMENT_ROOT_PATHS.has(pathname)) {
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

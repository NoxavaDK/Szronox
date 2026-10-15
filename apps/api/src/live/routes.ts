/**
 * STREAM-LIVE-01 HTTP surface under /api/v1/live.
 *
 * Two kinds of caller, never mixed:
 *   - users, through the ordinary session seam (`authenticate` also enforces Origin + CSRF on
 *     unsafe methods): create a message, list their own;
 *   - the streaming PC, through a `live_feed` access key: read the feed, report statuses, and
 *     (STREAM-PLAN-01) read the current stream plan.
 * A key is not accepted on the user routes (they ask the session seam, which ignores it), and a
 * session is not accepted on the device routes (`authenticateDevice` refuses cookies).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { LiveStatusRequest } from '@szronox/contracts';

import { rateLimited, type RequestAuthenticator } from '../auth/service.js';
import { createThrottle, type Throttle } from '../auth/throttle.js';
import { CoreError, internalError, validationError } from '../core/errors.js';
import type { Database } from '../db/client.js';
import { authenticateDevice } from './keys.js';
import { FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT, LiveRepository } from './repository.js';
import { CoreRepository } from '../core/repository.js';
import { StreamPlansRepository } from '../stream-plans/repository.js';

export interface LiveDependencies {
  db: Database;
  authenticate: RequestAuthenticator;
  now?: () => number;
  /** Per-user sends: generous for live use, bounded against a stuck client. */
  sendThrottle?: Throttle;
  /** Per-key device calls: a 2-second poll plus status reports fits well inside. */
  deviceThrottle?: Throttle;
}

export const DEFAULT_SEND_THROTTLE = { limit: 30, windowMs: 60_000 } as const;
export const DEFAULT_DEVICE_THROTTLE = { limit: 240, windowMs: 60_000 } as const;

export function registerLiveRoutes(app: FastifyInstance, dependencies: LiveDependencies): void {
  const repository = new LiveRepository(dependencies.db);
  const plans = new StreamPlansRepository(dependencies.db, new CoreRepository(dependencies.db));
  const now = dependencies.now ?? (() => Date.now());
  const sendThrottle = dependencies.sendThrottle ?? createThrottle({ ...DEFAULT_SEND_THROTTLE, now });
  const deviceThrottle = dependencies.deviceThrottle ?? createThrottle({ ...DEFAULT_DEVICE_THROTTLE, now });

  function handle(body: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('cache-control', 'no-store');
      try {
        return await body(request, reply);
      } catch (error) {
        if (error instanceof CoreError) {
          const retryAfter = error.details?.retryAfterSeconds;
          if (error.code === 'RATE_LIMITED' && typeof retryAfter === 'number') reply.header('retry-after', String(retryAfter));
          return reply.code(error.status).send(error.toEnvelope());
        }
        request.log.error(error);
        return reply.code(500).send(internalError().toEnvelope());
      }
    };
  }

  function consume(throttle: Throttle, key: string): void {
    const decision = throttle.consume(key);
    if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
  }

  const device = async (request: FastifyRequest) => {
    const key = await authenticateDevice(dependencies.db, request, 'live_feed', now);
    consume(deviceThrottle, key.id);
    return key;
  };

  // ── Users ───────────────────────────────────────────────────────────────────

  app.post('/api/v1/live/messages', handle(async (request, reply) => {
    const actor = await dependencies.authenticate(request);
    consume(sendThrottle, actor.id);
    const message = await repository.create(actor, request.body as never);
    return reply.code(201).send(message);
  }));

  app.get('/api/v1/live/messages/mine', handle(async (request) => {
    const actor = await dependencies.authenticate(request);
    return { items: await repository.listMine(actor) };
  }));

  // ── Streaming PC ───────────────────────────────────────────────────────────

  app.get('/api/v1/live/feed', handle(async (request) => {
    await device(request);
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    if (query.after !== undefined && !/^\d{1,18}$/.test(query.after)) {
      throw validationError('after must be a cursor returned by the feed', { field: 'after' });
    }
    const limit = query.limit === undefined ? FEED_DEFAULT_LIMIT : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > FEED_MAX_LIMIT) {
      throw validationError(`limit must be 1–${FEED_MAX_LIMIT}`, { field: 'limit' });
    }
    return repository.feed(query.after, limit);
  }));

  app.post('/api/v1/live/status', handle(async (request, reply) => {
    await device(request);
    const body = (request.body ?? {}) as Partial<LiveStatusRequest>;
    if (typeof body.id !== 'string' || typeof body.status !== 'string') {
      throw validationError('id and status are required');
    }
    await repository.setStatus(body.id, body.status, new Date(now()));
    return reply.code(204).send();
  }));

  // STREAM-PLAN-01: the plan marked current, for StreamControl's explicit import. Read-only, and
  // only broadcast content (titles, links, points) — no Reel data.
  app.get('/api/v1/live/stream', handle(async (request) => {
    await device(request);
    return { plan: await plans.currentForDevice() };
  }));
}

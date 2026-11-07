import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { CreateMonitorSourceRequest, MonitorRunFinishRequest, MonitorSourcePatchRequest } from '@szronox/contracts';

import { createThrottle, type Throttle } from '../auth/throttle.js';
import { rateLimited } from '../auth/service.js';
import { CoreError, internalError, validationError } from '../core/errors.js';
import { AiService } from '../ai/service.js';
import { CoreRepository } from '../core/repository.js';
import type { CoreDependencies } from '../core/routes.js';
import { authenticateDevice } from '../live/keys.js';
import { MonitorRepository } from './repository.js';

export const DEFAULT_MONITOR_DEVICE_THROTTLE = { limit: 240, windowMs: 60_000 } as const;

export interface MonitorRouteDependencies extends CoreDependencies {
  now?: () => number;
  deviceThrottle?: Throttle;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw validationError(`${field} must be a UUID`, { field });
  return value;
}

function requireDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw validationError('date must use YYYY-MM-DD', { field: 'date' });
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw validationError('date must use YYYY-MM-DD', { field: 'date' });
  }
  return value;
}

function parseBoundedInt(value: string | undefined, fallback: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw validationError(`${field} must be an integer from 1 to ${max}`, { field });
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw validationError(`${field} must be an integer from 1 to ${max}`, { field });
  }
  return parsed;
}

function todayInWarsaw(now: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function registerMonitorRoutes(app: FastifyInstance, dependencies: MonitorRouteDependencies): void {
  const repository = new MonitorRepository(dependencies.db);
  const now = dependencies.now ?? (() => Date.now());
  const deviceThrottle = dependencies.deviceThrottle ?? createThrottle({ ...DEFAULT_MONITOR_DEVICE_THROTTLE, now });

  const handle = (body: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('cache-control', 'no-store');
      try { return await body(request, reply); }
      catch (error) {
        if (error instanceof CoreError) {
          const retryAfter = error.details?.retryAfterSeconds;
          if (error.code === 'RATE_LIMITED' && typeof retryAfter === 'number') reply.header('retry-after', String(retryAfter));
          return reply.code(error.status).send(error.toEnvelope());
        }
        request.log.error(error);
        return reply.code(500).send(internalError().toEnvelope());
      }
    };

  const device = async (request: FastifyRequest) => {
    const key = await authenticateDevice(dependencies.db, request, 'monitor_collect', now);
    const decision = deviceThrottle.consume(key.id);
    if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
    return key;
  };

  // Browser routes: `authenticate` enforces the ordinary session, exact Origin and CSRF rules.
  app.get('/api/v1/monitor/sources', handle(async (request) => {
    await dependencies.authenticate(request);
    return { items: await repository.listSources() };
  }));

  app.post('/api/v1/monitor/sources', handle(async (request, reply) => {
    const actor = await dependencies.authenticate(request);
    const source = await repository.createSource(actor, (request.body ?? {}) as CreateMonitorSourceRequest);
    return reply.code(201).send(source);
  }));

  app.patch('/api/v1/monitor/sources/:id', handle(async (request) => {
    const actor = await dependencies.authenticate(request);
    const id = (request.params as { id: string }).id;
    return repository.patchSource(actor, id, (request.body ?? {}) as MonitorSourcePatchRequest);
  }));

  app.get('/api/v1/monitor/posts', handle(async (request) => {
    await dependencies.authenticate(request);
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const date = query.date === undefined ? todayInWarsaw(now()) : requireDate(query.date);
    if (query.group !== undefined && query.group.length > 80) throw validationError('group is too long', { field: 'group' });
    const limit = parseBoundedInt(query.limit, 50, 100, 'limit');
    return repository.listPosts({ date, group: query.group, platform: query.platform as 'facebook' | 'x' | undefined,
      sourceId: query.sourceId, before: query.before, limit });
  }));

  app.post('/api/v1/monitor/posts/:id/reel', handle(async (request, reply) => {
    const actor = await dependencies.authenticate(request);
    const postId = requireUuid((request.params as { id: string }).id, 'id');
    const body = (request.body ?? {}) as Record<string, unknown>;
    const operationId = requireUuid(body.operationId, 'operationId');
    const reelId = requireUuid(body.reelId, 'reelId');
    const postRows = await dependencies.db.query<{ id: string; url: string; text: string }>(
      'select id,url,text from app.monitor_posts where id=$1', [postId],
    );
    const post = postRows.rows[0];
    if (!post) throw new CoreError({ status: 404, code: 'NOT_FOUND', message: 'Monitor post not found' });
    const aiService = new AiService(dependencies.db);
    const autoDraft = dependencies.aiAutoDraft ?? { enabled: false, dailyLimit: 50 };
    const core = new CoreRepository(dependencies.db, async (tx, captureActor, reel) => {
      const attached = await tx.query(
        'update app.monitor_posts set reel_id=$1 where id=$2 and reel_id is null', [reel.id, postId],
      );
      if (attached.rowCount !== 1) {
        const latest = await tx.query<{ reel_id: string | null }>('select reel_id from app.monitor_posts where id=$1', [postId]);
        if (latest.rows[0]?.reel_id) throw validationError('This post already has a Reel', { reason: 'already_has_reel' });
        throw new Error('monitor post disappeared while creating its Reel');
      }
      await aiService.enqueueCaptureDraft(tx, captureActor, reel, autoDraft);
    });
    const reel = await core.createReel(actor, {
      operationId, reelId, input: { url: post.url, text: post.text, images: [] },
    });
    const metadata = reel.sourceMetadata;
    if (metadata?.state === 'pending' && dependencies.sourceMetadata) {
      void dependencies.sourceMetadata.enqueue(reel.id, metadata.requestId).catch(() => undefined);
    }
    return reply.code(201).send(reel);
  }));

  app.get('/api/v1/monitor/reports/:date', handle(async (request) => {
    await dependencies.authenticate(request);
    return repository.getReport(requireDate((request.params as { date: string }).date));
  }));

  app.post('/api/v1/monitor/reports/:date/regenerate', handle(async (request, reply) => {
    const actor = await dependencies.authenticate(request);
    const date = requireDate((request.params as { date: string }).date);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const operationId = requireUuid(body.operationId, 'operationId');
    return reply.code(202).send(await repository.regenerateReport(actor, date, operationId));
  }));

  // Device routes: only a monitor_collect key; authenticateDevice refuses cookies and Origin.
  app.get('/api/v1/monitor/collect/sources', handle(async (request) => {
    await device(request);
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const limit = parseBoundedInt(query.limit, 4, 20, 'limit');
    return repository.listCollectSources(limit);
  }));

  app.post('/api/v1/monitor/collect/runs', handle(async (request, reply) => {
    const key = await device(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const runId = requireUuid(body.runId, 'runId');
    return reply.code(201).send(await repository.startRun(key.id, runId));
  }));

  app.post('/api/v1/monitor/collect/posts', handle(async (request) => {
    const key = await device(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const runId = requireUuid(body.runId, 'runId');
    const sourceId = requireUuid(body.sourceId, 'sourceId');
    if (!Array.isArray(body.posts)) throw validationError('posts must be an array', { field: 'posts' });
    return repository.addPostBatch(key.id, runId, sourceId, body.posts);
  }));

  app.post('/api/v1/monitor/collect/runs/:runId/finish', handle(async (request, reply) => {
    const key = await device(request);
    const runId = requireUuid((request.params as { runId: string }).runId, 'runId');
    const body = (request.body ?? {}) as MonitorRunFinishRequest;
    await repository.finishRun(key.id, runId, body);
    return reply.code(204).send();
  }));
}

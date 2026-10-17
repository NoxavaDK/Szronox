/**
 * STREAM-PLAN-01 HTTP surface under /api/v1/stream-plans.
 *
 * Every route goes through the ordinary session seam (`authenticate`), which enforces Origin and
 * CSRF on unsafe methods like every other core route. The streaming PC's read of the current
 * plan is a `live_feed` device route registered with the other live routes (live/routes.ts).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { CreateStreamPlanRequest, UpdateStreamPlanRequest } from '@szronox/contracts';

import type { CoreDependencies } from '../core/routes.js';
import { CoreError, internalError, validationError } from '../core/errors.js';
import { CoreRepository } from '../core/repository.js';
import { StreamPlansRepository } from './repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw validationError(`${field} must be a UUID`, { field });
  return value.toLowerCase();
}

function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw validationError('expectedVersion must be a positive integer', { field: 'expectedVersion' });
  }
  return value;
}

export function registerStreamPlanRoutes(app: FastifyInstance, dependencies: CoreDependencies): void {
  const repository = new StreamPlansRepository(dependencies.db, new CoreRepository(dependencies.db));

  const handle = (body: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('cache-control', 'no-store');
      try { return await body(request, reply); }
      catch (error) {
        if (error instanceof CoreError) return reply.code(error.status).send(error.toEnvelope());
        request.log.error(error);
        return reply.code(500).send(internalError().toEnvelope());
      }
    };
  const planId = (request: FastifyRequest) => uuid((request.params as { id: string }).id);
  const bodyOf = (request: FastifyRequest) => (request.body ?? {}) as Record<string, unknown>;

  app.get('/api/v1/stream-plans', handle(async (request) => {
    await dependencies.authenticate(request);
    return { items: await repository.list() };
  }));

  // Registered before `/:id` so the literal segment is never read as an id.
  app.get('/api/v1/stream-plans/candidates', handle(async (request) => {
    await dependencies.authenticate(request);
    const q = (request.query as { q?: unknown } | undefined)?.q;
    if (q !== undefined && (typeof q !== 'string' || q.length > 200)) throw validationError('q must be text of at most 200 characters', { field: 'q' });
    return repository.candidates(q as string | undefined);
  }));

  app.get('/api/v1/stream-plans/:id', handle(async (request) => {
    await dependencies.authenticate(request);
    return repository.get(planId(request));
  }));

  app.post('/api/v1/stream-plans', handle(async (request, reply) => {
    const actor = await dependencies.authenticate(request);
    const body = bodyOf(request);
    const plan = await repository.create(actor, {
      operationId: uuid(body.operationId, 'operationId'), id: uuid(body.id), title: body.title,
      scheduledFor: body.scheduledFor,
    } as CreateStreamPlanRequest);
    return reply.code(201).send(plan);
  }));

  app.put('/api/v1/stream-plans/:id', handle(async (request) => {
    const actor = await dependencies.authenticate(request);
    const body = bodyOf(request);
    return repository.update(actor, planId(request), {
      ...body, operationId: uuid(body.operationId, 'operationId'), expectedVersion: version(body.expectedVersion),
    } as UpdateStreamPlanRequest);
  }));

  app.put('/api/v1/stream-plans/:id/current', handle(async (request) => {
    const actor = await dependencies.authenticate(request);
    const body = bodyOf(request);
    return repository.setCurrent(actor, planId(request), {
      operationId: uuid(body.operationId, 'operationId'), expectedVersion: version(body.expectedVersion), current: body.current as boolean,
    });
  }));

  // STREAM-PLAN-02: what is on air, polled by the screen, and switching the topic on air.
  app.get('/api/v1/stream-plans/:id/live', handle(async (request) => {
    await dependencies.authenticate(request);
    return repository.live(planId(request));
  }));

  app.put('/api/v1/stream-plans/:id/cue', handle(async (request) => {
    const actor = await dependencies.authenticate(request);
    const body = bodyOf(request);
    return repository.cue(actor, planId(request), { operationId: uuid(body.operationId, 'operationId'), topicId: body.topicId });
  }));

  app.delete('/api/v1/stream-plans/:id', handle(async (request) => {
    const actor = await dependencies.authenticate(request);
    const body = bodyOf(request);
    return repository.remove(actor, planId(request), {
      operationId: uuid(body.operationId, 'operationId'), expectedVersion: version(body.expectedVersion),
    });
  }));
}

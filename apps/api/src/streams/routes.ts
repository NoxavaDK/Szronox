/**
 * STREAM-01 HTTP surface: the five topic routes under `/api/v1/reels/:id/...`.
 *
 * Every route goes through the ordinary session seam (`authenticate`), which already enforces
 * Origin and CSRF on unsafe methods exactly like every other core route — this module adds no
 * second authorization path. Body/param shape is validated here; business rules (stream
 * membership, absorb/link conflicts, topic kind) live in `StreamsRepository`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AddStreamTopicRequest } from '@szronox/contracts';

import type { CoreDependencies } from '../core/routes.js';
import { CoreError, internalError, validationError } from '../core/errors.js';
import { CoreRepository } from '../core/repository.js';
import { StreamsRepository } from './repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw validationError(`${field} must be a UUID`, { field });
  return value;
}

function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw validationError('expectedVersion must be a positive integer', { field: 'expectedVersion' });
  }
  return value;
}

export function registerStreamRoutes(app: FastifyInstance, dependencies: CoreDependencies): void {
  const repository = new StreamsRepository(dependencies.db, new CoreRepository(dependencies.db));

  const handle = (body: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try { return await body(request, reply); }
      catch (error) {
        if (error instanceof CoreError) return reply.code(error.status).send(error.toEnvelope());
        request.log.error(error);
        return reply.code(500).send(internalError().toEnvelope());
      }
    };

  // ── POST /reels/:id/topics (absorb / link / new) ─────────────────────────────

  app.post('/api/v1/reels/:id/topics', handle(async (request, reply) => {
    const actor = await dependencies.authenticate(request);
    const streamId = uuid((request.params as { id: string }).id);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const operationId = uuid(body.operationId, 'operationId');
    const expectedVersion = version(body.expectedVersion);
    const mode = body.mode;

    let payload: AddStreamTopicRequest;
    let newTopicId: string | undefined;
    if (mode === 'absorb' || mode === 'link') {
      payload = { operationId, expectedVersion, mode, reelId: uuid(body.reelId, 'reelId') };
    } else if (mode === 'new') {
      if (typeof body.title !== 'string') throw validationError('title is required', { field: 'title' });
      if (body.link !== undefined && typeof body.link !== 'string') {
        throw validationError('link must be a string', { field: 'link' });
      }
      if (body.note !== undefined && typeof body.note !== 'string') {
        throw validationError('note must be a string', { field: 'note' });
      }
      newTopicId = uuid(body.topicId, 'topicId');
      payload = {
        operationId, expectedVersion, mode: 'new',
        topicId: newTopicId, reelId: uuid(body.reelId, 'reelId'), title: body.title,
        ...(body.link !== undefined ? { link: body.link as string } : {}),
        ...(body.note !== undefined ? { note: body.note as string } : {}),
      };
    } else {
      throw validationError('mode must be "absorb", "link" or "new"', { field: 'mode' });
    }

    const stream = await repository.addTopic(actor, streamId, payload);
    // SOURCE-01: a link given to `+ Nowy temat` enqueues metadata for the new idea after
    // commit, exactly like a normal capture with a URL.
    if (newTopicId && dependencies.sourceMetadata) {
      const topic = stream.topics.find((item) => item.id === newTopicId);
      if (topic?.source.sourceMetadata?.state === 'pending') {
        void dependencies.sourceMetadata.enqueue(topic.source.reelId, topic.source.sourceMetadata.requestId).catch(() => undefined);
      }
    }
    return reply.code(201).send(stream);
  }));

  // ── PATCH /reels/:id/topics/:topicId ──────────────────────────────────────────

  app.patch('/api/v1/reels/:id/topics/:topicId', handle(async (request) => {
    const actor = await dependencies.authenticate(request);
    const { id, topicId } = request.params as { id: string; topicId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const operationId = uuid(body.operationId, 'operationId');
    const expectedVersion = version(body.expectedVersion);
    if (body.changes === null || typeof body.changes !== 'object') throw validationError('changes is required');
    return repository.patchTopic(actor, uuid(id), uuid(topicId, 'topicId'), {
      operationId, expectedVersion, changes: body.changes as never,
    });
  }));

  // ── DELETE /reels/:id/topics/:topicId (Odłącz / remove reference) ────────────

  app.delete('/api/v1/reels/:id/topics/:topicId', handle(async (request) => {
    const actor = await dependencies.authenticate(request);
    const { id, topicId } = request.params as { id: string; topicId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const operationId = uuid(body.operationId, 'operationId');
    const expectedVersion = version(body.expectedVersion);
    return repository.removeTopic(actor, uuid(id), uuid(topicId, 'topicId'), { operationId, expectedVersion });
  }));

  // ── PUT /reels/:id/topic-order ─────────────────────────────────────────────────

  app.put('/api/v1/reels/:id/topic-order', handle(async (request) => {
    const actor = await dependencies.authenticate(request);
    const streamId = uuid((request.params as { id: string }).id);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const operationId = uuid(body.operationId, 'operationId');
    const expectedVersion = version(body.expectedVersion);
    if (!Array.isArray(body.topicIds)) throw validationError('topicIds must be an array', { field: 'topicIds' });
    const topicIds = body.topicIds.map((item, index) => uuid(item, `topicIds[${index}]`));
    return repository.reorderTopics(actor, streamId, { operationId, expectedVersion, topicIds });
  }));

  // ── GET /reels/:id/topic-candidates ───────────────────────────────────────────

  app.get('/api/v1/reels/:id/topic-candidates', handle(async (request) => {
    await dependencies.authenticate(request);
    const streamId = uuid((request.params as { id: string }).id);
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    return repository.topicCandidates(streamId, query.q);
  }));
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AiAction, ApplyAiRequest } from '@szronox/contracts';
import type { CoreDependencies } from '../core/routes.js';
import { CoreError, internalError, validationError } from '../core/errors.js';
import { AiService } from './service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw validationError('Expected UUID');
  return value;
}
function version(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw validationError('Expected positive version');
  return value;
}

export function registerAiRoutes(app: FastifyInstance, dependencies: CoreDependencies): void {
  const service = new AiService(dependencies.db);
  const handle = (body: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try { return await body(request, reply); }
      catch (error) {
        if (error instanceof CoreError) return reply.code(error.status).send(error.toEnvelope());
        request.log.error(error);
        return reply.code(500).send(internalError().toEnvelope());
      }
    };

  app.post('/api/v1/reels/:id/ai-runs', handle(async (request, reply) => {
    const actor = await dependencies.authenticate(request);
    if (!dependencies.aiEnabled) throw new CoreError({ status: 503, code: 'PROVIDER_UNAVAILABLE', message: 'AI capability is disabled', retryable: false });
    const id = uuid((request.params as { id: string }).id);
    const data = (request.body ?? {}) as Record<string, unknown>;
    const result = await service.enqueue(actor, id, {
      operationId: uuid(data.operationId), expectedVersion: version(data.expectedVersion),
      action: data.action as AiAction,
    });
    return reply.code(202).send(result);
  }));

  app.get('/api/v1/ai/capabilities', handle(async (request) => {
    await dependencies.authenticate(request);
    const version = await dependencies.db.query<{ id: string }>('select id from app.programme_versions where approved_at is not null limit 1');
    return { enabled: dependencies.aiEnabled === true, programmeIndexed: Boolean(version.rows[0]) };
  }));

  app.get('/api/v1/reels/:id/ai-runs/latest', handle(async (request) => {
    const actor = await dependencies.authenticate(request);
    const id = uuid((request.params as { id: string }).id);
    const action = (request.query as { action?: AiAction })?.action;
    if (action && !['develop', 'generate_hooks', 'fact_check', 'language_check', 'find_programme'].includes(action)) {
      throw validationError('Unknown AI action');
    }
    return { run: await service.latest(actor, id, action) };
  }));

  app.get('/api/v1/ai-runs/:id', handle(async (request) => {
    const actor = await dependencies.authenticate(request);
    return service.get(actor, uuid((request.params as { id: string }).id));
  }));

  app.post('/api/v1/ai-runs/:id/apply', handle(async (request) => {
    const actor = await dependencies.authenticate(request);
    const id = uuid((request.params as { id: string }).id);
    const data = (request.body ?? {}) as Record<string, unknown>;
    const selection = data.selection;
    if (typeof selection !== 'string') throw validationError('Selection required');
    const body = { ...data, operationId: uuid(data.operationId), expectedVersion: version(data.expectedVersion) } as ApplyAiRequest;
    return service.apply(actor, id, body);
  }));
}

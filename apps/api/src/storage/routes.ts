import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Database } from '../db/client.js';
import { CoreError, internalError, validationError } from '../core/errors.js';
import {
  type Actor,
  type AttachmentLimits,
  CoreRepository,
  DEFAULT_ATTACHMENT_LIMITS,
} from '../core/repository.js';
import {
  type StorageAdapter,
  StorageConflictError,
  StorageError,
  StorageInputError,
} from '../core/storage.js';

export interface AttachmentRouteDependencies {
  db: Database;
  storage: StorageAdapter;
  authenticate(request: FastifyRequest): Promise<Actor>;
  attachmentLimits?: AttachmentLimits;
  now?: () => Date;
  renewalLimit?: { attempts: number; windowMs: number; maxKeys?: number };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw validationError(`${field} must be a UUID`, { field });
  }
  return value;
}

class RenewalLimiter {
  private readonly attempts = new Map<string, number[]>();
  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
    private readonly maxKeys: number,
    private readonly now: () => Date,
  ) {}

  check(key: string): number | null {
    const current = this.now().getTime();
    const cutoff = current - this.windowMs;
    const recent = (this.attempts.get(key) ?? []).filter((value) => value > cutoff);
    if (recent.length >= this.maxAttempts) {
      return Math.max(1, Math.ceil((recent[0] + this.windowMs - current) / 1000));
    }
    recent.push(current);
    this.attempts.set(key, recent);
    if (this.attempts.size > this.maxKeys) {
      for (const [candidate, values] of this.attempts) {
        if (values.every((value) => value <= cutoff)) this.attempts.delete(candidate);
        if (this.attempts.size <= this.maxKeys) break;
      }
      if (this.attempts.size > this.maxKeys) this.attempts.delete(this.attempts.keys().next().value as string);
    }
    return null;
  }
}

function uploadExpired(): CoreError {
  return new CoreError({
    status: 422,
    code: 'UPLOAD_INCOMPLETE',
    message: 'Upload authorization expired',
    details: { reason: 'upload_authorization_expired' },
  });
}

/**
 * All attachment HTTP handlers consume one required request-authentication seam.
 * Its production implementation owns session validation and Origin/CSRF checks
 * for unsafe methods. There is intentionally no fallback or public test actor.
 */
export function registerAttachmentRoutes(
  app: FastifyInstance,
  dependencies: AttachmentRouteDependencies,
): void {
  const repository = new CoreRepository(dependencies.db);
  const limits = dependencies.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS;
  const now = dependencies.now ?? (() => new Date());
  const renewal = dependencies.renewalLimit ?? { attempts: 6, windowMs: 60_000, maxKeys: 512 };
  if (!Number.isInteger(renewal.attempts) || renewal.attempts < 1 || !Number.isInteger(renewal.windowMs)
      || renewal.windowMs < 1 || !Number.isInteger(renewal.maxKeys ?? 512) || (renewal.maxKeys ?? 512) < 1) {
    throw new Error('Invalid upload authorization renewal limiter configuration');
  }
  const limiter = new RenewalLimiter(renewal.attempts, renewal.windowMs, renewal.maxKeys ?? 512, now);

  // Return the raw request stream to the PUT handler. It is bounded while being
  // consumed by the storage adapter rather than buffered in memory.
  app.addContentTypeParser(
    /^(?:image\/(?:jpeg|png|webp)|application\/octet-stream)$/,
    (request, payload, done) => { void request; done(null, payload); },
  );

  function handle(body: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await body(request, reply);
      } catch (error) {
        if (error instanceof CoreError) {
          return reply.code(error.status).send(error.toEnvelope());
        }
        if (error instanceof StorageInputError) {
          const mapped = validationError(error.message, { reason: error.reason });
          return reply.code(mapped.status).send(mapped.toEnvelope());
        }
        if (error instanceof StorageConflictError) {
          const mapped = new CoreError({
            status: 409,
            code: 'UPLOAD_INCOMPLETE',
            message: error.message,
            details: { reason: error.reason },
          });
          return reply.code(mapped.status).send(mapped.toEnvelope());
        }
        if (error instanceof StorageError) {
          request.log.error(error);
          const mapped = internalError('Private storage operation failed');
          return reply.code(mapped.status).send(mapped.toEnvelope());
        }
        request.log.error(error);
        const mapped = internalError();
        return reply.code(mapped.status).send(mapped.toEnvelope());
      }
    };
  }

  app.post('/api/v1/reels/:id/attachments/initiate', handle(async (request, reply) => {
    const actor = await dependencies.authenticate(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const operationId = requireUuid(body.operationId, 'operationId');
    const attachmentId = requireUuid(body.attachmentId, 'attachmentId');
    if (typeof body.fileName !== 'string' || body.fileName === '') throw validationError('fileName is required');
    if (typeof body.mimeType !== 'string') throw validationError('mimeType is required');
    if (typeof body.byteSize !== 'number') throw validationError('byteSize must be a number');
    const result = await repository.initiateAttachment(actor, requireUuid(id, 'id'), {
      operationId,
      attachmentId,
      fileName: body.fileName,
      mimeType: body.mimeType,
      byteSize: body.byteSize,
      purpose: body.purpose as never,
    }, limits, dependencies.storage);
    return reply.code(201).send(result);
  }));

  app.put('/api/v1/reels/:id/attachments/:attachmentId/content', {
    bodyLimit: limits.maxByteSize + 1,
  }, handle(async (request, reply) => {
    const actor = await dependencies.authenticate(request);
    const { id, attachmentId } = request.params as { id: string; attachmentId: string };
    const token = request.headers['x-upload-token'];
    if (typeof token !== 'string') throw validationError('X-Upload-Token header is required');
    const plan = await repository.authorizeAttachmentUpload(
      actor,
      requireUuid(id, 'id'),
      requireUuid(attachmentId, 'attachmentId'),
      token,
      now(),
    );
    const contentLength = request.headers['content-length'];
    if (contentLength !== undefined && Number(contentLength) !== plan.byteSize) {
      throw validationError('Content-Length does not match the declared attachment size');
    }
    if (!dependencies.storage.writeObject) throw new StorageError('Configured storage cannot receive content');
    const object = await dependencies.storage.writeObject(
      plan.storageKey,
      request.body as NodeJS.ReadableStream as never,
      {
        mimeType: plan.mimeType,
        byteSize: plan.byteSize,
        maxByteSize: limits.maxByteSize,
        maxPixelCount: limits.maxPixelCount,
        maxDimension: limits.maxDimension,
      },
    );
    if (now().getTime() >= plan.expiresAt.getTime()) throw uploadExpired();
    await repository.recordValidatedAttachmentUpload(plan, object);
    return reply.code(204).send();
  }));

  app.post('/api/v1/reels/:id/attachments/:attachmentId/upload-authorization', handle(async (request, reply) => {
    const actor = await dependencies.authenticate(request);
    const { id, attachmentId } = request.params as { id: string; attachmentId: string };
    const body = request.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body as object).length !== 0) {
      throw validationError('Upload authorization renewal body must be an empty JSON object');
    }
    const retryAfter = limiter.check(`${actor.id}:${attachmentId}`);
    if (retryAfter !== null) {
      reply.header('Retry-After', String(retryAfter));
      throw new CoreError({ status: 429, code: 'RATE_LIMITED', message: 'Upload authorization renewal rate limit exceeded', retryable: true });
    }
    return repository.renewAttachmentUpload(
      actor,
      requireUuid(id, 'id'),
      requireUuid(attachmentId, 'attachmentId'),
      dependencies.storage,
    );
  }));

  app.post('/api/v1/reels/:id/attachments/:attachmentId/complete', handle(async (request) => {
    const actor = await dependencies.authenticate(request);
    const { id, attachmentId } = request.params as { id: string; attachmentId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const operationId = requireUuid(body.operationId, 'operationId');
    return repository.completeAttachment(
      actor,
      requireUuid(id, 'id'),
      requireUuid(attachmentId, 'attachmentId'),
      { operationId },
      dependencies.storage,
    );
  }));

  app.get('/api/v1/reels/:id/attachments/:attachmentId/content', handle(async (request, reply) => {
    const actor = await dependencies.authenticate(request);
    const { id, attachmentId } = request.params as { id: string; attachmentId: string };
    const plan = await repository.resolveAttachmentDownload(
      actor,
      requireUuid(id, 'id'),
      requireUuid(attachmentId, 'attachmentId'),
    );
    if (!dependencies.storage.openObject) throw new StorageError('Configured storage cannot read content');
    const opened = await dependencies.storage.openObject(plan.storageKey);
    if (opened.object.mimeType !== plan.mimeType || opened.object.byteSize !== plan.byteSize) {
      opened.stream.destroy();
      throw new StorageError('Stored object no longer matches validated database metadata');
    }
    const safeName = plan.fileName.replace(/[\r\n]/g, '_');
    reply.headers({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': plan.mimeType,
      'Content-Length': String(plan.byteSize),
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    });
    return reply.send(opened.stream);
  }));
}

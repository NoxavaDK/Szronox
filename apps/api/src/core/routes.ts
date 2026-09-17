/**
 * Core HTTP surface under /api/v1.
 *
 * Exported as `registerCoreRoutes(app, dependencies)` for the lead to register.
 * This module never touches app.ts, index.ts or the shutdown path, and it composes
 * nothing global: everything it needs arrives in `dependencies`.
 *
 * Every route requires a verified, allowlisted actor. There is no anonymous or
 * third-user path, and no route accepts a privileged key from a browser.
 *
 * VPS-01 replaced the token verifier with a session seam: `authenticate` resolves
 * the actor from the server's own session record and additionally enforces Origin
 * and CSRF on unsafe methods, so a request body still cannot state who it is and
 * there is no second bearer-token authorization path.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { RequestAuthenticator, VerifiedActor } from '../auth/service.js';
import { CoreError, internalError, validationError } from './errors.js';
import {
  type Actor,
  type AttachmentLimits,
  CoreRepository,
  DEFAULT_ATTACHMENT_LIMITS,
} from './repository.js';
import type { StorageAdapter } from './storage.js';
import type { Database } from '../db/client.js';
import { registerAttachmentRoutes } from '../storage/routes.js';

export interface CoreDependencies {
  db: Database;
  /** Resolves the session cookie to an actor, or throws the shared 401/403 envelope. */
  authenticate: RequestAuthenticator;
  storage: StorageAdapter;
  attachmentLimits?: AttachmentLimits;
  /** The two allowlisted users, for /me peer identity. */
  allowlist: Array<{ id: string; name: 'NOXAVA' | 'SZRON'; avatarUrl?: string | null }>;
  aiEnabled?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw validationError(`${field} must be a UUID`, { field });
  }
  return value;
}

function requireMutationContext(body: unknown): { operationId: string; expectedVersion: number } {
  const source = (body ?? {}) as Record<string, unknown>;
  const operationId = requireUuid(source.operationId, 'operationId');
  const expectedVersion = source.expectedVersion;
  if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw validationError('expectedVersion must be a positive integer');
  }
  return { operationId, expectedVersion };
}

export function registerCoreRoutes(app: FastifyInstance, dependencies: CoreDependencies): void {
  const repository = new CoreRepository(dependencies.db);
  const limits = dependencies.attachmentLimits ?? DEFAULT_ATTACHMENT_LIMITS;

  /**
   * Resolve the actor from the session, or throw. The seam already collapses every
   * failure reason into the shared envelope, so nothing about why a session was
   * refused is echoed back to the caller.
   */
  async function actorOf(request: FastifyRequest): Promise<Actor> {
    return dependencies.authenticate(request);
  }

  /** One error funnel, so every route answers with the shared envelope. */
  function handle(body: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await body(request, reply);
      } catch (error) {
        if (error instanceof CoreError) {
          return reply.code(error.status).send(error.toEnvelope());
        }
        // Unexpected failures are logged server-side and reduced to a generic
        // envelope: no driver message, SQL fragment or stack reaches the client.
        request.log.error(error);
        return reply.code(500).send(internalError().toEnvelope());
      }
    };
  }

  // GET /me is registered by registerAuthRoutes with full session metadata.

  // ── List and detail ────────────────────────────────────────────────────────

  app.get('/api/v1/reels', handle(async (request) => {
    await actorOf(request);
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    const statuses = ['idea', 'to_record', 'editing', 'ready', 'published'];
    if (query.status !== undefined && !statuses.includes(query.status)) {
      throw validationError('Unknown status filter', { status: query.status });
    }
    // An unknown visibility is refused rather than silently treated as active,
    // which would quietly return the wrong set.
    if (query.visibility !== undefined && query.visibility !== 'active' && query.visibility !== 'deleted') {
      throw validationError('visibility must be "active" or "deleted"', { visibility: query.visibility });
    }
    const limit = query.limit === undefined ? undefined : Number(query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw validationError('limit must be a positive integer');
    }
    // Both Reels are shared: either allowlisted user sees the same list.
    return repository.listReels({
      status: query.status as never,
      visibility: (query.visibility as never) ?? 'active',
      overdue: query.overdue === 'true',
      limit,
      cursor: query.cursor,
    });
  }));

  app.get('/api/v1/reels/:id', handle(async (request) => {
    await actorOf(request);
    const { id } = request.params as { id: string };
    const query = (request.query ?? {}) as Record<string, string | undefined>;
    // Deliberate opt-in, so the restore surface can load a deleted Reel while an
    // ordinary detail request still treats it as gone.
    return repository.getReel(requireUuid(id, 'id'), {
      includeDeleted: query.includeDeleted === 'true',
    });
  }));

  // ── Capture ────────────────────────────────────────────────────────────────

  app.post('/api/v1/reels', handle(async (request, reply) => {
    const actor = await actorOf(request);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const operationId = requireUuid(body.operationId, 'operationId');
    const reelId = requireUuid(body.reelId, 'reelId');
    const input = body.input;
    if (input === null || typeof input !== 'object') throw validationError('input is required');
    const capture = input as Record<string, unknown>;
    if (!Array.isArray(capture.images)) throw validationError('input.images must be an array');

    const reel = await repository.createReel(actor, {
      operationId,
      reelId,
      input: capture as never,
      initialHook: typeof body.initialHook === 'string' ? body.initialHook : undefined,
      priority: body.priority as never,
    });
    return reply.code(201).send(reel);
  }));

  // ── Scalar patch ───────────────────────────────────────────────────────────

  app.patch('/api/v1/reels/:id', handle(async (request) => {
    const actor = await actorOf(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const context = requireMutationContext(body);
    if (body.changes === null || typeof body.changes !== 'object') {
      throw validationError('changes is required');
    }
    return repository.patchReel(actor, requireUuid(id, 'id'), {
      ...context,
      changes: body.changes as Record<string, unknown>,
    });
  }));

  // ── Soft delete and restore ────────────────────────────────────────────────

  for (const action of ['delete', 'restore'] as const) {
    app.post(`/api/v1/reels/:id/${action}`, handle(async (request) => {
      const actor = await actorOf(request);
      const { id } = request.params as { id: string };
      const context = requireMutationContext(request.body);
      return repository.setDeleted(actor, requireUuid(id, 'id'), context, action === 'delete');
    }));
  }

  // ── Hooks ──────────────────────────────────────────────────────────────────

  app.post('/api/v1/reels/:id/hooks', handle(async (request, reply) => {
    const actor = await actorOf(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const context = requireMutationContext(body);
    if (body.position !== undefined && typeof body.position !== 'number') {
      throw validationError('position must be a number when provided');
    }
    const result = await repository.addHook(actor, requireUuid(id, 'id'), {
      ...context,
      text: body.text as string,
      position: body.position as number | undefined,
    });
    return reply.code(201).send(result);
  }));

  app.patch('/api/v1/reels/:id/hooks/:hookId', handle(async (request) => {
    const actor = await actorOf(request);
    const { id, hookId } = request.params as { id: string; hookId: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const context = requireMutationContext(body);
    return repository.editHook(actor, requireUuid(id, 'id'), requireUuid(hookId, 'hookId'), {
      ...context,
      text: body.text as string,
    });
  }));

  app.delete('/api/v1/reels/:id/hooks/:hookId', handle(async (request) => {
    const actor = await actorOf(request);
    const { id, hookId } = request.params as { id: string; hookId: string };
    const context = requireMutationContext(request.body);
    return repository.removeHook(actor, requireUuid(id, 'id'), requireUuid(hookId, 'hookId'), context);
  }));

  // ── Export reference and verification ──────────────────────────────────────

  app.post('/api/v1/reels/:id/current-export', handle(async (request) => {
    const actor = await actorOf(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const context = requireMutationContext(body);
    if (body.export === null || typeof body.export !== 'object') {
      throw validationError('export is required');
    }
    return repository.replaceExport(actor, requireUuid(id, 'id'), {
      ...context,
      export: body.export as never,
    });
  }));

  app.post('/api/v1/reels/:id/verification', handle(async (request) => {
    const actor = await actorOf(request);
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const context = requireMutationContext(body);
    if (typeof body.exportRevision !== 'number' || !Number.isInteger(body.exportRevision)) {
      throw validationError('exportRevision must be an integer');
    }
    return repository.verifyExport(actor, requireUuid(id, 'id'), {
      ...context,
      exportRevision: body.exportRevision,
    });
  }));

  // ── Bounded private attachment lifecycle ───────────────────────────────────
  registerAttachmentRoutes(app, {
    db: dependencies.db,
    storage: dependencies.storage,
    attachmentLimits: limits,
    authenticate: actorOf,
  });
}

export type { VerifiedActor };
export type { StorageAdapter };

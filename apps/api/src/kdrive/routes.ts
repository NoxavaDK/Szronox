/**
 * KDRIVE-01 routes (T00):
 *
 *   POST /api/v1/reels/:id/kdrive-folder   explicit create/link command, version-checked, idempotent
 *   GET  /api/v1/reels/:id/kdrive-folder   resolve the stored reference; distinguishes
 *                                          none / available / missing / access_denied / unavailable
 *
 * Both require the same verified session as every core route (the POST also its CSRF/Origin
 * checks, enforced by `authenticate`). Provider details are reduced to the shared envelope.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { KdriveFolderRequest } from '@szronox/contracts';

import { CoreError, internalError, validationError } from '../core/errors.js';
import { CoreRepository } from '../core/repository.js';
import type { CoreDependencies } from '../core/routes.js';
import { httpKdriveClient, type KdriveClient } from './client.js';
import { kdriveService } from './service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID = /^\d{1,20}$/;

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw validationError(`${field} must be a UUID`, { field });
  return value;
}

export function parseKdriveRequest(body: unknown): KdriveFolderRequest {
  const source = (body ?? {}) as Record<string, unknown>;
  const operationId = uuid(source.operationId, 'operationId');
  const expectedVersion = source.expectedVersion;
  if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw validationError('expectedVersion must be a positive integer');
  }
  if (source.mode === 'create') return { operationId, expectedVersion, mode: 'create' };
  if (source.mode === 'link') {
    const folderId = typeof source.folderId === 'number' ? String(source.folderId) : source.folderId;
    if (typeof folderId !== 'string' || !NUMERIC_ID.test(folderId)) throw validationError('folderId must be a numeric kDrive id', { field: 'folderId' });
    return { operationId, expectedVersion, mode: 'link', folderId };
  }
  throw validationError('mode must be "create" or "link"', { field: 'mode' });
}

export function registerKdriveRoutes(app: FastifyInstance, dependencies: CoreDependencies, clientOverride?: KdriveClient): void {
  const config = dependencies.kdrive ?? null;
  const service = kdriveService({
    repository: new CoreRepository(dependencies.db),
    settings: config ? { driveId: config.driveId, rootFolderId: config.rootFolderId } : null,
    client: config ? clientOverride ?? httpKdriveClient({ driveId: config.driveId, token: config.token }) : null,
  });

  const handle = (body: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await body(request, reply);
      } catch (error) {
        if (error instanceof CoreError) return reply.code(error.status).send(error.toEnvelope());
        request.log.error(error);
        return reply.code(500).send(internalError().toEnvelope());
      }
    };

  app.get('/api/v1/reels/:id/kdrive-folder', handle(async (request) => {
    await dependencies.authenticate(request);
    const { id } = request.params as { id: string };
    return service.resolve(uuid(id, 'id'));
  }));

  app.post('/api/v1/reels/:id/kdrive-folder', handle(async (request) => {
    const actor = await dependencies.authenticate(request);
    const { id } = request.params as { id: string };
    return service.command(actor, uuid(id, 'id'), parseKdriveRequest(request.body));
  }));
}

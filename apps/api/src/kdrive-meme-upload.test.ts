import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import Fastify, { type FastifyRequest } from 'fastify';

import { pgliteDatabase } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';
import { forbidden, unauthenticated } from './core/errors.js';
import { CoreRepository } from './core/repository.js';
import { memoryStorageAdapter } from './core/storage.js';
import { registerAttachmentRoutes } from './storage/routes.js';

const actor = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' as const };
const origin = 'https://szronox.test';
const csrf = 'test-only-csrf';

test('MEME-UPLOAD rejects JSON Content-Type before Fastify parses binary content', async () => {
  const db = pgliteDatabase(await PGlite.create());
  await migrate(db);
  await seedUsers(db, [actor, { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' }]);
  const app = Fastify({ logger: false });
  const storage = memoryStorageAdapter();
  registerAttachmentRoutes(app, {
    db, storage,
    async authenticate(request: FastifyRequest) {
      if (request.headers['x-test-actor'] !== actor.id) throw unauthenticated();
      if (request.method !== 'GET' && (request.headers.origin !== origin || request.headers['x-csrf-token'] !== csrf)) throw forbidden('Unsafe test request');
      return actor;
    },
  });
  await app.ready();
  try {
    const reelId = randomUUID();
    await new CoreRepository(db).createReel(actor, { operationId: randomUUID(), reelId, input: { text: 'Mem', images: [] } });
    const attachmentId = randomUUID();
    const initiated = await app.inject({
      method: 'POST', url: `/api/v1/reels/${reelId}/attachments/initiate`,
      headers: { 'x-test-actor': actor.id, origin, 'x-csrf-token': csrf },
      payload: { operationId: randomUUID(), attachmentId, fileName: 'meme.png', mimeType: 'image/png', byteSize: 4, purpose: 'material' },
    });
    assert.equal(initiated.statusCode, 201, initiated.body);
    const token = initiated.json().upload.headers['X-Upload-Token'];
    const response = await app.inject({
      method: 'PUT', url: `/api/v1/reels/${reelId}/attachments/${attachmentId}/content`,
      headers: { 'x-test-actor': actor.id, origin, 'x-csrf-token': csrf, 'x-upload-token': token, 'content-type': 'application/json' },
      payload: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().error.code, 'VALIDATION_ERROR');
    assert.deepEqual(response.json().error.details, { reason: 'content_type_mismatch' });
  } finally {
    await app.close();
    await db.close();
  }
});

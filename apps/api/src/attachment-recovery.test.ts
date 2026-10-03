import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import sharp from 'sharp';

import { CoreRepository, DEFAULT_ATTACHMENT_LIMITS, payloadHash } from './core/repository.js';
import { memoryStorageAdapter, UPLOAD_TOKEN_HEADER } from './core/storage.js';
import { pgliteDatabase } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';
import { filesystemStorageAdapter, initializeDisposableStorageRoot } from './storage/filesystem.js';

const NOXAVA = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' as const };
const SZRON = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' as const };

async function fixture() {
  const db = pgliteDatabase(await PGlite.create()); await migrate(db); await seedUsers(db, [NOXAVA, SZRON]);
  return { db, repo: new CoreRepository(db), storage: memoryStorageAdapter() };
}

test('an image initiation queued before MEME-VIDEO-01 (hashed without kind) replays instead of 409', async () => {
  const { db, repo, storage } = await fixture();
  try {
    const reelId = randomUUID();
    await repo.createReel(NOXAVA, { operationId: randomUUID(), reelId, input: { text: 'pomysł', images: [] } });
    const request = { operationId: randomUUID(), attachmentId: randomUUID(), fileName: '67693.jpg', mimeType: 'image/jpeg', byteSize: 275090 };
    const first = await repo.initiateAttachment(NOXAVA, reelId, request, DEFAULT_ATTACHMENT_LIMITS, storage);
    // Rewrite the recorded hash to the pre-MEME-VIDEO-01 shape, exactly as DEV holds it.
    await db.query('update app.operations set payload_hash=$1 where operation_id=$2', [payloadHash(request), request.operationId]);
    const replay = await repo.initiateAttachment(NOXAVA, reelId, request, DEFAULT_ATTACHMENT_LIMITS, storage);
    assert.equal(replay.attachment.id, first.attachment.id);
    // A genuinely different payload under the same operation id is still a conflict.
    await assert.rejects(
      () => repo.initiateAttachment(NOXAVA, reelId, { ...request, byteSize: 1 }, DEFAULT_ATTACHMENT_LIMITS, storage),
      (error: { status?: number }) => error.status === 409,
    );
  } finally { await db.close(); }
});

test('an image declared as JPEG but decoded as WebP is stored and recorded as WebP', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'szronox-decoded-'));
  const root = path.join(parent, 'storage');
  await initializeDisposableStorageRoot(root);
  const files = filesystemStorageAdapter({ root, appOrigin: 'https://szronox.test', expectedUid: process.getuid?.(), expectedGid: process.getgid?.() });
  await files.initialize();
  const { db, repo, storage } = await fixture();
  try {
    const webp = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#3a7' } }).webp().toBuffer();
    const object = await files.writeObject!('reels/test/disguised', Readable.from([webp]), {
      mimeType: 'image/jpeg', kind: 'image', byteSize: webp.length, maxByteSize: 8 * 1024 * 1024,
      maxPixelCount: 40_000_000, maxDimension: 20_000,
    });
    assert.equal(object.mimeType, 'image/webp');

    const reelId = randomUUID();
    await repo.createReel(NOXAVA, { operationId: randomUUID(), reelId, input: { text: 'pomysł', images: [] } });
    const initiated = await repo.initiateAttachment(NOXAVA, reelId, {
      operationId: randomUUID(), attachmentId: randomUUID(), fileName: '67945.jpg', mimeType: 'image/jpeg', byteSize: webp.length,
    }, DEFAULT_ATTACHMENT_LIMITS, storage);
    const token = Object.entries(initiated.upload.headers).find(([name]) => name.toLowerCase() === UPLOAD_TOKEN_HEADER.toLowerCase())![1];
    const plan = await repo.authorizeAttachmentUpload(NOXAVA, reelId, initiated.attachment.id, token, new Date());
    await repo.recordValidatedAttachmentUpload(plan, object);
    const row = await db.query<{ validated_mime_type: string }>('select validated_mime_type from app.attachments where id=$1', [initiated.attachment.id]);
    assert.equal(row.rows[0].validated_mime_type, 'image/webp');
  } finally { await db.close(); await rm(parent, { recursive: true, force: true }); }
});

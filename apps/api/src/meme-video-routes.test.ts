import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import { PGlite } from '@electric-sql/pglite';

import { pgliteDatabase } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';
import { unauthenticated } from './core/errors.js';
import { CoreRepository } from './core/repository.js';
import type { StorageAdapter } from './core/storage.js';
import { registerLibraryRoutes } from './ai/library.js';
import type { CoreDependencies } from './core/routes.js';
import { filesystemStorageAdapter, initializeDisposableStorageRoot } from './storage/filesystem.js';
import { registerAttachmentRoutes } from './storage/routes.js';

const actor = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' as const };
const video = Buffer.from('0123456789abcdef');
const poster = Buffer.from('poster-bytes');

test('video meme creation, optional poster, authenticated media ranges and aliases', async () => {
  const db = pgliteDatabase(await PGlite.create());
  await migrate(db);
  await seedUsers(db, [actor, { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' }]);
  const objects = new Map([['video-key', video], ['video-2-key', video], ['poster-key', poster]]);
  const storage = {
    async initialize() {}, async statObject() { return { exists: false, byteSize: 0 }; },
    async createSignedUpload() { throw new Error('not used'); },
    async openObject(key: string) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error('missing test object');
      return { object: { exists: true as const, byteSize: bytes.length, mimeType: key.startsWith('video') ? 'video/mp4' : 'image/png', contentHash: 'test-hash' }, stream: Readable.from([bytes]) };
    },
  } as StorageAdapter;
  const deps: CoreDependencies = {
    db, storage,
    async authenticate(request: FastifyRequest) { if (request.headers['x-test-actor'] !== actor.id) throw unauthenticated(); return actor; },
    allowlist: [actor, { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' }],
    kdrive: null,
  };
  const app = Fastify({ logger: false });
  registerLibraryRoutes(app, deps, { startRetryLoop() {}, async enqueue() {}, async retry() {} });
  await app.ready();
  try {
    const reelId = randomUUID();
    await new CoreRepository(db).createReel(actor, { operationId: randomUUID(), reelId, input: { text: 'video meme', images: [] } });
    const videoId = randomUUID(), posterId = randomUUID();
    await db.query(`insert into app.attachments(id,reel_id,purpose,kind,label,storage_key,state,validated_mime_type,validated_width,validated_height,validated_pixel_count,validated_at)
      values($1,$3,'meme','video','clip.mp4','video-key','ready','video/mp4',null,null,null,now()),
            ($2,$3,'meme','image','poster.png','poster-key','ready','image/png',1,1,1,now())`, [videoId, posterId, reelId]);
    const request = (path: string, payload?: unknown, headers: Record<string, string> = { 'x-test-actor': actor.id }) =>
      app.inject({ method: payload ? 'POST' : 'GET', url: path, ...(payload ? { payload } : {}), headers });
    const badBoth = await request('/api/v1/memes', { operationId: randomUUID(), name: 'both', imageAssetId: posterId, videoAssetId: videoId, attachToReel: { reelId, expectedVersion: 1 } });
    assert.equal(badBoth.statusCode, 422);
    const badNeither = await request('/api/v1/memes', { operationId: randomUUID(), name: 'neither', attachToReel: { reelId, expectedVersion: 1 } });
    assert.equal(badNeither.statusCode, 422);
    const created = await request('/api/v1/memes', { operationId: randomUUID(), name: 'Video', videoAssetId: videoId, posterAssetId: posterId, attachToReel: { reelId, expectedVersion: 1 } });
    assert.equal(created.statusCode, 201, created.body);
    const meme = created.json().meme;
    assert.equal(meme.mediaKind, 'video');
    assert.equal(meme.mimeType, 'video/mp4');
    assert.equal(meme.thumbnailRef, `/api/v1/memes/${meme.id}/thumbnail`);
    const full = await request(meme.assetRef);
    assert.equal(full.statusCode, 200); assert.equal(full.body, video.toString());
    assert.equal(full.headers['accept-ranges'], 'bytes'); assert.equal(full.headers['x-content-type-options'], 'nosniff');
    for (const [range, expected] of [['bytes=0-3', '0123'], ['bytes=4-', '456789abcdef'], ['bytes=-3', 'def']] as const) {
      const response = await request(meme.assetRef, undefined, { 'x-test-actor': actor.id, range });
      assert.equal(response.statusCode, 206); assert.equal(response.body, expected);
      assert.match(response.headers['content-range'] ?? '', /^bytes \d+-\d+\/16$/);
    }
    const invalidRange = await request(meme.assetRef, undefined, { 'x-test-actor': actor.id, range: 'bytes=99-' });
    assert.equal(invalidRange.statusCode, 416); assert.equal(invalidRange.headers['content-range'], 'bytes */16');
    const noAuth = await request(meme.assetRef, undefined, {});
    assert.equal(noAuth.statusCode, 401);
    const thumbnailResponse = await request(meme.thumbnailRef);
    assert.equal(thumbnailResponse.statusCode, 200); assert.equal(thumbnailResponse.body, poster.toString());

    const noPosterId = randomUUID();
    await db.query(`insert into app.attachments(id,reel_id,purpose,kind,label,storage_key,state,validated_mime_type,validated_at)
      values($1,$2,'meme','video','clip.webm','video-2-key','ready','video/webm',now())`, [noPosterId, reelId]);
    const withoutPoster = await request('/api/v1/memes', { operationId: randomUUID(), name: 'No poster', videoAssetId: noPosterId, attachToReel: { reelId, expectedVersion: 2 } });
    assert.equal(withoutPoster.statusCode, 201, withoutPoster.body);
    assert.equal(withoutPoster.json().meme.thumbnailRef, null);
    const missingThumbnail = await request(`/api/v1/memes/${withoutPoster.json().meme.id}/thumbnail`);
    assert.equal(missingThumbnail.statusCode, 404);
  } finally { await app.close(); await db.close(); }
});

test('generic video MIME is validated, derived, completed and carried into Meme creation', async () => {
  const db = pgliteDatabase(await PGlite.create());
  await migrate(db);
  await seedUsers(db, [actor, { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' }]);
  const parent = await mkdtemp(path.join(os.tmpdir(), 'szronox-video-lifecycle-'));
  const root = path.join(parent, 'storage');
  await initializeDisposableStorageRoot(root);
  const storage = filesystemStorageAdapter({ root, appOrigin: 'https://szronox.test', expectedUid: process.getuid?.(), expectedGid: process.getgid?.() });
  await storage.initialize();
  const authenticate = async (request: FastifyRequest) => {
    if (request.headers['x-test-actor'] !== actor.id) throw unauthenticated();
    return actor;
  };
  const deps: CoreDependencies = {
    db, storage, authenticate,
    allowlist: [actor, { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' }], kdrive: null,
  };
  const app = Fastify({ logger: false });
  registerAttachmentRoutes(app, { db, storage, authenticate });
  registerLibraryRoutes(app, deps, { startRetryLoop() {}, async enqueue() {}, async retry() {} });
  await app.ready();
  try {
    const reelId = randomUUID(), attachmentId = randomUUID();
    const derivedVideo = Buffer.from([0,0,0,16,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,0,0]);
    await new CoreRepository(db).createReel(actor, { operationId: randomUUID(), reelId, input: { text: 'generic video MIME', images: [] } });
    const headers = { 'x-test-actor': actor.id };
    const initiated = await app.inject({ method: 'POST', url: `/api/v1/reels/${reelId}/attachments/initiate`, headers,
      payload: { operationId: randomUUID(), attachmentId, fileName: 'clip.bin', mimeType: 'application/octet-stream', byteSize: derivedVideo.length, purpose: 'meme', kind: 'video' } });
    assert.equal(initiated.statusCode, 201, initiated.body);
    const upload = initiated.json().upload;
    const uploaded = await app.inject({ method: 'PUT', url: `/api/v1/reels/${reelId}/attachments/${attachmentId}/content`, headers: {
      ...headers, 'x-upload-token': upload.headers['X-Upload-Token'], 'content-type': 'application/octet-stream', 'content-length': String(derivedVideo.length),
    }, payload: derivedVideo });
    assert.equal(uploaded.statusCode, 204, uploaded.body);
    const completed = await app.inject({ method: 'POST', url: `/api/v1/reels/${reelId}/attachments/${attachmentId}/complete`, headers,
      payload: { operationId: randomUUID() } });
    assert.equal(completed.statusCode, 200, completed.body);
    const metadata = await db.query<{ validated_mime_type: string }>('select validated_mime_type from app.attachments where id=$1', [attachmentId]);
    assert.equal(metadata.rows[0].validated_mime_type, 'video/mp4');
    const created = await app.inject({ method: 'POST', url: '/api/v1/memes', headers,
      payload: { operationId: randomUUID(), name: 'Derived MIME', videoAssetId: attachmentId, attachToReel: { reelId, expectedVersion: 1 } } });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().meme.mimeType, 'video/mp4');
  } finally { await app.close(); await db.close(); await rm(parent, { recursive: true, force: true }); }
});

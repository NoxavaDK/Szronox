import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import Fastify, { type FastifyRequest } from 'fastify';
import sharp from 'sharp';

import { type Database, pgliteDatabase } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';
import { CoreError, forbidden, unauthenticated } from './core/errors.js';
import { CoreRepository, DEFAULT_ATTACHMENT_LIMITS } from './core/repository.js';
import { digestUploadToken } from './core/storage.js';
import { filesystemStorageAdapter, initializeDisposableStorageRoot } from './storage/filesystem.js';
import { registerAttachmentRoutes } from './storage/routes.js';

const NOXAVA = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' as const };
const SZRON = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' as const };
const ORIGIN = 'https://szronox.test';
const CSRF = 'test-only-csrf';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');

async function applyStorageMigration(db: Database): Promise<void> {
  const sql = await readFile(path.join(repositoryRoot, 'database/migrations/0004_vps_storage.sql'), 'utf8');
  await db.transaction((tx) => tx.execScript(sql));
}

async function createFixture(options: {
  now?: () => Date;
  renewalLimit?: { attempts: number; windowMs: number; maxKeys?: number };
  limits?: typeof DEFAULT_ATTACHMENT_LIMITS;
} = {}) {
  const db = pgliteDatabase(await PGlite.create());
  await migrate(db);
  await applyStorageMigration(db);
  await seedUsers(db, [NOXAVA, SZRON]);
  const parent = await mkdtemp(path.join(os.tmpdir(), 'szronox-routes-'));
  const root = path.join(parent, 'storage');
  await initializeDisposableStorageRoot(root);
  const storage = filesystemStorageAdapter({
    root,
    appOrigin: ORIGIN,
    now: () => (options.now?.() ?? new Date()).getTime(),
    expectedUid: process.getuid?.(), expectedGid: process.getgid?.(),
    maxPixelCount: options.limits?.maxPixelCount,
    maxDimension: options.limits?.maxDimension,
  });
  await storage.initialize();
  const app = Fastify({ logger: false });
  async function authenticate(request: FastifyRequest) {
    const id = request.headers['x-test-actor'];
    const actor = id === NOXAVA.id ? NOXAVA : id === SZRON.id ? SZRON : null;
    if (!actor) throw unauthenticated();
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (request.headers.origin !== ORIGIN || request.headers['x-csrf-token'] !== CSRF) {
        throw forbidden('Unsafe request origin or CSRF token is invalid');
      }
    }
    return actor;
  }
  registerAttachmentRoutes(app, {
    db, storage, authenticate, now: options.now,
    renewalLimit: options.renewalLimit,
    attachmentLimits: options.limits,
  });
  await app.ready();
  const repo = new CoreRepository(db);
  const reelId = randomUUID();
  await repo.createReel(NOXAVA, {
    operationId: randomUUID(), reelId, input: { text: 'Obraz', images: [] },
  });
  const close = async () => { await app.close(); await db.close(); await rm(parent, { recursive: true, force: true }); };
  return { app, db, repo, storage, reelId, close };
}

function unsafeHeaders(actorId = NOXAVA.id) {
  return { 'x-test-actor': actorId, origin: ORIGIN, 'x-csrf-token': CSRF };
}

async function image(red = 20, width = 3, height = 2): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: red, g: 30, b: 40 } } })
    .png({ compressionLevel: 0, adaptiveFiltering: false })
    .toBuffer();
}

async function initiate(ctx: Awaited<ReturnType<typeof createFixture>>, body: Buffer) {
  const operationId = randomUUID();
  const attachmentId = randomUUID();
  const response = await ctx.app.inject({
    method: 'POST', url: `/api/v1/reels/${ctx.reelId}/attachments/initiate`,
    headers: unsafeHeaders(),
    payload: { operationId, attachmentId, fileName: 'obraz.png', mimeType: 'image/png', byteSize: body.length },
  });
  assert.equal(response.statusCode, 201, response.body);
  return { operationId, attachmentId, response: response.json() as {
    attachment: { state: string }; storageKey: string;
    upload: { uploadUrl: string; method: string; headers: Record<string, string>; expiresAt: number };
  } };
}

test('private HTTP lifecycle authenticates upload/read, stores only ticket digest, and preserves bytes', async () => {
  const ctx = await createFixture();
  try {
    const body = await image();
    const unauthorized = await ctx.app.inject({
      method: 'POST', url: `/api/v1/reels/${ctx.reelId}/attachments/initiate`,
      payload: { operationId: randomUUID(), attachmentId: randomUUID(), fileName: 'a.png', mimeType: 'image/png', byteSize: body.length },
    });
    assert.equal(unauthorized.statusCode, 401);

    const initiated = await initiate(ctx, body);
    const token = initiated.response.upload.headers['X-Upload-Token'];
    assert.ok(token);
    assert.equal(initiated.response.upload.uploadUrl,
      `${ORIGIN}/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/content`);

    const metadata = await ctx.db.query<{ upload_token_digest: string; upload_actor_id: string }>(
      'select upload_token_digest, upload_actor_id from app.attachments where id = $1',
      [initiated.attachmentId],
    );
    assert.equal(metadata.rows[0].upload_token_digest, digestUploadToken(token));
    assert.notEqual(metadata.rows[0].upload_token_digest, token);
    assert.equal(metadata.rows[0].upload_actor_id, NOXAVA.id);

    const peerUpload = await ctx.app.inject({
      method: 'PUT', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/content`,
      headers: { ...unsafeHeaders(SZRON.id), 'x-upload-token': token, 'content-type': 'image/png' }, payload: body,
    });
    assert.equal(peerUpload.statusCode, 403);
    const missingCsrf = await ctx.app.inject({
      method: 'PUT', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/content`,
      headers: { 'x-test-actor': NOXAVA.id, origin: ORIGIN, 'x-upload-token': token, 'content-type': 'image/png' }, payload: body,
    });
    assert.equal(missingCsrf.statusCode, 403);

    const uploaded = await ctx.app.inject({
      method: 'PUT', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/content`,
      headers: { ...unsafeHeaders(), 'x-upload-token': token, 'content-type': 'image/png' }, payload: body,
    });
    assert.equal(uploaded.statusCode, 204, uploaded.body);
    const completeOperation = randomUUID();
    const complete = await ctx.app.inject({
      method: 'POST', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/complete`,
      headers: unsafeHeaders(), payload: { operationId: completeOperation },
    });
    assert.equal(complete.statusCode, 200, complete.body);
    assert.equal(complete.json().state, 'ready');
    const replay = await ctx.app.inject({
      method: 'POST', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/complete`,
      headers: unsafeHeaders(), payload: { operationId: completeOperation },
    });
    assert.deepEqual(replay.json(), complete.json());

    const read = await ctx.app.inject({
      method: 'GET', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/content`,
      headers: { 'x-test-actor': SZRON.id },
    });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.headers['cache-control'], 'private, no-store');
    assert.equal(read.headers['x-content-type-options'], 'nosniff');
    assert.equal(read.headers['content-type'], 'image/png');
    assert.deepEqual(read.rawPayload, body);

    const renewal = await ctx.app.inject({
      method: 'POST', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/upload-authorization`,
      headers: { ...unsafeHeaders(), 'content-type': 'application/json' }, payload: {},
    });
    assert.equal(renewal.statusCode, 422, 'ready attachments cannot renew transport');
  } finally { await ctx.close(); }
});

test('expired initiation replay stays stable while renewal rotates only transport and operation history is unchanged', async () => {
  let clock = new Date('2026-09-15T00:00:00.000Z');
  const ctx = await createFixture({ now: () => clock });
  try {
    const body = await image();
    const initiated = await initiate(ctx, body);
    const original = initiated.response;
    const before = await ctx.db.query<{ count: string }>('select count(*)::text as count from app.operations');
    clock = new Date(clock.getTime() + 301_000);

    const expired = await ctx.app.inject({
      method: 'PUT', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/content`,
      headers: { ...unsafeHeaders(), 'x-upload-token': original.upload.headers['X-Upload-Token'], 'content-type': 'image/png' },
      payload: body,
    });
    assert.equal(expired.statusCode, 422);
    assert.equal(expired.json().error.details.reason, 'upload_authorization_expired');

    const replay = await ctx.app.inject({
      method: 'POST', url: `/api/v1/reels/${ctx.reelId}/attachments/initiate`, headers: unsafeHeaders(),
      payload: {
        operationId: initiated.operationId, attachmentId: initiated.attachmentId,
        fileName: 'obraz.png', mimeType: 'image/png', byteSize: body.length,
      },
    });
    assert.deepEqual(replay.json(), original, 'initiation replay returns its original expired ticket');

    const renewed = await ctx.app.inject({
      method: 'POST', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/upload-authorization`,
      headers: { ...unsafeHeaders(), 'content-type': 'application/json' }, payload: {},
    });
    assert.equal(renewed.statusCode, 200, renewed.body);
    const renewedToken = renewed.json().upload.headers['X-Upload-Token'];
    assert.notEqual(renewedToken, original.upload.headers['X-Upload-Token']);
    const after = await ctx.db.query<{ count: string }>('select count(*)::text as count from app.operations');
    assert.equal(after.rows[0].count, before.rows[0].count, 'renewal creates no domain operation');

    const oldTicket = await ctx.app.inject({
      method: 'PUT', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/content`,
      headers: { ...unsafeHeaders(), 'x-upload-token': original.upload.headers['X-Upload-Token'], 'content-type': 'image/png' }, payload: body,
    });
    assert.equal(oldTicket.statusCode, 403);
    const uploaded = await ctx.app.inject({
      method: 'PUT', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/content`,
      headers: { ...unsafeHeaders(), 'x-upload-token': renewedToken, 'content-type': 'image/png' }, payload: body,
    });
    assert.equal(uploaded.statusCode, 204, uploaded.body);
  } finally { await ctx.close(); }
});

test('an object published before database validation remains an orphan until the same upload is reconciled', async () => {
  const ctx = await createFixture();
  try {
    const body = await image();
    const initiated = await initiate(ctx, body);
    await ctx.storage.writeObject!(initiated.response.storageKey, Readable.from([body]), {
      mimeType: 'image/png', byteSize: body.length,
      maxByteSize: DEFAULT_ATTACHMENT_LIMITS.maxByteSize,
      maxPixelCount: DEFAULT_ATTACHMENT_LIMITS.maxPixelCount,
      maxDimension: DEFAULT_ATTACHMENT_LIMITS.maxDimension,
    });
    const premature = await ctx.app.inject({
      method: 'POST', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/complete`,
      headers: unsafeHeaders(), payload: { operationId: randomUUID() },
    });
    assert.equal(premature.statusCode, 422);
    assert.equal(premature.json().error.code, 'UPLOAD_INCOMPLETE');

    const reconcile = await ctx.app.inject({
      method: 'PUT', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/content`,
      headers: {
        ...unsafeHeaders(), 'x-upload-token': initiated.response.upload.headers['X-Upload-Token'],
        'content-type': 'image/png',
      }, payload: body,
    });
    assert.equal(reconcile.statusCode, 204, reconcile.body);
    const complete = await ctx.app.inject({
      method: 'POST', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/complete`,
      headers: unsafeHeaders(), payload: { operationId: randomUUID() },
    });
    assert.equal(complete.statusCode, 200, complete.body);
    assert.equal(complete.json().state, 'ready');
  } finally { await ctx.close(); }
});

test('actual image decode, size, pixel limits and immutable retry behavior are enforced over HTTP', async () => {
  const limits = { ...DEFAULT_ATTACHMENT_LIMITS, maxPixelCount: 8, maxDimension: 100 };
  const ctx = await createFixture({ limits });
  try {
    const good = await image(1, 2, 2);
    const initiated = await initiate(ctx, good);
    const token = initiated.response.upload.headers['X-Upload-Token'];
    const corrupt = Buffer.alloc(good.length, 0x61);
    const invalid = await ctx.app.inject({
      method: 'PUT', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/content`,
      headers: { ...unsafeHeaders(), 'x-upload-token': token, 'content-type': 'image/png' }, payload: corrupt,
    });
    assert.equal(invalid.statusCode, 422);
    assert.equal(invalid.json().error.details.reason, 'invalid_image');

    const first = await ctx.app.inject({
      method: 'PUT', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/content`,
      headers: { ...unsafeHeaders(), 'x-upload-token': token, 'content-type': 'image/png' }, payload: good,
    });
    assert.equal(first.statusCode, 204, first.body);
    const retry = await ctx.app.inject({
      method: 'PUT', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/content`,
      headers: { ...unsafeHeaders(), 'x-upload-token': token, 'content-type': 'image/png' }, payload: good,
    });
    assert.equal(retry.statusCode, 204, retry.body);
    const different = await image(200, 2, 2);
    assert.equal(different.length, good.length);
    const overwrite = await ctx.app.inject({
      method: 'PUT', url: `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/content`,
      headers: { ...unsafeHeaders(), 'x-upload-token': token, 'content-type': 'image/png' }, payload: different,
    });
    assert.equal(overwrite.statusCode, 409);
    assert.equal(overwrite.json().error.details.reason, 'immutable_object_conflict');

    const largePixels = await image(3, 3, 3);
    const tooLarge = await initiate(ctx, largePixels);
    const pixelResponse = await ctx.app.inject({
      method: 'PUT', url: `/api/v1/reels/${ctx.reelId}/attachments/${tooLarge.attachmentId}/content`,
      headers: {
        ...unsafeHeaders(), 'x-upload-token': tooLarge.response.upload.headers['X-Upload-Token'],
        'content-type': 'image/png',
      }, payload: largePixels,
    });
    assert.equal(pixelResponse.statusCode, 422);
    assert.match(pixelResponse.json().error.details.reason, /invalid_image|image_dimensions_exceeded/);
  } finally { await ctx.close(); }
});

test('transport renewal is bounded and rate-limited after authentication', async () => {
  const ctx = await createFixture({ renewalLimit: { attempts: 1, windowMs: 60_000 } });
  try {
    const body = await image();
    const initiated = await initiate(ctx, body);
    const url = `/api/v1/reels/${ctx.reelId}/attachments/${initiated.attachmentId}/upload-authorization`;
    const first = await ctx.app.inject({ method: 'POST', url, headers: unsafeHeaders(), payload: {} });
    assert.equal(first.statusCode, 200, first.body);
    const second = await ctx.app.inject({ method: 'POST', url, headers: unsafeHeaders(), payload: {} });
    assert.equal(second.statusCode, 429);
    assert.equal(second.json().error.code, 'RATE_LIMITED');
    assert.equal(second.headers['retry-after'], '60');
  } finally { await ctx.close(); }
});

test('the storage migration applies on historical schema and is rerunnable', async () => {
  const db = pgliteDatabase(await PGlite.create());
  try {
    await migrate(db);
    await applyStorageMigration(db);
    await applyStorageMigration(db);
    const columns = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema = 'app' and table_name = 'attachments'
       and column_name in ('upload_token_digest', 'validated_mime_type') order by column_name`,
    );
    assert.deepEqual(columns.rows.map((row) => row.column_name), ['upload_token_digest', 'validated_mime_type']);
  } finally { await db.close(); }
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from './db/client.js';
import type { StorageAdapter } from './core/storage.js';
import { pgliteDatabase } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';
import { CoreRepository } from './core/repository.js';
import { registerLibraryRoutes } from './ai/library.js';
import type { CoreDependencies } from './core/routes.js';
import type { KdriveClient, KdriveFolder } from './kdrive/client.js';
import type { KdriveUploadClient } from './kdrive/upload-client.js';
import { MemeCopyService } from './kdrive/meme-copy.js';

function fixture(options: { uploadFails?: boolean; existingFolder?: boolean; gateUpload?: boolean } = {}) {
  const meme = { id: 'meme-1', name: 'Próba', asset_ref: 'asset-1', kdrive_copy_state: 'pending', kdrive_copy_attempts: 0 };
  let folderCreates = 0;
  let uploads = 0;
  let lookups = 0;
  let signalUploadStarted!: () => void;
  let releaseUpload!: () => void;
  const uploadStarted = new Promise<void>((resolve) => { signalUploadStarted = resolve; });
  const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
  const folders = new Map<string, KdriveFolder>();
  if (options.existingFolder) folders.set('22', { id: '22', name: 'SzroNox Memy', parentId: '10', type: 'dir', status: 'ok' });
  const db: Database = {
    async query<T>(sql: string, params?: unknown[]) {
      if (sql.includes('select id,name,asset_ref')) return { rows: [{ ...meme } as T], rowCount: 1 };
      if (sql.includes('select kdrive_copy_state,kdrive_copy_attempts')) return { rows: [{ kdrive_copy_state: meme.kdrive_copy_state, kdrive_copy_attempts: meme.kdrive_copy_attempts } as T], rowCount: 1 };
      if (sql.includes('select kdrive_copy_state from app.memes')) return { rows: [{ kdrive_copy_state: meme.kdrive_copy_state } as T], rowCount: 1 };
      if (sql.includes('select id from app.memes')) return { rows: meme.kdrive_copy_state === 'copied' ? [] : [{ id: meme.id } as T], rowCount: meme.kdrive_copy_state === 'copied' ? 0 : 1 };
      if (sql.includes("set kdrive_copy_state='pending',kdrive_copy_attempts=0")) { meme.kdrive_copy_state = 'pending'; meme.kdrive_copy_attempts = 0; return { rows: [], rowCount: 1 }; }
      if (sql.includes("set kdrive_copy_attempts=kdrive_copy_attempts+1")) { meme.kdrive_copy_attempts += 1; meme.kdrive_copy_state = 'pending'; return { rows: [], rowCount: 1 }; }
      if (sql.includes("kdrive_copy_state='copied'")) { meme.kdrive_copy_state = 'copied'; return { rows: [], rowCount: 1 }; }
      if (sql.includes('set kdrive_copy_state=$1')) { meme.kdrive_copy_state = String(params?.[0]); return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Database;

  const storage: StorageAdapter = {
    async initialize() {},
    async statObject() { return { exists: true, byteSize: 4 }; },
    async createSignedUpload() { throw new Error('not used'); },
    async openObject() { return { object: { exists: true, mimeType: 'image/png', byteSize: 4, width: 1, height: 1, pixelCount: 1, contentHash: 'hash' }, stream: Readable.from([Buffer.from([1, 2, 3, 4])]) }; },
  };
  const folderClient: KdriveClient = {
    async getFolder(id) { const f = folders.get(id); if (!f) throw new Error('missing'); return f; },
    async listChildren(id) { lookups += 1; return [...folders.values()].filter((f) => f.parentId === id); },
    async createFolder(parentId, name) { folderCreates += 1; const folder = { id: '22', name, parentId, type: 'dir' as const, status: 'ok' as const }; folders.set(folder.id, folder); return folder; },
  };
  const uploadClient: KdriveUploadClient = {
    async start() { throw new Error('not used'); }, async putChunk() { throw new Error('not used'); },
    async finish() { throw new Error('not used'); }, async getFile() { throw new Error('not used'); }, async cancel() { throw new Error('not used'); },
    async uploadSmall() { uploads += 1; signalUploadStarted(); if (options.gateUpload) await uploadGate; if (options.uploadFails) throw new Error('provider failed'); return { id: 'file-1', name: 'MEM - Próba.png', size: 4, status: 'ok' }; },
  };
  const service = new MemeCopyService({ db, storage, config: { driveId: '1', rootFolderId: '10', token: 'secret', memeFolderId: null }, folders: folderClient, uploads: uploadClient });
  return { service, meme, uploadStarted, releaseUpload, counts: () => ({ folderCreates, uploads, lookups }) };
}

test('meme copy is best effort, retries are bounded, and an existing folder is reused', async () => {
  const ctx = fixture({ uploadFails: true, existingFolder: true });
  await ctx.service.enqueue('meme-1');
  assert.equal(ctx.meme.kdrive_copy_state, 'pending');
  await ctx.service.retryPending();
  await ctx.service.retryPending();
  await ctx.service.retryPending();
  assert.equal(ctx.meme.kdrive_copy_state, 'failed');
  assert.equal(ctx.meme.kdrive_copy_attempts, 3);
  assert.equal(ctx.counts().folderCreates, 0);
  assert.equal(ctx.counts().uploads, 3);
});

test('copying existing rows is explicit and copied state is idempotently skipped', async () => {
  const ctx = fixture();
  const first = await ctx.service.copyExistingPending();
  assert.deepEqual(first, { selected: 1, copied: 1 });
  assert.equal(ctx.meme.kdrive_copy_state, 'copied');
  assert.equal(ctx.counts().folderCreates, 1);
  const second = await ctx.service.copyExistingPending();
  assert.deepEqual(second, { selected: 0, copied: 0 });
  assert.equal(ctx.counts().uploads, 1);
});

test('concurrent enqueue calls for the same meme share one in-flight provider copy', async () => {
  const ctx = fixture({ gateUpload: true });
  const first = ctx.service.enqueue('meme-1');
  await ctx.uploadStarted;
  const replay = ctx.service.enqueue('meme-1');
  ctx.releaseUpload();
  await Promise.all([first, replay]);
  assert.equal(ctx.counts().uploads, 1);
  assert.equal(ctx.meme.kdrive_copy_state, 'copied');
});

test('meme-create replay does not enqueue again; failed-copy retry is operation-idempotent and omits file web URLs', async () => {
  const db = pgliteDatabase(await PGlite.create()); await migrate(db);
  const actor = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' as const };
  await seedUsers(db, [actor, { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' }]);
  let enqueueCount = 0; let retryCount = 0;
  const copyService = {
    startRetryLoop() {},
    async enqueue() { enqueueCount += 1; },
    async retry() { retryCount += 1; },
  };
  const storage = {
    async initialize() {}, async statObject() { return { exists: true, byteSize: 4 }; },
    async createSignedUpload() { throw new Error('not used'); },
  } as unknown as StorageAdapter;
  const deps: CoreDependencies = {
    db, storage,
    async authenticate(_request: FastifyRequest) { return actor; },
    allowlist: [actor, { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' }],
    kdrive: { driveId: '1', rootFolderId: '10', token: 'test-only', memeFolderId: null },
  };
  const app = Fastify({ logger: false }); registerLibraryRoutes(app, deps, copyService); await app.ready();
  try {
    const reelId = randomUUID();
    await new CoreRepository(db).createReel(actor, { operationId: randomUUID(), reelId, input: { text: 'test', images: [] } });
    const imageAssetId = randomUUID();
    await db.query(`insert into app.attachments(id,reel_id,purpose,kind,label,storage_key,state,validated_mime_type,validated_width,validated_height,validated_pixel_count,validated_at)
      values($1,$2,'source','image','meme.png','asset-key','ready','image/png',1,1,1,now())`, [imageAssetId, reelId]);
    const createBody = { operationId: randomUUID(), name: 'Test meme', imageAssetId, attachToReel: { reelId, expectedVersion: 1 } };
    const created = await app.inject({ method: 'POST', url: '/api/v1/memes', payload: createBody });
    const memeId = created.json().meme.id as string;
    assert.equal(created.statusCode, 201); assert.equal(enqueueCount, 1);
    const replay = await app.inject({ method: 'POST', url: '/api/v1/memes', payload: createBody });
    assert.equal(replay.statusCode, 201); assert.equal(enqueueCount, 1);

    await db.query("update app.memes set kdrive_copy_state='failed',kdrive_copy_attempts=3 where id=$1", [memeId]);
    const retryBody = { operationId: randomUUID() };
    const retried = await app.inject({ method: 'POST', url: `/api/v1/memes/${memeId}/kdrive-copy/retry`, payload: retryBody });
    assert.equal(retried.statusCode, 200, retried.body); assert.equal(retryCount, 1);
    const retryReplay = await app.inject({ method: 'POST', url: `/api/v1/memes/${memeId}/kdrive-copy/retry`, payload: retryBody });
    assert.equal(retryReplay.statusCode, 200); assert.equal(retryCount, 1);
    const pending = await app.inject({ method: 'POST', url: `/api/v1/memes/${memeId}/kdrive-copy/retry`, payload: { operationId: randomUUID() } });
    assert.equal(pending.statusCode, 422); assert.equal(pending.json().error.details.reason, 'meme_copy_not_failed');

    await db.query("update app.memes set kdrive_copy_state='failed',kdrive_copy_attempts=3 where id=$1", [memeId]);
    deps.kdrive = null;
    const unconfigured = await app.inject({ method: 'POST', url: `/api/v1/memes/${memeId}/kdrive-copy/retry`, payload: { operationId: randomUUID() } });
    assert.equal(unconfigured.statusCode, 503); assert.equal(unconfigured.json().error.details.reason, 'kdrive_not_configured');
    const stillFailed = await db.query<{ kdrive_copy_state: string }>('select kdrive_copy_state from app.memes where id=$1', [memeId]);
    assert.equal(stillFailed.rows[0].kdrive_copy_state, 'failed'); assert.equal(retryCount, 1);
    deps.kdrive = { driveId: '1', rootFolderId: '10', token: 'test-only', memeFolderId: null };

    await db.query(`update app.memes set kdrive_copy_state='copied',kdrive_file=$1 where id=$2`, [JSON.stringify({ driveId: '1', fileId: '2', name: 'MEM - Test.png' }), memeId]);
    const listed = await app.inject({ method: 'GET', url: '/api/v1/memes' });
    assert.equal(listed.statusCode, 200); assert.equal('webUrl' in listed.json().items[0].kdriveCopy, false);
  } finally { await app.close(); await db.close(); }
});

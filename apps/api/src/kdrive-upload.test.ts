import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify, { type FastifyRequest } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import type { KdriveUploadStartRequest } from '@szronox/contracts';
import { pgliteDatabase, type Database } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';
import { forbidden, unauthenticated } from './core/errors.js';
import { CoreRepository } from './core/repository.js';
import { KdriveError, type KdriveClient, type KdriveFolder } from './kdrive/client.js';
import { prefixedName, registerKdriveUploadRoutes } from './kdrive/upload-routes.js';
import type { CoreDependencies } from './core/routes.js';
import type { KdriveUploadClient, UploadFileInfo, UploadSession } from './kdrive/upload-client.js';

const NOXAVA = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' as const };
const SZRON = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' as const };
const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);

function fakeProviders() {
  const folders = new Map<string, KdriveFolder>([['10', { id: '10', name: 'root', parentId: null, type: 'dir', status: 'ok' }]]);
  let folderCreates = 0; let starts = 0; let chunkCalls = 0; let finishCalls = 0; let cancelCalls = 0;
  let finishedFile: UploadFileInfo | null = null; let lastHashes: string[] = [];
  let finishUncertainty: KdriveError | null = null;
  let startBarrier: Promise<void> | null = null;
  let releaseStartBarrier: (() => void) | null = null;
  let targetStarts = 0;
  let reachedTarget!: () => void;
  let targetStarted = Promise.resolve();
  const folderClient: KdriveClient = {
    async getFolder(id) { const folder = folders.get(id); if (!folder) throw new KdriveError('missing', false, 404, 'object_not_found'); return folder; },
    async listChildren(id) { return [...folders.values()].filter((folder) => folder.parentId === id); },
    async createFolder(parentId, name) { folderCreates += 1; const folder = { id: String(100 + folderCreates), name, parentId, type: 'dir', status: 'ok' }; folders.set(folder.id, folder); return folder; },
  };
  const uploadClient: KdriveUploadClient = {
    async start(input) {
      starts += 1;
      if (targetStarts > 0 && starts === targetStarts) reachedTarget();
      if (startBarrier) await startBarrier;
      return { token: `session-${starts}`, uploadUrl: 'https://x.upload.kdrive.infomaniak.com', fileId: String(500 + starts), fileName: input.fileName };
    },
    async putChunk(_session, _index, _bytes, _hash) { chunkCalls += 1; },
    async finish(session, hashes) { finishCalls += 1; lastHashes = hashes; const suffix = Number(session.token.split('-')[1]); finishedFile = { id: String(500 + suffix), name: 'OKLADKA - cover.png', size: png.byteLength, status: 'ok' }; if (finishUncertainty) { const error = finishUncertainty; finishUncertainty = null; throw error; } return finishedFile; },
    async getFile(id) { if (!finishedFile || finishedFile.id !== id) throw new KdriveError('missing', false, 404, 'object_not_found'); return finishedFile; },
    async cancel(_session) { cancelCalls += 1; },
    async uploadSmall() { throw new Error('not used'); },
  };
  return { folders, folderClient, uploadClient,
    holdStarts(target: number) {
      targetStarts = target;
      targetStarted = new Promise<void>((resolve) => { reachedTarget = resolve; });
      startBarrier = new Promise<void>((resolve) => { releaseStartBarrier = resolve; });
      return { reached: targetStarted, release() { releaseStartBarrier?.(); startBarrier = null; } };
    },
    ambiguousFinish(error: KdriveError) { finishUncertainty = error; }, counts: () => ({ folderCreates, starts, chunkCalls, finishCalls, cancelCalls, lastHashes }) };
}

function serializedDatabase(database: Database): Database {
  let tail = Promise.resolve();
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const previous = tail; let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    return previous.then(run).finally(release);
  };
  return {
    query: <Row>(sql: string, params?: unknown[]) => exclusive(() => database.query<Row>(sql, params)),
    execScript: (sql: string) => exclusive(() => database.execScript(sql)),
    transaction: <T>(body: (tx: import('./db/client.js').Queryable) => Promise<T>) => exclusive(() => database.transaction(body)),
    close: () => database.close(),
  };
}

async function fixture(configured = true, serializeQueries = false) {
  const db = pgliteDatabase(await PGlite.create()); await migrate(db); await seedUsers(db, [NOXAVA, SZRON]);
  const provider = fakeProviders(); const app = Fastify({ logger: false });
  const deps: CoreDependencies = {
    db: serializeQueries ? serializedDatabase(db) : db, storage: { async initialize() {}, async statObject() { return { exists: false, byteSize: 0 }; }, async createSignedUpload() { throw new Error('unused'); } },
    async authenticate(request: FastifyRequest) { if (request.headers['x-actor'] !== NOXAVA.id) throw unauthenticated(); if (request.method !== 'GET' && request.headers['x-csrf'] !== 'test') throw forbidden('test'); return NOXAVA; },
    allowlist: [NOXAVA, SZRON], kdrive: configured ? { driveId: '1', rootFolderId: '10', token: 'test-token', memeFolderId: null } : null,
  };
  registerKdriveUploadRoutes(app, deps, provider.uploadClient, provider.folderClient); await app.ready();
  const reelId = randomUUID(); await new CoreRepository(db).createReel(NOXAVA, { operationId: randomUUID(), reelId, input: { text: 'test', images: [] } });
  const close = async () => { await app.close(); await db.close(); };
  const headers = { 'x-actor': NOXAVA.id, 'x-csrf': 'test' };
  return { app, db, reelId, headers, provider, close };
}
const startBody = (expectedVersion = 1, createFolder = false): KdriveUploadStartRequest => ({ operationId: randomUUID(), expectedVersion, purpose: 'cover', fileName: 'cover.png', mimeType: 'image/png', byteSize: png.length, ...(createFolder ? { createFolder: true } : {}) });

test('kDrive upload names keep a safe extension and never duplicate their purpose prefix', () => {
  assert.equal(prefixedName('video', 'cut.mov'), 'EKSPORT - cut.mov');
  assert.equal(prefixedName('video', 'EKSPORT - cut.mov'), 'EKSPORT - cut.mov');
  assert.equal(prefixedName('cover', 'cover.png'), 'OKLADKA - cover.png');
  assert.equal(prefixedName('cover', 'folder/bad name.png'), 'OKLADKA - folder bad name.png');
  assert.equal(prefixedName('cover', 'photo.pn/g'), 'OKLADKA - photo.pn g');
});

test('KDRIVE-02 folder-required, explicit combined create, and start replay are idempotent', async () => {
  const ctx = await fixture();
  try {
    const noFolder = await ctx.app.inject({ method: 'POST', url: `/api/v1/reels/${ctx.reelId}/kdrive-uploads`, headers: ctx.headers, payload: startBody() });
    assert.equal(noFolder.statusCode, 422); assert.equal(noFolder.json().error.details.reason, 'folder_required');
    const body = startBody(1, true);
    const first = await ctx.app.inject({ method: 'POST', url: `/api/v1/reels/${ctx.reelId}/kdrive-uploads`, headers: ctx.headers, payload: body });
    assert.equal(first.statusCode, 201, first.body);
    const replay = await ctx.app.inject({ method: 'POST', url: `/api/v1/reels/${ctx.reelId}/kdrive-uploads`, headers: ctx.headers, payload: body });
    assert.equal(replay.statusCode, 200, replay.body); assert.equal(replay.json().uploadId, first.json().uploadId);
    const changed = await ctx.app.inject({ method: 'POST', url: `/api/v1/reels/${ctx.reelId}/kdrive-uploads`, headers: ctx.headers, payload: { ...body, expectedVersion: 2 } });
    assert.equal(changed.statusCode, 409); assert.equal(changed.json().error.code, 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(ctx.provider.counts(), { folderCreates: 1, starts: 1, chunkCalls: 0, finishCalls: 0, cancelCalls: 0, lastHashes: [] });
    assert.equal(JSON.stringify(first.json()).includes('session-'), false);
  } finally { await ctx.close(); }
});

test('KDRIVE-02 validates chunk MIME and magic, accepts exact duplicates, finishes once and attaches a cover atomically', async () => {
  const ctx = await fixture();
  try {
    const body = startBody(1, true);
    const started = await ctx.app.inject({ method: 'POST', url: `/api/v1/reels/${ctx.reelId}/kdrive-uploads`, headers: ctx.headers, payload: body });
    const id = started.json().uploadId as string;
    const badType = await ctx.app.inject({ method: 'PUT', url: `/api/v1/kdrive-uploads/${id}/chunks/0`, headers: { ...ctx.headers, 'content-type': 'application/json' }, payload: png });
    assert.equal(badType.statusCode, 422); assert.equal(badType.json().error.details.reason, 'content_type_mismatch');
    const wrongMagic = await ctx.app.inject({ method: 'PUT', url: `/api/v1/kdrive-uploads/${id}/chunks/0`, headers: { ...ctx.headers, 'content-type': 'application/octet-stream' }, payload: Buffer.from('not png!!!!1') });
    assert.equal(wrongMagic.statusCode, 422); assert.equal(wrongMagic.json().error.details.reason, 'content_mismatch');
    const chunk = await ctx.app.inject({ method: 'PUT', url: `/api/v1/kdrive-uploads/${id}/chunks/0`, headers: { ...ctx.headers, 'content-type': 'application/octet-stream' }, payload: png });
    assert.equal(chunk.statusCode, 204);
    const duplicate = await ctx.app.inject({ method: 'PUT', url: `/api/v1/kdrive-uploads/${id}/chunks/0`, headers: { ...ctx.headers, 'content-type': 'application/octet-stream' }, payload: png });
    assert.equal(duplicate.statusCode, 204); assert.equal(ctx.provider.counts().chunkCalls, 1);
    const finish = await ctx.app.inject({ method: 'POST', url: `/api/v1/kdrive-uploads/${id}/finish`, headers: ctx.headers, payload: {} });
    assert.equal(finish.statusCode, 200, finish.body); assert.equal(finish.json().state, 'finished');
    const storedSession = await ctx.db.query<{ kdrive_session_token: string | null; kdrive_upload_host: string | null }>(
      'select kdrive_session_token,kdrive_upload_host from app.kdrive_uploads where id=$1', [id]);
    assert.equal(storedSession.rows[0].kdrive_session_token, null); assert.equal(storedSession.rows[0].kdrive_upload_host, null);
    const replay = await ctx.app.inject({ method: 'POST', url: `/api/v1/kdrive-uploads/${id}/finish`, headers: ctx.headers, payload: {} });
    assert.equal(replay.statusCode, 200); assert.equal(ctx.provider.counts().finishCalls, 1);
    const reel = await new CoreRepository(ctx.db).getReel(ctx.reelId);
    const attached = await ctx.app.inject({ method: 'POST', url: `/api/v1/kdrive-uploads/${id}/attach`, headers: ctx.headers, payload: { operationId: randomUUID(), expectedVersion: reel.version } });
    assert.equal(attached.statusCode, 200, attached.body); assert.equal(attached.json().feedCoverDone, true); assert.equal(attached.json().feedCoverAsset.fileId, '501');
    assert.equal(ctx.provider.counts().lastHashes.length, 1);
  } finally { await ctx.close(); }
});

test('unconfigured kDrive start is refused without outbound provider calls', async () => {
  const ctx = await fixture(false);
  try {
    const response = await ctx.app.inject({ method: 'POST', url: `/api/v1/reels/${ctx.reelId}/kdrive-uploads`, headers: ctx.headers, payload: startBody() });
    assert.equal(response.statusCode, 503); assert.equal(ctx.provider.counts().starts, 0); assert.equal(ctx.provider.counts().folderCreates, 0);
  } finally { await ctx.close(); }
});

test('concurrent starts reserve capacity atomically at two per Reel and four per user', async () => {
  const ctx = await fixture(true, true);
  try {
    const reelIds = [ctx.reelId, randomUUID(), randomUUID()];
    for (const [index, reelId] of reelIds.entries()) {
      if (index > 0) await new CoreRepository(ctx.db).createReel(NOXAVA, { operationId: randomUUID(), reelId, input: { text: `test ${index}`, images: [] } });
      await ctx.db.query('update app.reels set kdrive_folder=$1,version=version+1 where id=$2', [JSON.stringify({ driveId: '1', folderId: '10' }), reelId]);
    }
    const barrier = ctx.provider.holdStarts(4);
    const requests = [0, 0, 1, 1, 2].map((reelIndex) => ctx.app.inject({ method: 'POST',
      url: `/api/v1/reels/${reelIds[reelIndex]}/kdrive-uploads`, headers: ctx.headers, payload: startBody(2) }));
    await barrier.reached;
    barrier.release();
    const results = await Promise.all(requests);
    assert.equal(results.filter((result) => result.statusCode === 201).length, 4);
    assert.equal(results.filter((result) => result.statusCode === 429).length, 1);
    assert.equal(ctx.provider.counts().starts, 4);
    for (const result of results) assert.equal(result.body.includes('session-'), false);
    const counts = await ctx.db.query<{ reel_id: string; n: number }>(`select reel_id,count(*)::int n from app.kdrive_uploads
      where state in ('open','failed') group by reel_id`);
    assert.ok(counts.rows.every((row) => row.n <= 2));
    const total = await ctx.db.query<{ n: number }>(`select count(*)::int n from app.kdrive_uploads
      where requested_by=$1 and state in ('open','failed')`, [NOXAVA.id]);
    assert.equal(total.rows[0].n, 4);
  } finally { await ctx.close(); }
});

test('stale attach returns 409 and keeps the finished kDrive file row intact', async () => {
  const ctx = await fixture();
  try {
    const started = await ctx.app.inject({ method: 'POST', url: `/api/v1/reels/${ctx.reelId}/kdrive-uploads`, headers: ctx.headers, payload: startBody(1, true) });
    const id = started.json().uploadId as string;
    await ctx.app.inject({ method: 'PUT', url: `/api/v1/kdrive-uploads/${id}/chunks/0`, headers: { ...ctx.headers, 'content-type': 'application/octet-stream' }, payload: png });
    await ctx.app.inject({ method: 'POST', url: `/api/v1/kdrive-uploads/${id}/finish`, headers: ctx.headers, payload: {} });
    const current = await new CoreRepository(ctx.db).getReel(ctx.reelId);
    const changed = await new CoreRepository(ctx.db).patchReel(NOXAVA, ctx.reelId, { operationId: randomUUID(), expectedVersion: current.version, changes: { title: 'Nowszy tytuł' } });
    const attached = await ctx.app.inject({ method: 'POST', url: `/api/v1/kdrive-uploads/${id}/attach`, headers: ctx.headers, payload: { operationId: randomUUID(), expectedVersion: current.version } });
    assert.equal(attached.statusCode, 409); assert.equal(changed.version, current.version + 1);
    const row = await ctx.db.query<{ state: string }>('select state from app.kdrive_uploads where id=$1', [id]);
    assert.equal(row.rows[0].state, 'finished'); assert.equal(ctx.provider.counts().cancelCalls, 0);
  } finally { await ctx.close(); }
});

test('cancel stops only open sessions and never deletes a finished file', async () => {
  const ctx = await fixture();
  try {
    const started = await ctx.app.inject({ method: 'POST', url: `/api/v1/reels/${ctx.reelId}/kdrive-uploads`, headers: ctx.headers, payload: startBody(1, true) });
    const openId = started.json().uploadId as string;
    const cancelled = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/kdrive-uploads/${openId}`, headers: ctx.headers });
    assert.equal(cancelled.statusCode, 204); assert.equal(ctx.provider.counts().cancelCalls, 1);
    const finishedStart = await ctx.app.inject({ method: 'POST', url: `/api/v1/reels/${ctx.reelId}/kdrive-uploads`, headers: ctx.headers,
      payload: { ...startBody(2), operationId: randomUUID() } });
    const finishedId = finishedStart.json().uploadId as string;
    await ctx.app.inject({ method: 'PUT', url: `/api/v1/kdrive-uploads/${finishedId}/chunks/0`, headers: { ...ctx.headers, 'content-type': 'application/octet-stream' }, payload: png });
    await ctx.app.inject({ method: 'POST', url: `/api/v1/kdrive-uploads/${finishedId}/finish`, headers: ctx.headers, payload: {} });
    const rejected = await ctx.app.inject({ method: 'DELETE', url: `/api/v1/kdrive-uploads/${finishedId}`, headers: ctx.headers });
    assert.equal(rejected.statusCode, 422); assert.equal(ctx.provider.counts().cancelCalls, 1);
  } finally { await ctx.close(); }
});

test('ambiguous provider finish reconciles by the known file id without a second finish call', async () => {
  const ctx = await fixture();
  try {
    const started = await ctx.app.inject({ method: 'POST', url: `/api/v1/reels/${ctx.reelId}/kdrive-uploads`, headers: ctx.headers, payload: startBody(1, true) });
    const id = started.json().uploadId as string;
    await ctx.app.inject({ method: 'PUT', url: `/api/v1/kdrive-uploads/${id}/chunks/0`, headers: { ...ctx.headers, 'content-type': 'application/octet-stream' }, payload: png });
    ctx.provider.ambiguousFinish(new KdriveError('rejected', false, 400, 'invalid_upload_token_error'));
    const response = await ctx.app.inject({ method: 'POST', url: `/api/v1/kdrive-uploads/${id}/finish`, headers: ctx.headers, payload: {} });
    assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().state, 'finished');
    assert.equal(ctx.provider.counts().finishCalls, 1);
  } finally { await ctx.close(); }
});

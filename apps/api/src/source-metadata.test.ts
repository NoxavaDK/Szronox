import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { CoreRepository } from './core/repository.js';
import { pgliteDatabase, type Database } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';
import { SourceMetadataService } from './source/metadata.js';

const NOXAVA = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' as const };
const SZRON = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' as const };
async function fixture(): Promise<{ db: Database; repo: CoreRepository }> {
  const db = pgliteDatabase(await PGlite.create()); await migrate(db); await seedUsers(db, [NOXAVA, SZRON]);
  return { db, repo: new CoreRepository(db) };
}
const html = Buffer.from('<meta name="author" content="Ada Nowak"><meta property="og:site_name" content="Portal">');

test('capture stores pending host fallback without changing the normal version', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await repo.createReel(NOXAVA, { operationId: randomUUID(), reelId: randomUUID(), input: { url: 'https://www.example.com/news', images: [] } });
    assert.equal(reel.version, 1); assert.equal(reel.sourceMetadata?.state, 'pending');
    assert.equal(reel.sourceMetadata?.line, 'Źródło: example.com'); assert.equal(reel.publicationSource, null);
  } finally { await db.close(); }
});
test('background fetch changes metadata only and requestId compare-and-set protects newer work', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await repo.createReel(NOXAVA, { operationId: randomUUID(), reelId: randomUUID(), input: { url: 'https://example.com/news', images: [] } });
    const before = await db.query<{ version: number; updated_at: Date | string; publication_source: string | null }>('select version,updated_at,publication_source from app.reels where id=$1', [reel.id]);
    const service = new SourceMetadataService(db, async (url) => ({ finalUrl: url, contentType: 'text/html', bytes: html }), false);
    await service.enqueue(reel.id, reel.sourceMetadata!.requestId);
    const after = await db.query<{ version: number; updated_at: Date | string; publication_source: string | null; source_metadata: { state: string; line: string } }>('select version,updated_at,publication_source,source_metadata from app.reels where id=$1', [reel.id]);
    assert.equal(after.rows[0].version, before.rows[0].version); assert.equal(new Date(after.rows[0].updated_at).getTime(), new Date(before.rows[0].updated_at).getTime());
    assert.equal(after.rows[0].publication_source, null); assert.equal(after.rows[0].source_metadata.state, 'found');
    assert.equal(after.rows[0].source_metadata.line, 'Źródło: Ada Nowak, Portal');
    const newer = { ...reel.sourceMetadata!, requestId: randomUUID(), state: 'pending' as const, line: 'Źródło: newer.example', attempts: 0 };
    let release!: () => void;
    let announce!: () => void;
    const started = new Promise<void>((resolve) => { announce = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    await db.query('update app.reels set source_metadata=$1 where id=$2', [JSON.stringify({ ...reel.sourceMetadata!, state: 'pending', attempts: 0 }), reel.id]);
    const racing = new SourceMetadataService(db, async (url) => {
      announce(); await waiting; return { finalUrl: url, contentType: 'text/html', bytes: html };
    }, false);
    const olderRequest = racing.enqueue(reel.id, reel.sourceMetadata!.requestId);
    await started;
    await db.query('update app.reels set source_metadata=$1 where id=$2', [JSON.stringify(newer), reel.id]);
    release(); await olderRequest;
    const protectedValue = await repo.getReel(reel.id);
    assert.equal(protectedValue.sourceMetadata?.requestId, newer.requestId); assert.equal(protectedValue.sourceMetadata?.line, newer.line);
  } finally { await db.close(); }
});
test('no URL and publicationSource validation preserve null/empty semantics and bounds', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await repo.createReel(NOXAVA, { operationId: randomUUID(), reelId: randomUUID(), input: { text: 'bez adresu', images: [] } });
    assert.equal(reel.sourceMetadata?.state, 'no_url'); assert.equal(reel.sourceMetadata?.line, null);
    const empty = await repo.patchReel(NOXAVA, reel.id, { operationId: randomUUID(), expectedVersion: reel.version, changes: { publicationSource: '' } });
    assert.equal(empty.publicationSource, '');
    const automatic = await repo.patchReel(NOXAVA, reel.id, { operationId: randomUUID(), expectedVersion: empty.version, changes: { publicationSource: null } });
    assert.equal(automatic.publicationSource, null);
    await assert.rejects(repo.patchReel(NOXAVA, reel.id, { operationId: randomUUID(), expectedVersion: automatic.version, changes: { publicationSource: 'x'.repeat(1001) } }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
  } finally { await db.close(); }
});
test('refresh returns a recent pending request without enqueue and is idempotent', async () => {
  const { db, repo } = await fixture(); const called: string[] = [];
  try {
    const reel = await repo.createReel(NOXAVA, { operationId: randomUUID(), reelId: randomUUID(), input: { url: 'https://example.com/story', images: [] } });
    const service = new SourceMetadataService(db, async (url) => { called.push(url); return { finalUrl: url, contentType: 'text/html', bytes: html }; }, false);
    const operationId = randomUUID();
    const first = await service.refresh(NOXAVA.id, reel.id, operationId);
    const replay = await service.refresh(NOXAVA.id, reel.id, operationId);
    assert.deepEqual(replay, first); assert.equal(first.enqueue, false); assert.equal(called.length, 0);
    assert.equal(service.allowRefresh(NOXAVA.id), true);
  } finally { await db.close(); }
});
test('soft-deleted Reel is skipped by queue work', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await repo.createReel(NOXAVA, { operationId: randomUUID(), reelId: randomUUID(), input: { url: 'https://example.com/story', images: [] } });
    await repo.setDeleted(NOXAVA, reel.id, { operationId: randomUUID(), expectedVersion: reel.version }, true);
    const service = new SourceMetadataService(db, async () => { throw new Error('must not fetch'); }, false);
    await service.enqueue(reel.id, reel.sourceMetadata!.requestId);
    const row = await db.query<{ source_metadata: { state: string; attempts: number } }>('select source_metadata from app.reels where id=$1', [reel.id]);
    assert.equal(row.rows[0].source_metadata.state, 'pending'); assert.equal(row.rows[0].source_metadata.attempts, 0);
  } finally { await db.close(); }
});
test('failed fetch retains the host attribution and reaches the bounded failed state', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await repo.createReel(NOXAVA, { operationId: randomUUID(), reelId: randomUUID(), input: { url: 'https://example.com/story', images: [] } });
    const service = new SourceMetadataService(db, async () => { throw new Error('offline'); }, false);
    const requestId = reel.sourceMetadata!.requestId;
    await service.enqueue(reel.id, requestId);
    await service.enqueue(reel.id, requestId);
    await service.enqueue(reel.id, requestId);
    const failed = await repo.getReel(reel.id);
    assert.equal(failed.sourceMetadata?.state, 'failed'); assert.equal(failed.sourceMetadata?.attempts, 3);
    assert.equal(failed.sourceMetadata?.line, 'Źródło: example.com'); assert.equal(failed.version, 1);
  } finally { await db.close(); }
});
test('completed metadata refresh starts a new operation-owned request without overwriting manual source', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await repo.createReel(NOXAVA, { operationId: randomUUID(), reelId: randomUUID(), input: { url: 'https://example.com/story', images: [] } });
    const manual = await repo.patchReel(NOXAVA, reel.id, { operationId: randomUUID(), expectedVersion: reel.version, changes: { publicationSource: 'ręcznie' } });
    await db.query("update app.reels set source_metadata=jsonb_set(source_metadata,'{state}','\"found\"'::jsonb) where id=$1", [reel.id]);
    const service = new SourceMetadataService(db, async () => ({ finalUrl: 'https://example.com/story', contentType: 'text/html', bytes: html }), false);
    const operationId = randomUUID();
    const refreshed = await service.refresh(NOXAVA.id, reel.id, operationId);
    assert.equal(refreshed.enqueue, true); assert.equal(refreshed.metadata.requestId, operationId);
    await service.enqueue(reel.id, operationId);
    const after = await repo.getReel(reel.id);
    assert.equal(after.publicationSource, 'ręcznie'); assert.equal(after.sourceMetadata?.state, 'found');
    assert.equal(after.version, manual.version);
  } finally { await db.close(); }
});
test('manual refresh with no URL writes no_url and the per-user limit is ten per minute', async () => {
  const { db, repo } = await fixture();
  try {
    const reel = await repo.createReel(NOXAVA, { operationId: randomUUID(), reelId: randomUUID(), input: { text: 'tekst bez linku', images: [] } });
    const service = new SourceMetadataService(db, async () => { throw new Error('no fetch expected'); }, false);
    const result = await service.refresh(NOXAVA.id, reel.id, randomUUID());
    assert.equal(result.enqueue, false); assert.equal(result.metadata.state, 'no_url');
    for (let i = 1; i < 10; i += 1) await service.refresh(NOXAVA.id, reel.id, randomUUID());
    await assert.rejects(service.refresh(NOXAVA.id, reel.id, randomUUID()), (error: unknown) => (error as { code?: string }).code === 'RATE_LIMITED');
  } finally { await db.close(); }
});

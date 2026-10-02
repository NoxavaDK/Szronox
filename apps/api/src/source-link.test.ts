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
const html = Buffer.from('<meta name="author" content="Ada Nowak"><meta property="og:site_name" content="Portal">');
async function fixture(): Promise<{ db: Database; repo: CoreRepository }> {
  const db = pgliteDatabase(await PGlite.create()); await migrate(db); await seedUsers(db, [NOXAVA, SZRON]);
  return { db, repo: new CoreRepository(db) };
}

test('SOURCE-02 link set/change/clear refreshes metadata in the versioned write and keeps capture/manual source', async () => {
  const { db, repo } = await fixture();
  try {
    const originalInput = { text: 'An image capture with commentary', additionalText: 'exact extra text', images: [] };
    const created = await repo.createReel(NOXAVA, { operationId: randomUUID(), reelId: randomUUID(), input: originalInput });
    const manual = await repo.patchReel(NOXAVA, created.id, { operationId: randomUUID(), expectedVersion: created.version, changes: { publicationSource: 'Wpisane ręcznie' } });
    const first = await repo.patchReel(NOXAVA, created.id, { operationId: randomUUID(), expectedVersion: manual.version, changes: { sourceLink: ' https://example.com/story ' } });
    assert.equal(first.version, manual.version + 1); assert.equal(first.sourceLink, 'https://example.com/story');
    assert.equal(first.originalInput.text, originalInput.text); assert.equal(first.originalInput.additionalText, originalInput.additionalText);
    assert.equal(first.publicationSource, 'Wpisane ręcznie'); assert.equal(first.sourceMetadata?.state, 'pending');
    assert.equal(first.sourceMetadata?.line, 'Źródło: example.com'); assert.ok(first.sourceMetadata?.requestId);
    const initialRequestId = first.sourceMetadata!.requestId;
    const second = await repo.patchReel(NOXAVA, created.id, { operationId: randomUUID(), expectedVersion: first.version, changes: { sourceLink: 'https://news.example.org/article' } });
    assert.notEqual(second.sourceMetadata?.requestId, initialRequestId); assert.equal(second.sourceMetadata?.line, 'Źródło: news.example.org');
    let release!: () => void; let announce!: () => void;
    const started = new Promise<void>((resolve) => { announce = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const racing = new SourceMetadataService(db, async (url) => { announce(); await waiting; return { finalUrl: url, contentType: 'text/html', bytes: html }; }, false);
    const oldFetch = racing.enqueue(second.id, second.sourceMetadata!.requestId);
    await started;
    const third = await repo.patchReel(NOXAVA, created.id, { operationId: randomUUID(), expectedVersion: second.version, changes: { sourceLink: 'https://latest.example.net/new' } });
    release(); await oldFetch;
    const protectedValue = await repo.getReel(second.id);
    assert.equal(protectedValue.sourceMetadata?.requestId, third.sourceMetadata?.requestId);
    assert.equal(protectedValue.sourceMetadata?.state, 'pending'); assert.equal(protectedValue.sourceMetadata?.line, 'Źródło: latest.example.net');
    const refreshedUrls: string[] = [];
    const service = new SourceMetadataService(db, async (url) => { refreshedUrls.push(url); return { finalUrl: url, contentType: 'text/html', bytes: html }; }, false);
    await service.enqueue(third.id, third.sourceMetadata!.requestId);
    const fetched = await repo.getReel(third.id);
    assert.equal(fetched.sourceMetadata?.state, 'found'); assert.equal(fetched.sourceMetadata?.line, 'Źródło: Ada Nowak, Portal');
    assert.equal(fetched.publicationSource, 'Wpisane ręcznie'); assert.equal(fetched.version, third.version);
    const refreshed = await service.refresh(NOXAVA.id, fetched.id, randomUUID());
    assert.equal(refreshed.enqueue, true); assert.equal(refreshed.metadata.url, 'https://latest.example.net/new');
    await service.enqueue(fetched.id, refreshed.metadata.requestId);
    assert.deepEqual(refreshedUrls, ['https://latest.example.net/new', 'https://latest.example.net/new']);
    const cleared = await repo.patchReel(NOXAVA, created.id, { operationId: randomUUID(), expectedVersion: third.version, changes: { sourceLink: null } });
    assert.equal(cleared.sourceLink, null); assert.equal(cleared.sourceMetadata?.state, 'no_url');
    assert.equal(cleared.sourceMetadata?.requestId === second.sourceMetadata?.requestId, false);
    assert.equal(cleared.publicationSource, 'Wpisane ręcznie');
  } finally { await db.close(); }
});

test('SOURCE-02 validates URLs, rejects links when capture has one, and preserves stale-version protection', async () => {
  const { db, repo } = await fixture();
  try {
    const imageOnly = await repo.createReel(NOXAVA, { operationId: randomUUID(), reelId: randomUUID(), input: { text: 'Only text, no URL', images: [] } });
    for (const sourceLink of ['javascript:alert(1)', 'https://', `https://example.com/${'x'.repeat(2048)}`]) {
      await assert.rejects(repo.patchReel(NOXAVA, imageOnly.id, { operationId: randomUUID(), expectedVersion: imageOnly.version, changes: { sourceLink } }),
        (error: unknown) => (error as { code?: string }).code === 'VALIDATION_ERROR');
    }
    await assert.rejects(repo.patchReel(NOXAVA, imageOnly.id, { operationId: randomUUID(), expectedVersion: imageOnly.version - 1, changes: { sourceLink: 'https://example.com' } }),
      (error: unknown) => (error as { code?: string }).code === 'EDIT_CONFLICT');
    for (const input of [
      { url: 'https://captured.example/story', images: [] },
      { text: 'Read this https://captured.example/story today', images: [] },
      { text: 'Captured context', additionalText: 'https://captured.example/story', images: [] },
    ]) {
      const captured = await repo.createReel(NOXAVA, { operationId: randomUUID(), reelId: randomUUID(), input });
      await assert.rejects(repo.patchReel(NOXAVA, captured.id, { operationId: randomUUID(), expectedVersion: captured.version, changes: { sourceLink: 'https://other.example' } }),
        (error: unknown) => (error as { code?: string; details?: Record<string, unknown> }).code === 'VALIDATION_ERROR'
          && (error as { details?: Record<string, unknown> }).details?.reason === 'capture_has_link');
    }
  } finally { await db.close(); }
});

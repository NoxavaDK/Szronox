import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import type { Database } from './db/client.js';
import type { StorageAdapter } from './core/storage.js';
import type { KdriveClient, KdriveFolder } from './kdrive/client.js';
import type { KdriveUploadClient } from './kdrive/upload-client.js';
import { MemeCopyService } from './kdrive/meme-copy.js';

function fixture(options: { uploadFails?: boolean; existingFolder?: boolean } = {}) {
  const meme = { id: 'meme-1', name: 'Próba', asset_ref: 'asset-1', kdrive_copy_state: 'pending', kdrive_copy_attempts: 0 };
  let folderCreates = 0;
  let uploads = 0;
  let lookups = 0;
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
    async uploadSmall() { uploads += 1; if (options.uploadFails) throw new Error('provider failed'); return { id: 'file-1', name: 'MEM - Próba.png', size: 4, status: 'ok' }; },
  };
  const service = new MemeCopyService({ db, storage, config: { driveId: '1', rootFolderId: '10', token: 'secret', memeFolderId: null }, folders: folderClient, uploads: uploadClient });
  return { service, meme, counts: () => ({ folderCreates, uploads, lookups }) };
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

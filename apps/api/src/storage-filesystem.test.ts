import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import sharp from 'sharp';

import { StorageConflictError, StorageInputError } from './core/storage.js';
import { filesystemStorageAdapter, initializeDisposableStorageRoot } from './storage/filesystem.js';

async function fixture(options: { maxPixelCount?: number } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'szronox-storage-'));
  const root = path.join(parent, 'root');
  await initializeDisposableStorageRoot(root);
  const storage = filesystemStorageAdapter({
    root,
    appOrigin: 'https://szronox.test',
    expectedUid: process.getuid?.(),
    expectedGid: process.getgid?.(),
    maxPixelCount: options.maxPixelCount,
  });
  await storage.initialize();
  return { parent, root, storage, close: () => rm(parent, { recursive: true, force: true }) };
}

async function png(red: number, width = 3, height = 2): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: red, g: 20, b: 30 } } })
    .png({ compressionLevel: 0, adaptiveFiltering: false })
    .toBuffer();
}

function writeOptions(body: Buffer, over: Record<string, unknown> = {}) {
  return {
    mimeType: 'image/png',
    byteSize: body.length,
    maxByteSize: 1024 * 1024,
    maxPixelCount: 100,
    maxDimension: 100,
    ...over,
  };
}

test('filesystem storage validates its private root and creates scoped same-origin tickets', async () => {
  const ctx = await fixture();
  try {
    const upload = await ctx.storage.createSignedUpload('reels/r/a', {
      mimeType: 'image/png',
      byteSize: 10,
      scope: { actorId: 'u', reelId: 'r', attachmentId: 'a' },
    });
    assert.equal(upload.uploadUrl, 'https://szronox.test/api/v1/reels/r/attachments/a/content');
    assert.equal(upload.method, 'PUT');
    assert.match(upload.headers['X-Upload-Token'], /^[A-Za-z0-9_-]{40,}$/);
    assert.ok(upload.expiresAt > Math.floor(Date.now() / 1000));

    assert.throws(
      () => filesystemStorageAdapter({ root: 'relative', appOrigin: 'https://szronox.test' }),
      /absolute normalized path/,
    );
    const linkPath = path.join(ctx.parent, 'linked-root');
    await symlink(ctx.root, linkPath);
    const linked = filesystemStorageAdapter({
      root: linkPath,
      appOrigin: 'https://szronox.test',
      expectedUid: process.getuid?.(), expectedGid: process.getgid?.(),
    });
    await assert.rejects(linked.initialize(), /symlink/);
  } finally { await ctx.close(); }
});

test('raw uploads preserve exact image bytes and immutable retries cannot overwrite an object', async () => {
  const ctx = await fixture();
  try {
    const first = await png(10);
    const second = await png(200);
    assert.equal(first.length, second.length, 'fixed PNG settings make same-size conflict fixtures');
    const key = 'reels/one/attachment';
    const stored = await ctx.storage.writeObject!(key, Readable.from([first]), writeOptions(first));
    assert.equal(stored.mimeType, 'image/png');
    assert.equal(stored.pixelCount, 6);

    const retry = await ctx.storage.writeObject!(key, Readable.from([first]), writeOptions(first));
    assert.equal(retry.contentHash, stored.contentHash, 'identical transport retry is accepted');
    await assert.rejects(
      ctx.storage.writeObject!(key, Readable.from([second]), writeOptions(second)),
      StorageConflictError,
    );

    const opened = await ctx.storage.openObject!(key);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), first, 'original encoded bytes are unchanged');
    assert.deepEqual(await readdir(path.join(ctx.root, 'staging')), []);
  } finally { await ctx.close(); }
});

test('concurrent publication picks one immutable object and rejects the competing bytes', async () => {
  const ctx = await fixture();
  try {
    const one = await png(1);
    const two = await png(2);
    assert.equal(one.length, two.length);
    const results = await Promise.allSettled([
      ctx.storage.writeObject!('reels/concurrent/object', Readable.from([one]), writeOptions(one)),
      ctx.storage.writeObject!('reels/concurrent/object', Readable.from([two]), writeOptions(two)),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    assert.ok(rejected.reason instanceof StorageConflictError);
    const opened = await ctx.storage.openObject!('reels/concurrent/object');
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    const final = Buffer.concat(chunks);
    assert.ok(final.equals(one) || final.equals(two));
  } finally { await ctx.close(); }
});

test('interrupted, oversized, corrupt and type-mismatched bodies never publish', async () => {
  const ctx = await fixture();
  try {
    const good = await png(15);
    async function* interrupted() {
      yield good.subarray(0, 20);
      throw new Error('simulated client disconnect');
    }
    await assert.rejects(
      ctx.storage.writeObject!('reels/interrupted/object', interrupted(), writeOptions(good)),
      /simulated client disconnect/,
    );
    assert.deepEqual(await ctx.storage.statObject('reels/interrupted/object'), { exists: false, byteSize: 0 });

    await assert.rejects(
      ctx.storage.writeObject!('reels/oversized/object', Readable.from([good, Buffer.from('x')]), writeOptions(good)),
      (error: unknown) => error instanceof StorageInputError && error.reason === 'byte_size_exceeded',
    );
    const corrupt = Buffer.alloc(good.length, 0x61);
    await assert.rejects(
      ctx.storage.writeObject!('reels/corrupt/object', Readable.from([corrupt]), writeOptions(corrupt)),
      (error: unknown) => error instanceof StorageInputError && error.reason === 'invalid_image',
    );
    await assert.rejects(
      ctx.storage.writeObject!('reels/mismatch/object', Readable.from([good]), writeOptions(good, { mimeType: 'image/jpeg' })),
      (error: unknown) => error instanceof StorageInputError && error.reason === 'mime_type_mismatch',
    );
    await assert.rejects(
      ctx.storage.writeObject!('../escape', Readable.from([good]), writeOptions(good)),
      (error: unknown) => error instanceof StorageInputError && error.reason === 'invalid_storage_key',
    );
    assert.deepEqual(await readdir(path.join(ctx.root, 'objects')), []);
    assert.deepEqual(await readdir(path.join(ctx.root, 'staging')), []);
  } finally { await ctx.close(); }
});

test('decoded dimensions and total pixels are bounded', async () => {
  const ctx = await fixture({ maxPixelCount: 4 });
  try {
    const body = await png(10, 3, 3);
    await assert.rejects(
      ctx.storage.writeObject!('reels/pixels/object', Readable.from([body]), writeOptions(body, { maxPixelCount: 4 })),
      (error: unknown) => error instanceof StorageInputError
        && (error.reason === 'invalid_image' || error.reason === 'image_dimensions_exceeded'),
    );
    assert.deepEqual(await ctx.storage.statObject('reels/pixels/object'), { exists: false, byteSize: 0 });
  } finally { await ctx.close(); }
});

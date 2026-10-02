import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { StorageInputError } from './core/storage.js';
import { filesystemStorageAdapter, initializeDisposableStorageRoot } from './storage/filesystem.js';

function fixtureBytes(kind: string): Buffer {
  if (['iso', 'mp4', 'mov', 'm4v', '3gp'].includes(kind)) return Buffer.from([0,0,0,16,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,0,0]);
  if (['ebml', 'webm', 'mkv'].includes(kind)) return Buffer.from([0x1a,0x45,0xdf,0xa3,0x93,0x42,0x82,0x88]);
  if (kind === 'avi') return Buffer.from('RIFF\x10\x00\x00\x00AVI ', 'binary');
  if (kind === 'ogg') return Buffer.from('OggS\x00\x02\x00\x00', 'binary');
  if (kind === 'flv') return Buffer.from('FLV\x01\x00\x00\x00\x09', 'binary');
  if (kind === 'ts') { const bytes = Buffer.alloc(377); bytes[0] = 0x47; bytes[188] = 0x47; return bytes; }
  if (kind === 'ps') return Buffer.from([0,0,1,0xba,0x44,0,4,0]);
  if (kind === 'asf') return Buffer.from([0x30,0x26,0xb2,0x75,0x8e,0x66,0xcf,0x11,0xa6,0xd9,0,0xaa,0,0x62,0xce,0x6c]);
  return Buffer.from('plain text is not video');
}

test('video uploads use recognized container signatures and retain a declared video MIME', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'szronox-video-'));
  const root = path.join(parent, 'storage');
  await initializeDisposableStorageRoot(root);
  const storage = filesystemStorageAdapter({ root, appOrigin: 'https://szronox.test', expectedUid: process.getuid?.(), expectedGid: process.getgid?.() });
  await storage.initialize();
  try {
    for (const [name, declared] of [['mp4', 'video/mp4'], ['mov', 'video/quicktime'], ['m4v', 'video/x-m4v'], ['3gp', 'video/3gpp'], ['webm', 'video/webm'], ['mkv', 'video/x-matroska'], ['avi', 'video/x-msvideo'], ['ogg', 'application/octet-stream'], ['flv', 'video/x-flv'], ['ts', 'video/mp2t'], ['ps', 'video/mpeg'], ['asf', 'video/x-ms-asf']] as const) {
      const bytes = fixtureBytes(name);
      const object = await storage.writeObject!(`reels/test/${name}`, Readable.from([bytes]), {
        mimeType: declared, kind: 'video', byteSize: bytes.length, maxByteSize: 25 * 1024 * 1024,
        maxPixelCount: 40_000_000, maxDimension: 20_000,
      });
      assert.equal(object.mimeType, declared.startsWith('video/') ? declared : 'video/ogg');
      assert.equal(object.width, undefined);
    }
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('video validation rejects image/text spoofing, unknown containers and streamed overruns', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'szronox-video-'));
  const root = path.join(parent, 'storage');
  await initializeDisposableStorageRoot(root);
  const storage = filesystemStorageAdapter({ root, appOrigin: 'https://szronox.test', expectedUid: process.getuid?.(), expectedGid: process.getgid?.() });
  await storage.initialize();
  try {
    const pngSignature = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
    for (const [key, bytes] of [['png-spoof', pngSignature], ['text-spoof', Buffer.from('not a container')], ['unknown', fixtureBytes('unknown')]] as const) {
      await assert.rejects(storage.writeObject!(`reels/test/${key}`, Readable.from([bytes]), {
        mimeType: 'video/mp4', kind: 'video', byteSize: bytes.length, maxByteSize: 25 * 1024 * 1024,
        maxPixelCount: 40_000_000, maxDimension: 20_000,
      }), (error: unknown) => error instanceof StorageInputError && error.reason === 'content_mismatch');
    }
    const tiny = Buffer.from('abc');
    await assert.rejects(storage.writeObject!('reels/test/overrun', Readable.from([Buffer.from('abcd')]), {
      mimeType: 'video/mp4', kind: 'video', byteSize: tiny.length, maxByteSize: 25 * 1024 * 1024,
      maxPixelCount: 40_000_000, maxDimension: 20_000,
    }), (error: unknown) => error instanceof StorageInputError && error.reason === 'byte_size_exceeded');
    await assert.rejects(storage.writeObject!('reels/test/over-limit', Readable.from([]), {
      mimeType: 'video/mp4', kind: 'video', byteSize: 25 * 1024 * 1024 + 1, maxByteSize: 25 * 1024 * 1024,
      maxPixelCount: 40_000_000, maxDimension: 20_000,
    }), (error: unknown) => error instanceof StorageInputError && error.reason === 'byte_size_exceeded');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test('GIF is accepted as a decoded image attachment', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'szronox-gif-'));
  const root = path.join(parent, 'storage');
  await initializeDisposableStorageRoot(root);
  const storage = filesystemStorageAdapter({ root, appOrigin: 'https://szronox.test', expectedUid: process.getuid?.(), expectedGid: process.getgid?.() });
  await storage.initialize();
  try {
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
    const object = await storage.writeObject!('reels/test/gif', Readable.from([gif]), {
      mimeType: 'image/gif', kind: 'image', byteSize: gif.length, maxByteSize: 8 * 1024 * 1024,
      maxPixelCount: 40_000_000, maxDimension: 20_000,
    });
    assert.equal(object.mimeType, 'image/gif');
  } finally { await rm(parent, { recursive: true, force: true }); }
});

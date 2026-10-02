import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadKdriveFile, uploadPercent } from '../kdrive-upload.ts';

const reel = { id: 'reel-1', version: 4 };
function fileFixture() {
  const slices = [];
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const file = {
    name: 'clip.mp4', type: 'video/mp4', size: bytes.length,
    slice(start, end) { slices.push([start, end]); return new Blob([bytes.slice(start, end)], { type: this.type }); },
  };
  return { file, slices };
}

test('kDrive uploader slices only bounded chunks and reports acknowledged progress', async () => {
  const { file, slices } = fileFixture();
  const calls = [];
  const api = {
    async startKdriveUpload(_reelId, body) {
      // The local copy is version 4; the start must use the server's current version (5),
      // so a folder link or save that the page has not seen yet cannot cause a false conflict.
      assert.equal(body.expectedVersion, 5);
      return { uploadId: 'upload-1', reelId: reel.id, purpose: 'video', fileName: file.name, mimeType: file.type,
        byteSize: file.size, chunkSize: 2, totalChunks: 3, receivedChunks: [], state: 'open' };
    },
    async sendKdriveChunk(id, index, chunk) { calls.push([id, index, chunk.size, chunk.type]); },
    async finishKdriveUpload(id) { assert.equal(id, 'upload-1'); },
    async reel(id) { assert.equal(id, reel.id); return { ...reel, version: 5 }; },
    async attachKdriveUpload(id, body) { assert.equal(id, 'upload-1'); assert.equal(body.expectedVersion, 5); return { ...reel, version: 6 }; },
  };
  const progress = [];
  const result = await uploadKdriveFile({ api, reel, purpose: 'video', file, createFolder: false,
    signal: new AbortController().signal, onProgress: (value) => progress.push(value) });
  assert.equal(result.version, 6);
  assert.deepEqual(slices, [[0, 2], [2, 4], [4, 5]]);
  assert.deepEqual(calls.map((call) => call.slice(1)), [[0, 2, 'video/mp4'], [1, 2, 'video/mp4'], [2, 1, 'video/mp4']]);
  assert.equal(progress.at(-1).phase, 'attaching');
  assert.equal(uploadPercent({ completedBytes: 5, totalBytes: 5 }), 100);
});

test('resume revalidates chunk zero and skips already acknowledged later chunks', async () => {
  const { file, slices } = fileFixture(); const calls = [];
  const existing = { uploadId: 'upload-2', reelId: reel.id, purpose: 'video', fileName: file.name, mimeType: file.type,
    byteSize: file.size, chunkSize: 2, totalChunks: 3, receivedChunks: [0, 1], state: 'open' };
  const api = {
    async sendKdriveChunk(id, index, chunk) { calls.push([id, index, chunk.size]); },
    async finishKdriveUpload() {}, async reel() { return reel; }, async attachKdriveUpload() { return reel; },
  };
  await uploadKdriveFile({ api, reel, purpose: 'video', file, createFolder: false, existing,
    signal: new AbortController().signal, onProgress() {} });
  assert.deepEqual(slices, [[0, 2], [4, 5]]);
  assert.deepEqual(calls.map((call) => call.slice(1)), [[0, 2], [2, 1]]);
});

test('resume rejects a different file before sending bytes', async () => {
  const { file } = fileFixture(); const calls = [];
  const api = { async sendKdriveChunk() { calls.push(true); } };
  await assert.rejects(uploadKdriveFile({ api, reel, purpose: 'video', file: { ...file, name: 'other.mp4' }, createFolder: false,
    existing: { uploadId: 'u', reelId: reel.id, purpose: 'video', fileName: file.name, mimeType: file.type, byteSize: file.size, chunkSize: 2, totalChunks: 3, receivedChunks: [], state: 'open' },
    signal: new AbortController().signal, onProgress() {} }), /Wybierz ten sam plik/);
  assert.equal(calls.length, 0);
});

/**
 * The real kDrive HTTP relay, against a recording fetch. kDrive numbers upload chunks from 1
 * (KDRIVE-02 live probe); the app's chunk index is 0-based, so chunk 0 must be sent as
 * `chunk_number=1`. Sending 0 made every first chunk fail on DEV with a 502.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { httpKdriveUploadClient } from './kdrive/upload-client.js';

test('putChunk sends a 1-based chunk_number with size, hash, bearer token and raw body', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ result: 'success', data: { number: 1, status: 'ok' } }), { status: 200 });
  }) as typeof fetch;
  const client = httpKdriveUploadClient({ driveId: '1990403', token: 'test-token', fetchImpl });
  const session = { token: 'session-token', uploadUrl: 'https://1-52-v3-12.upload.kdrive.infomaniak.com', fileId: '42', fileName: 'film.mp4' };

  const first = new Uint8Array([1, 2, 3]);
  const second = new Uint8Array([4, 5]);
  await client.putChunk(session, 0, first, createHash('sha256').update(first).digest('hex'));
  await client.putChunk(session, 1, second, createHash('sha256').update(second).digest('hex'));

  const [a, b] = calls.map((call) => new URL(call.url));
  assert.equal(a.searchParams.get('chunk_number'), '1');
  assert.equal(b.searchParams.get('chunk_number'), '2');
  assert.equal(a.searchParams.get('chunk_size'), '3');
  assert.equal(a.searchParams.get('chunk_hash'), `sha256:${createHash('sha256').update(first).digest('hex')}`);
  assert.equal(a.pathname, '/3/drive/1990403/upload/session/session-token/chunk');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer test-token');
  assert.equal((calls[0].init.headers as Record<string, string>)['content-type'], 'application/octet-stream');
});

test('a kDrive 400 on a chunk surfaces as a non-retryable rejection', async () => {
  const fetchImpl = (async () => new Response(JSON.stringify({ result: 'error', error: { code: 'upload_failed_error' } }), { status: 400 })) as typeof fetch;
  const client = httpKdriveUploadClient({ driveId: '1990403', token: 'test-token', fetchImpl });
  await assert.rejects(
    client.putChunk({ token: 's', uploadUrl: 'https://x.upload.kdrive.infomaniak.com' }, 0, new Uint8Array([1]), 'aa'),
    (error: { failure?: string; retryable?: boolean }) => error.failure === 'rejected' && error.retryable === false,
  );
});

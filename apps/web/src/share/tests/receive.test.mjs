import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SHARE_LIMITS,
  ShareRejectedError,
  findUrl,
  parseBoundedShare,
  readBoundedBody,
  readSharePayload,
  toCaptureInput,
} from '../receive.ts';

/**
 * Share receipt, tested against the real Web APIs Node provides — `Request`, `FormData`,
 * `Blob`, `ReadableStream` — rather than against doubles of them. What is not covered here is
 * anything needing a service worker scope or IndexedDB; those are browser facts and are
 * reported as such, not simulated into a pass.
 */

const boundary = '----szronoxtest';

/** Build a real multipart body. */
function multipart(parts) {
  const chunks = [];
  const encoder = new TextEncoder();
  for (const part of parts) {
    const disposition = part.filename === undefined
      ? `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`
      : `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
        `Content-Type: ${part.type}\r\n\r\n`;
    chunks.push(encoder.encode(`--${boundary}\r\n${disposition}`));
    chunks.push(typeof part.value === 'string' ? encoder.encode(part.value) : part.value);
    chunks.push(encoder.encode('\r\n'));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  return new Blob(chunks, { type: `multipart/form-data; boundary=${boundary}` });
}

function shareRequest(body) {
  return new Request('https://dev.example.test/share-target', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

let counter = 0;
const newId = () => `id-${++counter}`;

test('a body over the cap is refused while streaming, without being fully read', async () => {
  const cap = 1024;
  let produced = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      // Far more than the cap: if the reader were not stopped, this would run forever.
      produced += 256;
      controller.enqueue(new Uint8Array(256));
    },
    cancel() { cancelled = true; },
  });

  const request = new Request('https://dev.example.test/share-target', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: stream,
    duplex: 'half',
  });

  await assert.rejects(
    () => readBoundedBody(request, cap),
    (error) => error instanceof ShareRejectedError && error.reason === 'body_too_large',
  );
  assert.equal(cancelled, true, 'the reader must be cancelled, not drained');
  // The read stops at the first chunk that crosses the cap, so consumption is bounded by
  // cap + one chunk — not by whatever the sender chose to send.
  assert.ok(produced <= cap + 256, `consumed ${produced} bytes for a ${cap} byte cap`);
});

test('an over-stated content-length is refused before the body is read at all', async () => {
  const request = new Request('https://dev.example.test/share-target', {
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(SHARE_LIMITS.maxBodyBytes + 1),
    },
    body: new ReadableStream({ pull() { /* never resolves into a finished body */ } }),
    duplex: 'half',
  });
  await assert.rejects(
    () => readBoundedBody(request),
    (error) => error instanceof ShareRejectedError && error.reason === 'body_too_large',
  );
  // A declared over-limit body is rejected on the header alone: the stream is never locked,
  // which is the observable proof that no reader was ever taken from it.
  assert.equal(request.bodyUsed, false, 'the body must not be consumed');
  assert.equal(request.body?.locked, false, 'no reader should have been acquired');
});

test('a body with no content-length is still bounded by bytes actually read', async () => {
  const cap = 512;
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(128)); },
  });
  const request = new Request('https://dev.example.test/share-target', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: stream,
    duplex: 'half',
  });
  assert.equal(request.headers.get('content-length'), null, 'precondition: no declared length');
  await assert.rejects(
    () => readBoundedBody(request, cap),
    (error) => error instanceof ShareRejectedError && error.reason === 'body_too_large',
  );
});

test('too many files is refused, and the seventh file is what trips it', () => {
  const image = new Blob([new Uint8Array(16)], { type: 'image/png' });
  const parts = Array.from({ length: 7 }, (_, index) => ({
    name: 'images', filename: `p${index}.png`, type: 'image/png', value: image,
  }));
  const form = new FormData();
  for (const part of parts) form.append(part.name, new File([image], part.filename, { type: part.type }));
  assert.throws(
    () => readSharePayload(form, newId),
    (error) => error instanceof ShareRejectedError && error.reason === 'too_many_files',
  );
  assert.equal(SHARE_LIMITS.maxFiles, 6);
});

test('an oversized single file and an oversized aggregate are refused separately', () => {
  const big = new File([new Uint8Array(SHARE_LIMITS.maxFileBytes + 1)], 'big.png', { type: 'image/png' });
  const oneBig = new FormData();
  oneBig.append('images', big);
  assert.throws(
    () => readSharePayload(oneBig, newId),
    (error) => error instanceof ShareRejectedError && error.reason === 'file_too_large',
  );

  // Four files, each inside the per-file bound, together past the aggregate bound.
  const aggregate = new FormData();
  for (let index = 0; index < 4; index += 1) {
    aggregate.append('images', new File([new Uint8Array(SHARE_LIMITS.maxFileBytes)], `p${index}.png`, { type: 'image/png' }));
  }
  assert.throws(
    () => readSharePayload(aggregate, newId),
    (error) => error instanceof ShareRejectedError && error.reason === 'aggregate_too_large',
  );
});

test('scalar fields keep their exact order, repetition and empty values', async () => {
  const body = multipart([
    { name: 'title', value: 'Pierwszy' },
    { name: 'text', value: '' },
    { name: 'title', value: 'Drugi' },
    { name: 'text', value: 'Treść https://example.test/x ogon' },
    { name: 'nieznane', value: 'zachowane' },
  ]);
  const form = await parseBoundedShare(shareRequest(body));
  const received = readSharePayload(form, newId);

  assert.deepEqual(received.original.fields, [
    { name: 'title', value: 'Pierwszy' },
    { name: 'text', value: '' },
    { name: 'title', value: 'Drugi' },
    { name: 'text', value: 'Treść https://example.test/x ogon' },
    { name: 'nieznane', value: 'zachowane' },
  ]);

  const mapped = toCaptureInput(received);
  // A URL lifted out of the text does not remove the text it came from, in either place.
  assert.equal(mapped.input.url, 'https://example.test/x');
  assert.equal(mapped.input.text, 'Treść https://example.test/x ogon');
  assert.deepEqual(mapped.input.originalShare.fields, received.original.fields);
  // `additionalText` is the user's own later note; a share must never fabricate it.
  assert.equal('additionalText' in mapped.input, false);
});

test('an unsupported file is recorded as unsupported, not dropped and not stored', async () => {
  const body = multipart([
    { name: 'text', value: 'Opis' },
    { name: 'images', filename: 'ok.png', type: 'image/png', value: new Uint8Array([1, 2, 3]) },
    { name: 'images', filename: 'zly.gif', type: 'image/gif', value: new Uint8Array([4, 5]) },
  ]);
  const form = await parseBoundedShare(shareRequest(body));
  const received = readSharePayload(form, newId);

  assert.equal(received.original.files.length, 2, 'both files are described');
  assert.equal(received.original.files[0].issue, undefined);
  assert.equal(received.original.files[1].issue, 'UNSUPPORTED_INPUT');
  assert.equal(received.original.files[1].fileName, 'zly.gif');

  const mapped = toCaptureInput(received);
  assert.equal(mapped.input.images.length, 1, 'only the supported image becomes an attachment');
  assert.equal(mapped.blobs.size, 1, 'the unsupported file’s bytes are not kept');
  assert.equal(mapped.blobs.has(mapped.input.images[0].attachmentId), true);
  assert.equal(mapped.detectedKind, 'image');
});

test('attachment ids are allocated once at receipt and are distinct per file', async () => {
  const body = multipart([
    { name: 'images', filename: 'a.png', type: 'image/png', value: new Uint8Array([1]) },
    { name: 'images', filename: 'b.jpg', type: 'image/jpeg', value: new Uint8Array([2]) },
  ]);
  const form = await parseBoundedShare(shareRequest(body));
  const mapped = toCaptureInput(readSharePayload(form, newId));
  const ids = mapped.input.images.map((image) => image.attachmentId);
  assert.equal(new Set(ids).size, 2, 'distinct ids');
  assert.deepEqual(Object.keys(mapped.fileNames).sort(), [...ids].sort());
  assert.deepEqual([...mapped.blobs.keys()].sort(), [...ids].sort());
});

test('a share with nothing usable is refused explicitly rather than saved empty', async () => {
  const body = multipart([{ name: 'text', value: '   ' }, { name: 'url', value: '' }]);
  const form = await parseBoundedShare(shareRequest(body));
  assert.throws(
    () => toCaptureInput(readSharePayload(form, newId)),
    (error) => error instanceof ShareRejectedError && error.reason === 'nothing_usable',
  );
});

test('a text-only and a link-only share are detected as such', async () => {
  const textOnly = await parseBoundedShare(shareRequest(multipart([{ name: 'text', value: 'Sam tekst' }])));
  assert.equal(toCaptureInput(readSharePayload(textOnly, newId)).detectedKind, 'text');

  const linkOnly = await parseBoundedShare(shareRequest(multipart([{ name: 'url', value: 'https://example.test/r' }])));
  const mapped = toCaptureInput(readSharePayload(linkOnly, newId));
  assert.equal(mapped.detectedKind, 'url');
  assert.equal(mapped.input.url, 'https://example.test/r');
});

test('a title-only share is usable, and the title is not mistaken for body text it is not', async () => {
  const form = await parseBoundedShare(shareRequest(multipart([{ name: 'title', value: 'Sam tytuł' }])));
  const mapped = toCaptureInput(readSharePayload(form, newId));
  assert.equal(mapped.input.text, 'Sam tytuł');
  assert.deepEqual(mapped.input.originalShare.fields, [{ name: 'title', value: 'Sam tytuł' }]);
});

test('a non-multipart share is refused before anything is read', async () => {
  const request = new Request('https://dev.example.test/share-target', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  await assert.rejects(
    () => parseBoundedShare(request),
    (error) => error instanceof ShareRejectedError && error.reason === 'unreadable',
  );
});

test('only absolute http(s) URLs are lifted out of shared text', () => {
  assert.equal(findUrl('zobacz https://example.test/a?b=c koniec'), 'https://example.test/a?b=c');
  assert.equal(findUrl('http://example.test'), 'http://example.test/');
  assert.equal(findUrl('example.test/a'), undefined);
  assert.equal(findUrl('javascript:alert(1)'), undefined);
  assert.equal(findUrl('ftp://example.test/a'), undefined);
  assert.equal(findUrl(undefined), undefined);
});

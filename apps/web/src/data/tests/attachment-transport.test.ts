/**
 * Browser attachment transport and recovery.
 *
 * Real code under test: `AttachmentUploader`, `AttachmentRecovery`, `CoreApiClient`'s
 * raw-upload path and the real `DraftStore` logic. `fetch` is a recorder so every request
 * can be inspected exactly, and IndexedDB is a minimal in-memory double because Node has
 * none — the double proves how the store *addresses* records, not IndexedDB's own
 * transaction semantics.
 *
 * Not shown here, and not claimed: a real browser, a real service worker, a real upload
 * over the network, or a real image decode. Those are the VPS-07 gate.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AttachmentReference, AuthSessionResponse, CaptureImageDescriptor, Reel, User,
} from '../../../../../packages/contracts/src/index.js';
import { CoreApiClient, StaleResponseError, type RequestContext } from '../api.js';
import { AttachmentRecovery, attachmentOperations, derivedOperationId } from '../attachment-recovery.js';
import { AttachmentUploader, CrossOriginUploadError, sameOriginUploadPath, ticketHeaders } from '../attachments.js';
import { ClientApiError } from '../errors.js';
import { DraftStore, type CaptureDraft } from '../../drafts/store.js';

const NOXAVA: User = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA', avatarUrl: null };
const SZRON: User = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON', avatarUrl: null };
const ORIGIN = 'https://szronox.test';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A session source under the test's control, so generations can be rotated by hand. */
function sessionSource(initial: User = NOXAVA) {
  let user: User | null = initial;
  let generation = 1;
  let controller = new AbortController();
  return {
    context(): RequestContext {
      return { generation, actorId: user?.id ?? null, csrfToken: user ? 'csrf-token' : null, signal: controller.signal };
    },
    switchTo(next: User | null) {
      controller.abort();
      controller = new AbortController();
      generation += 1;
      user = next;
    },
    activeAccountId: () => user?.id ?? null,
  };
}

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials: string | undefined;
  body: unknown;
}

function recorder(responder: (call: Recorded) => Promise<Response> | Response) {
  const calls: Recorded[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const call: Recorded = {
      url: String(input),
      method: (init.method ?? 'GET').toUpperCase(),
      headers,
      credentials: init.credentials,
      body: init.body,
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { calls, restore() { globalThis.fetch = original; } };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const expired = () => json({
  error: {
    code: 'UPLOAD_INCOMPLETE',
    message: 'Upload authorization expired',
    retryable: false,
    details: { reason: 'upload_authorization_expired' },
  },
}, 422);

const descriptor = (attachmentId: string): CaptureImageDescriptor =>
  ({ attachmentId, fileName: 'a.png', mimeType: 'image/png', byteSize: 4 });

const ticket = (reelId: string, attachmentId: string, token = 'ticket-1') => ({
  uploadUrl: `${ORIGIN}/api/v1/reels/${reelId}/attachments/${attachmentId}/content`,
  method: 'PUT' as const,
  headers: { 'X-Upload-Token': token },
  expiresAt: Math.floor(Date.now() / 1000) + 300,
});

const reference = (attachmentId: string, reelId: string): AttachmentReference =>
  ({ id: attachmentId, reelId, purpose: 'input', kind: 'image', label: 'a.png', state: 'ready' });

const reelWith = (reelId: string, attachments: AttachmentReference[]) =>
  ({ id: reelId, attachments } as unknown as Reel);

// ══════════════════════ stable identifiers ══════════════════════════════════

test('attachment operation ids are stable, distinct per step, and correctly formatted', async () => {
  const capture = '33333333-3333-4333-8333-333333333333';
  const attachment = '44444444-4444-4444-8444-444444444444';

  const first = await attachmentOperations(capture, attachment);
  const second = await attachmentOperations(capture, attachment);
  // The whole point: a retry after a reload derives the same ids, so the server's
  // idempotency ledger recognises it instead of creating a second attachment.
  assert.deepEqual(first, second);
  assert.match(first.initiate, UUID);
  assert.match(first.complete, UUID);

  // Distinct per step. The same id on two routes would make the ledger return one
  // route's recorded result for the other.
  assert.notEqual(first.initiate, first.complete);
  // Distinct per attachment and per capture.
  const otherAttachment = await attachmentOperations(capture, '55555555-5555-4555-8555-555555555555');
  assert.notEqual(first.initiate, otherAttachment.initiate);
  const otherCapture = await attachmentOperations('66666666-6666-4666-8666-666666666666', attachment);
  assert.notEqual(first.initiate, otherCapture.initiate);

  // RFC 9562 version 8 with the correct variant bits: derived, and labelled as derived
  // rather than dressed up as random.
  const id = await derivedOperationId(capture, attachment, 'initiate');
  assert.equal(id[14], '8', 'version nibble must be 8');
  assert.ok(['8', '9', 'a', 'b'].includes(id[19]), 'variant nibble must be 10xx');
});

// ══════════════════════ same-origin refusal ═════════════════════════════════

test('a non-same-origin upload URL is refused before any credential is attached', () => {
  const good = `${ORIGIN}/api/v1/reels/r/attachments/a/content`;
  assert.equal(sameOriginUploadPath(good, ORIGIN), '/api/v1/reels/r/attachments/a/content');
  assert.equal(sameOriginUploadPath(`${ORIGIN}/api/v1/x?y=1`, ORIGIN), '/api/v1/x?y=1');

  for (const hostile of [
    'https://evil.test/api/v1/x',
    `${ORIGIN}.evil.test/api/v1/x`,
    'http://szronox.test/api/v1/x',
    `${ORIGIN}:8443/api/v1/x`,
    'not a url at all',
    // Relative: the server's contract is an absolute URL, so a relative one is a value
    // the client cannot verify rather than one it should resolve against the page.
    '/api/v1/reels/r/attachments/a/content',
    // Credentials embedded in the URL.
    'https://user:pass@szronox.test/api/v1/x',
  ]) {
    assert.throws(() => sameOriginUploadPath(hostile, ORIGIN), CrossOriginUploadError, hostile);
  }

  // Only the ticket header is forwarded, whatever else the server put in `headers`.
  assert.deepEqual(
    ticketHeaders({ ...ticket('r', 'a'), headers: { 'X-Upload-Token': 't', Cookie: 'leak', Authorization: 'leak' } }),
    { 'X-Upload-Token': 't' },
  );
  assert.throws(() => ticketHeaders({ ...ticket('r', 'a'), headers: {} }), /no upload token/);
});

test('the raw upload is same-origin, CSRF-protected and carries only the ticket header', async () => {
  const session = sessionSource();
  const api = new CoreApiClient(session);
  const uploader = new AttachmentUploader({ api, pageOrigin: ORIGIN });
  const fake = recorder(() => new Response(null, { status: 204 }));
  try {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
    await uploader.putContent(ticket('reel-1', 'att-1', 'token-abc'), blob, 'image/png');

    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0];
    // A path, not the absolute URL: the origin was checked and stripped, so the request
    // cannot leave this origin even if the server's URL was wrong.
    assert.equal(call.url, '/api/v1/reels/reel-1/attachments/att-1/content');
    assert.equal(call.method, 'PUT');
    assert.equal(call.credentials, 'same-origin');
    assert.equal(call.headers['x-upload-token'], 'token-abc');
    assert.equal(call.headers['x-csrf-token'], 'csrf-token');
    assert.equal(call.headers['content-type'], 'image/png');
    assert.equal(call.headers.authorization, undefined);
    assert.equal(call.headers.cookie, undefined, 'the browser attaches the cookie; the page never sets it');
    assert.ok(call.body instanceof Blob, 'the blob is streamed rather than copied into a string');
  } finally {
    fake.restore();
  }
});

// ══════════════════════ expiry renewal ══════════════════════════════════════

test('an expired ticket is renewed once and the same identifiers are reused', async () => {
  const session = sessionSource();
  const api = new CoreApiClient(session);
  const uploader = new AttachmentUploader({ api, pageOrigin: ORIGIN });
  const reelId = 'reel-1';
  const attachmentId = 'att-1';
  let puts = 0;

  const fake = recorder((call) => {
    if (call.url.endsWith('/attachments/initiate')) {
      return json({
        attachment: { ...reference(attachmentId, reelId), state: 'pending' },
        storageKey: 'k',
        upload: ticket(reelId, attachmentId, 'stale-token'),
      });
    }
    if (call.url.endsWith('/upload-authorization')) {
      return json({ upload: ticket(reelId, attachmentId, 'fresh-token') });
    }
    if (call.url.endsWith('/content')) {
      puts += 1;
      // The first attempt is refused as expired, exactly as the server would.
      return puts === 1 ? expired() : new Response(null, { status: 204 });
    }
    return json(reference(attachmentId, reelId));
  });
  try {
    const operations = await attachmentOperations('capture-op', attachmentId);
    const outcome = await uploader.uploadOne({
      reelId,
      descriptor: descriptor(attachmentId),
      blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
      operations,
    });

    assert.deepEqual(outcome.steps, ['initiate', 'renew', 'upload', 'complete']);
    assert.equal(outcome.releasable, true);
    assert.equal(outcome.acknowledged?.state, 'ready');

    // The second PUT used the renewed ticket; the attachment id never changed.
    const puts2 = fake.calls.filter((call) => call.url.endsWith('/content'));
    assert.equal(puts2.length, 2);
    assert.equal(puts2[0].headers['x-upload-token'], 'stale-token');
    assert.equal(puts2[1].headers['x-upload-token'], 'fresh-token');

    // Renewal carries an empty JSON object and creates nothing.
    const renewal = fake.calls.find((call) => call.url.endsWith('/upload-authorization'));
    assert.equal(renewal?.body, '{}');

    // Initiation and completion used the derived ids, so a later retry is a replay.
    const initiate = fake.calls.find((call) => call.url.endsWith('/attachments/initiate'));
    assert.equal(JSON.parse(String(initiate?.body)).operationId, operations.initiate);
    assert.equal(JSON.parse(String(initiate?.body)).attachmentId, attachmentId);
    const complete = fake.calls.find((call) => call.url.endsWith('/complete'));
    assert.equal(JSON.parse(String(complete?.body)).operationId, operations.complete);
  } finally {
    fake.restore();
  }
});

test('a replayed initiation that already reports ready skips straight to completion', async () => {
  const session = sessionSource();
  const api = new CoreApiClient(session);
  const uploader = new AttachmentUploader({ api, pageOrigin: ORIGIN });
  const fake = recorder((call) => {
    if (call.url.endsWith('/attachments/initiate')) {
      return json({ attachment: reference('att-1', 'reel-1'), storageKey: 'k', upload: ticket('reel-1', 'att-1') });
    }
    return json(reference('att-1', 'reel-1'));
  });
  try {
    const outcome = await uploader.uploadOne({
      reelId: 'reel-1',
      descriptor: descriptor('att-1'),
      blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
      operations: await attachmentOperations('capture-op', 'att-1'),
    });
    // No PUT: the object is immutable and already published, so re-sending bytes would
    // be refused. Completion is all that is left.
    assert.deepEqual(outcome.steps, ['initiate', 'complete']);
    assert.equal(fake.calls.filter((call) => call.url.endsWith('/content')).length, 0);
  } finally {
    fake.restore();
  }
});

// ══════════════════════ acknowledgement and blob retention ══════════════════

/** Minimal in-memory IndexedDB, covering exactly what `DraftStore` uses. */
function fakeIndexedDB() {
  const data = new Map<string, Map<string, { id: string } & Record<string, unknown>>>();
  for (const name of ['captureDrafts', 'reelDrafts', 'blobs', 'queue', 'quarantine']) data.set(name, new Map());
  const succeed = <T>(result: T) => {
    const request = { result, onsuccess: null as null | (() => void), onerror: null as null | (() => void) };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  };
  return {
    data,
    open() {
      const open = {
        result: {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => undefined,
          transaction() {
            const tx = {
              oncomplete: null as null | (() => void),
              onerror: null as null | (() => void),
              onabort: null as null | (() => void),
              objectStore(name: string) {
                const bucket = data.get(name)!;
                return {
                  put: (value: { id: string }) => succeed(bucket.set(value.id, value as never)),
                  get: (id: string) => succeed(bucket.get(id)),
                  getAll: () => succeed([...bucket.values()]),
                  delete: (id: string) => succeed(bucket.delete(id)),
                };
              },
            };
            queueMicrotask(() => tx.oncomplete?.());
            return tx;
          },
        },
        onupgradeneeded: null as null | (() => void),
        onsuccess: null as null | (() => void),
        onerror: null as null | (() => void),
      };
      queueMicrotask(() => { open.onupgradeneeded?.(); open.onsuccess?.(); });
      return open;
    },
  };
}

async function withFakeIdb<T>(body: (store: DraftStore, idb: ReturnType<typeof fakeIndexedDB>) => Promise<T>): Promise<T> {
  const idb = fakeIndexedDB();
  const previous = Reflect.get(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { value: idb, configurable: true });
  try {
    return await body(new DraftStore(), idb);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'indexedDB');
    else Object.defineProperty(globalThis, 'indexedDB', { value: previous, configurable: true });
  }
}

const captureDraft = (accountId: string, reelId: string, attachmentIds: string[]): CaptureDraft => ({
  id: `${accountId}:${reelId}`,
  accountId,
  reelId,
  operationId: 'capture-op-1',
  input: { images: attachmentIds.map(descriptor) },
  priority: 'normal',
  fileNames: Object.fromEntries(attachmentIds.map((id) => [id, 'a.png'])),
  updatedAt: 1,
  state: 'queued',
});

test('the capture draft survives until every attachment is acknowledged', async () => {
  await withFakeIdb(async (store) => {
    const session = sessionSource();
    const api = new CoreApiClient(session);
    const recovery = new AttachmentRecovery({ api, store, pageOrigin: ORIGIN, activeAccountId: session.activeAccountId });
    const reelId = 'reel-1';
    const [first, second] = ['att-1', 'att-2'];
    const draft = captureDraft(NOXAVA.id, reelId, [first, second]);

    await store.saveCapture(draft, new Map([
      [first, new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' })],
      [second, new Blob([new Uint8Array([5, 6, 7, 8])], { type: 'image/png' })],
    ]));

    // The second attachment fails to complete on the first attempt only, so the first
    // pass leaves the capture unfinished and the second pass finishes it.
    let ready: string[] = [];
    let secondAttempts = 0;
    const fake = recorder((call) => {
      if (call.url.match(/\/reels\/reel-1$/)) {
        return json(reelWith(reelId, ready.map((id) => reference(id, reelId))));
      }
      if (call.url.endsWith('/attachments/initiate')) {
        const attachmentId = JSON.parse(String(call.body)).attachmentId as string;
        return json({
          attachment: { ...reference(attachmentId, reelId), state: 'pending' },
          storageKey: 'k',
          upload: ticket(reelId, attachmentId),
        });
      }
      if (call.url.endsWith('/content')) return new Response(null, { status: 204 });
      if (call.url.endsWith('/complete')) {
        const attachmentId = call.url.split('/').at(-2) as string;
        if (attachmentId === second) {
          secondAttempts += 1;
          if (secondAttempts === 1) {
            return json({ error: { code: 'INTERNAL_ERROR', message: 'nope', retryable: true } }, 500);
          }
        }
        ready = [...ready, attachmentId];
        return json(reference(attachmentId, reelId));
      }
      return json({});
    });
    try {
      const progress = await recovery.runCapture(draft);
      assert.deepEqual(progress.acknowledged, [first]);
      assert.deepEqual(progress.outstanding, [second]);
      assert.equal(progress.complete, false);

      // Both the draft and both blobs are still local: one attachment is unacknowledged,
      // and the bytes are the only copy of it.
      assert.ok(await store.capture(NOXAVA.id, reelId), 'the draft must survive an incomplete capture');
      assert.ok(await store.blob(NOXAVA.id, first));
      assert.ok(await store.blob(NOXAVA.id, second));

      // Second pass: the previously acknowledged attachment is skipped and the failing
      // one now succeeds, with the same derived identifiers.
      const secondPass = await recovery.runCapture(draft);
      assert.deepEqual(secondPass.outstanding, []);
      assert.equal(secondPass.complete, true);
      const initiations = fake.calls.filter((call) => call.url.endsWith('/attachments/initiate'));
      const firstIds = initiations.map((call) => JSON.parse(String(call.body)).operationId as string);
      assert.equal(new Set(firstIds).size, 2, 'exactly two distinct operation ids for two attachments, across retries');

      // Only now is the draft removed, because the server reports every image ready.
      assert.equal(await store.capture(NOXAVA.id, reelId), undefined);
    } finally {
      fake.restore();
    }
  });
});

test('resume skips unsubmitted drafts and retries submitted ones with the same ids', async () => {
  await withFakeIdb(async (store) => {
    const session = sessionSource();
    const api = new CoreApiClient(session);
    const recovery = new AttachmentRecovery({ api, store, pageOrigin: ORIGIN, activeAccountId: session.activeAccountId });

    const submitted = captureDraft(NOXAVA.id, 'reel-queued', ['att-1']);
    const unsubmitted: CaptureDraft = { ...captureDraft(NOXAVA.id, 'reel-draft', ['att-2']), id: `${NOXAVA.id}:reel-draft`, state: 'draft' };
    await store.saveCapture(submitted, new Map([['att-1', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' })]]));
    await store.saveCapture(unsubmitted, new Map([['att-2', new Blob([new Uint8Array([5, 6, 7, 8])], { type: 'image/png' })]]));

    const fake = recorder((call) => {
      if (/\/reels\/reel-draft$/.test(call.url)) assert.fail('an unsubmitted draft must not be uploaded');
      if (/\/reels\/reel-queued$/.test(call.url)) return json(reelWith('reel-queued', []));
      if (call.url.endsWith('/attachments/initiate')) {
        return json({
          attachment: { ...reference('att-1', 'reel-queued'), state: 'pending' },
          storageKey: 'k',
          upload: ticket('reel-queued', 'att-1'),
        });
      }
      if (call.url.endsWith('/content')) return new Response(null, { status: 204 });
      return json(reference('att-1', 'reel-queued'));
    });
    try {
      const results = await recovery.resume(NOXAVA.id);
      assert.equal(results.length, 1);
      assert.equal(results[0].reelId, 'reel-queued');
      assert.equal(results[0].complete, true);
      // The unsubmitted draft and its blob are untouched: its Reel does not exist yet.
      assert.ok(await store.capture(NOXAVA.id, 'reel-draft'));
      assert.ok(await store.blob(NOXAVA.id, 'att-2'));
    } finally {
      fake.restore();
    }
  });
});

// ══════════════════════ account isolation ═══════════════════════════════════

test('an upload result arriving after an account switch touches no partition', async () => {
  await withFakeIdb(async (store) => {
    const session = sessionSource();
    const api = new CoreApiClient(session);
    const recovery = new AttachmentRecovery({ api, store, pageOrigin: ORIGIN, activeAccountId: session.activeAccountId });
    const draft = captureDraft(NOXAVA.id, 'reel-1', ['att-1']);
    await store.saveCapture(draft, new Map([['att-1', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' })]]));

    // The other account signs in while the Reel read is outstanding.
    const fake = recorder((call) => {
      if (/\/reels\/reel-1$/.test(call.url)) {
        session.switchTo(SZRON);
        return json(reelWith('reel-1', [reference('att-1', 'reel-1')]));
      }
      return json({});
    });
    try {
      const progress = await recovery.runCapture(draft);
      assert.equal(progress.abandoned, true, 'the run must report that it was abandoned');
      assert.equal(progress.complete, false);

      // NOXAVA's draft and blob are exactly as they were. A stale success that deleted
      // them would have destroyed the other account's only copy of the image.
      assert.ok(await store.capture(NOXAVA.id, 'reel-1'));
      assert.ok(await store.blob(NOXAVA.id, 'att-1'));
      // And nothing was written into SZRON's partition.
      assert.equal(await store.capture(SZRON.id, 'reel-1'), undefined);
      assert.equal(await store.blob(SZRON.id, 'att-1'), undefined);
    } finally {
      fake.restore();
    }
  });
});

test('a stale attachment response is rejected rather than returned', async () => {
  const session = sessionSource();
  const api = new CoreApiClient(session);
  const fake = recorder(() => {
    session.switchTo(SZRON);
    return json(reference('att-1', 'reel-1'));
  });
  try {
    await assert.rejects(
      api.completeAttachment('reel-1', 'att-1', { operationId: 'op-1' }),
      (error: unknown) => error instanceof StaleResponseError,
    );
  } finally {
    fake.restore();
  }
});

test('no attachment request is dispatched before the server confirms the identity', async () => {
  const session = sessionSource();
  session.switchTo(null);
  const api = new CoreApiClient(session);
  const fake = recorder(() => json({}));
  try {
    await assert.rejects(
      api.initiateAttachment('reel-1', {
        operationId: 'op-1', attachmentId: 'att-1', fileName: 'a.png', mimeType: 'image/png', byteSize: 4,
      }),
      (error: unknown) => error instanceof ClientApiError && error.status === 401,
    );
    assert.equal(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
});

/** Keeps the unused-import checker honest about what this file exercises. */
void (null as AuthSessionResponse | null);

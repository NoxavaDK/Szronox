/**
 * Browser-side authentication behaviour.
 *
 * What is real here: the actual `BrowserSession`, the actual `AuthTransport`, the
 * actual `CoreApiClient` and the actual `DraftStore` code paths. `fetch` is replaced
 * by a recorder so every request the client makes can be inspected exactly — method,
 * headers, credentials mode, abort signal — and IndexedDB is replaced by a minimal
 * in-memory double, because Node has no IndexedDB.
 *
 * What this cannot show, stated plainly: whether a real browser honours
 * `credentials: 'same-origin'`, `HttpOnly`, `Secure`, `SameSite=Lax` or the
 * `__Host-` prefix. Those are browser behaviours; the server-side tests assert the
 * headers that ask for them, and the browser acceptance run remains a VPS-07 gate.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

import type { AuthSessionResponse, Reel, User } from '../../../../../packages/contracts/src/index.js';
import { CoreApiClient, StaleResponseError } from '../../data/api.js';
import { ClientApiError } from '../../data/errors.js';
import { DraftStore } from '../../drafts/store.js';
import { BrowserSession } from '../session.js';
import { AuthTransport } from '../transport.js';

const NOXAVA: User = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA', avatarUrl: null };
const SZRON: User = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON', avatarUrl: null };

function sessionFor(user: User, peer: User, csrfToken: string): AuthSessionResponse {
  return { user, peer, expiresAt: '2026-09-21T12:00:00.000Z', csrfToken };
}

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  credentials: string | undefined;
  signal: AbortSignal | undefined;
  body: string | undefined;
}

interface Responder { (recorded: Recorded): Promise<Response> | Response }

/** Replace global fetch and record everything the client asked for. */
function recorder(responder: Responder) {
  const calls: Recorded[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const recordedCall: Recorded = {
      url: String(input),
      method: (init.method ?? 'GET').toUpperCase(),
      headers,
      credentials: init.credentials,
      signal: init.signal ?? undefined,
      body: typeof init.body === 'string' ? init.body : undefined,
    };
    calls.push(recordedCall);
    return responder(recordedCall);
  }) as typeof fetch;
  return { calls, restore() { globalThis.fetch = original; } };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const errorBody = (code: string, status: number) =>
  json({ error: { code, message: code, retryable: status >= 500 } }, status);

/** A response the test releases by hand, so a request can be held mid-flight. */
function held() {
  let release!: (value: Response) => void;
  const promise = new Promise<Response>((resolve) => { release = resolve; });
  return { promise, release };
}

/** The happy path most tests need: session bootstrap, login, and a reel list. */
function standardResponder(csrfToken = 'csrf-token-noxava'): Responder {
  return (call) => {
    if (call.url.endsWith('/auth/login')) return json(sessionFor(NOXAVA, SZRON, csrfToken));
    if (call.url.endsWith('/auth/session')) return json(sessionFor(NOXAVA, SZRON, csrfToken));
    if (call.url.endsWith('/auth/logout')) return new Response(null, { status: 204 });
    if (call.url.endsWith('/me')) return json({ user: NOXAVA, peer: SZRON });
    return json({ items: [], nextCursor: null });
  };
}

// ══════════════════════ nothing is persisted ════════════════════════════════

test('signing in, working and signing out writes nothing to any browser storage', async () => {
  const writes: string[] = [];
  const trap = (label: string) => new Proxy({}, {
    get(_target, property) {
      // Reading is recorded as well: even a read implies something was expected to
      // be there, which for auth state it must not be.
      writes.push(`${label}.${String(property)}`);
      return () => undefined;
    },
    set(_target, property) { writes.push(`${label}.${String(property)}=`); return true; },
  });

  const previous = {
    localStorage: Reflect.get(globalThis, 'localStorage'),
    sessionStorage: Reflect.get(globalThis, 'sessionStorage'),
    indexedDB: Reflect.get(globalThis, 'indexedDB'),
    caches: Reflect.get(globalThis, 'caches'),
    cookie: Reflect.get(globalThis, 'document'),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: trap('localStorage'), configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: trap('sessionStorage'), configurable: true });
  Object.defineProperty(globalThis, 'indexedDB', { value: trap('indexedDB'), configurable: true });
  Object.defineProperty(globalThis, 'caches', { value: trap('caches'), configurable: true });
  Object.defineProperty(globalThis, 'document', { value: { cookie: '' }, configurable: true });

  const fake = recorder(standardResponder());
  try {
    const auth = new BrowserSession(new AuthTransport());
    const api = new CoreApiClient(auth);
    await auth.restore();
    await auth.signIn('NOXAVA', 'hasło');
    await api.list({ status: 'idea' });
    await auth.signOut();

    assert.deepEqual(writes, [], `auth must touch no browser storage, saw: ${writes.join(', ')}`);
  } finally {
    fake.restore();
    for (const [key, value] of Object.entries(previous)) {
      const name = key === 'cookie' ? 'document' : key;
      if (value === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, { value, configurable: true });
    }
  }
});

/**
 * Strip comments so the check below inspects code rather than prose.
 *
 * Crude by design — it does not parse — but these four files contain no `//` inside
 * a string literal, so for them it is exact. Without this, the documentation that
 * explains *why* nothing is persisted would itself fail the assertion.
 */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/.*$/gm, '');
}

test('no auth source file contains code that persists a token', () => {
  // A static companion to the dynamic check above: a future edit that reintroduced
  // token persistence would have to name one of these.
  // Walk up to the package root by looking for the source itself, so this works
  // whether the test runs from src/ or from the compiled output under dist/.
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(directory, 'src', 'auth', 'session.ts'))) {
    const parent = path.dirname(directory);
    assert.notEqual(parent, directory, 'could not locate the web package root');
    directory = parent;
  }
  const sources = [
    ['auth/session.ts', path.join(directory, 'src', 'auth', 'session.ts')],
    ['auth/transport.ts', path.join(directory, 'src', 'auth', 'transport.ts')],
    ['auth/Login.tsx', path.join(directory, 'src', 'auth', 'Login.tsx')],
    ['data/api.ts', path.join(directory, 'src', 'data', 'api.ts')],
    ['main.tsx', path.join(directory, 'src', 'main.tsx')],
  ] as const;

  for (const [name, file] of sources) {
    const code = codeOnly(readFileSync(file, 'utf8'));
    for (const forbidden of [
      'localStorage', 'sessionStorage', 'indexedDB', 'caches.',
      'refresh_token', 'access_token', 'VITE_SUPABASE', 'supabase',
    ]) {
      assert.ok(!code.includes(forbidden), `${name} must not use ${forbidden}`);
    }
    // A bearer token would have to be attached under this header name.
    assert.ok(!/['"`]?Authorization['"`]?\s*:/i.test(code), `${name} must not set an Authorization header`);
  }
});

// ══════════════════════ transport shape ═════════════════════════════════════

test('every request is same-origin cookie-backed, with CSRF on unsafe methods only', async () => {
  const fake = recorder(standardResponder('csrf-abc'));
  try {
    const auth = new BrowserSession(new AuthTransport());
    const api = new CoreApiClient(auth);
    await auth.signIn('NOXAVA', 'hasło');

    await api.me();
    await api.list();
    await api.create({ operationId: 'op-1', reelId: 'reel-1', input: { images: [] } } as never);
    await api.patch('reel-1', { operationId: 'op-2', expectedVersion: 1, changes: { title: 'x' } } as never);

    for (const call of fake.calls) {
      assert.equal(call.credentials, 'same-origin', `${call.method} ${call.url}`);
      assert.equal(call.headers.authorization, undefined, 'no Authorization header may be sent');
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(call.method) && !call.url.endsWith('/auth/login')) {
        assert.equal(call.headers['x-csrf-token'], 'csrf-abc', `${call.method} ${call.url} needs the CSRF token`);
      } else {
        assert.equal(call.headers['x-csrf-token'], undefined, `${call.method} ${call.url} must not send CSRF`);
      }
    }

    // The password goes to the login endpoint and nowhere else.
    const withPassword = fake.calls.filter((call) => (call.body ?? '').includes('hasło'));
    assert.equal(withPassword.length, 1);
    assert.ok(withPassword[0].url.endsWith('/auth/login'));
  } finally {
    fake.restore();
  }
});

test('a 204 response is accepted without trying to parse a body', async () => {
  const fake = recorder((call) => {
    if (call.url.endsWith('/auth/login')) return json(sessionFor(NOXAVA, SZRON, 'csrf'));
    return new Response(null, { status: 204 });
  });
  try {
    const auth = new BrowserSession(new AuthTransport());
    await auth.signIn('NOXAVA', 'hasło');
    // Logout is the 204 the contract specifies; a JSON parse here would throw.
    await auth.signOut();
    assert.equal(auth.current(), null);
  } finally {
    fake.restore();
  }
});

test('no domain request is dispatched before the server confirms the identity', async () => {
  const fake = recorder(standardResponder());
  try {
    const auth = new BrowserSession(new AuthTransport());
    const api = new CoreApiClient(auth);

    await assert.rejects(
      api.list(),
      (error: unknown) => error instanceof ClientApiError && error.status === 401,
    );
    assert.equal(fake.calls.length, 0, 'nothing may reach the network before identity is confirmed');
  } finally {
    fake.restore();
  }
});

// ══════════════════════ reload and connection failure ═══════════════════════

test('a reload recovers the session from the cookie alone', async () => {
  const fake = recorder(standardResponder('csrf-restored'));
  try {
    // A fresh instance is exactly what a reload produces: no memory of anything.
    const auth = new BrowserSession(new AuthTransport());
    assert.equal(auth.current(), null);
    assert.equal(auth.state().status, 'unknown');

    await auth.restore();
    assert.equal(auth.state().status, 'authenticated');
    assert.equal(auth.current()?.user.name, 'NOXAVA');
    assert.equal(auth.current()?.peer.name, 'SZRON');
    assert.equal(auth.context().csrfToken, 'csrf-restored');

    assert.equal(fake.calls.length, 1);
    assert.ok(fake.calls[0].url.endsWith('/auth/session'));
    assert.equal(fake.calls[0].credentials, 'same-origin');
  } finally {
    fake.restore();
  }
});

test('a restore that cannot reach the server is not a logout', async () => {
  let mode: 'ok' | 'network' | 'anonymous' = 'ok';
  const fake = recorder((call) => {
    if (mode === 'network') throw new TypeError('Failed to fetch');
    if (call.url.endsWith('/auth/session')) {
      return mode === 'anonymous'
        ? errorBody('UNAUTHENTICATED', 401)
        : json(sessionFor(NOXAVA, SZRON, 'csrf'));
    }
    return json(sessionFor(NOXAVA, SZRON, 'csrf'));
  });
  try {
    const auth = new BrowserSession(new AuthTransport());
    await auth.restore();
    assert.equal(auth.state().status, 'authenticated');

    mode = 'network';
    await auth.restore();
    // Unreachable, and the session is retained: a failed request is not evidence
    // that the session ended, and discarding it here would discard local drafts too.
    assert.equal(auth.state().status, 'unreachable');
    assert.equal(auth.current()?.user.name, 'NOXAVA');

    // Only a 401 is confirmation.
    mode = 'anonymous';
    await auth.restore();
    assert.equal(auth.state().status, 'anonymous');
    assert.equal(auth.current(), null);
  } finally {
    fake.restore();
  }
});

test('concurrent restores are a single request', async () => {
  const fake = recorder(standardResponder());
  try {
    const auth = new BrowserSession(new AuthTransport());
    await Promise.all([auth.restore(), auth.restore(), auth.restore()]);
    assert.equal(fake.calls.length, 1, 'the bootstrap must be single-flight');
  } finally {
    fake.restore();
  }
});

// ══════════════════════ account switching ═══════════════════════════════════

test('a response in flight when the account changes is discarded, not applied', async () => {
  const outstanding = held();
  const fake = recorder((call) => {
    if (call.url.endsWith('/auth/login')) {
      return json(sessionFor(call.body?.includes('SZRON') ? SZRON : NOXAVA, NOXAVA, 'csrf-new'));
    }
    // Held open so the account can change while this request is outstanding.
    if (call.url.includes('/reels/')) return outstanding.promise;
    return json({ items: [], nextCursor: null });
  });
  try {
    const auth = new BrowserSession(new AuthTransport());
    const api = new CoreApiClient(auth);
    await auth.signIn('NOXAVA', 'hasło');
    const generationBefore = auth.context().generation;

    const inFlight = api.reel('reel-1');
    const signal = fake.calls.at(-1)?.signal;
    assert.ok(signal, 'the request must carry the generation abort signal');
    assert.equal(signal.aborted, false);

    // The other account signs in while the read is outstanding.
    await auth.signIn('SZRON', 'inne-hasło');
    assert.notEqual(auth.context().generation, generationBefore);
    assert.equal(signal.aborted, true, 'the previous generation must be aborted');

    // The server answers anyway — a race a real network produces routinely.
    outstanding.release(json({ id: 'reel-1', title: 'NOXAVA-only' } as unknown as Reel));
    await assert.rejects(
      inFlight,
      (error: unknown) => error instanceof StaleResponseError,
      'the old account\'s result must not be returned to the new account',
    );
    assert.equal(auth.current()?.user.name, 'SZRON');
  } finally {
    fake.restore();
  }
});

test('signing out aborts outstanding work and clears the confirmed identity', async () => {
  const outstanding = held();
  const fake = recorder((call) => {
    if (call.url.endsWith('/auth/login')) return json(sessionFor(NOXAVA, SZRON, 'csrf'));
    if (call.url.endsWith('/auth/logout')) return new Response(null, { status: 204 });
    return outstanding.promise;
  });
  try {
    const auth = new BrowserSession(new AuthTransport());
    const api = new CoreApiClient(auth);
    await auth.signIn('NOXAVA', 'hasło');

    const inFlight = api.list();
    const signal = fake.calls.at(-1)?.signal;
    await auth.signOut();

    assert.equal(auth.current(), null);
    assert.equal(auth.context().actorId, null);
    assert.equal(auth.context().csrfToken, null);
    assert.equal(signal?.aborted, true);

    outstanding.release(json({ items: [{ id: 'leaked' }], nextCursor: null }));
    await assert.rejects(inFlight, (error: unknown) => error instanceof StaleResponseError);
  } finally {
    fake.restore();
  }
});

test('a failed logout still clears local state and says the server was not confirmed', async () => {
  const fake = recorder((call) => {
    if (call.url.endsWith('/auth/login')) return json(sessionFor(NOXAVA, SZRON, 'csrf'));
    if (call.url.endsWith('/auth/logout')) throw new TypeError('Failed to fetch');
    return json({ items: [], nextCursor: null });
  });
  try {
    const auth = new BrowserSession(new AuthTransport());
    await auth.signIn('NOXAVA', 'hasło');
    await assert.rejects(auth.signOut(), TypeError);
    // The view is anonymous, and the caller was told rather than reassured.
    assert.equal(auth.current(), null);
    assert.equal(auth.state().status, 'anonymous');
  } finally {
    fake.restore();
  }
});

test('a logout the server reports as already gone counts as a clean logout', async () => {
  const fake = recorder((call) => {
    if (call.url.endsWith('/auth/login')) return json(sessionFor(NOXAVA, SZRON, 'csrf'));
    if (call.url.endsWith('/auth/logout')) return errorBody('UNAUTHENTICATED', 401);
    return json({ items: [], nextCursor: null });
  });
  try {
    const auth = new BrowserSession(new AuthTransport());
    await auth.signIn('NOXAVA', 'hasło');
    await auth.signOut();
    assert.equal(auth.current(), null);
  } finally {
    fake.restore();
  }
});

test('subscribers see each transition, including unreachable', async () => {
  let mode: 'ok' | 'network' = 'ok';
  const fake = recorder((call) => {
    if (mode === 'network') throw new TypeError('Failed to fetch');
    if (call.url.endsWith('/auth/login')) return json(sessionFor(NOXAVA, SZRON, 'csrf'));
    if (call.url.endsWith('/auth/logout')) return new Response(null, { status: 204 });
    return json(sessionFor(NOXAVA, SZRON, 'csrf'));
  });
  try {
    const auth = new BrowserSession(new AuthTransport());
    const seen: string[] = [];
    const unsubscribe = auth.subscribe((state) => seen.push(state.status));

    await auth.signIn('NOXAVA', 'hasło');
    mode = 'network';
    await auth.restore();
    mode = 'ok';
    await auth.signOut();
    unsubscribe();
    await auth.restore();

    assert.deepEqual(seen, ['unknown', 'authenticated', 'unreachable', 'anonymous']);
  } finally {
    fake.restore();
  }
});

// ══════════════════════ draft partitions ════════════════════════════════════

/**
 * Minimal in-memory IndexedDB, covering exactly the operations `DraftStore` uses.
 *
 * It is a double, and it proves one thing only: that the store addresses its records
 * by an account-qualified key, so one account's reads cannot reach the other's rows.
 * It does not demonstrate IndexedDB's own transaction semantics.
 */
function fakeIndexedDB() {
  const data = new Map<string, Map<string, { id: string } & Record<string, unknown>>>();
  const storeNames = ['captureDrafts', 'reelDrafts', 'blobs', 'queue', 'quarantine'];
  for (const name of storeNames) data.set(name, new Map());

  const succeed = <T>(result: T) => {
    const request = { result, onsuccess: null as null | (() => void), onerror: null as null | (() => void) };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  };

  return {
    open() {
      const open = {
        result: {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => undefined,
          transaction(names: string | string[]) {
            const used = Array.isArray(names) ? names : [names];
            const tx = {
              oncomplete: null as null | (() => void),
              onerror: null as null | (() => void),
              onabort: null as null | (() => void),
              objectStore(name: string) {
                assert.ok(used.includes(name), `${name} was not in the transaction scope`);
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
    data,
  };
}

test('drafts stay in their own account partition across a switch', async () => {
  const fake = fakeIndexedDB();
  const previous = Reflect.get(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { value: fake, configurable: true });
  try {
    const store = new DraftStore();
    await store.saveReel({
      id: `${NOXAVA.id}:reel-1`, accountId: NOXAVA.id, reelId: 'reel-1',
      expectedVersion: 3, changes: { title: 'Wersja NOXAVY' }, updatedAt: 1,
    });
    await store.enqueue({
      id: 'op-1', accountId: NOXAVA.id, kind: 'patch', reelId: 'reel-1',
      createdAt: 1, state: 'pending', payload: {},
    });

    // The other account, on the same device and the same Reel.
    assert.equal(await store.reel(SZRON.id, 'reel-1'), undefined, 'SZRON must not see NOXAVA\'s draft');
    assert.deepEqual(await store.queue(SZRON.id), [], 'SZRON must not inherit NOXAVA\'s queue');

    await store.saveReel({
      id: `${SZRON.id}:reel-1`, accountId: SZRON.id, reelId: 'reel-1',
      expectedVersion: 3, changes: { title: 'Wersja SZRONA' }, updatedAt: 2,
    });

    // Both drafts coexist; neither overwrote the other.
    assert.equal((await store.reel(NOXAVA.id, 'reel-1'))?.changes.title, 'Wersja NOXAVY');
    assert.equal((await store.reel(SZRON.id, 'reel-1'))?.changes.title, 'Wersja SZRONA');

    // Deleting one account's draft leaves the other's in place.
    await store.deleteReel(SZRON.id, 'reel-1');
    assert.equal((await store.reel(NOXAVA.id, 'reel-1'))?.changes.title, 'Wersja NOXAVY');
    assert.equal(await store.reel(SZRON.id, 'reel-1'), undefined);

    // And the queue is still NOXAVA's alone.
    assert.deepEqual((await store.queue(NOXAVA.id)).map((item) => item.id), ['op-1']);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'indexedDB');
    else Object.defineProperty(globalThis, 'indexedDB', { value: previous, configurable: true });
  }
});

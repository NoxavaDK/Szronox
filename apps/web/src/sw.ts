/**
 * SzroNox service worker.
 *
 * It exists for two reasons and no others: an installable app needs a worker, and an Android
 * Share Target POST is delivered to a worker rather than to the page. Everything here serves
 * one of those two purposes.
 *
 * What it deliberately does **not** do:
 *
 *   - It is not an offline-first cache. Only the identity-free app shell is precached — the
 *     HTML skeleton and its hashed bundle. No authenticated HTML, no API response, no
 *     attachment bytes, no session or CSRF token ever enters a cache. `/api/**` is passed
 *     straight to the network, untouched, so a stale authenticated answer cannot exist.
 *   - It does not `skipWaiting()` or claim clients. A share being received or a draft being
 *     written must not have the worker swapped out from under it; a new release activates the
 *     ordinary way, once the old pages are gone.
 *   - It does not bind a share to an account. It cannot: the worker has no authoritative
 *     identity. It stores the payload in quarantine and hands the page one opaque id.
 *
 * Built as a **classic** worker by `vite.sw.config.ts` (IIFE, no import statements in the
 * output), and the precache list is injected from the real build output at build time — no
 * hand-copied hashes, which would silently rot on the next build.
 */

import { DraftStore } from './drafts/store.js';
import {
  INCOMING_PARAM,
  SHARE_ERROR_PARAM,
  SHARE_TARGET_PATH,
  ShareRejectedError,
  parseBoundedShare,
  readSharePayload,
  toCaptureInput,
} from './share/receive.js';

declare const self: ServiceWorkerGlobalScope;

/**
 * Injected by the worker build from the manifest the app build actually emitted.
 *
 * Declared as globals rather than imported, because Vite's `define` substitutes them
 * literally; a missing definition is a build error rather than a silent empty shell.
 */
declare const __SHELL_ASSETS__: string[];
declare const __SHELL_VERSION__: string;

/** Cache name carries the build's own version, so a new release cannot read an old shell. */
const CACHE = `szronox-shell-${__SHELL_VERSION__}`;
const SHELL_DOCUMENT = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await self.caches.open(CACHE);
      // `reload` bypasses the HTTP cache: installing a release must fetch that release's files,
      // not whatever a previous visit left in the browser cache.
      await cache.addAll(
        [SHELL_DOCUMENT, ...__SHELL_ASSETS__].map((url) => new Request(url, { cache: 'reload' })),
      );
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Only shells from older releases are dropped. Activation happens after the previous
      // worker's clients are gone, so nothing in flight is reading these.
      for (const name of await self.caches.keys()) {
        if (name.startsWith('szronox-shell-') && name !== CACHE) await self.caches.delete(name);
      }
    })(),
  );
});

/** Redirect the share POST back into the app. 303 turns the POST into a GET navigation. */
function seeOther(url: string): Response {
  return new Response(null, { status: 303, headers: { Location: url, 'cache-control': 'no-store' } });
}

/**
 * Receive one shared payload.
 *
 * The order matters: the payload is durably committed to IndexedDB *before* the redirect is
 * returned. Android may tear the sharing activity down the instant it sees the response, so a
 * redirect that preceded the write would report success for data that never landed.
 */
async function receiveShare(request: Request): Promise<Response> {
  let shareId: string | null = null;
  try {
    const form = await parseBoundedShare(request);
    // The id is minted here and is the only thing that crosses back to the page.
    shareId = crypto.randomUUID();
    const received = readSharePayload(form, () => crypto.randomUUID());
    const mapped = toCaptureInput(received);

    const store = new DraftStore();
    await store.saveQuarantine(
      { id: shareId, input: mapped.input, fileNames: mapped.fileNames, createdAt: Date.now() },
      mapped.blobs,
    );

    return seeOther(`/?${INCOMING_PARAM}=${encodeURIComponent(shareId)}`);
  } catch (error) {
    // A refusal is reported as a refusal. The reason vocabulary is closed, and the shared
    // content itself is never echoed into the URL.
    const reason = error instanceof ShareRejectedError ? error.reason : 'storage_failed';
    return seeOther(`/?${SHARE_ERROR_PARAM}=${encodeURIComponent(reason)}`);
  }
}

/** The shell document, for a navigation that cannot reach the network. */
async function shellFallback(): Promise<Response> {
  const cached = await (await self.caches.open(CACHE)).match(SHELL_DOCUMENT);
  return (
    cached ??
    new Response('Brak połączenia.', {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  );
}

/**
 * Serve a precached shell asset.
 *
 * Cache-first is safe only because these filenames are content-hashed: a different build means
 * a different name, so a hit can never be stale. Anything not precached goes to the network and
 * is not added to the cache — the cache holds exactly this release's shell and nothing else.
 */
async function shellAsset(request: Request): Promise<Response> {
  const cached = await (await self.caches.open(CACHE)).match(request, { ignoreSearch: true });
  return cached ?? (await fetch(request));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // The share target is the one POST this worker owns.
  if (request.method === 'POST' && url.origin === self.location.origin && url.pathname === SHARE_TARGET_PATH) {
    event.respondWith(receiveShare(request));
    return;
  }

  // Everything else the worker touches is a same-origin GET. Cross-origin requests, other
  // methods and API traffic are left entirely alone — no interception, no caching.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    // Network-first: the live app is always preferred, and the shell answers only when the
    // network does not. The response is not cached, so an authenticated document cannot be
    // replayed later to anyone.
    event.respondWith(fetch(request).catch(() => shellFallback()));
    return;
  }

  if (__SHELL_ASSETS__.includes(url.pathname)) {
    event.respondWith(shellAsset(request));
  }
});

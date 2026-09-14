import { openShareDb, putRecord } from "./storage.js";
import { readSharePayload } from "./share-contract.js";

const SHELL = "share-diagnostic-shell-v3";
const ASSETS = [
  "./", "./index.html", "./app.js", "./share-contract.js", "./storage.js",
  "./receiver-state.js", "./manifest.webmanifest",
  // Icons are part of the offline shell: the manifest references them, and an
  // offline launch that cannot resolve them is a different failure to debug.
  "./icon.svg", "./icon-192.png", "./icon-512.png",
];

self.addEventListener("install", event => event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(ASSETS))));

self.addEventListener("activate", event => event.waitUntil((async () => {
  // Drop superseded caches from THIS diagnostic only, leaving any other scope
  // untouched. Without this, every SHELL bump left its predecessor behind.
  const names = await caches.keys();
  await Promise.all(names
    .filter(name => name.startsWith("share-diagnostic-shell-") && name !== SHELL)
    .map(name => caches.delete(name)));
  // Claim so an already-open page becomes controlled. There is deliberately no
  // skipWaiting(): replacing a worker mid-capture needs an explicit update
  // strategy, which this diagnostic does not decide.
  await self.clients.claim();
})()));

/**
 * Capture the share payload exactly as received.
 *
 * C02: the previous version read `formData.get("title" | "text" | "url")` into a
 * flat object, which collapsed repeated parameters, discarded unknown ones and
 * lost arrival order. The pinned capture contract requires the original scalar
 * fields "in order, including repeated, unknown and empty fields", so the raw
 * ordered entry list is what gets stored. Normalization happens later, in the
 * page, from this record.
 */
async function storeRawShare(formData) {
  const { fields, files } = readSharePayload(formData, { randomUUID: () => crypto.randomUUID() });

  const record = {
    id: crypto.randomUUID(),
    operationId: crypto.randomUUID(),
    recordType: "raw-share",
    receivedAt: new Date().toISOString(),
    fields,
    files,
  };

  const db = await openShareDb();
  await putRecord(db, record);
  return record.id;
}

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    event.respondWith((async () => {
      try {
        // The redirect is issued only after putRecord resolves on
        // transaction.oncomplete, so the 303 never outruns durability. This is
        // bafffec's guarantee and is deliberately unchanged.
        const id = await storeRawShare(await event.request.formData());
        return Response.redirect(new URL(`index.html?incoming=${encodeURIComponent(id)}`, self.registration.scope), 303);
      } catch {
        return Response.redirect(new URL("index.html?captureError=LOCAL_STORE_FAILED", self.registration.scope), 303);
      }
    })());
    return;
  }
  if (event.request.method === "GET") {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then(hit => hit || caches.match("./index.html"))));
  }
});

import { openShareDb, putRecord } from "./storage.js";

const SHELL = "share-diagnostic-shell-v2";
const ASSETS = ["./", "./index.html", "./app.js", "./share-contract.js", "./storage.js", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", event => event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(ASSETS))));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

async function storeRawShare(formData) {
  const images = formData.getAll("images").filter(value => value instanceof File);
  const id = crypto.randomUUID();
  const record = {
    id,
    operationId: crypto.randomUUID(),
    attachmentIds: images.map(() => crypto.randomUUID()),
    recordType: "raw-share",
    receivedAt: new Date().toISOString(),
    title: formData.get("title") || null,
    text: formData.get("text") || null,
    url: formData.get("url") || null,
    images
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

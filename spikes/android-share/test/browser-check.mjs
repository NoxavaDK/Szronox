import assert from "node:assert/strict";

const pages = await fetch("http://127.0.0.1:9223/json/list").then(r => r.json());
const page = pages.find(item => item.type === "page");
assert(page, "diagnostic page not found in headless Chrome");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let id = 0;
const pending = new Map();
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
  message.error ? reject(new Error(message.error.message)) : resolve(message.result);
};
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id;
    const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 5000);
    pending.set(requestId, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); }
    });
    socket.send(JSON.stringify({id:requestId,method,params}));
  });
}
async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise:true, returnByValue:true });
  if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text}: ${result.exceptionDetails.exception?.description || "unknown"}`);
  return result.result.value;
}
async function waitFor(predicate, label) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const value = await evaluate(predicate);
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timeout: ${label}`);
}

try {
await cdp("Page.enable");
await cdp("Page.navigate", {url:"http://127.0.0.1:4173/"});
await waitFor("location.href.startsWith('http://127.0.0.1:4173')", "initial navigation");
await waitFor("document.readyState === 'complete'", "initial load");
assert.equal(await evaluate("'serviceWorker' in navigator"), true, "Service Worker API unavailable");
await waitFor("Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))])", "service worker ready");
await cdp("Page.reload");
await waitFor("location.href.startsWith('http://127.0.0.1:4173')", "controlled navigation");
await waitFor("document.readyState === 'complete'", "controlled reload");
assert.equal(await evaluate("Boolean(navigator.serviceWorker.controller)"), true);

// Receiver readiness is its own element and must report control, not just
// registration, before a share can be captured. C02-R3: wait for the DISPLAYED
// state rather than sampling it once -- registration resolves asynchronously and
// control arrives later still via controllerchange, so a single read races both.
await waitFor(
  "document.querySelector('#receiver-status')?.dataset.state === 'ready'",
  "receiver-status reaching the visible ready state",
);
assert.equal(await evaluate("document.querySelector('#receiver-status').dataset.shareCapture"), "true");

// A mixed payload with a repeated field, an unknown field, an empty field, two
// supported images and one unsupported file: everything C02 must preserve.
const redirectedUrl = await evaluate(`(async () => {
  const data = new FormData();
  data.append("title", "Próba przeglądarkowa");
  data.append("text", "Treść https://example.test/ścieżka");
  data.append("title", "Drugi tytuł");
  data.append("nieznane", "");
  data.append("images", new File([new Uint8Array([1,2,3])], "obraz.png", {type:"image/png", lastModified:123}));
  data.append("images", new File([new Uint8Array([9])], "film.mp4", {type:"video/mp4"}));
  data.append("images", new File([new Uint8Array([4,5])], "drugi.jpg", {type:"image/jpeg"}));
  return (await fetch("share-target", {method:"POST", body:data})).url;
})()`);
assert.match(redirectedUrl, /index\.html\?incoming=/);
await cdp("Page.navigate", {url:redirectedUrl});
await waitFor("document.querySelector('#output')?.textContent.includes('quarantined_pending_identity')", "raw-to-draft promotion");
const before = JSON.parse(await evaluate("document.querySelector('#output').textContent"));

// Exact scalars, in order, including the repeat and the empty unknown field.
assert.deepEqual(before.capture.originalInput.fields, [
  { name: "title", value: "Próba przeglądarkowa" },
  { name: "text", value: "Treść https://example.test/ścieżka" },
  { name: "title", value: "Drugi tytuł" },
  { name: "nieznane", value: "" },
], "ordered scalar fields were not preserved exactly");
assert.equal(before.capture.title, "Próba przeglądarkowa", "normalization takes the first value");

// Every received file described in order; only the supported ones accepted.
assert.deepEqual(before.capture.originalInput.files.map(f => f.fileName), ["obraz.png", "film.mp4", "drugi.jpg"]);
assert.equal(before.capture.originalInput.files[1].issue, "UNSUPPORTED_INPUT");
assert.equal(before.capture.attachments.length, 2, "both supported images must survive");
assert.equal(before.capture.attachments[0].attachmentId, before.capture.originalInput.files[0].attachmentId);
assert.equal(new Set(before.capture.attachments.map(a => a.attachmentId)).size, 2, "image IDs must be distinct");

// The mapping onto the pinned contract is rendered beside the draft.
const mappingText = await evaluate("document.querySelector('#mapping').textContent");
assert.match(mappingText, /CreateReelRequest/);
const mapped = JSON.parse(mappingText.slice(mappingText.indexOf("{")));
assert.equal(mapped.input.images.length, 2, "mapping must carry both supported images");
assert.equal(mapped.input.originalShare.files.length, 3, "mapping must describe every received file");

await cdp("Page.reload");
await waitFor("document.querySelector('#output')?.textContent.includes('quarantined_pending_identity')", "durable reload");
const after = JSON.parse(await evaluate("document.querySelector('#output').textContent"));
assert.equal(after.id, before.id);
assert.equal(after.operationId, before.operationId);
assert.deepEqual(after.capture.originalInput, before.capture.originalInput);

const storedBlobSize = await evaluate(`(async () => {
  const request = indexedDB.open("szronox-share-diagnostic-v1");
  const db = await new Promise((resolve,reject) => { request.onsuccess=()=>resolve(request.result); request.onerror=()=>reject(request.error); });
  const get = db.transaction("incomingShares").objectStore("incomingShares").get(${JSON.stringify(before.id)});
  const draft = await new Promise((resolve,reject) => { get.onsuccess=()=>resolve(get.result); get.onerror=()=>reject(get.error); });
  return draft.blobs.map(b => b.blob.size);
})()`);
assert.deepEqual(storedBlobSize, [3, 2], "both supported blobs must persist");
console.log("PASS: Chrome controlled the service worker and preserved one normalized draft,");
console.log("      stable IDs, exact ordered original fields, every file descriptor and both");
console.log("      supported blobs across reload. Desktop evidence only; concurrent promotion");
console.log("      and Android share-sheet behaviour remain UNVERIFIED.");
} finally {
  socket.close();
}

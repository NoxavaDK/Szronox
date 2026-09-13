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

const redirectedUrl = await evaluate(`(async () => {
  const data = new FormData();
  data.set("title", "Próba przeglądarkowa");
  data.set("text", "Treść https://example.test/ścieżka");
  data.set("images", new File([new Uint8Array([1,2,3])], "obraz.png", {type:"image/png", lastModified:123}));
  return (await fetch("share-target", {method:"POST", body:data})).url;
})()`);
assert.match(redirectedUrl, /index\.html\?incoming=/);
await cdp("Page.navigate", {url:redirectedUrl});
await waitFor("document.querySelector('#output')?.textContent.includes('quarantined_pending_identity')", "raw-to-draft promotion");
const before = JSON.parse(await evaluate("document.querySelector('#output').textContent"));
assert.equal(before.capture.originalInput.title, "Próba przeglądarkowa");
assert.equal(before.capture.originalInput.files[0].name, "obraz.png");
assert.equal(before.capture.attachments[0].id, before.capture.originalInput.files[0].id);

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
  return draft.blobs[0].blob.size;
})()`);
assert.equal(storedBlobSize, 3);
console.log("PASS: Chrome registered/controlled the service worker and preserved one normalized draft, IDs, original input, and blob across reload.");
} finally {
  socket.close();
}

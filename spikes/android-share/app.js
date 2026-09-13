import { DB_NAME, STORE_NAME, normalizeShare, bindIdentity, publicDraft } from "./share-contract.js";

const status = document.querySelector("#status");
const output = document.querySelector("#output");
let current = null;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function get(id) {
  const db = await openDb();
  const record = await new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return record || null;
}

async function replaceRaw(rawId, draft) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({ ...draft, recordType: "capture-draft" });
    transaction.objectStore(STORE_NAME).delete(rawId);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

async function save(draft) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({ ...draft, recordType: "capture-draft" });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

function show(draft) {
  current = draft;
  output.textContent = JSON.stringify(publicDraft(draft), null, 2);
  status.textContent = draft.state === "quarantined_pending_identity" ? "Dane zapisano lokalnie w kwarantannie do czasu ustalenia konta." : "Dane przypisano do diagnostycznego konta; wysyłanie nie jest częścią testu.";
}

function normalize(entries) {
  return normalizeShare({ entries, now: () => new Date().toISOString(), randomUUID: () => crypto.randomUUID() });
}

document.querySelector("#simulate").onclick = async () => {
  const draft = normalize({
    title: document.querySelector("#title").value,
    text: document.querySelector("#text").value,
    url: document.querySelector("#url").value,
    images: [...document.querySelector("#images").files]
  });
  await save(draft);
  history.replaceState(null, "", `?incoming=${encodeURIComponent(draft.id)}`);
  show(draft);
};
document.querySelector("#login").onclick = async () => {
  if (!current) return;
  const assigned = bindIdentity(current, "diagnostic-account-A");
  await save(assigned);
  show(assigned);
};

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => status.textContent = "Nie udało się uruchomić obsługi offline.");
const params = new URL(location.href).searchParams;
if (params.get("captureError")) status.textContent = "Nie zapisano danych lokalnie. Udostępnij ponownie po zwolnieniu miejsca.";
if (params.get("incoming")) get(params.get("incoming")).then(async record => {
  if (!record) { status.textContent = "Nie znaleziono przechwyconych danych."; return; }
  if (record.recordType === "capture-draft") { show(record); return; }
  const draft = normalize(record);
  await replaceRaw(record.id, draft);
  history.replaceState(null, "", `?incoming=${encodeURIComponent(draft.id)}`);
  show(draft);
}).catch(() => status.textContent = "Nie można odczytać lokalnych danych.");

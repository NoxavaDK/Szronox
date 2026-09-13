import { normalizeShare, bindIdentity, publicDraft } from "./share-contract.js";
import { getRecord, openShareDb, promoteRaw, putRecord } from "./storage.js";

const status = document.querySelector("#status");
const output = document.querySelector("#output");
let current = null;

async function get(id) {
  return getRecord(await openShareDb(), id);
}

async function replaceRaw(rawId, draft) {
  return promoteRaw(await openShareDb(), rawId, draft);
}

async function save(draft) {
  await putRecord(await openShareDb(), { ...draft, recordType: "capture-draft" });
}

function show(draft) {
  current = draft;
  output.textContent = JSON.stringify(publicDraft(draft), null, 2);
  status.textContent = draft.state === "quarantined_pending_identity" ? "Dane zapisano lokalnie w kwarantannie do czasu ustalenia konta." : "Dane przypisano do diagnostycznego konta; wysyłanie nie jest częścią testu.";
}

function showStorageFailure() {
  current = null;
  output.textContent = "";
  status.textContent = "Nie zapisano danych lokalnie. Zwolnij miejsce i spróbuj ponownie.";
}

function normalize(entries) {
  return normalizeShare({ entries, now: () => new Date().toISOString(), randomUUID: () => crypto.randomUUID() });
}

document.querySelector("#simulate").onclick = async () => {
  try {
    const draft = normalize({
      title: document.querySelector("#title").value,
      text: document.querySelector("#text").value,
      url: document.querySelector("#url").value,
      images: [...document.querySelector("#images").files]
    });
    await save(draft);
    history.replaceState(null, "", `?incoming=${encodeURIComponent(draft.id)}`);
    show(draft);
  } catch { showStorageFailure(); }
};
document.querySelector("#login").onclick = async () => {
  if (!current) return;
  try {
    const assigned = bindIdentity(current, "diagnostic-account-A");
    await save(assigned);
    show(assigned);
  } catch { showStorageFailure(); }
};

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { scope: "./", type: "module" }).catch(() => status.textContent = "Nie udało się uruchomić obsługi offline.");
const params = new URL(location.href).searchParams;
if (params.get("captureError")) status.textContent = "Nie zapisano danych lokalnie. Udostępnij ponownie po zwolnieniu miejsca.";
if (params.get("incoming")) get(params.get("incoming")).then(async record => {
  if (!record) { status.textContent = "Nie znaleziono przechwyconych danych."; return; }
  if (record.recordType === "capture-draft") { show(record); return; }
  const draft = normalize(record);
  show(await replaceRaw(record.id, draft));
}).catch(showStorageFailure);

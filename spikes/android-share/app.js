import { normalizeShare, bindIdentity, publicDraft, toCaptureInput } from "./share-contract.js";
import { getRecord, openShareDb, promoteRaw, putRecord } from "./storage.js";
import { watchReceiver } from "./receiver-state.js";

const receiverStatus = document.querySelector("#receiver-status");
const status = document.querySelector("#status");
const output = document.querySelector("#output");
const mapping = document.querySelector("#mapping");
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
  status.textContent = draft.state === "quarantined_pending_identity"
    ? "Dane zapisano lokalnie w kwarantannie do czasu ustalenia konta."
    : "Dane przypisano do diagnostycznego konta; wysyłanie nie jest częścią testu.";

  // Show the pinned-contract mapping alongside the draft, so a reader can see
  // exactly what would be sent and what was refused. Nothing is transmitted.
  const mapped = toCaptureInput(draft);
  mapping.textContent = mapped.ok
    ? `Mapowanie na CreateReelRequest (diagnostyczne, nic nie jest wysyłane):\n${JSON.stringify(mapped.request, null, 2)}`
    : `Mapowanie odrzucone — nic nie zostałoby wysłane:\n${JSON.stringify(mapped.problems, null, 2)}`;
}

function showStorageFailure() {
  current = null;
  output.textContent = "";
  mapping.textContent = "";
  status.textContent = "Nie zapisano danych lokalnie. Zwolnij miejsce i spróbuj ponownie.";
}

function normalize(entries) {
  return normalizeShare({ entries, now: () => new Date().toISOString(), randomUUID: () => crypto.randomUUID() });
}

document.querySelector("#simulate").onclick = async () => {
  try {
    // The local simulation stays independent of the receiver: it exercises
    // normalization and mapping even when share capture is unavailable.
    const draft = normalize({
      title: document.querySelector("#title").value,
      text: document.querySelector("#text").value,
      url: document.querySelector("#url").value,
      images: [...document.querySelector("#images").files],
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

/**
 * Receiver readiness owns its own element. No form operation writes here, so a
 * successful local simulate can never paint over an unavailable receiver.
 */
watchReceiver(navigator, (receiver) => {
  // C02-R3: refreshed on controllerchange, so a worker that activates after first
  // paint updates the visible claim instead of leaving it stale.
  receiverStatus.textContent = receiver.message;
  receiverStatus.dataset.state = receiver.state;
  receiverStatus.dataset.severity = receiver.severity;
  receiverStatus.dataset.shareCapture = String(receiver.shareCaptureAvailable);
});

const params = new URL(location.href).searchParams;
if (params.get("captureError")) {
  status.textContent = "Nie zapisano danych lokalnie. Udostępnij ponownie po zwolnieniu miejsca.";
}
if (params.get("incoming")) {
  get(params.get("incoming")).then(async record => {
    if (!record) { status.textContent = "Nie znaleziono przechwyconych danych."; return; }
    if (record.recordType === "capture-draft") { show(record); return; }
    const draft = normalize(record);
    show(await replaceRaw(record.id, draft));
  }).catch(showStorageFailure);
}

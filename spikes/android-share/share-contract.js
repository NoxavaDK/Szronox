export const DB_NAME = "szronox-share-diagnostic-v1";
export const STORE_NAME = "incomingShares";
export const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function newId(randomUUID) {
  if (typeof randomUUID !== "function") throw new Error("UUID_UNAVAILABLE");
  return randomUUID();
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value : null;
}

function findUrl(value) {
  if (!value) return null;
  const match = value.match(/https?:\/\/[^\s<>]+/i);
  if (!match) return null;
  try { return new URL(match[0]).href; } catch { return null; }
}

/** Build the same local capture-draft shape for URL, text, image, and mixed shares. */
export function normalizeShare({ entries, now, randomUUID }) {
  const title = nonEmpty(entries.title);
  const text = nonEmpty(entries.text);
  const explicitUrl = nonEmpty(entries.url);
  const inferredUrl = findUrl(explicitUrl) || findUrl(text) || findUrl(title);
  const files = Array.isArray(entries.images) ? entries.images : [];
  const supported = [];
  const rejected = [];

  for (const file of files) {
    const descriptor = {
      id: newId(randomUUID),
      name: file.name || "bez-nazwy",
      type: file.type || "application/octet-stream",
      size: Number(file.size) || 0,
      lastModified: Number(file.lastModified) || 0
    };
    if (SUPPORTED_IMAGE_TYPES.has(descriptor.type)) supported.push({ descriptor, blob: file });
    else rejected.push({ ...descriptor, reason: "UNSUPPORTED_MEDIA_TYPE" });
  }

  const originalInput = { title, text, url: explicitUrl, files: [...supported.map(x => x.descriptor), ...rejected] };
  const hasUsableInput = Boolean(title || text || inferredUrl || supported.length);
  return {
    id: newId(randomUUID),
    operationId: newId(randomUUID),
    createdAt: now(),
    source: "android_share_target",
    state: "quarantined_pending_identity",
    accountId: null,
    capture: { title, originalInput, url: inferredUrl, text, attachments: supported.map(x => x.descriptor) },
    blobs: supported,
    issues: [
      ...rejected.map(file => ({ code: file.reason, file })),
      ...(!hasUsableInput ? [{ code: "NO_SUPPORTED_INPUT" }] : [])
    ]
  };
}

export function bindIdentity(draft, accountId) {
  if (draft.state !== "quarantined_pending_identity" || draft.accountId !== null) throw new Error("INVALID_QUARANTINE_STATE");
  if (!nonEmpty(accountId)) throw new Error("ACCOUNT_REQUIRED");
  return { ...draft, state: "local_pending_upload", accountId };
}

export function publicDraft(draft) {
  const { blobs, ...safe } = draft;
  return safe;
}

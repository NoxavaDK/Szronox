export const DB_NAME = "szronox-share-diagnostic-v1";
export const STORE_NAME = "incomingShares";
export const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Scalar share-target params this diagnostic knows how to normalize. */
export const KNOWN_SCALAR_FIELDS = ["title", "text", "url"];

function newId(randomUUID) {
  if (typeof randomUUID !== "function") throw new Error("UUID_UNAVAILABLE");
  return randomUUID();
}

function nonEmpty(value) {
  // Whitespace is preserved deliberately: the original input is evidence, and
  // trimming it would be a silent field substitution.
  return typeof value === "string" && value.trim() ? value : null;
}

function findUrl(value) {
  if (!value) return null;
  const match = value.match(/https?:\/\/[^\s<>]+/i);
  if (!match) return null;
  try { return new URL(match[0]).href; } catch { return null; }
}

/**
 * Ordered scalar fields, exactly as received.
 *
 * C02: the previous shape was a flat object, which silently collapsed repeated
 * parameters, dropped unknown ones and lost arrival order. The pinned capture
 * contract requires `originalShare.fields` to retain "exact received scalar
 * names/values in order, including repeated, unknown and empty fields", so the
 * ordered list is now the source of truth. The object form is still accepted for
 * the local simulation form, which genuinely has one named input each.
 */
function readOrderedFields(entries) {
  if (Array.isArray(entries?.fields)) {
    return entries.fields
      .filter((field) => field && typeof field.name === "string")
      .map((field) => ({ name: field.name, value: String(field.value ?? "") }));
  }
  // Legacy/simulation object form: fixed order, only fields actually present.
  return KNOWN_SCALAR_FIELDS
    .filter((name) => entries?.[name] !== undefined && entries?.[name] !== null)
    .map((name) => ({ name, value: String(entries[name]) }));
}

/** First value for a scalar name, preserving "first wins" for repeats. */
function firstValue(fields, name) {
  return fields.find((field) => field.name === name)?.value ?? null;
}

function readFiles(entries) {
  if (Array.isArray(entries?.files)) return entries.files;
  // Legacy/simulation form: `images` is the share-target file param name.
  return (Array.isArray(entries?.images) ? entries.images : []).map((file, index) => ({
    name: "images",
    attachmentId: entries?.attachmentIds?.[index],
    file,
  }));
}

/**
 * Split an incoming multipart share into ordered scalars and ordered files.
 *
 * Extracted from the service worker so it can be exercised against a real
 * FormData. `FormData.entries()` preserves insertion order and repeated names,
 * which is exactly what the pinned contract requires and what reading named keys
 * one at a time destroyed.
 */
export function readSharePayload(formData, { randomUUID }) {
  const fields = [];
  const files = [];
  for (const [name, value] of formData.entries()) {
    if (typeof File !== "undefined" && value instanceof File) {
      files.push({ name, attachmentId: newId(randomUUID), file: value });
    } else {
      // Empty and unknown scalars are part of what arrived and are kept.
      fields.push({ name, value: String(value) });
    }
  }
  return { fields, files };
}

/**
 * Build the same local capture-draft shape for URL, text, image and mixed shares.
 *
 * Every received file is described, in order. Supported files additionally carry
 * a blob. Nothing is dropped: unsupported files stay as descriptors marked with
 * their issue, which is evidence of the original input and explicitly NOT
 * permission to create an upload record.
 */
export function normalizeShare({ entries, now, randomUUID }) {
  const fields = readOrderedFields(entries);
  const title = nonEmpty(firstValue(fields, "title"));
  const text = nonEmpty(firstValue(fields, "text"));
  const explicitUrl = nonEmpty(firstValue(fields, "url"));
  const inferredUrl = findUrl(explicitUrl) || findUrl(text) || findUrl(title);

  const received = readFiles(entries);
  const descriptors = [];
  const blobs = [];

  received.forEach((entry, index) => {
    const file = entry?.file ?? entry;
    const descriptor = {
      // Allocated for every received file so the original record is complete and
      // stable across reopen. An id on an unsupported descriptor identifies it;
      // it never becomes an accepted upload record.
      attachmentId: entry?.attachmentId || entries?.attachmentIds?.[index] || newId(randomUUID),
      fieldName: entry?.name ?? "images",
      fileName: file?.name || "bez-nazwy",
      mimeType: file?.type || "application/octet-stream",
      byteSize: Number(file?.size) || 0,
      lastModified: Number(file?.lastModified) || 0,
    };
    const supported = SUPPORTED_IMAGE_TYPES.has(descriptor.mimeType);
    descriptors.push(supported ? descriptor : { ...descriptor, issue: "UNSUPPORTED_INPUT" });
    if (supported) blobs.push({ attachmentId: descriptor.attachmentId, blob: file });
  });

  const supportedDescriptors = descriptors.filter((descriptor) => !descriptor.issue);
  const rejected = descriptors.filter((descriptor) => descriptor.issue);
  const hasUsableInput = Boolean(title || text || inferredUrl || supportedDescriptors.length);

  return {
    id: entries?.id || newId(randomUUID),
    operationId: entries?.operationId || newId(randomUUID),
    createdAt: entries?.receivedAt || now(),
    source: "android_share_target",
    state: "quarantined_pending_identity",
    accountId: null,
    capture: {
      title,
      text,
      url: inferredUrl,
      attachments: supportedDescriptors,
      // Exact original input, distinct from the normalized values above.
      originalInput: { fields, files: descriptors },
    },
    blobs,
    issues: [
      ...rejected.map((file) => ({ code: file.issue, file })),
      ...(!hasUsableInput ? [{ code: "NO_SUPPORTED_INPUT" }] : []),
    ],
  };
}

/**
 * Map a local draft onto the pinned `CreateReelRequest` / `CaptureInput`.
 *
 * This is a DIAGNOSTIC mapping. It builds and validates the request shape; it
 * does not send anything, and it is not a production Quick Add or upload client.
 * `packages/contracts/src/index.ts` is not imported — the spike stays standalone,
 * so this mirrors the pinned shape rather than depending on it.
 *
 * The contract's hard rule is that nothing may be lost quietly: "No silent
 * trimming, truncation, field substitution, dropped images or merging of separate
 * captures. A bounded request may be rejected explicitly rather than partially
 * persisted." So every refusal below returns `ok: false` with a reason, and there
 * is no path that returns a partial request.
 */
export function toCaptureInput(draft) {
  const problems = [];
  const fields = draft?.capture?.originalInput?.fields ?? [];
  const files = draft?.capture?.originalInput?.files ?? [];
  const supported = files.filter((file) => !file.issue);

  const ids = supported.map((file) => file.attachmentId);
  if (ids.some((id) => typeof id !== "string" || id === "")) {
    problems.push({ code: "MISSING_ATTACHMENT_ID", message: "A supported image has no attachmentId." });
  }
  if (new Set(ids).size !== ids.length) {
    // Rejecting beats de-duplicating: silently collapsing two images into one is
    // exactly the truncation the contract forbids.
    problems.push({ code: "DUPLICATE_ATTACHMENT_ID", message: "Supported images must have distinct attachmentIds." });
  }

  const text = draft?.capture?.text ?? null;
  const url = draft?.capture?.url ?? null;
  const originalTextual = fields.some((field) => nonEmpty(field.value));
  if (!text && !url && supported.length === 0 && !originalTextual) {
    problems.push({ code: "NO_SUPPORTED_INPUT", message: "Capture has no text, URL, supported image or usable original field." });
  }

  if (problems.length > 0) {
    return { ok: false, problems, request: null };
  }

  const input = {
    images: supported.map((file) => ({
      attachmentId: file.attachmentId,
      fileName: file.fileName,
      mimeType: file.mimeType,
      byteSize: file.byteSize,
    })),
    originalShare: {
      // Exact received scalars, in order, including repeats, unknown names and
      // empty values.
      fields: fields.map((field) => ({ name: field.name, value: field.value })),
      // Every received file, in order, supported and unsupported alike.
      files: files.map((file) => ({
        attachmentId: file.attachmentId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        ...(file.lastModified ? { lastModified: file.lastModified } : {}),
        ...(file.issue ? { issue: file.issue } : {}),
      })),
    },
  };
  // Optional scalars are omitted rather than sent as null, matching the contract.
  if (text) input.text = text;
  if (url) input.url = url;

  return {
    ok: true,
    problems: [],
    request: { operationId: draft.operationId, reelId: draft.id, input },
    // Stated so a reader cannot mistake a built request for an accepted capture.
    limitation: "Diagnostic mapping only. Nothing is sent; server validation, transport limits and attachment upload are out of scope.",
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

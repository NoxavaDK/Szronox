import test from "node:test";
import assert from "node:assert/strict";
import { bindIdentity, normalizeShare, publicDraft, toCaptureInput } from "../share-contract.js";

function factory(entries) {
  let n = 0;
  return normalizeShare({
    entries,
    now: () => "2026-09-13T10:00:00.000Z",
    randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  });
}

const image = { name: "oryginal.png", type: "image/png", size: 17, lastModified: 123 };
const second = { name: "drugi.jpg", type: "image/jpeg", size: 42, lastModified: 456 };

// ── Normalization (existing coverage, updated to the pinned draft shape) ──────

test("URL in Android text is inferred while exact original fields remain distinct", () => {
  const draft = factory({ title: "Tytuł", text: "Opis https://example.com/a?x=1", url: null, images: [] });
  assert.equal(draft.capture.url, "https://example.com/a?x=1");
  // The derived URL never overwrites what actually arrived.
  assert.deepEqual(draft.capture.originalInput.fields, [
    { name: "title", value: "Tytuł" },
    { name: "text", value: "Opis https://example.com/a?x=1" },
  ]);
  assert.deepEqual(draft.capture.originalInput.files, []);
});

test("image-only and mixed shares use the same draft and retain the blob", () => {
  const only = factory({ images: [image] });
  const mixed = factory({ title: "T", text: "Treść", url: "https://example.org", images: [image] });
  for (const draft of [only, mixed]) {
    assert.equal(draft.state, "quarantined_pending_identity");
    assert.equal(draft.accountId, null);
    assert.equal(draft.capture.attachments[0].fileName, "oryginal.png");
    assert.equal(draft.blobs[0].blob, image);
    assert.equal(draft.blobs[0].attachmentId, draft.capture.attachments[0].attachmentId);
  }
  assert.equal(mixed.capture.text, "Treść");
  assert.equal(mixed.capture.url, "https://example.org/");
});

test("unsupported files remain described and are explicitly rejected", () => {
  const draft = factory({ images: [{ name: "film.mp4", type: "video/mp4", size: 99 }] });
  assert.equal(draft.capture.attachments.length, 0);
  const [described] = draft.capture.originalInput.files;
  assert.equal(described.fileName, "film.mp4");
  assert.equal(described.issue, "UNSUPPORTED_INPUT");
  assert.deepEqual(draft.issues.map((x) => x.code), ["UNSUPPORTED_INPUT", "NO_SUPPORTED_INPUT"]);
});

test("empty payload is not reported as successful input", () => {
  assert.deepEqual(factory({}).issues, [{ code: "NO_SUPPORTED_INPUT" }]);
});

test("identity binds only after quarantine while IDs remain stable", () => {
  const draft = factory({ text: "notatka" });
  const assigned = bindIdentity(draft, "account-A");
  assert.equal(assigned.id, draft.id);
  assert.equal(assigned.operationId, draft.operationId);
  assert.equal(assigned.state, "local_pending_upload");
  assert.equal(assigned.accountId, "account-A");
  assert.throws(() => bindIdentity(assigned, "account-B"), /INVALID_QUARANTINE_STATE/);
});

test("raw-share allocated IDs remain stable across concurrent normalization", () => {
  const raw = {
    id: "00000000-0000-4000-8000-000000000101",
    operationId: "00000000-0000-4000-8000-000000000102",
    receivedAt: "2026-09-13T09:00:00.000Z",
    fields: [{ name: "text", value: "notatka" }],
    files: [{ name: "images", attachmentId: "00000000-0000-4000-8000-000000000103", file: image }],
  };
  const first = factory(raw);
  const secondRun = factory(raw);
  assert.equal(first.id, raw.id);
  assert.equal(secondRun.operationId, raw.operationId);
  assert.equal(first.capture.attachments[0].attachmentId, raw.files[0].attachmentId);
  assert.deepEqual(first, secondRun);
});

test("diagnostic display omits blobs but retains original descriptors", () => {
  const shown = publicDraft(factory({ images: [image] }));
  assert.equal("blobs" in shown, false);
  assert.equal(shown.capture.originalInput.files[0].byteSize, 17);
});

// ── Exact original scalar fields (C02) ───────────────────────────────────────

test("repeated, unknown and empty scalar fields survive in received order", () => {
  // The pinned contract requires "exact received scalar names/values in order,
  // including repeated, unknown and empty fields". The previous flat-object
  // shape collapsed all three.
  const draft = factory({
    fields: [
      { name: "title", value: "Pierwszy" },
      { name: "text", value: "" },
      { name: "title", value: "Drugi" },
      { name: "nieznane", value: "wartość" },
      { name: "url", value: "https://example.com/a" },
    ],
    files: [],
  });
  assert.deepEqual(draft.capture.originalInput.fields, [
    { name: "title", value: "Pierwszy" },
    { name: "text", value: "" },
    { name: "title", value: "Drugi" },
    { name: "nieznane", value: "wartość" },
    { name: "url", value: "https://example.com/a" },
  ]);
  // Normalization takes the first value; it does not delete the second.
  assert.equal(draft.capture.title, "Pierwszy");
});

test("a share carrying only unknown fields is still not silently accepted as empty", () => {
  const draft = factory({ fields: [{ name: "nieznane", value: "wartość" }], files: [] });
  assert.deepEqual(draft.issues.map((x) => x.code), ["NO_SUPPORTED_INPUT"]);
  // The unknown field is preserved as evidence even though nothing normalized.
  assert.equal(draft.capture.originalInput.fields.length, 1);
});

// ── Mapping onto the pinned CaptureInput (C02) ───────────────────────────────

test("multiple images map to one request with distinct stable IDs", () => {
  const draft = factory({ title: "T", text: "Treść", images: [image, second] });
  const mapped = toCaptureInput(draft);
  assert.equal(mapped.ok, true);
  assert.equal(mapped.request.input.images.length, 2, "no image may be dropped");
  const ids = mapped.request.input.images.map((i) => i.attachmentId);
  assert.equal(new Set(ids).size, 2, "IDs must be distinct");
  assert.deepEqual(mapped.request.input.images[0], {
    attachmentId: ids[0], fileName: "oryginal.png", mimeType: "image/png", byteSize: 17,
  });
  // One request, one reel, one operation id.
  assert.equal(mapped.request.reelId, draft.id);
  assert.equal(mapped.request.operationId, draft.operationId);
});

test("mixed input keeps text, URL and images together in one capture", () => {
  const draft = factory({ title: "T", text: "Opis", url: "https://example.com/a", images: [image] });
  const { request } = toCaptureInput(draft);
  assert.equal(request.input.text, "Opis");
  assert.equal(request.input.url, "https://example.com/a");
  assert.equal(request.input.images.length, 1);
});

test("unsupported files appear in originalShare but never in accepted images", () => {
  const draft = factory({ text: "Opis", images: [image, { name: "film.mp4", type: "video/mp4", size: 99 }] });
  const { request } = toCaptureInput(draft);
  assert.equal(request.input.images.length, 1, "only supported images become upload records");
  assert.equal(request.input.originalShare.files.length, 2, "every received file stays described");
  assert.equal(request.input.originalShare.files[1].issue, "UNSUPPORTED_INPUT");
  assert.ok(!request.input.images.some((i) => i.mimeType === "video/mp4"));
});

test("originalShare preserves received file order", () => {
  const draft = factory({ text: "Opis", images: [second, image] });
  const { request } = toCaptureInput(draft);
  assert.deepEqual(request.input.originalShare.files.map((f) => f.fileName), ["drugi.jpg", "oryginal.png"]);
});

test("duplicate attachment IDs are rejected rather than de-duplicated", () => {
  // Collapsing two images into one would be exactly the silent truncation the
  // contract forbids, so the whole request is refused.
  const draft = factory({
    text: "Opis",
    fields: [{ name: "text", value: "Opis" }],
    files: [
      { name: "images", attachmentId: "dup", file: image },
      { name: "images", attachmentId: "dup", file: second },
    ],
  });
  const mapped = toCaptureInput(draft);
  assert.equal(mapped.ok, false);
  assert.equal(mapped.request, null, "no partial request may be produced");
  assert.ok(mapped.problems.some((p) => p.code === "DUPLICATE_ATTACHMENT_ID"));
});

test("a wholly unusable capture is refused, not mapped to an empty request", () => {
  const mapped = toCaptureInput(factory({}));
  assert.equal(mapped.ok, false);
  assert.equal(mapped.request, null);
  assert.ok(mapped.problems.some((p) => p.code === "NO_SUPPORTED_INPUT"));
});

test("an image-only share maps without inventing text or url keys", () => {
  const { request } = toCaptureInput(factory({ images: [image] }));
  assert.equal("text" in request.input, false, "absent optional scalars are omitted, not null");
  assert.equal("url" in request.input, false);
  assert.equal(request.input.images.length, 1);
});

test("the mapping states that it sends nothing", () => {
  const mapped = toCaptureInput(factory({ text: "Opis" }));
  assert.match(mapped.limitation, /Nothing is sent|Diagnostic mapping only/);
});

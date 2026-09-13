import test from "node:test";
import assert from "node:assert/strict";
import { bindIdentity, normalizeShare, publicDraft } from "../share-contract.js";

function factory(entries) {
  let n = 0;
  return normalizeShare({ entries, now: () => "2026-09-13T10:00:00.000Z", randomUUID: () => `00000000-0000-4000-8000-${String(++n).padStart(12,"0")}` });
}
const image = { name:"oryginal.png", type:"image/png", size:17, lastModified:123 };

test("URL in Android text is inferred while exact original fields remain distinct", () => {
  const draft = factory({ title:"Tytuł", text:"Opis https://example.com/a?x=1", url:null, images:[] });
  assert.equal(draft.capture.url, "https://example.com/a?x=1");
  assert.deepEqual(draft.capture.originalInput, { title:"Tytuł", text:"Opis https://example.com/a?x=1", url:null, files:[] });
});

test("image-only and mixed shares use the same draft and retain the blob", () => {
  const only = factory({ images:[image] });
  const mixed = factory({ title:"T", text:"Treść", url:"https://example.org", images:[image] });
  for (const draft of [only, mixed]) {
    assert.equal(draft.state, "quarantined_pending_identity");
    assert.equal(draft.accountId, null);
    assert.equal(draft.capture.attachments[0].name, "oryginal.png");
    assert.equal(draft.blobs[0].blob, image);
  }
  assert.equal(mixed.capture.text, "Treść");
  assert.equal(mixed.capture.url, "https://example.org/");
});

test("unsupported files remain described and are explicitly rejected", () => {
  const draft = factory({ images:[{ name:"film.mp4", type:"video/mp4", size:99 }] });
  assert.equal(draft.capture.attachments.length, 0);
  assert.equal(draft.capture.originalInput.files[0].name, "film.mp4");
  assert.deepEqual(draft.issues.map(x => x.code), ["UNSUPPORTED_MEDIA_TYPE", "NO_SUPPORTED_INPUT"]);
});

test("empty payload is not reported as successful input", () => {
  assert.deepEqual(factory({}).issues, [{ code:"NO_SUPPORTED_INPUT" }]);
});

test("identity binds only after quarantine while IDs remain stable", () => {
  const draft = factory({ text:"notatka" });
  const assigned = bindIdentity(draft, "account-A");
  assert.equal(assigned.id, draft.id);
  assert.equal(assigned.operationId, draft.operationId);
  assert.equal(assigned.state, "local_pending_upload");
  assert.equal(assigned.accountId, "account-A");
  assert.throws(() => bindIdentity(assigned, "account-B"), /INVALID_QUARANTINE_STATE/);
});

test("raw-share allocated IDs remain stable across concurrent normalization", () => {
  const raw = {
    id:"00000000-0000-4000-8000-000000000101",
    operationId:"00000000-0000-4000-8000-000000000102",
    attachmentIds:["00000000-0000-4000-8000-000000000103"],
    receivedAt:"2026-09-13T09:00:00.000Z",
    images:[image]
  };
  const first = factory(raw);
  const second = factory(raw);
  assert.equal(first.id, raw.id);
  assert.equal(second.operationId, raw.operationId);
  assert.equal(first.capture.attachments[0].id, raw.attachmentIds[0]);
  assert.deepEqual(first, second);
});

test("diagnostic display omits blobs but retains original descriptors", () => {
  const shown = publicDraft(factory({ images:[image] }));
  assert.equal("blobs" in shown, false);
  assert.equal(shown.capture.originalInput.files[0].size, 17);
});

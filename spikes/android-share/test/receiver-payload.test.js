/**
 * The receiver's payload path, exercised against a real FormData (C02).
 *
 * The service worker receives `multipart/form-data`. Reading named keys one at a
 * time collapsed repeated parameters, discarded unknown ones and lost arrival
 * order, all of which the pinned capture contract requires be preserved. These
 * tests drive the same function `sw.js` calls, with a genuine FormData rather
 * than a hand-built object, then follow it through normalization and mapping.
 *
 * This is not evidence that a browser or Android delivers these payloads. That
 * remains an open device gate.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeShare, readSharePayload, toCaptureInput } from "../share-contract.js";

let counter = 0;
const ids = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const read = (formData) => readSharePayload(formData, { randomUUID: ids });

const png = (name) => new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });

test("ordered scalars survive, including repeats, unknown names and empty values", () => {
  const form = new FormData();
  form.append("title", "Pierwszy");
  form.append("text", "");
  form.append("title", "Drugi");
  form.append("nieznane", "wartość");
  form.append("url", "https://example.com/a");

  const { fields, files } = read(form);
  assert.deepEqual(fields, [
    { name: "title", value: "Pierwszy" },
    { name: "text", value: "" },
    { name: "title", value: "Drugi" },
    { name: "nieznane", value: "wartość" },
    { name: "url", value: "https://example.com/a" },
  ]);
  assert.equal(files.length, 0);
});

test("multiple files are kept in order, each with a distinct id", () => {
  const form = new FormData();
  form.append("images", png("a.png"));
  form.append("images", png("b.png"));
  form.append("images", png("c.png"));

  const { files } = read(form);
  assert.deepEqual(files.map((f) => f.file.name), ["a.png", "b.png", "c.png"]);
  assert.equal(new Set(files.map((f) => f.attachmentId)).size, 3);
});

test("a mixed share keeps scalars and files together, each in its own order", () => {
  const form = new FormData();
  form.append("title", "Tytuł");
  form.append("images", png("a.png"));
  form.append("text", "Opis");
  form.append("images", png("b.png"));

  const { fields, files } = read(form);
  assert.deepEqual(fields.map((f) => f.name), ["title", "text"]);
  assert.deepEqual(files.map((f) => f.file.name), ["a.png", "b.png"]);
});

test("a received payload normalizes and maps without losing anything", () => {
  const form = new FormData();
  form.append("title", "Tytuł");
  form.append("text", "Opis https://example.com/a");
  form.append("nieznane", "");
  form.append("images", png("a.png"));
  form.append("images", new File([new Uint8Array([9])], "film.mp4", { type: "video/mp4" }));
  form.append("images", png("b.png"));

  const payload = read(form);
  const draft = normalizeShare({
    entries: { ...payload, id: "reel-1", operationId: "op-1", receivedAt: "2026-09-14T00:00:00.000Z" },
    now: () => "2026-09-14T00:00:00.000Z",
    randomUUID: ids,
  });

  // Two supported images accepted, the unsupported one described and refused.
  assert.equal(draft.capture.attachments.length, 2);
  assert.equal(draft.issues.filter((i) => i.code === "UNSUPPORTED_INPUT").length, 1);

  const mapped = toCaptureInput(draft);
  assert.equal(mapped.ok, true);
  assert.equal(mapped.request.input.images.length, 2, "both supported images map through");
  assert.equal(mapped.request.input.originalShare.files.length, 3, "every received file stays described");
  assert.deepEqual(
    mapped.request.input.originalShare.files.map((f) => f.fileName),
    ["a.png", "film.mp4", "b.png"],
    "received order is preserved across the unsupported entry",
  );
  assert.equal(mapped.request.input.originalShare.files[1].issue, "UNSUPPORTED_INPUT");
  // Exact scalars, including the empty unknown one.
  assert.deepEqual(mapped.request.input.originalShare.fields, [
    { name: "title", value: "Tytuł" },
    { name: "text", value: "Opis https://example.com/a" },
    { name: "nieznane", value: "" },
  ]);
  assert.equal(mapped.request.input.url, "https://example.com/a", "URL inferred from text");
  assert.equal(mapped.request.input.text, "Opis https://example.com/a", "without destroying the original text");
});

test("an image-only share from FormData maps to one request with all images", () => {
  const form = new FormData();
  form.append("images", png("a.png"));
  form.append("images", png("b.png"));

  const payload = read(form);
  const draft = normalizeShare({
    entries: { ...payload, id: "reel-2", operationId: "op-2" },
    now: () => "2026-09-14T00:00:00.000Z",
    randomUUID: ids,
  });
  const mapped = toCaptureInput(draft);
  assert.equal(mapped.ok, true);
  assert.equal(mapped.request.input.images.length, 2);
  assert.equal(mapped.request.reelId, "reel-2");
});

test("a share with no usable content is refused rather than mapped", () => {
  const form = new FormData();
  form.append("text", "   ");
  const payload = read(form);
  const draft = normalizeShare({
    entries: { ...payload, id: "reel-3", operationId: "op-3" },
    now: () => "2026-09-14T00:00:00.000Z",
    randomUUID: ids,
  });
  // The whitespace field is still preserved as original evidence...
  assert.equal(draft.capture.originalInput.fields[0].value, "   ");
  // ...but it does not make the capture usable on its own.
  assert.ok(draft.issues.some((i) => i.code === "NO_SUPPORTED_INPUT"));
});

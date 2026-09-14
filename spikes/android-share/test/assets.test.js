/**
 * Manifest and icon assets (C02 / R01 F1).
 *
 * These assert that the files exist, decode, and are referenced consistently.
 * They assert nothing about Android installability: that remains an open device
 * gate, and a passing test here must never be read as evidence the PWA installs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const root = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const manifest = JSON.parse(readFileSync(root("manifest.webmanifest"), "utf8"));
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Decode enough of a PNG to prove it is real, without a dependency. */
function decodePng(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], PNG_SIGNATURE, "PNG signature");
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colourType = bytes[25];

  const idat = [];
  let offset = 8;
  let sawEnd = false;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === "IEND") sawEnd = true;
    offset += 12 + length;
  }
  assert.ok(sawEnd, "PNG must terminate with IEND");
  // Inflating proves the pixel data is genuinely decodable, not a stub file.
  const raw = inflateSync(Buffer.concat(idat));
  return { width, height, bitDepth, colourType, rawLength: raw.length };
}

test("the manifest declares the documented 192 and 512 raster sizes", () => {
  const sizes = manifest.icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes("192x192"), "Chromium's criteria list a 192x192 icon");
  assert.ok(sizes.includes("512x512"), "and a 512x512 icon");
  assert.ok(manifest.icons.some((icon) => icon.purpose?.includes("maskable")), "Android adaptive masking");
});

test("every manifest icon file exists and decodes at its declared size", () => {
  for (const icon of manifest.icons) {
    const bytes = readFileSync(root(icon.src));
    assert.ok(bytes.length > 0, `${icon.src} is not empty`);
    if (icon.type !== "image/png") continue;
    const decoded = decodePng(bytes);
    const [declaredWidth, declaredHeight] = icon.sizes.split("x").map(Number);
    assert.equal(decoded.width, declaredWidth, `${icon.src} width matches its declared size`);
    assert.equal(decoded.height, declaredHeight, `${icon.src} height matches its declared size`);
    assert.equal(decoded.bitDepth, 8);
    assert.equal(decoded.colourType, 2, "truecolour RGB");
    // Each scanline is one filter byte plus width RGB triples.
    assert.equal(decoded.rawLength, decoded.height * (1 + decoded.width * 3), `${icon.src} pixel data is complete`);
  }
});

test("the generator reproduces the committed icons byte for byte", async () => {
  const { buildIconPng, ICON_SIZES } = await import("../tools/make-icons.mjs");
  for (const size of ICON_SIZES) {
    assert.ok(buildIconPng(size).equals(readFileSync(root(`icon-${size}.png`))), `icon-${size}.png is reproducible`);
  }
});

test("the offline shell caches every asset the manifest references", () => {
  // An offline launch that cannot resolve a manifest icon is a different failure
  // to debug, so the icons belong in the precache list.
  const sw = readFileSync(root("sw.js"), "utf8");
  for (const icon of manifest.icons) {
    assert.ok(sw.includes(`./${icon.src}`), `sw.js precaches ${icon.src}`);
  }
});

test("the share target still declares POST multipart with the images file param", () => {
  assert.equal(manifest.share_target.method, "POST");
  assert.equal(manifest.share_target.enctype, "multipart/form-data");
  assert.equal(manifest.share_target.params.files[0].name, "images");
  assert.deepEqual(Object.keys(manifest.share_target.params).sort(), ["files", "text", "title", "url"]);
});

test("icon assets prove nothing about Android installation", () => {
  // Recorded as a test so the claim cannot drift: the device gate is open.
  const readme = readFileSync(root("README.md"), "utf8");
  assert.match(readme, /UNVERIFIED/i, "the README must still carry an open device gate");
});

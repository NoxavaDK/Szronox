#!/usr/bin/env node
/**
 * Generate the diagnostic's raster icon fallbacks.
 *
 * C02 / R01 F1. Chromium's documented installability criteria list a 192x192 and
 * a 512x512 icon. The manifest previously carried only `icon.svg` with
 * `sizes: "any"`. Whether that installs is not something this repository can
 * settle — the lead's adjudication called it a compatibility risk, not a proven
 * failure — so the fix is to remove the variable before device testing rather
 * than to argue about it.
 *
 * These icons belong to the DIAGNOSTIC only. They are deliberately plain and do
 * not freeze, preview or imply any product icon. Regenerate with:
 *
 *     node tools/make-icons.mjs
 *
 * Written with node:zlib alone so the spike keeps zero dependencies.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BACKGROUND = [0x21, 0x35, 0x47]; // diagnostic ink
const FOREGROUND = [0xf4, 0xf1, 0xe8]; // diagnostic paper

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/**
 * A centred share-style glyph: three nodes joined by two links.
 *
 * Everything is kept inside a circle of radius 0.4 * size around the centre,
 * which is the documented maskable safe zone, so the 512 icon survives Android's
 * adaptive-icon masking without losing the mark.
 */
function pixel(x, y, size) {
  const cx = size / 2;
  const cy = size / 2;
  const unit = size / 64;

  const disc = (px, py, r) => (x - px) ** 2 + (y - py) ** 2 <= r ** 2;
  // Distance from a point to a segment, for the connecting links.
  const nearSegment = (ax, ay, bx, by, width) => {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const px = ax + t * dx;
    const py = ay + t * dy;
    return (x - px) ** 2 + (y - py) ** 2 <= width ** 2;
  };

  const top = [cx + 9 * unit, cy - 11 * unit];
  const mid = [cx - 10 * unit, cy];
  const bottom = [cx + 9 * unit, cy + 11 * unit];
  const nodeR = 4.4 * unit;
  const linkW = 1.7 * unit;

  const onGlyph =
    disc(top[0], top[1], nodeR) ||
    disc(mid[0], mid[1], nodeR) ||
    disc(bottom[0], bottom[1], nodeR) ||
    nearSegment(mid[0], mid[1], top[0], top[1], linkW) ||
    nearSegment(mid[0], mid[1], bottom[0], bottom[1], linkW);

  return onGlyph ? FOREGROUND : BACKGROUND;
}

export function buildIconPng(size) {
  // Filter byte 0 (None) per scanline, then RGB triples.
  const raw = Buffer.alloc(size * (1 + size * 3));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = pixel(x, y, size);
      raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b;
      offset += 3;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const ICON_SIZES = [192, 512];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const size of ICON_SIZES) {
    const target = fileURLToPath(new URL(`../icon-${size}.png`, import.meta.url));
    const png = buildIconPng(size);
    writeFileSync(target, png);
    process.stdout.write(`wrote icon-${size}.png (${png.length} bytes)\n`);
  }
}

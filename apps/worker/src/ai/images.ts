import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

export interface ImageInput { id: string; storageKey: string; mimeType: string; byteSize: number }
export interface ImagePart { inlineData: { mimeType: string; data: string } }
export interface ImageProvenance { attachmentId: string; sha256: string; byteSize: number; mimeType: string }

function mimeOf(bytes: Buffer): string | null {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

/** The same opaque storage-key layout as the API, opened without following symlinks. */
export async function readInputImages(root: string, images: ImageInput[]): Promise<{ parts: ImagePart[]; provenance: ImageProvenance[] }> {
  if (!path.isAbsolute(root)) throw new Error('APP_STORAGE_ROOT must be absolute');
  if (images.length > 8) throw new Error('UNSUPPORTED_INPUT');
  const objects = path.join(root, 'objects');
  const directory = await lstat(objects);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('UNSUPPORTED_INPUT');
  const parts: ImagePart[] = [];
  const provenance: ImageProvenance[] = [];
  let total = 0;
  for (const image of images) {
    if (typeof image.storageKey !== 'string' || image.storageKey.length > 256 ||
        !image.storageKey.split('/').every((segment) => /^[A-Za-z0-9_-]+$/.test(segment))) throw new Error('UNSUPPORTED_INPUT');
    const fileName = createHash('sha256').update(image.storageKey).digest('hex');
    const target = path.join(objects, fileName);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== Number(image.byteSize) || info.size > 8_000_000) {
      throw new Error('UNSUPPORTED_INPUT');
    }
    total += info.size;
    if (total > 12_000_000) throw new Error('UNSUPPORTED_INPUT');
    const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let bytes: Buffer;
    try { bytes = await handle.readFile(); } finally { await handle.close(); }
    if (bytes.length !== info.size || mimeOf(bytes) !== image.mimeType) throw new Error('UNSUPPORTED_INPUT');
    provenance.push({ attachmentId: image.id, sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.length, mimeType: image.mimeType });
    parts.push({ inlineData: { mimeType: image.mimeType, data: bytes.toString('base64') } });
  }
  return { parts, provenance };
}

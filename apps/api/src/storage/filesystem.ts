import { constants as fsConstants, createReadStream } from 'node:fs';
import {
  chmod,
  lstat,
  link,
  open,
  unlink,
} from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';

import sharp from 'sharp';

import {
  type OpenStoredObject,
  type SignedUpload,
  type StorageAdapter,
  StorageConflictError,
  StorageError,
  StorageInputError,
  type StorageWriteOptions,
  UPLOAD_TOKEN_HEADER,
  type ValidatedStoredObject,
} from '../core/storage.js';

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const DEFAULT_MAX_PIXEL_COUNT = 40_000_000;
const DEFAULT_MAX_DIMENSION = 20_000;
const SUPPORTED_FORMATS: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};
const VIDEO_MAX_BYTES = 25 * 1024 * 1024;

function videoContainerMime(header: Buffer): string | null {
  if (header.length >= 8 && header.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  if (header.length >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'AVI ') return 'video/x-msvideo';
  if (header.length >= 4 && header.toString('ascii', 0, 4) === 'OggS') return 'video/ogg';
  if (header.length >= 3 && header.toString('ascii', 0, 3) === 'FLV') return 'video/x-flv';
  if (header.length >= 377 && header[0] === 0x47 && header[188] === 0x47) return 'video/mp2t';
  if (header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0xba]))) return 'video/mpeg';
  if (header.length >= 16 && header.subarray(0, 16).equals(Buffer.from([
    0x30,0x26,0xb2,0x75,0x8e,0x66,0xcf,0x11,0xa6,0xd9,0x00,0xaa,0x00,0x62,0xce,0x6c,
  ]))) return 'video/x-ms-asf';
  return null;
}

export interface FilesystemStorageConfig {
  root: string;
  appOrigin: string;
  defaultExpiresInSeconds?: number;
  now?: () => number;
  expectedUid?: number;
  expectedGid?: number;
  maxPixelCount?: number;
  maxDimension?: number;
}

function validatedOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new StorageError('Storage appOrigin must be an absolute HTTP(S) origin'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    throw new StorageError('Storage appOrigin must contain only an HTTP(S) scheme and authority');
  }
  return url.origin;
}

function validateStorageKey(storageKey: string): void {
  if (storageKey.length === 0 || storageKey.length > 256 || storageKey.startsWith('/')
      || storageKey.includes('\\') || storageKey.includes('\0')) {
    throw new StorageInputError('Invalid storage key', 'invalid_storage_key');
  }
  const segments = storageKey.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..'
      || !/^[A-Za-z0-9_-]+$/.test(segment))) {
    throw new StorageInputError('Invalid storage key', 'invalid_storage_key');
  }
}

function objectName(storageKey: string): string {
  validateStorageKey(storageKey);
  return createHash('sha256').update(storageKey, 'utf8').digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function validateImage(
  filePath: string,
  byteSize: number,
  expectedMimeType: string | undefined,
  maxPixelCount: number,
  maxDimension: number,
  contentHash?: string,
): Promise<ValidatedStoredObject> {
  try {
    const input = sharp(filePath, { failOn: 'error', limitInputPixels: maxPixelCount, pages: 1 });
    const metadata = await input.metadata();
    const mimeType = metadata.format ? SUPPORTED_FORMATS[metadata.format] : undefined;
    const width = metadata.width;
    const height = metadata.height;
    const pages = metadata.pages ?? 1;
    if (!mimeType || !width || !height || pages < 1) {
      throw new StorageInputError('The uploaded file is not a supported decodable image', 'invalid_image');
    }
    const pixelCount = width * height * pages;
    if (!Number.isSafeInteger(pixelCount) || pixelCount > maxPixelCount
        || width > maxDimension || height > maxDimension) {
      throw new StorageInputError('The uploaded image exceeds configured dimension limits', 'image_dimensions_exceeded');
    }
    if (expectedMimeType !== undefined && mimeType !== expectedMimeType) {
      throw new StorageInputError('Decoded image type does not match the declared MIME type', 'mime_type_mismatch');
    }
    // metadata() parses the container; stats() forces a full pixel decode so a
    // truncated or corrupt body never reaches immutable object storage.
    await sharp(filePath, { failOn: 'error', limitInputPixels: maxPixelCount, pages: 1 }).stats();
    return {
      exists: true,
      byteSize,
      mimeType,
      width,
      height,
      pixelCount,
      contentHash: contentHash ?? await sha256File(filePath),
    };
  } catch (error) {
    if (error instanceof StorageInputError) throw error;
    throw new StorageInputError('The uploaded file could not be decoded as an image', 'invalid_image');
  }
}

async function validateVideo(filePath: string, byteSize: number, declaredMimeType: string): Promise<ValidatedStoredObject> {
  if (byteSize > VIDEO_MAX_BYTES) throw new StorageInputError('Video exceeds the 25 MiB limit', 'too_large');
  const handle = await open(filePath, fsConstants.O_RDONLY);
  let header: Buffer;
  try {
    header = Buffer.alloc(512);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    header = header.subarray(0, bytesRead);
  } finally { await handle.close(); }
  const detectedMime = videoContainerMime(header);
  if (!detectedMime || (declaredMimeType.startsWith('image/'))) {
    throw new StorageInputError('Uploaded content is not a recognized video container', 'content_mismatch');
  }
  return {
    exists: true,
    byteSize,
    mimeType: declaredMimeType.startsWith('video/') ? declaredMimeType : detectedMime,
    contentHash: await sha256File(filePath),
  };
}

async function requireOwnedDirectory(directory: string, uid: number, gid: number): Promise<Awaited<ReturnType<typeof lstat>>> {
  const info = await lstat(directory).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    throw new StorageError(`Storage directory is missing, not a directory, or a symlink: ${directory}`);
  }
  if (info.uid !== uid || info.gid !== gid) {
    throw new StorageError(`Storage directory ownership does not match the API process: ${directory}`);
  }
  if ((info.mode & 0o777) !== DIRECTORY_MODE) {
    throw new StorageError(`Storage directory must have mode 0700: ${directory}`);
  }
  return info;
}

async function requirePrivateRegularFile(filePath: string, uid: number, gid: number) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new StorageError('Stored object is not a regular file');
  if (info.uid !== uid || info.gid !== gid || (info.mode & 0o777) !== FILE_MODE) {
    throw new StorageError('Stored object ownership or mode is unsafe');
  }
  return info;
}

export function filesystemStorageAdapter(config: FilesystemStorageConfig): StorageAdapter {
  if (!path.isAbsolute(config.root) || path.normalize(config.root) !== config.root) {
    throw new StorageError('APP_STORAGE_ROOT must be an absolute normalized path');
  }
  const root = config.root;
  const staging = path.join(root, 'staging');
  const objects = path.join(root, 'objects');
  const origin = validatedOrigin(config.appOrigin);
  const now = config.now ?? (() => Date.now());
  const defaultExpiresInSeconds = config.defaultExpiresInSeconds ?? 300;
  if (!Number.isInteger(defaultExpiresInSeconds) || defaultExpiresInSeconds < 1 || defaultExpiresInSeconds > 900) {
    throw new StorageError('Upload authorization lifetime must be between 1 and 900 seconds');
  }
  // The container contract runs the API as uid/gid 1000. Tests explicitly inject
  // their local uid/gid; a root-run production process therefore fails closed.
  const expectedUid = config.expectedUid ?? 1000;
  const expectedGid = config.expectedGid ?? 1000;
  const configuredMaxPixels = config.maxPixelCount ?? DEFAULT_MAX_PIXEL_COUNT;
  const configuredMaxDimension = config.maxDimension ?? DEFAULT_MAX_DIMENSION;
  let initialization: Promise<void> | undefined;

  async function initializeOnce(): Promise<void> {
    if (!initialization) {
      initialization = (async () => {
        const rootInfo = await requireOwnedDirectory(root, expectedUid, expectedGid);
        const [stagingInfo, objectsInfo] = await Promise.all([
          requireOwnedDirectory(staging, expectedUid, expectedGid),
          requireOwnedDirectory(objects, expectedUid, expectedGid),
        ]);
        if (rootInfo.dev !== stagingInfo.dev || rootInfo.dev !== objectsInfo.dev) {
          throw new StorageError('Storage staging and objects directories must be on the same filesystem');
        }
        const probe = path.join(staging, `.write-probe-${randomUUID()}`);
        const handle = await open(probe, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, FILE_MODE);
        try { await handle.sync(); } finally { await handle.close(); await unlink(probe).catch(() => undefined); }
      })();
    }
    return initialization;
  }

  function finalPath(storageKey: string): string {
    return path.join(objects, objectName(storageKey));
  }

  async function inspectPublished(storageKey: string): Promise<ValidatedStoredObject | null> {
    await initializeOnce();
    const target = finalPath(storageKey);
    let info;
    try { info = await requirePrivateRegularFile(target, expectedUid, expectedGid); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let header = Buffer.alloc(512);
    const handle = await open(target, fsConstants.O_RDONLY);
    try { const read = await handle.read(header, 0, header.length, 0); header = header.subarray(0, read.bytesRead); } finally { await handle.close(); }
    if (videoContainerMime(header)) return validateVideo(target, info.size, 'application/octet-stream');
    return validateImage(target, info.size, undefined, configuredMaxPixels, configuredMaxDimension);
  }

  return {
    initialize: initializeOnce,

    async createSignedUpload(_storageKey, options): Promise<SignedUpload> {
      await initializeOnce();
      validateStorageKey(_storageKey);
      if (!options.scope) throw new StorageError('Filesystem upload authorization requires actor/reel/attachment scope');
      const expiresIn = options.expiresInSeconds ?? defaultExpiresInSeconds;
      if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 900) {
        throw new StorageError('Upload authorization lifetime must be between 1 and 900 seconds');
      }
      const token = randomBytes(32).toString('base64url');
      return {
        uploadUrl: `${origin}/api/v1/reels/${encodeURIComponent(options.scope.reelId)}`
          + `/attachments/${encodeURIComponent(options.scope.attachmentId)}/content`,
        method: 'PUT',
        headers: { [UPLOAD_TOKEN_HEADER]: token },
        expiresAt: Math.floor(now() / 1000) + expiresIn,
      };
    },

    async writeObject(storageKey, source, options): Promise<ValidatedStoredObject> {
      await initializeOnce();
      const name = objectName(storageKey);
      const maxByteSize = options.kind === 'video' ? Math.min(options.maxByteSize, VIDEO_MAX_BYTES) : options.maxByteSize;
      if (!Number.isInteger(options.byteSize) || options.byteSize < 1 || options.byteSize > maxByteSize) {
        throw new StorageInputError('Declared byte size is outside the configured bound', 'byte_size_exceeded');
      }
      const temporary = path.join(staging, `${name}.${randomUUID()}.part`);
      const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY
        | (fsConstants.O_NOFOLLOW ?? 0);
      const handle = await open(temporary, flags, FILE_MODE);
      const hash = createHash('sha256');
      let byteSize = 0;
      try {
        try {
          for await (const value of source) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            byteSize += chunk.byteLength;
            if (byteSize > options.byteSize || byteSize > maxByteSize) {
              throw new StorageInputError('Upload body exceeds its declared or configured byte bound', 'byte_size_exceeded');
            }
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.byteLength) {
              const written = await handle.write(chunk, offset, chunk.byteLength - offset);
              if (written.bytesWritten < 1) throw new StorageError('Storage write made no progress');
              offset += written.bytesWritten;
            }
          }
          if (byteSize !== options.byteSize) {
            throw new StorageInputError('Upload body size does not match the declared byte size', 'byte_size_mismatch');
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        await chmod(temporary, FILE_MODE);
        const validated = options.kind === 'video'
          ? await validateVideo(temporary, byteSize, options.mimeType)
          : await validateImage(
            temporary,
            byteSize,
            // Record the decoded format, not the declared guess (a WebP named .jpg is still a WebP).
            undefined,
            Math.min(options.maxPixelCount, configuredMaxPixels),
            Math.min(options.maxDimension, configuredMaxDimension),
            hash.digest('hex'),
          );
        const target = path.join(objects, name);
        try {
          // Hard-link publication is atomic and refuses replacement (EEXIST).
          // staging and objects are verified to be on the same filesystem.
          await link(temporary, target);
          const directory = await open(objects, fsConstants.O_RDONLY);
          try { await directory.sync(); } finally { await directory.close(); }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const existing = await inspectPublished(storageKey);
          if (!existing || existing.contentHash !== validated.contentHash) {
            throw new StorageConflictError('An immutable object already exists for this attachment');
          }
          return existing;
        }
        return validated;
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    },

    async statObject(storageKey) {
      const object = await inspectPublished(storageKey);
      return object ?? { exists: false, byteSize: 0 };
    },

    async openObject(storageKey): Promise<OpenStoredObject> {
      const object = await inspectPublished(storageKey);
      if (!object) throw new StorageError('Stored object was not found', 404);
      const target = finalPath(storageKey);
      const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
      const handle = await open(target, flags);
      // FileHandle-backed stream keeps the no-follow descriptor that was checked.
      return { object, stream: handle.createReadStream({ autoClose: true }) as Readable };
    },
  };
}

/** Test/operator helper for disposable roots; production volume creation stays in VPS-03. */
export async function initializeDisposableStorageRoot(root: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(root, { recursive: true, mode: DIRECTORY_MODE });
  await chmod(root, DIRECTORY_MODE);
  await mkdir(path.join(root, 'staging'), { mode: DIRECTORY_MODE });
  await mkdir(path.join(root, 'objects'), { mode: DIRECTORY_MODE });
}

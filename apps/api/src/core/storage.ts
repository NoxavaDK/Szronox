import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

export interface StoredObject {
  exists: boolean;
  byteSize: number;
  /** Present for filesystem objects that passed a real image decode. */
  mimeType?: string;
  width?: number;
  height?: number;
  pixelCount?: number;
  contentHash?: string;
}

export interface ValidatedStoredObject extends StoredObject {
  exists: true;
  mimeType: string;
  width: number;
  height: number;
  pixelCount: number;
  contentHash: string;
}

export interface UploadScope {
  actorId: string;
  reelId: string;
  attachmentId: string;
}

export interface SignedUpload {
  uploadUrl: string;
  method: 'PUT' | 'POST';
  headers: Record<string, string>;
  expiresAt: number;
}

export interface StorageWriteOptions {
  mimeType: string;
  byteSize: number;
  maxByteSize: number;
  maxPixelCount: number;
  maxDimension: number;
}

export interface OpenStoredObject {
  object: ValidatedStoredObject;
  stream: Readable;
}

export interface StorageAdapter {
  /** VPS-04 must await this before listen; operations await the same promise too. */
  initialize(): Promise<void>;
  statObject(storageKey: string): Promise<StoredObject>;
  createSignedUpload(storageKey: string, options: {
    mimeType: string;
    byteSize: number;
    expiresInSeconds?: number;
    /** Required by the VPS adapter. Optional only for the retained legacy test double. */
    scope?: UploadScope;
  }): Promise<SignedUpload>;
  writeObject?(
    storageKey: string,
    source: AsyncIterable<Uint8Array> | Readable,
    options: StorageWriteOptions,
  ): Promise<ValidatedStoredObject>;
  openObject?(storageKey: string): Promise<OpenStoredObject>;
}

export class StorageError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
  }
}

export class StorageInputError extends StorageError {
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message, 422);
    this.name = 'StorageInputError';
    this.reason = reason;
  }
}

export class StorageConflictError extends StorageError {
  readonly reason: string;
  constructor(message: string, reason = 'immutable_object_conflict') {
    super(message, 409);
    this.name = 'StorageConflictError';
    this.reason = reason;
  }
}

export const UPLOAD_TOKEN_HEADER = 'X-Upload-Token';

export function digestUploadToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * In-memory storage remains an injectable test double. It is never selected as a
 * public production fallback and deliberately does not claim filesystem/image
 * validation evidence.
 */
export function memoryStorageAdapter(options: { now?: () => number } = {}): StorageAdapter & {
  put(storageKey: string, byteSize: number): void;
  uploads(): string[];
} {
  const objects = new Map<string, number>();
  const issued: string[] = [];
  const now = options.now ?? (() => Date.now());
  return {
    async initialize() {},
    put(storageKey, byteSize) { objects.set(storageKey, byteSize); },
    uploads: () => [...issued],
    async statObject(storageKey) {
      const byteSize = objects.get(storageKey);
      return byteSize === undefined ? { exists: false, byteSize: 0 } : { exists: true, byteSize };
    },
    async createSignedUpload(storageKey, opts) {
      issued.push(storageKey);
      const expiresIn = opts.expiresInSeconds ?? 300;
      const token = randomBytes(32).toString('base64url');
      return {
        uploadUrl: opts.scope
          ? `https://memory.invalid/api/v1/reels/${opts.scope.reelId}/attachments/${opts.scope.attachmentId}/content`
          : `memory://upload/${encodeURIComponent(storageKey)}`,
        method: 'PUT',
        headers: { [UPLOAD_TOKEN_HEADER]: token },
        expiresAt: Math.floor(now() / 1000) + expiresIn,
      };
    },
  };
}

/**
 * Retained only so accepted historical tests compile while VPS branches are
 * integrated. Core configuration no longer selects this adapter; VPS storage is
 * the filesystem implementation in ../storage/filesystem.ts.
 */
export interface SupabaseStorageConfig {
  url: string;
  serviceRoleKey: string;
  bucket: string;
  defaultExpiresInSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function supabaseStorageAdapter(config: SupabaseStorageConfig): StorageAdapter {
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? (() => Date.now());
  const base = config.url.replace(/\/+$/, '');
  const authHeaders = { authorization: `Bearer ${config.serviceRoleKey}`, apikey: config.serviceRoleKey };
  const encodePath = (key: string) => key.split('/').map(encodeURIComponent).join('/');
  return {
    async initialize() {},
    async statObject(storageKey) {
      const response = await fetchImpl(
        `${base}/storage/v1/object/info/authenticated/${config.bucket}/${encodePath(storageKey)}`,
        { method: 'GET', headers: { ...authHeaders, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) },
      );
      if (response.status === 404) return { exists: false, byteSize: 0 };
      if (!response.ok) throw new StorageError(`Storage info request failed with status ${response.status}`, response.status);
      const body = (await response.json()) as { size?: unknown; contentLength?: unknown; metadata?: { size?: unknown } };
      const raw = body.size ?? body.contentLength ?? body.metadata?.size;
      const byteSize = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(byteSize)) throw new StorageError('Storage info response did not report an object size');
      return { exists: true, byteSize };
    },
    async createSignedUpload(storageKey, options) {
      const expiresIn = options.expiresInSeconds ?? config.defaultExpiresInSeconds ?? 300;
      const response = await fetchImpl(
        `${base}/storage/v1/object/upload/sign/${config.bucket}/${encodePath(storageKey)}`,
        {
          method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ expiresIn }), signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new StorageError(`Signed upload request failed with status ${response.status}`, response.status);
      const body = (await response.json()) as { url?: unknown };
      if (typeof body.url !== 'string' || body.url === '') throw new StorageError('Signed upload response did not contain a url');
      return {
        uploadUrl: body.url.startsWith('http') ? body.url : `${base}/storage/v1${body.url}`,
        method: 'PUT', headers: { 'x-upsert': 'false' }, expiresAt: Math.floor(now() / 1000) + expiresIn,
      };
    },
  };
}

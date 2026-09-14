/**
 * Private attachment storage.
 *
 * T05's first pass returned only a storage key, so a browser had nowhere to upload
 * to; T08 reported that as a blocker. This adds the transport.
 *
 * Honest scope, because it bounds what can be claimed:
 *
 *   - The Supabase adapter below is written against Supabase Storage's documented
 *     signed-upload flow, but **it has never been executed against a real project**.
 *     No Supabase URL, service-role key or bucket was available. Treat its exact
 *     request shapes as unverified configuration, not as observed behaviour.
 *   - The in-memory adapter IS fully exercised by the test suite, so the repository's
 *     use of the interface — initiate, probe, size mismatch, completion — is real
 *     evidence about this codebase even while the provider call is not.
 *
 * The service-role key never leaves the server: the browser receives only a
 * short-lived signed URL scoped to one object path.
 */

export interface StoredObject {
  exists: boolean;
  byteSize: number;
}

export interface SignedUpload {
  /** Absolute URL the browser PUTs the bytes to. */
  uploadUrl: string;
  /** HTTP method the browser must use. */
  method: 'PUT' | 'POST';
  /** Headers the browser must send, excluding Content-Type it sets itself. */
  headers: Record<string, string>;
  /** Unix seconds after which the URL stops working. */
  expiresAt: number;
}

export interface StorageAdapter {
  /** Server-side existence/size probe used to validate completion. */
  statObject(storageKey: string): Promise<StoredObject>;
  /**
   * Mint a short-lived, single-object upload URL. The caller has already validated
   * the declared type and size against the configured bounds.
   */
  createSignedUpload(storageKey: string, options: {
    mimeType: string;
    byteSize: number;
    expiresInSeconds?: number;
  }): Promise<SignedUpload>;
}

export interface SupabaseStorageConfig {
  /** e.g. https://<ref>.supabase.co */
  url: string;
  /** Service-role key. Server-side only; never sent to a browser. */
  serviceRoleKey: string;
  /** Private bucket name. */
  bucket: string;
  defaultExpiresInSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Fail loudly rather than silently degrading to "no storage configured". */
export class StorageError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
  }
}

/**
 * Supabase Storage adapter.
 *
 * UNVERIFIED against a live project. The endpoints follow Supabase Storage's
 * documented shapes:
 *   POST /storage/v1/object/upload/sign/{bucket}/{path}  -> { url: "/object/upload/sign/..." }
 *   POST /storage/v1/object/info/authenticated/{bucket}/{path} -> object metadata
 * If a live run disagrees, the disagreement belongs in a follow-up report rather
 * than being smoothed over here.
 */
export function supabaseStorageAdapter(config: SupabaseStorageConfig): StorageAdapter {
  const fetchImpl = config.fetchImpl ?? fetch;
  const now = config.now ?? (() => Date.now());
  const base = config.url.replace(/\/+$/, '');
  const authHeaders = {
    authorization: `Bearer ${config.serviceRoleKey}`,
    apikey: config.serviceRoleKey,
  };

  const encodePath = (storageKey: string) =>
    storageKey.split('/').map((segment) => encodeURIComponent(segment)).join('/');

  return {
    async statObject(storageKey) {
      const response = await fetchImpl(
        `${base}/storage/v1/object/info/authenticated/${config.bucket}/${encodePath(storageKey)}`,
        { method: 'GET', headers: { ...authHeaders, accept: 'application/json' }, signal: AbortSignal.timeout(10_000) },
      );
      if (response.status === 404) return { exists: false, byteSize: 0 };
      if (!response.ok) {
        throw new StorageError(`Storage info request failed with status ${response.status}`, response.status);
      }
      const body = (await response.json()) as { size?: unknown; contentLength?: unknown; metadata?: { size?: unknown } };
      // Size has appeared under more than one key across Storage versions; a
      // missing size is an error rather than a silent zero, because zero would
      // make a mismatch check pass by accident.
      const raw = body.size ?? body.contentLength ?? body.metadata?.size;
      const byteSize = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(byteSize)) {
        throw new StorageError('Storage info response did not report an object size');
      }
      return { exists: true, byteSize };
    },

    async createSignedUpload(storageKey, options) {
      const expiresIn = options.expiresInSeconds ?? config.defaultExpiresInSeconds ?? 300;
      const response = await fetchImpl(
        `${base}/storage/v1/object/upload/sign/${config.bucket}/${encodePath(storageKey)}`,
        {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ expiresIn }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) {
        throw new StorageError(`Signed upload request failed with status ${response.status}`, response.status);
      }
      const body = (await response.json()) as { url?: unknown };
      if (typeof body.url !== 'string' || body.url === '') {
        throw new StorageError('Signed upload response did not contain a url');
      }
      // Supabase returns a path relative to /storage/v1.
      const uploadUrl = body.url.startsWith('http') ? body.url : `${base}/storage/v1${body.url}`;
      return {
        uploadUrl,
        method: 'PUT',
        // No service-role key here: the signed token in the URL is the authority.
        headers: { 'x-upsert': 'false' },
        expiresAt: Math.floor(now() / 1000) + expiresIn,
      };
    },
  };
}

/**
 * In-memory adapter for tests and local development.
 *
 * Deliberately labelled: a green run against this proves the repository's
 * contract, not that Supabase Storage works.
 */
export function memoryStorageAdapter(options: { now?: () => number } = {}): StorageAdapter & {
  put(storageKey: string, byteSize: number): void;
  uploads(): string[];
} {
  const objects = new Map<string, number>();
  const issued: string[] = [];
  const now = options.now ?? (() => Date.now());
  return {
    put(storageKey, byteSize) { objects.set(storageKey, byteSize); },
    uploads: () => [...issued],
    async statObject(storageKey) {
      const byteSize = objects.get(storageKey);
      return byteSize === undefined ? { exists: false, byteSize: 0 } : { exists: true, byteSize };
    },
    async createSignedUpload(storageKey, opts) {
      issued.push(storageKey);
      const expiresIn = opts.expiresInSeconds ?? 300;
      return {
        uploadUrl: `memory://upload/${encodeURIComponent(storageKey)}`,
        method: 'PUT',
        headers: {},
        expiresAt: Math.floor(now() / 1000) + expiresIn,
      };
    },
  };
}

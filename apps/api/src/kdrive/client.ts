/**
 * Infomaniak kDrive folder client (KDRIVE-01), ported from the T04 spike's live-verified
 * transport (`agents/t04-kdrive`, 6/6 live probes on 2026-09-14).
 *
 * Facts it relies on, each observed live rather than assumed:
 *   - Host `https://api.infomaniak.com`, bearer token with the `drive` scope.
 *   - Versions are per operation: metadata, listing and create are v3.
 *   - Success is `{ result, data }`; failure is `{ error: { code, description } }`, and the
 *     `error.code` is what distinguishes causes (a 400 covers several).
 *   - A duplicate folder name in the same parent is rejected with `destination_already_exists`;
 *     create is not idempotent, so an ambiguous create is reconciled by lookup, never retried.
 *   - A missing id is `404 object_not_found`. Ids survive rename and move.
 *
 * The token travels only in the Authorization header. It never appears in a URL, a body, an
 * error message or a log line produced here.
 */

export const KDRIVE_API_HOST = 'https://api.infomaniak.com';
/** Canonical web location of a folder (the older kdrive.infomaniak.com form redirects here). */
export const kdriveWebUrl = (driveId: string, folderId: string) =>
  `https://ksuite.infomaniak.com/kdrive/app/drive/${encodeURIComponent(driveId)}/files/${encodeURIComponent(folderId)}`;

export interface KdriveFolder {
  id: string;
  name: string;
  parentId: string | null;
  type: string;
  /** `ok` for a live file; anything else (e.g. trashed) is treated as missing. */
  status: string;
}

/** Why a call failed, in the terms the app acts on. */
export type KdriveFailure =
  | 'missing'          // 404 / object_not_found
  | 'access_denied'    // 401 / 403: the token cannot reach it
  | 'already_exists'   // destination_already_exists on create
  | 'rejected'         // any other 4xx: the request itself is wrong
  | 'unavailable';     // 429, 5xx, timeout, network, unreadable response

export class KdriveError extends Error {
  constructor(
    readonly failure: KdriveFailure,
    readonly retryable: boolean,
    readonly status: number | null,
    readonly providerCode: string | null,
  ) {
    super(`kDrive ${failure}${status === null ? '' : ` (HTTP ${status}${providerCode ? `, ${providerCode}` : ''})`}`);
    this.name = 'KdriveError';
  }
}

export interface KdriveClient {
  getFolder(folderId: string): Promise<KdriveFolder>;
  listChildren(folderId: string): Promise<KdriveFolder[]>;
  createFolder(parentId: string, name: string): Promise<KdriveFolder>;
}

export interface HttpKdriveClientOptions {
  driveId: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Attempts for idempotent reads; create is always a single attempt. */
  maxReadAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

function classifyStatus(status: number, providerCode: string | null): { failure: KdriveFailure; retryable: boolean } {
  if (providerCode === 'destination_already_exists') return { failure: 'already_exists', retryable: false };
  if (status === 404 || providerCode === 'object_not_found') return { failure: 'missing', retryable: false };
  if (status === 401 || status === 403) return { failure: 'access_denied', retryable: false };
  if (status === 429 || status >= 500) return { failure: 'unavailable', retryable: true };
  return { failure: 'rejected', retryable: false };
}

function toFolder(raw: unknown): KdriveFolder {
  const value = (raw ?? {}) as Record<string, unknown>;
  if (value.id === undefined || value.id === null) throw new KdriveError('unavailable', true, null, 'unrecognised_payload');
  return {
    id: String(value.id),
    name: typeof value.name === 'string' ? value.name : '',
    parentId: value.parent_id === undefined || value.parent_id === null ? null : String(value.parent_id),
    type: typeof value.type === 'string' ? value.type : '',
    status: typeof value.status === 'string' ? value.status : 'ok',
  };
}

export function httpKdriveClient(options: HttpKdriveClientOptions): KdriveClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxReadAttempts = options.maxReadAttempts ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const files = `/3/drive/${encodeURIComponent(options.driveId)}/files`;

  async function once(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null; retryAfter: number | null }> {
    let response: Response;
    try {
      response = await fetchImpl(`${KDRIVE_API_HOST}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // Timeout, DNS or connection failure. The request may or may not have reached kDrive.
      throw new KdriveError('unavailable', true, null, 'transport');
    }
    let json: Record<string, unknown> | null = null;
    try {
      const text = await response.text();
      json = text.trim() === '' ? null : JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (response.ok) throw new KdriveError('unavailable', true, response.status, 'unreadable_body');
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    return { status: response.status, json, retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null };
  }

  /** The full success envelope (`{ result, data, has_more?, cursor? }`), or a thrown KdriveError. */
  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> {
    const attempts = method === 'GET' ? maxReadAttempts : 1;
    for (let attempt = 1; ; attempt += 1) {
      let failure: KdriveError;
      try {
        const { status, json, retryAfter } = await once(method, path, body);
        const providerCode = typeof (json?.error as Record<string, unknown> | undefined)?.code === 'string'
          ? String((json!.error as Record<string, unknown>).code) : null;
        if (status >= 200 && status < 300 && json !== null && json.result !== 'error') return json;
        const classified = classifyStatus(status, providerCode);
        failure = new KdriveError(classified.failure, classified.retryable, status, providerCode);
        if (failure.retryable && attempt < attempts) {
          await sleep(Math.min(retryAfter !== null ? retryAfter * 1000 : 400 * 2 ** (attempt - 1), 10_000));
          continue;
        }
      } catch (error) {
        if (!(error instanceof KdriveError)) throw error;
        failure = error;
        if (failure.retryable && attempt < attempts) { await sleep(400 * 2 ** (attempt - 1)); continue; }
      }
      throw failure;
    }
  }

  return {
    async getFolder(folderId) {
      return toFolder((await call('GET', `${files}/${encodeURIComponent(folderId)}`)).data);
    },
    async listChildren(folderId) {
      const children: KdriveFolder[] = [];
      let cursor: string | null = null;
      // Bounded: a base folder with thousands of Reel folders still resolves in a few pages.
      for (let page = 0; page < 50; page += 1) {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const envelope = await call('GET', `${files}/${encodeURIComponent(folderId)}/listing${query}`);
        // Listing data is `{ files: [...] }` (observed live); a bare array is accepted too.
        const data = envelope.data as { files?: unknown[] } | unknown[] | undefined;
        const list = Array.isArray(data) ? data : Array.isArray(data?.files) ? data.files : [];
        children.push(...list.map(toFolder));
        const next = typeof envelope.cursor === 'string' ? envelope.cursor : null;
        if (envelope.has_more !== true || next === null || next === cursor) break;
        cursor = next;
      }
      return children;
    },
    async createFolder(parentId, name) {
      return toFolder((await call('POST', `${files}/${encodeURIComponent(parentId)}/directory`, { name, only_for_me: false })).data);
    },
  };
}

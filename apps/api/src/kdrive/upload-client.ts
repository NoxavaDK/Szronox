import { KdriveError, KDRIVE_API_HOST } from './client.js';

export interface UploadSession {
  token: string;
  uploadUrl: string;
  fileId: string;
  fileName: string;
}

export interface UploadFileInfo { id: string; name: string; size: number; status: string }

export interface KdriveUploadClient {
  start(input: { folderId: string; fileName: string; byteSize: number; totalChunks: number }): Promise<UploadSession>;
  putChunk(session: Pick<UploadSession, 'token' | 'uploadUrl'>, index: number, bytes: Uint8Array, sha256: string): Promise<void>;
  finish(session: Pick<UploadSession, 'token'>, chunkHashes: string[]): Promise<UploadFileInfo>;
  getFile(fileId: string): Promise<UploadFileInfo>;
  cancel(session: Pick<UploadSession, 'token'>): Promise<void>;
  uploadSmall(folderId: string, fileName: string, bytes: Uint8Array): Promise<UploadFileInfo>;
}

/** Token-bearing kDrive relay. Error text and logs intentionally omit request URLs and headers. */
export function httpKdriveUploadClient(options: { driveId: string; token: string; fetchImpl?: typeof fetch }): KdriveUploadClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `${KDRIVE_API_HOST}/3/drive/${encodeURIComponent(options.driveId)}`;
  async function json(response: Response): Promise<Record<string, unknown>> {
    let result: Record<string, unknown> = {};
    try { result = await response.json() as Record<string, unknown>; } catch { /* mapped below */ }
    if (!response.ok || result.result === 'error') {
      const code = typeof (result.error as { code?: unknown } | undefined)?.code === 'string'
        ? String((result.error as { code: string }).code) : null;
      throw new KdriveError(response.status === 404 ? 'missing' : response.status === 401 || response.status === 403 ? 'access_denied' : response.status >= 500 || response.status === 429 ? 'unavailable' : 'rejected', response.status >= 500 || response.status === 429, response.status, code);
    }
    return result;
  }
  async function request(path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(`${base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${options.token}`, accept: 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new KdriveError('unavailable', true, null, 'transport');
    }
  }
  const fileInfo = (raw: unknown): UploadFileInfo => {
    const file = (raw ?? {}) as Record<string, unknown>;
    if (file.id === undefined || file.id === null || typeof file.name !== 'string') throw new KdriveError('unavailable', true, null, 'unrecognised_payload');
    return { id: String(file.id), name: file.name, size: Number(file.size ?? 0), status: String(file.status ?? 'ok') };
  };
  return {
    async start(input) {
      const envelope = await json(await request('/upload/session/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conflict: 'rename', directory_id: input.folderId, file_name: input.fileName, total_chunks: input.totalChunks, total_size: input.byteSize }) }));
      const data = envelope.data as Record<string, unknown>;
      const file = data.file as Record<string, unknown>;
      const uploadUrl = String(data.upload_url ?? '');
      let parsed: URL;
      try { parsed = new URL(uploadUrl); } catch { throw new KdriveError('unavailable', true, null, 'unrecognised_payload'); }
      if (parsed.protocol !== 'https:' || !/(^|\.)upload\.kdrive\.infomaniak\.com$/i.test(parsed.hostname)) throw new KdriveError('rejected', false, null, 'unsafe_upload_host');
      if (!data.token || !file?.id || !file.name) throw new KdriveError('unavailable', true, null, 'unrecognised_payload');
      return { token: String(data.token), uploadUrl: parsed.origin, fileId: String(file.id), fileName: String(file.name) };
    },
    async putChunk(session, index, bytes, sha256) {
      // kDrive numbers chunks from 1 (KDRIVE-02 probe, `n = index + 1`); our index is 0-based.
      const url = `${session.uploadUrl}/3/drive/${encodeURIComponent(options.driveId)}/upload/session/${encodeURIComponent(session.token)}/chunk?chunk_number=${index + 1}&chunk_size=${bytes.byteLength}&chunk_hash=${encodeURIComponent(`sha256:${sha256}`)}`;
      try {
        const response = await fetchImpl(url, { method: 'POST', headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/octet-stream' }, body: Buffer.from(bytes), signal: AbortSignal.timeout(120_000) });
        if (!response.ok) await json(response);
      } catch (error) { if (error instanceof KdriveError) throw error; throw new KdriveError('unavailable', true, null, 'transport'); }
    },
    async finish(session, chunkHashes) {
      const combined = await import('node:crypto').then(({ createHash }) => createHash('sha256').update(chunkHashes.join('')).digest('hex'));
      const envelope = await json(await request(`/upload/session/${encodeURIComponent(session.token)}/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ total_chunk_hash: `sha256:${combined}` }) }));
      return fileInfo((envelope.data as Record<string, unknown>).file);
    },
    async getFile(fileId) {
      const envelope = await json(await request(`/files/${encodeURIComponent(fileId)}`, { method: 'GET' }));
      return fileInfo(envelope.data);
    },
    async cancel(session) {
      const response = await request(`/upload/session/${encodeURIComponent(session.token)}`, { method: 'DELETE' });
      if (response.ok) return;
      await json(response);
    },
    async uploadSmall(folderId, fileName, bytes) {
      const query = new URLSearchParams({ directory_id: folderId, file_name: fileName, total_size: String(bytes.byteLength), conflict: 'rename' });
      const response = await request(`/upload?${query}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from(bytes) });
      const envelope = await json(response);
      return fileInfo((envelope.data as Record<string, unknown>).file);
    },
  };
}

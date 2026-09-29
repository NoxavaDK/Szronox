import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { KdriveUploadStartRequest, KdriveUploadState } from '@szronox/contracts';
import { CoreError, editConflict, idempotencyConflict, internalError, notFound, validationError } from '../core/errors.js';
import { CoreRepository, payloadHash, type Actor } from '../core/repository.js';
import type { CoreDependencies } from '../core/routes.js';
import { httpKdriveClient, KdriveError } from './client.js';
import { kdriveService } from './service.js';
import { httpKdriveUploadClient, type KdriveUploadClient, type UploadSession } from './upload-client.js';
import type { KdriveClient } from './client.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHUNK_SIZE = 16 * 1024 * 1024;
const VIDEO_MAX = 4 * 1024 * 1024 * 1024;
const COVER_MAX = 25 * 1024 * 1024;
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime']);
const COVER_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SAFE_NAME = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

interface UploadRow {
  id: string; reel_id: string; purpose: 'video' | 'cover'; requested_by: string; file_name: string; mime_type: string;
  byte_size: string | number; chunk_size: number; total_chunks: number; received_chunks: number[]; chunk0_sha256: string | null;
  chunk_hashes: string[]; kdrive_session_token: string | null; kdrive_upload_host: string | null; folder_id: string; state: KdriveUploadState['state'];
  kdrive_file_id: string; final_name: string | null; start_payload_hash: string;
}

function uuid(value: unknown, field: string): string { if (typeof value !== 'string' || !UUID.test(value)) throw validationError(`${field} must be a UUID`, { field }); return value; }
function state(row: UploadRow): KdriveUploadState {
  return { uploadId: row.id, reelId: row.reel_id, purpose: row.purpose, fileName: row.file_name, mimeType: row.mime_type,
    byteSize: Number(row.byte_size), chunkSize: row.chunk_size, totalChunks: row.total_chunks, receivedChunks: row.received_chunks,
    state: row.state, ...(row.final_name ? { finalName: row.final_name } : {}), ...(row.state !== 'open' ? { fileId: row.kdrive_file_id } : {}) };
}
export function prefixedName(purpose: 'video' | 'cover', value: string): string {
  const candidateExtension = value.lastIndexOf('.') > 0 ? value.slice(value.lastIndexOf('.')) : '';
  const ext = /^\.[a-z0-9]{1,12}$/i.test(candidateExtension) ? candidateExtension : '';
  const stem = (ext ? value.slice(0, -ext.length) : value).replace(SAFE_NAME, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 160) || 'plik';
  const prefix = purpose === 'video' ? 'EKSPORT - ' : 'OKLADKA - ';
  return `${stem.toLocaleLowerCase('pl').startsWith(prefix.toLocaleLowerCase('pl')) ? '' : prefix}${stem}${ext}`;
}
function magicMatches(type: string, bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes);
  if (type === 'image/png') return b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (type === 'image/jpeg') return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === 'image/webp') return b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
  if (type === 'video/mp4' || type === 'video/quicktime') return b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp';
  return false;
}
async function bufferBody(body: unknown, max: number): Promise<Buffer> {
  const stream = body as Readable;
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw validationError('Chunk body is required', { reason: 'chunk_size_mismatch' });
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of stream) { const data = Buffer.from(part); size += data.length; if (size > max) throw validationError('Chunk exceeds its declared size', { reason: 'chunk_size_mismatch' }); chunks.push(data); }
  return Buffer.concat(chunks, size);
}

export function registerKdriveUploadRoutes(app: FastifyInstance, deps: CoreDependencies, providerOverride?: KdriveUploadClient, folderOverride?: KdriveClient): void {
  if (!app.hasContentTypeParser('application/octet-stream')) {
    app.addContentTypeParser('application/octet-stream', (request, payload, done) => { void request; done(null, payload); });
  }
  const config = deps.kdrive ?? null;
  const folders = kdriveService({ repository: new CoreRepository(deps.db), settings: config ? { driveId: config.driveId, rootFolderId: config.rootFolderId } : null,
    client: config ? folderOverride ?? httpKdriveClient({ driveId: config.driveId, token: config.token }) : null });
  const provider = config ? providerOverride ?? httpKdriveUploadClient({ driveId: config.driveId, token: config.token }) : null;
  const repo = new CoreRepository(deps.db);
  const failure = (error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof CoreError) return reply.code(error.status).send(error.toEnvelope());
    if (error instanceof KdriveError) {
      const mapped = new CoreError({ status: error.failure === 'missing' ? 422 : error.failure === 'unavailable' ? 503 : 502,
        code: error.failure === 'missing' ? 'PROVIDER_RESOURCE_MISSING' : error.failure === 'access_denied' ? 'PROVIDER_ACCESS_DENIED' : 'PROVIDER_UNAVAILABLE',
        retryable: error.retryable, message: 'kDrive operation failed', details: { provider: 'kdrive', reason: error.failure } });
      return reply.code(mapped.status).send(mapped.toEnvelope());
    }
    request.log.error(error);
    const mapped = internalError(); return reply.code(mapped.status).send(mapped.toEnvelope());
  };
  const handle = (fn: (request: FastifyRequest, reply: FastifyReply, actor: Actor) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    try { const actor = await deps.authenticate(request); return await fn(request, reply, actor); }
    catch (error) { return failure(error, request, reply); }
  };
  const load = async (id: string, actor: Actor) => {
    const result = await deps.db.query<UploadRow>('select * from app.kdrive_uploads where id=$1 and requested_by=$2', [id, actor.id]);
    if (!result.rows[0]) throw notFound('Upload not found'); return result.rows[0];
  };

  app.post('/api/v1/reels/:id/kdrive-uploads', handle(async (request, reply, actor) => {
    if (!config || !provider) throw new CoreError({ status: 503, code: 'PROVIDER_UNAVAILABLE', message: 'kDrive integration is not configured', retryable: false, details: { reason: 'kdrive_not_configured' } });
    const reelId = uuid((request.params as { id: string }).id, 'id'); const body = (request.body ?? {}) as Record<string, unknown>;
    const operationId = uuid(body.operationId, 'operationId'); const expectedVersion = body.expectedVersion;
    if (!Number.isInteger(expectedVersion) || Number(expectedVersion) < 1) throw validationError('expectedVersion must be a positive integer');
    if (body.purpose !== 'video' && body.purpose !== 'cover') throw validationError('purpose must be video or cover');
    const purpose = body.purpose; const mimeType = body.mimeType; const fileName = body.fileName; const byteSize = body.byteSize;
    if (typeof mimeType !== 'string' || !(purpose === 'video' ? VIDEO_TYPES : COVER_TYPES).has(mimeType)) throw validationError('Unsupported upload type', { reason: 'unsupported_type' });
    if (typeof fileName !== 'string' || !fileName.trim() || fileName.length > 240 || typeof byteSize !== 'number' || !Number.isSafeInteger(byteSize) || byteSize < 1) throw validationError('Invalid upload metadata');
    if (byteSize > (purpose === 'video' ? VIDEO_MAX : COVER_MAX)) throw validationError('Upload exceeds the size limit', { reason: 'too_large' });
    const normalized: KdriveUploadStartRequest = { operationId, expectedVersion: Number(expectedVersion), purpose, fileName: fileName.trim(), byteSize, mimeType, ...(body.createFolder === true ? { createFolder: true } : {}) };
    const startHash = payloadHash({ reelId, request: normalized });
    const replay = await deps.db.query<UploadRow>('select * from app.kdrive_uploads where start_operation_id=$1', [operationId]);
    if (replay.rows[0]) {
      const row = replay.rows[0];
      if (row.start_payload_hash !== startHash || row.requested_by !== actor.id) throw idempotencyConflict();
      if (row.state === 'failed') throw new CoreError({ status: 503, code: 'PROVIDER_UNAVAILABLE', message: 'Upload start needs a new operation', retryable: false, details: { reason: 'upload_start_not_replayable' } });
      return state(row);
    }
    const reel = await repo.getReel(reelId);
    if (reel.version !== normalized.expectedVersion) throw editConflict(reel.version);
    let folderId: string;
    let reservationReelVersion: number;
    if (!reel.kdriveFolder) {
      if (!normalized.createFolder) throw validationError('Create the Reel folder before uploading', { reason: 'folder_required' });
      const linked = await folders.command(actor, reelId, { operationId, expectedVersion: reel.version, mode: 'create' });
      if (linked.folder.state !== 'available') throw validationError('The Reel folder could not be made available', { reason: 'folder_unavailable' });
      folderId = linked.folder.folderId;
      reservationReelVersion = linked.reel.version;
    } else {
      const resolved = await folders.resolve(reelId);
      if (resolved.state === 'available') folderId = resolved.folderId;
      else throw validationError('The linked kDrive folder is not available; reconnect it first', { reason: resolved.state === 'missing' ? 'folder_missing' : 'folder_unavailable' });
      reservationReelVersion = reel.version;
    }
    const totalChunks = Math.ceil(byteSize / CHUNK_SIZE); const uploadName = prefixedName(purpose, normalized.fileName);
    const id = randomUUID();
    try {
      await deps.db.transaction(async (tx) => {
        // Serialize every start by requester, then by Reel. Counting and writing the
        // reservation in the same transaction prevents two starts from observing the
        // same free capacity. The reservation's state/error pair counts until kDrive
        // confirms that the session has started or the request is known to have failed.
        const userLock = await tx.query('select id from app.users where id=$1 for update', [actor.id]);
        if (!userLock.rows[0]) throw notFound('User not found');
        const reelLock = await tx.query<{ version: number }>(
          'select version from app.reels where id=$1 and deleted_at is null for update', [reelId]);
        if (!reelLock.rows[0]) throw notFound('Reel not found');
        if (reelLock.rows[0].version !== reservationReelVersion) throw editConflict(reelLock.rows[0].version);
        const counts = await tx.query<{ reel_count: number; user_count: number }>(`select
          count(*) filter(where reel_id=$1 and (state='open' or (state='failed' and error->>'reason' in ('start_in_progress','start_uncertain'))))::int reel_count,
          count(*) filter(where requested_by=$2 and (state='open' or (state='failed' and error->>'reason' in ('start_in_progress','start_uncertain'))))::int user_count
          from app.kdrive_uploads`, [reelId, actor.id]);
        if (counts.rows[0].reel_count >= 2 || counts.rows[0].user_count >= 4) {
          throw new CoreError({ status: 429, code: 'RATE_LIMITED', message: 'Too many active uploads', retryable: true });
        }
        await tx.query(`insert into app.kdrive_uploads(id,reel_id,purpose,requested_by,file_name,mime_type,byte_size,chunk_size,total_chunks,
          kdrive_session_token,kdrive_upload_host,folder_id,state,kdrive_file_id,final_name,start_operation_id,start_payload_hash,error)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,'','',$10,'failed','',$11,$12,$13,$14)`,
          [id, reelId, purpose, actor.id, normalized.fileName, mimeType, byteSize, CHUNK_SIZE, totalChunks, folderId, uploadName, operationId, startHash, JSON.stringify({ reason: 'start_in_progress' })]);
      });
    } catch (error) {
      const concurrent = await deps.db.query<UploadRow>('select * from app.kdrive_uploads where start_operation_id=$1', [operationId]);
      if (concurrent.rows[0]) {
        const row = concurrent.rows[0];
        if (row.start_payload_hash !== startHash || row.requested_by !== actor.id) throw idempotencyConflict();
        if (row.state !== 'failed') return state(row);
        throw new CoreError({ status: 503, code: 'PROVIDER_UNAVAILABLE', message: 'Upload start needs a new operation', retryable: false, details: { reason: 'upload_start_not_replayable' } });
      }
      throw error;
    }
    let session: UploadSession;
    try { session = await provider.start({ folderId, fileName: uploadName, byteSize, totalChunks }); }
    catch (error) {
      const uncertain = !(error instanceof KdriveError) || error.retryable;
      await deps.db.query(`update app.kdrive_uploads set error=$1,updated_at=now() where id=$2 and state='failed'`,
        [JSON.stringify({ reason: uncertain ? 'start_uncertain' : 'start_failed' }), id]);
      throw error;
    }
    const started = await deps.db.query(`update app.kdrive_uploads set kdrive_session_token=$1,kdrive_upload_host=$2,kdrive_file_id=$3,final_name=$4,state='open',error=null,updated_at=now() where id=$5 and state='failed'`,
      [session.token, session.uploadUrl, session.fileId, session.fileName, id]);
    if (started.rowCount !== 1) { await provider.cancel({ token: session.token }).catch(() => undefined); throw internalError('Upload reservation could not be finalized'); }
    return reply.code(201).send({ uploadId: id, reelId, purpose, fileName: normalized.fileName, mimeType, byteSize, chunkSize: CHUNK_SIZE, totalChunks, receivedChunks: [], state: 'open' });
  }));

  app.get('/api/v1/reels/:id/kdrive-uploads', handle(async (request, _reply, actor) => {
    const reelId = uuid((request.params as { id: string }).id, 'id');
    const rows = await deps.db.query<UploadRow>(`select * from app.kdrive_uploads where reel_id=$1 and requested_by=$2 and state='open' order by created_at desc`, [reelId, actor.id]);
    return rows.rows.map(state);
  }));

  app.put('/api/v1/kdrive-uploads/:uploadId/chunks/:index', {
    bodyLimit: CHUNK_SIZE,
    preParsing: async (request, reply, payload) => {
      if (request.headers['content-type'] !== 'application/octet-stream') {
        const error = validationError('Chunk Content-Type must be application/octet-stream', { reason: 'content_type_mismatch' });
        return reply.code(error.status).send(error.toEnvelope()) as never;
      }
      return payload;
    },
  }, handle(async (request, reply, actor) => {
    if (!provider) throw new CoreError({ status: 503, code: 'PROVIDER_UNAVAILABLE', message: 'kDrive integration is not configured', retryable: false, details: { reason: 'kdrive_not_configured' } });
    const { uploadId, index: rawIndex } = request.params as { uploadId: string; index: string }; const row = await load(uuid(uploadId, 'uploadId'), actor);
    const index = Number(rawIndex); if (!Number.isInteger(index) || index < 0 || index >= row.total_chunks) throw validationError('Chunk index is outside this upload', { reason: 'chunk_out_of_range' });
    if (row.state !== 'open') throw validationError('Upload is no longer open', { reason: 'upload_not_open' });
    const expected = index === row.total_chunks - 1 ? Number(row.byte_size) - row.chunk_size * (row.total_chunks - 1) : row.chunk_size;
    const declared = request.headers['content-length'];
    if (declared === undefined || Number(declared) !== expected) throw validationError('Chunk size does not match the expected size', { reason: 'chunk_size_mismatch' });
    const bytes = await bufferBody(request.body, expected); if (bytes.byteLength !== expected) throw validationError('Chunk size does not match the expected size', { reason: 'chunk_size_mismatch' });
    if (index === 0 && !magicMatches(row.mime_type, bytes)) throw validationError('File content does not match the declared type', { reason: 'content_mismatch' });
    const hash = createHash('sha256').update(bytes).digest('hex');
    const savedHashIndex = row.received_chunks.indexOf(index);
    if (savedHashIndex >= 0) {
      if (row.chunk_hashes[savedHashIndex] !== hash) throw validationError('Selected file does not match the saved upload', { reason: 'content_mismatch' });
      return reply.code(204).send();
    }
    if (!row.kdrive_session_token || !row.kdrive_upload_host) throw internalError('Open upload is missing provider session state');
    const session: UploadSession = { token: row.kdrive_session_token, uploadUrl: row.kdrive_upload_host, fileId: row.kdrive_file_id, fileName: row.final_name ?? row.file_name };
    await deps.db.transaction(async (tx) => {
      const locked = await tx.query<UploadRow>('select * from app.kdrive_uploads where id=$1 and requested_by=$2 for update', [row.id, actor.id]);
      const current = locked.rows[0]; if (!current) throw notFound('Upload not found');
      if (current.state !== 'open') throw validationError('Upload is no longer open', { reason: 'upload_not_open' });
      if (current.received_chunks.includes(index)) {
        const seen = current.received_chunks.indexOf(index);
        if (current.chunk_hashes[seen] !== hash) throw validationError('Selected file does not match the saved upload', { reason: 'content_mismatch' });
        return;
      }
      await provider.putChunk(session, index, bytes, hash);
      await tx.query(`update app.kdrive_uploads set received_chunks=array_append(received_chunks,$1),
        chunk_hashes=array_append(chunk_hashes,$2),chunk0_sha256=case when $1=0 then $2 else chunk0_sha256 end,updated_at=now()
        where id=$3 and state='open'`, [index, hash, row.id]);
    });
    return reply.code(204).send();
  }));

  app.post('/api/v1/kdrive-uploads/:uploadId/finish', handle(async (request, reply, actor) => {
    if (!provider) throw new CoreError({ status: 503, code: 'PROVIDER_UNAVAILABLE', message: 'kDrive integration is not configured', retryable: false });
    const uploadId = uuid((request.params as { uploadId: string }).uploadId, 'uploadId');
    const result = await deps.db.transaction(async (tx) => {
      const locked = await tx.query<UploadRow>('select * from app.kdrive_uploads where id=$1 and requested_by=$2 for update', [uploadId, actor.id]);
      const row = locked.rows[0]; if (!row) throw notFound('Upload not found');
      if (row.state === 'finished' || row.state === 'attached') return state(row);
      if (row.state !== 'open') throw validationError('Upload is no longer open', { reason: 'upload_not_open' });
      if (row.received_chunks.length !== row.total_chunks || row.chunk_hashes.length !== row.total_chunks
          || new Set(row.received_chunks).size !== row.total_chunks || row.received_chunks.some((n) => n < 0 || n >= row.total_chunks)) throw validationError('Upload has missing chunks', { reason: 'upload_incomplete' });
      if (!row.kdrive_session_token || !row.kdrive_upload_host) throw internalError('Open upload is missing provider session state');
      const session = { token: row.kdrive_session_token, uploadUrl: row.kdrive_upload_host, fileId: row.kdrive_file_id, fileName: row.final_name ?? row.file_name };
      const orderedHashes = Array.from({ length: row.total_chunks }, (_, index) => row.chunk_hashes[row.received_chunks.indexOf(index)]);
      let file;
      try { file = await provider.finish(session, orderedHashes); }
      catch (error) {
        if (!(error instanceof KdriveError) || (!error.retryable && error.providerCode !== 'invalid_upload_token_error')) throw error;
        // Finish is not replay-safe at kDrive. Reconcile once by the file id returned at start.
        file = await provider.getFile(row.kdrive_file_id);
        if (file.status !== 'ok' || file.size !== Number(row.byte_size)) throw error;
      }
      await tx.query(`update app.kdrive_uploads set state='finished',final_name=$1,kdrive_file_id=$2,
        kdrive_session_token=null,kdrive_upload_host=null,updated_at=now() where id=$3 and state='open'`, [file.name, file.id, row.id]);
      return state({ ...row, state: 'finished', final_name: file.name, kdrive_file_id: file.id });
    });
    return reply.code(200).send(result);
  }));

  app.post('/api/v1/kdrive-uploads/:uploadId/attach', handle(async (request, _reply, actor) => {
    const uploadId = uuid((request.params as { uploadId: string }).uploadId, 'uploadId'); const row = await load(uploadId, actor);
    const body = (request.body ?? {}) as Record<string, unknown>; const operationId = uuid(body.operationId, 'operationId');
    if (!Number.isInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) throw validationError('expectedVersion must be a positive integer');
    if (row.state !== 'finished' && row.state !== 'attached') throw validationError('Finish the upload before attaching it', { reason: 'upload_not_open' });
    return repo.attachKdriveFile(actor, row.reel_id, { operationId, expectedVersion: Number(body.expectedVersion), uploadId, purpose: row.purpose,
      driveId: config!.driveId, fileId: row.kdrive_file_id, name: row.final_name ?? row.file_name, byteSize: Number(row.byte_size),
      url: `https://ksuite.infomaniak.com/kdrive/app/drive/${encodeURIComponent(config!.driveId)}/files/${encodeURIComponent(row.folder_id)}` });
  }));

  app.delete('/api/v1/kdrive-uploads/:uploadId', handle(async (request, reply, actor) => {
    const row = await load(uuid((request.params as { uploadId: string }).uploadId, 'uploadId'), actor);
    if (row.state === 'cancelled' || row.state === 'expired') return reply.code(204).send();
    if (row.state !== 'open') throw validationError('A finished kDrive file cannot be deleted', { reason: 'upload_not_open' });
    if (!provider) throw new CoreError({ status: 503, code: 'PROVIDER_UNAVAILABLE', message: 'kDrive integration is not configured', retryable: false });
    if (!row.kdrive_session_token) throw internalError('Open upload is missing provider session state');
    await provider.cancel({ token: row.kdrive_session_token });
    await deps.db.query(`update app.kdrive_uploads set state='cancelled',kdrive_session_token=null,kdrive_upload_host=null,updated_at=now() where id=$1 and state='open'`, [row.id]);
    return reply.code(204).send();
  }));

  // Expire stale sessions without ever deleting a finished provider file.
  if (provider) {
    const timer = setInterval(() => { void (async () => {
      const expired = await deps.db.query<UploadRow>(`select * from app.kdrive_uploads where state='open' and updated_at < now()-interval '24 hours' limit 100`);
      for (const row of expired.rows) {
        if (!row.kdrive_session_token) continue;
        try { await provider.cancel({ token: row.kdrive_session_token }); } catch { continue; }
        await deps.db.query(`update app.kdrive_uploads set state='expired',kdrive_session_token=null,kdrive_upload_host=null,updated_at=now() where id=$1 and state='open'`, [row.id]);
      }
    })().catch(() => undefined); }, 5 * 60_000);
    timer.unref();
  }
}

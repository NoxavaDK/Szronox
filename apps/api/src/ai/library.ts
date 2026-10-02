import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database, Queryable } from '../db/client.js';
import { pgErrorCode, PG_UNIQUE_VIOLATION } from '../db/client.js';
import { CoreRepository, payloadHash, type Actor } from '../core/repository.js';
import { CoreError, editConflict, idempotencyConflict, internalError, notFound, validationError } from '../core/errors.js';
import type { CoreDependencies } from '../core/routes.js';
import { httpKdriveClient } from '../kdrive/client.js';
import { createMemeCopyService, type MemeCopyService } from '../kdrive/meme-copy.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) throw validationError('Expected UUID'); return value; }
function version(value: unknown): number { if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw validationError('Expected positive version'); return value; }
function memeResponse(row: { id: string; name: string; media_kind?: 'image' | 'video'; mime_type?: string | null; poster_ref?: string | null; kdrive_copy_state?: string; kdrive_file?: { name?: string } | null }) {
  const state = row.kdrive_copy_state ?? 'pending';
  const mediaKind = row.media_kind ?? 'image';
  return { id: row.id, name: row.name, mediaKind, mimeType: row.mime_type ?? null,
    thumbnailRef: mediaKind === 'video' && !row.poster_ref ? null : `/api/v1/memes/${row.id}/thumbnail`, assetRef: `/api/v1/memes/${row.id}/media`,
    kdriveCopy: { state, ...(state === 'copied' && row.kdrive_file?.name ? { name: row.kdrive_file.name } : {}) } };
}

function rangeFor(value: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (value === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return 'invalid';
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

async function* byteRange(stream: Readable, start: number, length: number): AsyncGenerator<Buffer> {
  let skipped = 0, sent = 0;
  for await (const item of stream) {
    const chunk = Buffer.from(item);
    const skip = Math.min(chunk.length, Math.max(0, start - skipped));
    skipped += skip;
    if (skip === chunk.length) continue;
    const remaining = length - sent;
    if (remaining <= 0) break;
    const part = chunk.subarray(skip, skip + remaining);
    sent += part.length;
    if (part.length) yield part;
    if (sent >= length) break;
  }
}

async function idempotent<T>(db: Database, actor: Actor, operationId: string, route: string, payload: unknown, mutate: (tx: Queryable) => Promise<T>, onFresh?: (result: T) => void): Promise<T> {
  const replay = async (tx: Queryable): Promise<T | null> => {
    const rows = await tx.query<{ actor_id: string; route: string; payload_hash: string; result: T }>('select actor_id,route,payload_hash,result from app.operations where operation_id=$1', [operationId]);
    if (!rows.rows[0]) return null;
    if (rows.rows[0].actor_id !== actor.id || rows.rows[0].route !== route || rows.rows[0].payload_hash !== payloadHash(payload)) throw idempotencyConflict();
    return rows.rows[0].result;
  };
  let fresh = false;
  try {
    const result = await db.transaction(async (tx) => {
      const prior = await replay(tx);
      if (prior !== null) return prior;
      const result = await mutate(tx);
      await tx.query('insert into app.operations(operation_id,actor_id,route,payload_hash,result) values($1,$2,$3,$4,$5)',
        [operationId, actor.id, route, payloadHash(payload), JSON.stringify(result)]);
      fresh = true;
      return result;
    });
    if (fresh) onFresh?.(result);
    return result;
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
      const prior = await replay(db);
      if (prior !== null) return prior;
    }
    throw error;
  }
}

export function registerLibraryRoutes(app: FastifyInstance, deps: CoreDependencies, copyService?: Pick<MemeCopyService, 'enqueue' | 'retry' | 'startRetryLoop'>): void {
  const core = new CoreRepository(deps.db);
  const memeCopies = copyService ?? createMemeCopyService({ db: deps.db, storage: deps.storage, config: deps.kdrive ?? null,
    folders: deps.kdrive ? httpKdriveClient({ driveId: deps.kdrive.driveId, token: deps.kdrive.token }) : null });
  memeCopies.startRetryLoop();
  const handle = (body: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try { return await body(request, reply); }
      catch (error) {
        if (error instanceof CoreError) return reply.code(error.status).send(error.toEnvelope());
        request.log.error(error);
        return reply.code(500).send(internalError().toEnvelope());
      }
    };

  app.get('/api/v1/memes', handle(async (request) => {
    await deps.authenticate(request);
    const query = String((request.query as { q?: string })?.q ?? '').trim().slice(0, 100);
    const rows = await deps.db.query<{ id: string; name: string; media_kind: 'image' | 'video'; mime_type: string | null; poster_ref: string | null; kdrive_copy_state: string; kdrive_file: { name?: string; fileId?: string; driveId?: string } | null }>(
      `select id,name,media_kind,mime_type,poster_ref,kdrive_copy_state,kdrive_file from app.memes where $1='' or position(lower($1) in lower(name))>0
       order by name,id limit 40`, [query]);
    return { items: rows.rows.map(memeResponse) };
  }));

  async function serveMemeAsset(request: FastifyRequest, reply: FastifyReply, mode: 'media' | 'thumbnail' | 'image') {
    await deps.authenticate(request);
    const id = uuid((request.params as { id: string }).id);
    const rows = await deps.db.query<{ asset_ref: string; poster_ref: string | null; media_kind: 'image' | 'video'; mime_type: string | null }>(
      'select asset_ref,poster_ref,media_kind,mime_type from app.memes where id=$1', [id]);
    const row = rows.rows[0];
    if (!row || !deps.storage.openObject) throw notFound('Meme media unavailable');
    if (mode === 'image' && row.media_kind !== 'image') throw notFound('Meme image unavailable');
    const key = mode === 'thumbnail' && row.media_kind === 'video' ? row.poster_ref : row.asset_ref;
    if (!key) throw notFound('Meme thumbnail unavailable');
    const opened = await deps.storage.openObject(key);
    const mime = mode === 'thumbnail' && row.media_kind === 'video' ? opened.object.mimeType : (row.mime_type ?? opened.object.mimeType);
    if (mode !== 'media') {
      return reply.headers({ 'content-type': mime, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }).send(opened.stream);
    }
    const requestedRange = rangeFor(request.headers.range, opened.object.byteSize);
    reply.headers({ 'accept-ranges': 'bytes', 'cache-control': 'private, no-store', 'content-type': mime, 'x-content-type-options': 'nosniff' });
    if (requestedRange === 'invalid') {
      opened.stream.destroy();
      return reply.code(416).header('content-range', `bytes */${opened.object.byteSize}`).send();
    }
    if (!requestedRange) {
      return reply.header('content-length', String(opened.object.byteSize)).send(opened.stream);
    }
    const length = requestedRange.end - requestedRange.start + 1;
    return reply.code(206).headers({ 'content-range': `bytes ${requestedRange.start}-${requestedRange.end}/${opened.object.byteSize}`, 'content-length': String(length) })
      .send(Readable.from(byteRange(opened.stream, requestedRange.start, length)));
  }

  app.get('/api/v1/memes/:id/media', handle((request, reply) => serveMemeAsset(request, reply, 'media')));
  app.get('/api/v1/memes/:id/thumbnail', handle((request, reply) => serveMemeAsset(request, reply, 'thumbnail')));
  app.get('/api/v1/memes/:id/image', handle((request, reply) => serveMemeAsset(request, reply, 'image')));

  app.post('/api/v1/memes', handle(async (request, reply) => {
    const actor = await deps.authenticate(request);
    const data = (request.body ?? {}) as Record<string, unknown>;
    const operationId = uuid(data.operationId);
    const hasImage = typeof data.imageAssetId === 'string';
    const hasVideo = typeof data.videoAssetId === 'string';
    if (hasImage === hasVideo || (data.posterAssetId !== undefined && !hasVideo)) throw validationError('Choose exactly one image or video asset', { reason: 'invalid_media_choice' });
    const mediaKind = hasVideo ? 'video' : 'image';
    const assetId = uuid(hasVideo ? data.videoAssetId : data.imageAssetId);
    const posterId = data.posterAssetId === undefined ? null : uuid(data.posterAssetId);
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name || name.length > 120) throw validationError('Meme name required');
    const attach = data.attachToReel as { reelId?: unknown; expectedVersion?: unknown } | undefined;
    const reelId = attach ? uuid(attach.reelId) : null;
    const expectedVersion = attach ? version(attach.expectedVersion) : null;
    const result = await idempotent(deps.db, actor, operationId, 'POST /memes', data, async (tx) => {
      if (reelId) {
        const locked = await tx.query<{ version: number }>('select version from app.reels where id=$1 and deleted_at is null for update', [reelId]);
        if (!locked.rows[0]) throw notFound('Reel not found');
        if (locked.rows[0].version !== expectedVersion) throw editConflict(locked.rows[0].version);
      }
      if (!reelId) throw validationError('Meme creation requires a Reel context');
      const assets = await tx.query<{ reel_id: string; storage_key: string; validated_mime_type: string | null; purpose: string }>(
        `select reel_id,storage_key,validated_mime_type,purpose from app.attachments
          where id=$1 and state='ready' and kind=$2 and validated_at is not null`, [assetId, mediaKind]);
      const asset = assets.rows[0];
      if (!asset || asset.reel_id !== reelId || asset.purpose !== 'meme' || !asset.storage_key || !asset.validated_mime_type) throw validationError('Meme asset is not a validated asset of this Reel');
      let posterRef: string | null = null;
      if (posterId) {
        const posters = await tx.query<{ reel_id: string; purpose: string; storage_key: string | null; validated_mime_type: string | null }>(
          `select reel_id,purpose,storage_key,validated_mime_type from app.attachments
            where id=$1 and state='ready' and kind='image' and validated_at is not null`, [posterId]);
        const poster = posters.rows[0];
        if (!poster || poster.reel_id !== reelId || poster.purpose !== 'meme' || !poster.storage_key || !poster.validated_mime_type) throw validationError('Poster is not a validated image of this Reel');
        posterRef = poster.storage_key;
      }
      const id = randomUUID();
      await tx.query(`insert into app.memes(id,name,asset_ref,thumbnail_ref,media_kind,mime_type,poster_ref)
        values($1,$2,$3,$4,$5,$6,$7)`, [id, name, asset.storage_key, mediaKind === 'image' ? asset.storage_key : posterRef,
        mediaKind, asset.validated_mime_type, posterRef]);
      if (reelId) {
        await tx.query(`insert into app.reel_memes(reel_id,meme_id,position)
          select $1,$2,coalesce(max(position)+1,0) from app.reel_memes where reel_id=$1`, [reelId, id]);
        await tx.query('update app.reels set version=version+1,updated_at=now() where id=$1', [reelId]);
      }
      return { meme: memeResponse({ id, name, media_kind: mediaKind, mime_type: asset.validated_mime_type, poster_ref: posterRef }), reel: reelId ? await core.loadReel(tx, reelId) : null };
    }, (created) => { void memeCopies.enqueue(created.meme.id).catch(() => undefined); });
    if (!deps.kdrive) result.meme.kdriveCopy = { state: 'not_configured' };
    return reply.code(201).send(result);
  }));

  app.post('/api/v1/memes/:id/kdrive-copy/retry', handle(async (request) => {
    const actor = await deps.authenticate(request);
    const memeId = uuid((request.params as { id: string }).id);
    if (!deps.kdrive) throw new CoreError({ status: 503, code: 'PROVIDER_UNAVAILABLE', message: 'kDrive integration is not configured', retryable: false, details: { reason: 'kdrive_not_configured' } });
    const data = (request.body ?? {}) as Record<string, unknown>;
    const operationId = uuid(data.operationId);
    let shouldRetry = false;
    await idempotent(deps.db, actor, operationId, 'POST /memes/:id/kdrive-copy/retry', { memeId }, async (tx) => {
      const current = await tx.query<{ kdrive_copy_state: string }>('select kdrive_copy_state from app.memes where id=$1 for update', [memeId]);
      if (!current.rows[0]) throw notFound('Meme not found');
      if (current.rows[0].kdrive_copy_state !== 'failed') {
        throw validationError('Only a failed kDrive copy can be retried', { reason: 'meme_copy_not_failed' });
      }
      const reset = await tx.query(`update app.memes set kdrive_copy_state='pending',kdrive_copy_attempts=0,kdrive_copy_error=null
        where id=$1 and kdrive_copy_state='failed' returning id`, [memeId]);
      if (!reset.rows[0]) throw validationError('Only a failed kDrive copy can be retried', { reason: 'meme_copy_not_failed' });
      return { memeId };
    }, () => { shouldRetry = true; });
    if (shouldRetry) await memeCopies.retry(memeId);
    const current = await deps.db.query<{ id: string; name: string; media_kind: 'image' | 'video'; mime_type: string | null; poster_ref: string | null; kdrive_copy_state: string; kdrive_file: { name?: string } | null }>(
      'select id,name,media_kind,mime_type,poster_ref,kdrive_copy_state,kdrive_file from app.memes where id=$1', [memeId]);
    if (!current.rows[0]) throw notFound('Meme not found');
    return memeResponse(current.rows[0]);
  }));

  app.post('/api/v1/reels/:id/memes', handle(async (request, reply) => {
    const actor = await deps.authenticate(request);
    const reelId = uuid((request.params as { id: string }).id);
    const data = (request.body ?? {}) as Record<string, unknown>;
    const operationId = uuid(data.operationId), memeId = uuid(data.memeId), expected = version(data.expectedVersion);
    const reel = await idempotent(deps.db, actor, operationId, 'POST /reels/:id/memes', { reelId, ...data }, async (tx) => {
      const locked = await tx.query<{ version: number }>('select version from app.reels where id=$1 and deleted_at is null for update', [reelId]);
      if (!locked.rows[0]) throw notFound('Reel not found');
      if (locked.rows[0].version !== expected) throw editConflict(locked.rows[0].version);
      if (!(await tx.query('select id from app.memes where id=$1', [memeId])).rows[0]) throw validationError('Unknown meme');
      if ((await tx.query('select 1 from app.reel_memes where reel_id=$1 and meme_id=$2', [reelId, memeId])).rows[0]) {
        return core.loadReel(tx, reelId);
      }
      await tx.query(`insert into app.reel_memes(reel_id,meme_id,position)
        select $1,$2,coalesce(max(position)+1,0) from app.reel_memes where reel_id=$1`, [reelId, memeId]);
      await tx.query('update app.reels set version=version+1,updated_at=now() where id=$1', [reelId]);
      return core.loadReel(tx, reelId);
    });
    return reply.code(201).send(reel);
  }));

  app.delete('/api/v1/reels/:id/memes/:memeId', handle(async (request) => {
    const actor = await deps.authenticate(request);
    const { id, memeId } = request.params as { id: string; memeId: string };
    const reelId = uuid(id), libraryId = uuid(memeId);
    const data = (request.body ?? {}) as Record<string, unknown>;
    const operationId = uuid(data.operationId), expected = version(data.expectedVersion);
    return idempotent(deps.db, actor, operationId, 'DELETE /reels/:id/memes/:memeId', { reelId, libraryId, ...data }, async (tx) => {
      const locked = await tx.query<{ version: number }>('select version from app.reels where id=$1 and deleted_at is null for update', [reelId]);
      if (!locked.rows[0]) throw notFound('Reel not found');
      if (locked.rows[0].version !== expected) throw editConflict(locked.rows[0].version);
      await tx.query('delete from app.reel_memes where reel_id=$1 and meme_id=$2', [reelId, libraryId]);
      await tx.query('update app.reels set version=version+1,updated_at=now() where id=$1', [reelId]);
      return core.loadReel(tx, reelId);
    });
  }));

  app.delete('/api/v1/reels/:id/programme-association', handle(async (request) => {
    const actor = await deps.authenticate(request);
    const reelId = uuid((request.params as { id: string }).id);
    const data = (request.body ?? {}) as Record<string, unknown>;
    const operationId = uuid(data.operationId), expected = version(data.expectedVersion);
    return idempotent(deps.db, actor, operationId, 'DELETE /reels/:id/programme-association', { reelId, ...data }, async (tx) => {
      const locked = await tx.query<{ version: number }>('select version from app.reels where id=$1 and deleted_at is null for update', [reelId]);
      if (!locked.rows[0]) throw notFound('Reel not found');
      if (locked.rows[0].version !== expected) throw editConflict(locked.rows[0].version);
      await tx.query(`update app.reels set programme_state='unchecked',programme_attachment=null,
        programme_input_hash=null,programme_document_version_id=null,version=version+1,updated_at=now() where id=$1`, [reelId]);
      return core.loadReel(tx, reelId);
    });
  }));
}

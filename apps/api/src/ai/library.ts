import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database, Queryable } from '../db/client.js';
import { pgErrorCode, PG_UNIQUE_VIOLATION } from '../db/client.js';
import { CoreRepository, payloadHash, type Actor } from '../core/repository.js';
import { CoreError, editConflict, idempotencyConflict, internalError, notFound, validationError } from '../core/errors.js';
import type { CoreDependencies } from '../core/routes.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) throw validationError('Expected UUID'); return value; }
function version(value: unknown): number { if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw validationError('Expected positive version'); return value; }
function memeResponse(row: { id: string; name: string }) { return { id: row.id, name: row.name, thumbnailRef: `/api/v1/memes/${row.id}/image`, assetRef: `/api/v1/memes/${row.id}/image` }; }

async function idempotent<T>(db: Database, actor: Actor, operationId: string, route: string, payload: unknown, mutate: (tx: Queryable) => Promise<T>): Promise<T> {
  const replay = async (tx: Queryable): Promise<T | null> => {
    const rows = await tx.query<{ actor_id: string; route: string; payload_hash: string; result: T }>('select actor_id,route,payload_hash,result from app.operations where operation_id=$1', [operationId]);
    if (!rows.rows[0]) return null;
    if (rows.rows[0].actor_id !== actor.id || rows.rows[0].route !== route || rows.rows[0].payload_hash !== payloadHash(payload)) throw idempotencyConflict();
    return rows.rows[0].result;
  };
  try {
    return await db.transaction(async (tx) => {
      const prior = await replay(tx);
      if (prior !== null) return prior;
      const result = await mutate(tx);
      await tx.query('insert into app.operations(operation_id,actor_id,route,payload_hash,result) values($1,$2,$3,$4,$5)',
        [operationId, actor.id, route, payloadHash(payload), JSON.stringify(result)]);
      return result;
    });
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
      const prior = await replay(db);
      if (prior !== null) return prior;
    }
    throw error;
  }
}

export function registerLibraryRoutes(app: FastifyInstance, deps: CoreDependencies): void {
  const core = new CoreRepository(deps.db);
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
    const rows = await deps.db.query<{ id: string; name: string }>(
      `select id,name from app.memes where $1='' or position(lower($1) in lower(name))>0
       order by name,id limit 40`, [query]);
    return { items: rows.rows.map(memeResponse) };
  }));

  app.get('/api/v1/memes/:id/image', handle(async (request, reply) => {
    await deps.authenticate(request);
    const id = uuid((request.params as { id: string }).id);
    const rows = await deps.db.query<{ asset_ref: string }>('select asset_ref from app.memes where id=$1', [id]);
    if (!rows.rows[0] || !deps.storage.openObject) throw notFound('Meme image unavailable');
    const opened = await deps.storage.openObject(rows.rows[0].asset_ref);
    return reply.header('content-type', opened.object.mimeType).header('cache-control', 'private, max-age=300').send(opened.stream);
  }));

  app.post('/api/v1/memes', handle(async (request, reply) => {
    const actor = await deps.authenticate(request);
    const data = (request.body ?? {}) as Record<string, unknown>;
    const operationId = uuid(data.operationId);
    const imageAssetId = uuid(data.imageAssetId);
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
      const assets = await tx.query<{ reel_id: string; storage_key: string; validated_mime_type: string | null }>(
        `select reel_id,storage_key,validated_mime_type from app.attachments
          where id=$1 and state='ready' and kind='image' and validated_at is not null`, [imageAssetId]);
      const asset = assets.rows[0];
      if (!asset || asset.reel_id !== reelId || !asset.storage_key || !asset.validated_mime_type) throw validationError('Image asset is not a validated image of this Reel');
      const id = randomUUID();
      await tx.query('insert into app.memes(id,name,asset_ref,thumbnail_ref) values($1,$2,$3,$3)', [id, name, asset.storage_key]);
      if (reelId) {
        await tx.query(`insert into app.reel_memes(reel_id,meme_id,position)
          select $1,$2,coalesce(max(position)+1,0) from app.reel_memes where reel_id=$1`, [reelId, id]);
        await tx.query('update app.reels set version=version+1,updated_at=now() where id=$1', [reelId]);
      }
      return { meme: memeResponse({ id, name }), reel: reelId ? await core.loadReel(tx, reelId) : null };
    });
    return reply.code(201).send(result);
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

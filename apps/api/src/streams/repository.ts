/**
 * STREAM-01 topic persistence.
 *
 * A stream is a Reel (`format = 'stream'`); its topics live in `app.stream_topics`, ordered by
 * `position`. Every mutation here is version-checked against the STREAM's own `app.reels` row
 * and idempotent on `operationId` — exactly the hook/export/kdrive-folder pattern already in
 * `CoreRepository`, which this module reuses rather than re-implementing: `idempotent` and
 * `bumpVersion` are the same ledger and the same guarded UPDATE, and `loadReel` (via
 * `CoreRepository.assemble`) is what turns the stream's row plus the topic table back into the
 * authoritative `Reel` every route here returns.
 */

import { randomUUID } from 'node:crypto';

import type {
  AddStreamTopicRequest,
  PublicationSlot,
  Reel,
  ReelStatus,
  RemoveStreamTopicRequest,
  StreamTopicCandidatesResponse,
  StreamTopicOrderRequest,
  StreamTopicPatchRequest,
} from '@szronox/contracts';

import { type Actor, CoreRepository } from '../core/repository.js';
import { notFound, validationError } from '../core/errors.js';
import type { StreamTopicRow } from '../core/mapping.js';
import type { Database, Queryable } from '../db/client.js';
import { initialSourceMetadata } from '../source/metadata.js';

/** Every `reason` STREAM-01 names for a topic-mutation refusal. */
export type StreamTopicRefusalReason =
  | 'not_a_stream'
  | 'source_is_stream'
  | 'already_in_stream'
  | 'absorbed_elsewhere'
  | 'linked_elsewhere'
  | 'absorb_requires_idea'
  | 'source_deleted'
  | 'topic_not_absorbed'
  | 'topic_set_mismatch';

function refusal(reason: StreamTopicRefusalReason, message: string) {
  return validationError(message, { reason });
}

interface StreamLockRow { id: string; format: 'reel' | 'stream' }

interface SourceLockRow {
  id: string;
  format: 'reel' | 'stream';
  status: ReelStatus;
  absorbed_into: string | null;
  deleted_at: Date | string | null;
  title: string;
  input_note: string;
  script: string;
}

const LINK = /^https?:\/\//i;

export class StreamsRepository {
  constructor(private readonly db: Database, private readonly core: CoreRepository) {}

  // ── Shared helpers ───────────────────────────────────────────────────────────

  private assertIsStream(row: StreamLockRow): void {
    if (row.format !== 'stream') throw refusal('not_a_stream', 'Reel is not a stream');
  }

  private async lockTopic(tx: Queryable, streamId: string, topicId: string): Promise<StreamTopicRow> {
    const rows = await tx.query<StreamTopicRow>(
      `select id, stream_id, position, kind, source_reel_id, title, notes, script, created_at, updated_at
       from app.stream_topics where id = $1 and stream_id = $2 for update`,
      [topicId, streamId],
    );
    const row = rows.rows[0];
    if (!row) throw notFound('Topic not found');
    return row;
  }

  private async nextPosition(tx: Queryable, streamId: string): Promise<number> {
    const result = await tx.query<{ max: number | null }>(
      'select max(position) as max from app.stream_topics where stream_id = $1', [streamId],
    );
    return (result.rows[0]?.max ?? -1) + 1;
  }

  /** Close the gap left by a removed topic so `position` stays a dense 0-based order. */
  private async renumberAfterRemoval(tx: Queryable, streamId: string, removedPosition: number): Promise<void> {
    await tx.query('set constraints app.stream_topics_position_unique deferred');
    await tx.query(
      'update app.stream_topics set position = position - 1 where stream_id = $1 and position > $2',
      [streamId, removedPosition],
    );
  }

  /** `link` is validated exactly like SOURCE-02's `sourceLink`: a full http(s) URL, ≤ 2048 chars. */
  private normalizeLink(link: unknown): string | null {
    if (link === undefined || link === null) return null;
    if (typeof link !== 'string') throw validationError('link must be a string', { field: 'link' });
    const trimmed = link.trim();
    if (trimmed === '') return null;
    if (trimmed.length > 2048 || !LINK.test(trimmed)) {
      throw validationError('link must be a valid HTTP(S) URL of at most 2048 characters', { field: 'link' });
    }
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
    } catch {
      throw validationError('link must be a valid HTTP(S) URL of at most 2048 characters', { field: 'link' });
    }
    return trimmed;
  }

  private validatePublicationSource(value: unknown): string | null {
    if (value !== null && (typeof value !== 'string' || value.length > 1000)) {
      throw validationError('publicationSource must be a string of at most 1000 characters or null', { field: 'publicationSource' });
    }
    return value as string | null;
  }

  // ── POST /reels/:id/topics ───────────────────────────────────────────────────

  async addTopic(actor: Actor, streamId: string, request: AddStreamTopicRequest): Promise<Reel> {
    return this.core.idempotent(
      actor, request.operationId, `POST /reels/${streamId}/topics`, { streamId, ...request },
      async (tx) => {
        const stream = await this.core.bumpVersion(tx, streamId, request.expectedVersion);
        this.assertIsStream(stream);

        if (request.mode === 'new') return this.insertNewTopic(tx, actor, streamId, request);

        const { reelId } = request;
        if (reelId === streamId) throw refusal('source_is_stream', 'A stream cannot be a topic');
        const source = await this.lockSource(tx, reelId);
        if (source.format === 'stream') throw refusal('source_is_stream', 'A stream cannot be a topic');
        if (source.deleted_at !== null) throw refusal('source_deleted', 'Source Reel is deleted');

        const inThisStream = await tx.query(
          'select 1 from app.stream_topics where stream_id = $1 and source_reel_id = $2', [streamId, reelId],
        );
        if (inThisStream.rows[0]) throw refusal('already_in_stream', 'Reel is already a topic of this stream');
        if (source.absorbed_into !== null) throw refusal('absorbed_elsewhere', 'Reel is already absorbed into another stream');
        const linkedElsewhere = await tx.query(
          "select 1 from app.stream_topics where kind = 'linked' and source_reel_id = $1 limit 1", [reelId],
        );
        if (linkedElsewhere.rows[0]) throw refusal('linked_elsewhere', 'Reel is already linked in a stream');
        if (request.mode === 'absorb' && source.status !== 'idea') {
          throw refusal('absorb_requires_idea', 'Only an idea can be absorbed');
        }

        const position = await this.nextPosition(tx, streamId);
        if (request.mode === 'absorb') {
          await tx.query(
            `insert into app.stream_topics (id, stream_id, position, kind, source_reel_id, title, notes, script)
             values ($1, $2, $3, 'absorbed', $4, $5, $6, $7)`,
            [randomUUID(), streamId, position, reelId, source.title, source.input_note, source.script],
          );
          await tx.query('update app.reels set absorbed_into = $1 where id = $2', [streamId, reelId]);
        } else {
          await tx.query(
            `insert into app.stream_topics (id, stream_id, position, kind, source_reel_id)
             values ($1, $2, $3, 'linked', $4)`,
            [randomUUID(), streamId, position, reelId],
          );
        }
        return this.core.loadReel(tx, streamId);
      },
    );
  }

  private async lockSource(tx: Queryable, reelId: string): Promise<SourceLockRow> {
    const rows = await tx.query<SourceLockRow>(
      `select id, format, status, absorbed_into, deleted_at, title, input_note, script
       from app.reels where id = $1 for update`,
      [reelId],
    );
    const row = rows.rows[0];
    if (!row) throw notFound('Reel not found');
    return row;
  }

  /**
   * `+ Nowy temat`: one write creates a hidden absorbed idea plus its topic, at the end. This is
   * the only exception to the ordinary "text, URL or image required" capture rule.
   */
  private async insertNewTopic(
    tx: Queryable, actor: Actor, streamId: string,
    request: AddStreamTopicRequest & { mode: 'new' },
  ): Promise<Reel> {
    const title = typeof request.title === 'string' ? request.title.trim() : '';
    if (title === '') throw validationError('A new topic requires a non-empty title', { field: 'title' });
    const link = this.normalizeLink(request.link);
    const note = typeof request.note === 'string' ? request.note : '';
    const captureInput = link ? { url: link, images: [] as never[] } : { images: [] as never[] };
    const position = await this.nextPosition(tx, streamId);

    await tx.query(
      `insert into app.reels
         (id, format, status, absorbed_into, title, original_input, input_note, script, script_revision, priority, created_by, source_metadata)
       values ($1, 'reel', 'idea', $2, $3, $4, $5, '', 0, 'normal', $6, $7)`,
      [
        request.reelId, streamId, title, JSON.stringify(captureInput), note, actor.id,
        JSON.stringify(initialSourceMetadata(captureInput)),
      ],
    );
    await tx.query(
      `insert into app.stream_topics (id, stream_id, position, kind, source_reel_id, title, notes, script)
       values ($1, $2, $3, 'absorbed', $4, $5, $6, '')`,
      [request.topicId, streamId, position, request.reelId, title, note],
    );
    return this.core.loadReel(tx, streamId);
  }

  // ── PATCH /reels/:id/topics/:topicId ─────────────────────────────────────────

  async patchTopic(actor: Actor, streamId: string, topicId: string, request: StreamTopicPatchRequest): Promise<Reel> {
    return this.core.idempotent(
      actor, request.operationId, `PATCH /reels/${streamId}/topics/${topicId}`, { streamId, topicId, ...request },
      async (tx) => {
        const stream = await this.core.bumpVersion(tx, streamId, request.expectedVersion);
        this.assertIsStream(stream);
        const topic = await this.lockTopic(tx, streamId, topicId);
        if (topic.kind !== 'absorbed') throw refusal('topic_not_absorbed', 'Only an absorbed topic can be edited');

        const changes = (request.changes ?? {}) as Record<string, unknown>;
        const hasChange = ['title', 'notes', 'script', 'publicationSource'].some((field) => Object.hasOwn(changes, field));
        if (!hasChange) throw validationError('Patch contains no changes');

        const sets: string[] = [];
        const params: unknown[] = [];
        for (const field of ['title', 'notes', 'script'] as const) {
          if (!Object.hasOwn(changes, field)) continue;
          if (typeof changes[field] !== 'string') throw validationError(`${field} must be a string`, { field });
          params.push(changes[field]);
          sets.push(`${field} = $${params.length}`);
        }
        if (sets.length > 0) {
          params.push(topicId);
          await tx.query(`update app.stream_topics set ${sets.join(', ')}, updated_at = now() where id = $${params.length}`, params);
        }
        if (Object.hasOwn(changes, 'publicationSource')) {
          const value = this.validatePublicationSource(changes.publicationSource);
          await tx.query('update app.reels set publication_source = $1 where id = $2', [value, topic.source_reel_id]);
        }
        return this.core.loadReel(tx, streamId);
      },
    );
  }

  // ── DELETE /reels/:id/topics/:topicId ────────────────────────────────────────

  async removeTopic(actor: Actor, streamId: string, topicId: string, request: RemoveStreamTopicRequest): Promise<Reel> {
    return this.core.idempotent(
      actor, request.operationId, `DELETE /reels/${streamId}/topics/${topicId}`, { streamId, topicId, ...request },
      async (tx) => {
        const stream = await this.core.bumpVersion(tx, streamId, request.expectedVersion);
        this.assertIsStream(stream);
        const topic = await this.lockTopic(tx, streamId, topicId);

        if (topic.kind === 'absorbed') {
          // Odłącz: write the editable copy back to the idea, un-hide it, and bump ITS version.
          // scriptRevision only advances when the script text actually changed.
          const idea = await tx.query<{ script: string }>(
            'select script from app.reels where id = $1 for update', [topic.source_reel_id],
          );
          const scriptChanged = idea.rows[0] !== undefined && idea.rows[0].script !== topic.script;
          await tx.query(
            `update app.reels
             set title = $1, input_note = $2, script = $3, absorbed_into = null,
                 version = version + 1, updated_at = now()
                 ${scriptChanged ? ', script_revision = script_revision + 1' : ''}
             where id = $4`,
            [topic.title, topic.notes, topic.script, topic.source_reel_id],
          );
        }

        await tx.query('delete from app.stream_topics where id = $1', [topicId]);
        await this.renumberAfterRemoval(tx, streamId, topic.position);
        return this.core.loadReel(tx, streamId);
      },
    );
  }

  // ── PUT /reels/:id/topic-order ────────────────────────────────────────────────

  async reorderTopics(actor: Actor, streamId: string, request: StreamTopicOrderRequest): Promise<Reel> {
    return this.core.idempotent(
      actor, request.operationId, `PUT /reels/${streamId}/topic-order`, { streamId, ...request },
      async (tx) => {
        const stream = await this.core.bumpVersion(tx, streamId, request.expectedVersion);
        this.assertIsStream(stream);

        const existing = await tx.query<{ id: string }>(
          'select id from app.stream_topics where stream_id = $1', [streamId],
        );
        const currentIds = new Set(existing.rows.map((row) => row.id));
        const requestedIds = request.topicIds;
        const requestedSet = new Set(requestedIds);
        const sameSet = requestedIds.length === currentIds.size && requestedSet.size === requestedIds.length
          && [...requestedSet].every((id) => currentIds.has(id));
        if (!sameSet) throw refusal('topic_set_mismatch', 'Reorder must name exactly the stream\'s current topic IDs');

        await tx.query('set constraints app.stream_topics_position_unique deferred');
        for (let index = 0; index < requestedIds.length; index += 1) {
          await tx.query(
            'update app.stream_topics set position = $1 where id = $2 and stream_id = $3',
            [index, requestedIds[index], streamId],
          );
        }
        return this.core.loadReel(tx, streamId);
      },
    );
  }

  // ── GET /reels/:id/topic-candidates ──────────────────────────────────────────

  async topicCandidates(streamId: string, q: string | undefined): Promise<StreamTopicCandidatesResponse> {
    const stream = await this.core.getReel(streamId);
    if (stream.format !== 'stream') throw refusal('not_a_stream', 'Reel is not a stream');
    const term = `%${(q ?? '').trim()}%`;
    const rows = await this.db.query<{
      id: string; title: string; status: ReelStatus;
      planned_publication_date: string | null; planned_publication_slot: PublicationSlot | null;
      in_this_stream: boolean;
    }>(
      `select r.id, r.title, r.status,
              to_char(r.planned_publication_date, 'YYYY-MM-DD') as planned_publication_date,
              r.planned_publication_slot,
              exists(select 1 from app.stream_topics t where t.stream_id = $1 and t.source_reel_id = r.id) as in_this_stream
       from app.reels r
       where r.format = 'reel' and r.deleted_at is null and r.absorbed_into is null and r.title ilike $2
       order by r.title asc, r.id asc
       limit 100`,
      [streamId, term],
    );
    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        plannedPublicationDate: row.planned_publication_date ?? null,
        plannedPublicationSlot: row.planned_publication_slot ?? null,
        inThisStream: row.in_this_stream,
      })),
    };
  }
}

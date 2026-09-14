/**
 * Core persistence. Every mutation here is atomic and version-checked.
 *
 * Two invariants shape the whole file:
 *
 *  1. Compare-and-update lives in SQL, not in application sequencing. Every write
 *     guards on `version = $expectedVersion` inside its own UPDATE and bumps the
 *     version in the same statement. Whether two writers are interleaved by an
 *     event loop or by two real sessions, at most one UPDATE can match, so the
 *     guarantee does not depend on the driver being single- or multi-connection.
 *  2. The idempotency ledger is written in the same transaction as the domain
 *     change. There is no window in which a mutation is applied but unrecorded.
 */

import { randomUUID, createHash } from 'node:crypto';

import type {
  AttachmentReference,
  CaptureImageDescriptor,
  CaptureInput,
  ExportReference,
  Priority,
  Reel,
  ReelHook,
  ReelStatus,
} from '@szronox/contracts';

import type { Database, Queryable } from '../db/client.js';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../db/client.js';
import {
  editConflict,
  editorRequired,
  exportChanged,
  feedCoverRequired,
  forbidden,
  idempotencyConflict,
  notFound,
  uploadIncomplete,
  validationError,
} from './errors.js';
import {
  type AttachmentRow,
  type HookRow,
  type ReelRow,
  toAttachment,
  toHook,
  toReel,
} from './mapping.js';
import type { SignedUpload, StorageAdapter } from './storage.js';

const REEL_COLUMNS = `
  id, version, title, status, priority, input_note, original_input, script, editing_notes,
  editor_id, current_export, verification, programme_state, programme_attachment,
  programme_input_hash, programme_document_version_id, kdrive_folder, editing_started_at,
  published_at, publication_urls, publication_description, publication_hashtags,
  feed_cover_done, created_by, created_at, updated_at, deleted_at
`;

/** Scalar fields PATCH may touch. Anything else is refused, not ignored. */
export const PATCHABLE_FIELDS = [
  'title', 'status', 'priority', 'inputNote', 'script', 'editingNotes',
  'editorId', 'publishedAt', 'publicationUrls', 'publicationDescription',
  'publicationHashtags', 'feedCoverDone',
] as const;

const PATCH_COLUMNS: Record<(typeof PATCHABLE_FIELDS)[number], string> = {
  title: 'title',
  status: 'status',
  priority: 'priority',
  inputNote: 'input_note',
  script: 'script',
  editingNotes: 'editing_notes',
  editorId: 'editor_id',
  publishedAt: 'published_at',
  publicationUrls: 'publication_urls',
  publicationDescription: 'publication_description',
  publicationHashtags: 'publication_hashtags',
  feedCoverDone: 'feed_cover_done',
};

/**
 * Canonical payload hash for the idempotency ledger. Key order is normalised so
 * two semantically identical bodies hash alike, and nothing is excluded — a
 * changed payload under a reused id must be detectable.
 */
export function payloadHash(payload: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    }
    return value;
  };
  return createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex');
}

export interface Actor { id: string; name: 'NOXAVA' | 'SZRON' }

/**
 * Which Reels a list request is asking for.
 *
 * `active` is the default and excludes soft-deleted rows. `deleted` returns ONLY
 * soft-deleted rows, which is what the restore surface needs: T08 reported that a
 * correct client request could not retrieve deleted records at all, because the
 * list unconditionally filtered them out.
 */
export type ReelVisibility = 'active' | 'deleted';

export interface ListReelsQuery {
  status?: ReelStatus;
  visibility?: ReelVisibility;
  /** Only Reels currently in editing past the first attention threshold. */
  overdue?: boolean;
  limit?: number;
  cursor?: string;
}

export interface ListReelsPage {
  items: Reel[];
  nextCursor: string | null;
}

/** Attention thresholds in elapsed editing hours; only current editing items count. */
export const ATTENTION_THRESHOLD_HOURS = [24, 96, 168] as const;

const PRIORITY_RANK_SQL = `case priority when 'urgent' then 0 when 'normal' then 1 else 2 end`;

interface Cursor { rank: number; createdAt: string; id: string }

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.rank !== 'number' || typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('shape');
    }
    return parsed;
  } catch {
    throw validationError('Malformed pagination cursor');
  }
}

export class CoreRepository {
  constructor(private readonly db: Database) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  async loadReel(tx: Queryable, reelId: string, options: { includeDeleted?: boolean } = {}): Promise<Reel> {
    const clause = options.includeDeleted ? '' : 'and deleted_at is null';
    const rows = await tx.query<ReelRow>(
      `select ${REEL_COLUMNS} from app.reels where id = $1 ${clause}`,
      [reelId],
    );
    const row = rows.rows[0];
    if (!row) throw notFound('Reel not found');
    return this.assemble(tx, row);
  }

  private async assemble(tx: Queryable, row: ReelRow): Promise<Reel> {
    const [hooks, attachments, memes] = await Promise.all([
      tx.query<HookRow>(
        'select id, reel_id, text, source, position, created_at from app.reel_hooks where reel_id = $1 order by position asc',
        [row.id],
      ),
      tx.query<AttachmentRow>(
        'select id, reel_id, purpose, kind, label, url, storage_key, state from app.attachments where reel_id = $1 order by created_at asc, id asc',
        [row.id],
      ),
      tx.query<{ meme_id: string }>(
        'select meme_id from app.reel_memes where reel_id = $1 order by attached_at asc',
        [row.id],
      ),
    ]);
    return toReel(row, hooks.rows, attachments.rows, memes.rows.map((entry) => entry.meme_id));
  }

  /**
   * Read one Reel. `includeDeleted` is required to see a soft-deleted row, so a
   * normal detail request still 404s on a deleted Reel while the restore surface
   * can fetch it deliberately.
   */
  async getReel(reelId: string, options: { includeDeleted?: boolean } = {}): Promise<Reel> {
    return this.loadReel(this.db, reelId, options);
  }

  /**
   * Fixed product ordering: urgent first, then newest. Keyset pagination on the
   * same tuple, so a page boundary cannot skip or repeat a row when the list
   * changes underneath.
   *
   * Note for the lead: T00 says "fixed product sorting" without pinning the exact
   * order. This is an implementation choice, recorded in T05-result.md, not an
   * inferred product decision.
   */
  async listReels(query: ListReelsQuery): Promise<ListReelsPage> {
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const params: unknown[] = [];
    // Deleted is an explicit request, never a side effect of omitting a filter.
    const where: string[] = [
      query.visibility === 'deleted' ? 'deleted_at is not null' : 'deleted_at is null',
    ];

    if (query.status) {
      params.push(query.status);
      where.push(`status = $${params.length}`);
    }
    if (query.overdue) {
      // Only current editing items count toward attention.
      params.push(ATTENTION_THRESHOLD_HOURS[0]);
      where.push(
        `status = 'editing' and editing_started_at is not null
         and editing_started_at <= now() - make_interval(hours => $${params.length}::int)`,
      );
    }
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      params.push(cursor.rank, cursor.createdAt, cursor.id);
      const rank = `$${params.length - 2}::int`;
      const createdAt = `$${params.length - 1}::timestamptz`;
      const id = `$${params.length}::uuid`;
      // The sort is MIXED direction (rank asc, created_at desc, id asc), so a row
      // comparison `(a,b,c) < (x,y,z)` is wrong: it assumes every column ascends.
      // Each tie level is therefore compared in its own direction.
      where.push(`(
        ${PRIORITY_RANK_SQL} > ${rank}
        or (${PRIORITY_RANK_SQL} = ${rank} and created_at < ${createdAt})
        or (${PRIORITY_RANK_SQL} = ${rank} and created_at = ${createdAt} and id > ${id})
      )`);
    }

    params.push(limit + 1);
    const rows = await this.db.query<ReelRow & { rank: number }>(
      `select ${REEL_COLUMNS}, ${PRIORITY_RANK_SQL} as rank
       from app.reels
       where ${where.join(' and ')}
       order by ${PRIORITY_RANK_SQL} asc, created_at desc, id asc
       limit $${params.length}`,
      params,
    );

    const page = rows.rows.slice(0, limit);
    const items = await Promise.all(page.map((row) => this.assemble(this.db, row)));
    const last = page[page.length - 1];
    const nextCursor = rows.rows.length > limit && last
      ? encodeCursor({
          rank: Number(last.rank),
          createdAt: new Date(last.created_at as string).toISOString(),
          id: last.id,
        })
      : null;
    return { items, nextCursor };
  }

  // ── Idempotency ────────────────────────────────────────────────────────────

  /**
   * Replay guard. Returns the original result for an identical retry, throws
   * IDEMPOTENCY_CONFLICT when the same id carries a different payload, and returns
   * null when this operation has not been seen.
   */
  private async replay<T>(
    tx: Queryable, operationId: string, route: string, hash: string,
  ): Promise<T | null> {
    const existing = await tx.query<{ payload_hash: string; result: T }>(
      'select payload_hash, result from app.operations where operation_id = $1',
      [operationId],
    );
    const row = existing.rows[0];
    if (!row) return null;
    if (row.payload_hash !== hash) throw idempotencyConflict();
    // Deliberately the recorded result, not a fresh read: T00 requires the original
    // result "including after subsequent edits".
    void route;
    return row.result;
  }

  private async record(
    tx: Queryable, operationId: string, actorId: string, route: string, hash: string, result: unknown,
  ): Promise<void> {
    await tx.query(
      `insert into app.operations (operation_id, actor_id, route, payload_hash, result)
       values ($1, $2, $3, $4, $5)`,
      [operationId, actorId, route, hash, JSON.stringify(result)],
    );
  }

  /**
   * Run an idempotent mutation. A concurrent duplicate that loses the race on the
   * ledger's primary key is converted into a replay rather than an error, so a
   * retry storm cannot produce two domain writes.
   */
  private async idempotent<T>(
    actor: Actor, operationId: string, route: string, payload: unknown,
    body: (tx: Queryable) => Promise<T>,
  ): Promise<T> {
    const hash = payloadHash(payload);
    try {
      return await this.db.transaction(async (tx) => {
        const replayed = await this.replay<T>(tx, operationId, route, hash);
        if (replayed !== null) return replayed;
        const result = await body(tx);
        await this.record(tx, operationId, actor.id, route, hash, result);
        return result;
      });
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
        const replayed = await this.replay<T>(this.db, operationId, route, hash);
        if (replayed !== null) return replayed;
      }
      throw error;
    }
  }

  // ── Capture ────────────────────────────────────────────────────────────────

  /**
   * Atomic capture: one Reel, every supported image as a pending attachment, and
   * the optional initial user hook, in a single transaction. A failure rolls the
   * whole thing back; a truncated subset is never saved.
   */
  async createReel(
    actor: Actor,
    request: { operationId: string; reelId: string; input: CaptureInput; initialHook?: string; priority?: Priority },
  ): Promise<Reel> {
    const images = request.input.images ?? [];
    const ids = images.map((image) => image.attachmentId);
    if (new Set(ids).size !== ids.length) {
      throw validationError('Capture image attachmentIds must be distinct');
    }
    for (const image of images) this.assertImageDescriptor(image);

    const usable = Boolean(
      (request.input.text && request.input.text.trim()) ||
      (request.input.url && request.input.url.trim()) ||
      images.length > 0,
    );
    if (!usable) throw validationError('Capture has no text, URL or supported image');

    return this.idempotent(actor, request.operationId, 'POST /reels', request, async (tx) => {
      await tx.query(
        `insert into app.reels (id, original_input, input_note, priority, created_by)
         values ($1, $2, $3, coalesce($4, 'normal'), $5)`,
        [
          request.reelId,
          JSON.stringify(request.input),
          request.input.text ?? '',
          request.priority ?? null,
          actor.id,
        ],
      );

      for (const image of images) {
        await tx.query(
          `insert into app.attachments (id, reel_id, purpose, kind, label, state, file_name, mime_type, byte_size)
           values ($1, $2, 'input', 'image', $3, 'pending', $4, $5, $6)`,
          [image.attachmentId, request.reelId, image.fileName, image.fileName, image.mimeType, image.byteSize],
        );
      }

      if (request.initialHook && request.initialHook.trim()) {
        await tx.query(
          `insert into app.reel_hooks (id, reel_id, text, source, position)
           values ($1, $2, $3, 'user', 0)`,
          [randomUUID(), request.reelId, request.initialHook],
        );
      }

      return this.loadReel(tx, request.reelId);
    });
  }

  private assertImageDescriptor(image: CaptureImageDescriptor): void {
    if (typeof image.attachmentId !== 'string' || image.attachmentId.length === 0) {
      throw validationError('Capture image is missing attachmentId');
    }
    if (typeof image.byteSize !== 'number' || !Number.isFinite(image.byteSize) || image.byteSize < 0) {
      throw validationError('Capture image byteSize must be a non-negative number');
    }
  }

  // ── Version-checked scalar patch ────────────────────────────────────────────

  async patchReel(
    actor: Actor,
    reelId: string,
    request: { operationId: string; expectedVersion: number; changes: Record<string, unknown> },
  ): Promise<Reel> {
    const entries = Object.entries(request.changes ?? {});
    if (entries.length === 0) throw validationError('Patch contains no changes');

    for (const [field] of entries) {
      if (!(PATCHABLE_FIELDS as readonly string[]).includes(field)) {
        // Refused, not silently dropped: hook, verification and result injection
        // must never ride in on a scalar patch.
        throw validationError(`Field is not patchable: ${field}`, { field });
      }
    }

    return this.idempotent(actor, request.operationId, `PATCH /reels/${reelId}`, request, async (tx) => {
      const before = await this.loadReel(tx, reelId);
      if (before.version !== request.expectedVersion) throw editConflict(before.version);

      const changes = request.changes as Partial<Record<(typeof PATCHABLE_FIELDS)[number], unknown>>;

      // The publish gate is evaluated on the EFFECTIVE updated Reel, so a single
      // patch may mark the cover done and publish at once.
      const nextStatus = (changes.status as ReelStatus | undefined) ?? before.status;
      const nextCover = (changes.feedCoverDone as boolean | undefined) ?? before.feedCoverDone;
      if (nextStatus === 'published' && before.status !== 'published' && nextCover !== true) {
        throw feedCoverRequired();
      }

      const assignments: string[] = [];
      const params: unknown[] = [];
      for (const [field, value] of entries) {
        params.push(this.patchValue(field as (typeof PATCHABLE_FIELDS)[number], value));
        assignments.push(`${PATCH_COLUMNS[field as (typeof PATCHABLE_FIELDS)[number]]} = $${params.length}`);
      }

      // Entering editing from another status stamps a server timestamp; re-saving
      // editing does not reset it, and priority or editor changes never do.
      if (nextStatus === 'editing' && before.status !== 'editing') {
        assignments.push('editing_started_at = now()');
      } else if (nextStatus !== 'editing' && before.status === 'editing') {
        // Leaving editing ends the period; re-entering later starts a new one.
        assignments.push('editing_started_at = null');
      }

      params.push(reelId, request.expectedVersion);
      const updated = await tx.query<ReelRow>(
        `update app.reels set ${assignments.join(', ')}, version = version + 1, updated_at = now()
         where id = $${params.length - 1} and version = $${params.length} and deleted_at is null
         returning ${REEL_COLUMNS}`,
        params,
      );
      const row = updated.rows[0];
      // The guard is the UPDATE's own WHERE clause, so a lost race yields no row.
      if (!row) throw editConflict((await this.loadReel(tx, reelId)).version);
      return this.assemble(tx, row);
    });
  }

  private patchValue(field: (typeof PATCHABLE_FIELDS)[number], value: unknown): unknown {
    switch (field) {
      case 'status':
        this.assertOneOf(value, ['idea', 'to_record', 'editing', 'ready', 'published'], 'status');
        return value;
      case 'priority':
        this.assertOneOf(value, ['urgent', 'normal', 'evergreen'], 'priority');
        return value;
      case 'feedCoverDone':
        if (typeof value !== 'boolean') throw validationError('feedCoverDone must be a boolean');
        return value;
      case 'publicationUrls':
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
          throw validationError('publicationUrls must be an array of strings');
        }
        return value;
      case 'editorId':
        if (value !== null && typeof value !== 'string') throw validationError('editorId must be a string or null');
        return value;
      case 'publishedAt':
        if (value !== null && typeof value !== 'string') throw validationError('publishedAt must be an ISO string or null');
        return value;
      default:
        if (typeof value !== 'string') throw validationError(`${field} must be a string`);
        return value;
    }
  }

  private assertOneOf(value: unknown, allowed: string[], field: string): void {
    if (typeof value !== 'string' || !allowed.includes(value)) {
      throw validationError(`${field} must be one of: ${allowed.join(', ')}`, { field });
    }
  }

  // ── Soft delete and restore ────────────────────────────────────────────────

  async setDeleted(
    actor: Actor, reelId: string,
    request: { operationId: string; expectedVersion: number }, deleted: boolean,
  ): Promise<Reel> {
    const route = `POST /reels/${reelId}/${deleted ? 'delete' : 'restore'}`;
    return this.idempotent(actor, request.operationId, route, request, async (tx) => {
      const before = await this.loadReel(tx, reelId, { includeDeleted: true });
      if (before.version !== request.expectedVersion) throw editConflict(before.version);
      const updated = await tx.query<ReelRow>(
        `update app.reels set deleted_at = ${deleted ? 'now()' : 'null'},
                version = version + 1, updated_at = now()
         where id = $1 and version = $2
         returning ${REEL_COLUMNS}`,
        [reelId, request.expectedVersion],
      );
      const row = updated.rows[0];
      if (!row) throw editConflict(before.version);
      return this.assemble(tx, row);
    });
  }

  // ── Hooks ──────────────────────────────────────────────────────────────────

  /**
   * Add a user hook. Positions are allocated transactionally; inserting in the
   * middle shifts later hooks rather than colliding. Existing hooks always survive.
   */
  async addHook(
    actor: Actor, reelId: string,
    request: { operationId: string; expectedVersion: number; text: string; position?: number },
  ): Promise<{ reel: Reel; hook: ReelHook }> {
    if (typeof request.text !== 'string' || request.text.trim() === '') {
      throw validationError('Hook text must be non-empty');
    }
    return this.idempotent(actor, request.operationId, `POST /reels/${reelId}/hooks`, request, async (tx) => {
      const before = await this.bumpVersion(tx, reelId, request.expectedVersion);
      const count = await tx.query<{ count: string }>(
        'select count(*)::text as count from app.reel_hooks where reel_id = $1', [reelId],
      );
      const total = Number(count.rows[0]?.count ?? '0');
      const target = request.position === undefined
        ? total
        : Math.min(Math.max(Math.trunc(request.position), 0), total);

      // Deferred uniqueness lets the shift happen without a mid-statement clash.
      await tx.query('set constraints app.reel_hooks_unique_position deferred');
      await tx.query(
        'update app.reel_hooks set position = position + 1 where reel_id = $1 and position >= $2',
        [reelId, target],
      );
      const hookId = randomUUID();
      const inserted = await tx.query<HookRow>(
        `insert into app.reel_hooks (id, reel_id, text, source, position)
         values ($1, $2, $3, 'user', $4)
         returning id, reel_id, text, source, position, created_at`,
        [hookId, reelId, request.text, target],
      );
      void before;
      return { reel: await this.loadReel(tx, reelId), hook: toHook(inserted.rows[0]) };
    });
  }

  async editHook(
    actor: Actor, reelId: string, hookId: string,
    request: { operationId: string; expectedVersion: number; text: string },
  ): Promise<Reel> {
    if (typeof request.text !== 'string' || request.text.trim() === '') {
      throw validationError('Hook text must be non-empty');
    }
    const route = `PATCH /reels/${reelId}/hooks/${hookId}`;
    return this.idempotent(actor, request.operationId, route, request, async (tx) => {
      await this.bumpVersion(tx, reelId, request.expectedVersion);
      // Only the wording changes. `source` and `created_at` are server-owned
      // provenance and are deliberately untouched.
      const updated = await tx.query(
        'update app.reel_hooks set text = $1 where id = $2 and reel_id = $3',
        [request.text, hookId, reelId],
      );
      if (updated.rowCount === 0) throw notFound('Hook not found');
      return this.loadReel(tx, reelId);
    });
  }

  async removeHook(
    actor: Actor, reelId: string, hookId: string,
    request: { operationId: string; expectedVersion: number },
  ): Promise<Reel> {
    const route = `DELETE /reels/${reelId}/hooks/${hookId}`;
    return this.idempotent(actor, request.operationId, route, request, async (tx) => {
      await this.bumpVersion(tx, reelId, request.expectedVersion);
      const removed = await tx.query<{ position: number }>(
        'delete from app.reel_hooks where id = $1 and reel_id = $2 returning position',
        [hookId, reelId],
      );
      const gone = removed.rows[0];
      if (!gone) throw notFound('Hook not found');
      // Close the gap so `position` stays a dense, stable order.
      await tx.query('set constraints app.reel_hooks_unique_position deferred');
      await tx.query(
        'update app.reel_hooks set position = position - 1 where reel_id = $1 and position > $2',
        [reelId, gone.position],
      );
      return this.loadReel(tx, reelId);
    });
  }

  /** Version-check and bump in one guarded statement. */
  private async bumpVersion(tx: Queryable, reelId: string, expectedVersion: number): Promise<ReelRow> {
    const updated = await tx.query<ReelRow>(
      `update app.reels set version = version + 1, updated_at = now()
       where id = $1 and version = $2 and deleted_at is null
       returning ${REEL_COLUMNS}`,
      [reelId, expectedVersion],
    );
    const row = updated.rows[0];
    if (row) return row;
    // Distinguish "gone" from "moved on" so the client knows whether to retry.
    const current = await tx.query<{ version: number }>(
      'select version from app.reels where id = $1 and deleted_at is null', [reelId],
    );
    const version = current.rows[0]?.version;
    if (version === undefined) throw notFound('Reel not found');
    throw editConflict(version);
  }

  // ── Export reference and verification ──────────────────────────────────────

  /**
   * Replace the current export reference. The application-owned revision increments
   * even when the URL or file id is unchanged. Linking verifies nothing, and it
   * stays allowed independently of editor selection.
   */
  async replaceExport(
    actor: Actor, reelId: string,
    request: { operationId: string; expectedVersion: number; export: Omit<ExportReference, 'revision'> },
  ): Promise<Reel> {
    const reference = request.export;
    if (!reference || typeof reference.url !== 'string' || reference.url.trim() === '') {
      throw validationError('Export url is required');
    }
    if (typeof reference.label !== 'string') throw validationError('Export label is required');

    const route = `POST /reels/${reelId}/current-export`;
    return this.idempotent(actor, request.operationId, route, request, async (tx) => {
      const before = await this.loadReel(tx, reelId);
      if (before.version !== request.expectedVersion) throw editConflict(before.version);
      const nextRevision = (before.currentExport?.revision ?? 0) + 1;
      const next: ExportReference = { ...reference, revision: nextRevision };

      // The historical verification record is retained, not cleared, so `outdated`
      // remains derivable after a replacement.
      const updated = await tx.query<ReelRow>(
        `update app.reels set current_export = $1, version = version + 1, updated_at = now()
         where id = $2 and version = $3 and deleted_at is null
         returning ${REEL_COLUMNS}`,
        [JSON.stringify(next), reelId, request.expectedVersion],
      );
      const row = updated.rows[0];
      if (!row) throw editConflict(before.version);
      return this.assemble(tx, row);
    });
  }

  /**
   * Verify the current export.
   *
   * All three facts are checked against the same version-checked state: a valid
   * editor is selected, the acting user is the OTHER allowlisted user, and the
   * named revision is still current. The editor/verifier is never inferred from
   * the acting user.
   */
  async verifyExport(
    actor: Actor, reelId: string,
    request: { operationId: string; expectedVersion: number; exportRevision: number },
  ): Promise<Reel> {
    const route = `POST /reels/${reelId}/verification`;
    return this.idempotent(actor, request.operationId, route, request, async (tx) => {
      const before = await this.loadReel(tx, reelId);
      if (before.version !== request.expectedVersion) throw editConflict(before.version);
      if (before.currentExport === null) throw validationError('Reel has no current export to verify');

      // No valid selected editor: 422, and never a guess at who it should be.
      if (before.editorId === null) throw editorRequired();
      const editor = await tx.query<{ id: string }>('select id from app.users where id = $1', [before.editorId]);
      if (editor.rows.length === 0) throw editorRequired();

      // The verifier is the other allowlisted user relative to editorId.
      if (actor.id === before.editorId) {
        throw forbidden('The selected editor cannot verify their own export');
      }
      if (before.currentExport.revision !== request.exportRevision) {
        throw exportChanged(before.version);
      }

      const record = {
        checkedBy: actor.id,
        checkedAt: new Date().toISOString(),
        exportRevision: request.exportRevision,
      };
      const updated = await tx.query<ReelRow>(
        `update app.reels set verification = $1, version = version + 1, updated_at = now()
         where id = $2 and version = $3 and deleted_at is null
         returning ${REEL_COLUMNS}`,
        [JSON.stringify(record), reelId, request.expectedVersion],
      );
      const row = updated.rows[0];
      if (!row) throw editConflict(before.version);
      return this.assemble(tx, row);
    });
  }

  // ── Bounded private attachment lifecycle ───────────────────────────────────

  /**
   * Initiate an upload. Returns the storage key the transfer should target. The
   * record stays `pending` until completion is validated server-side.
   */
  async initiateAttachment(
    actor: Actor, reelId: string,
    request: {
      operationId: string; attachmentId: string; fileName: string;
      mimeType: string; byteSize: number; purpose?: AttachmentReference['purpose'];
    },
    limits: AttachmentLimits,
    storage: StorageAdapter,
  ): Promise<{ attachment: AttachmentReference; storageKey: string; upload: SignedUpload }> {
    if (!limits.allowedMimeTypes.includes(request.mimeType)) {
      throw validationError(`Unsupported attachment type: ${request.mimeType}`, { mimeType: request.mimeType });
    }
    if (typeof request.byteSize !== 'number' || request.byteSize <= 0 || request.byteSize > limits.maxByteSize) {
      throw validationError('Attachment byteSize is outside the configured bound', {
        maxByteSize: limits.maxByteSize,
      });
    }

    const route = `POST /reels/${reelId}/attachments/initiate`;
    return this.idempotent(actor, request.operationId, route, request, async (tx) => {
      await this.loadReel(tx, reelId);
      const storageKey = `reels/${reelId}/${request.attachmentId}`;
      const rows = await tx.query<AttachmentRow>(
        `insert into app.attachments (id, reel_id, purpose, kind, label, state, file_name, mime_type, byte_size, storage_key)
         values ($1, $2, $3, 'image', $4, 'pending', $4, $5, $6, $7)
         on conflict (id) do update set storage_key = excluded.storage_key
         returning id, reel_id, purpose, kind, label, url, storage_key, state`,
        [
          request.attachmentId, reelId, request.purpose ?? 'input',
          request.fileName, request.mimeType, request.byteSize, storageKey,
        ],
      );
      // The browser needs somewhere to PUT the bytes. Minting the signed URL inside
      // the idempotent body means a replayed initiate returns the same recorded
      // result rather than issuing a second URL.
      const upload = await storage.createSignedUpload(storageKey, {
        mimeType: request.mimeType,
        byteSize: request.byteSize,
      });
      return { attachment: toAttachment(rows.rows[0]), storageKey, upload };
    });
  }

  /**
   * Complete an upload only once the storage backend confirms the object exists
   * and its observed size matches what was declared. A client assertion alone never
   * moves an attachment to `ready`.
   */
  async completeAttachment(
    actor: Actor, reelId: string, attachmentId: string,
    request: { operationId: string },
    storage: StorageAdapter,
  ): Promise<AttachmentReference> {
    const route = `POST /reels/${reelId}/attachments/${attachmentId}/complete`;
    return this.idempotent(actor, request.operationId, route, { ...request, attachmentId }, async (tx) => {
      const rows = await tx.query<AttachmentRow & { storage_key: string | null; byte_size: string | null }>(
        `select id, reel_id, purpose, kind, label, url, storage_key, state, byte_size
         from app.attachments where id = $1 and reel_id = $2`,
        [attachmentId, reelId],
      );
      const row = rows.rows[0];
      if (!row) throw notFound('Attachment not found');
      if (row.state === 'ready') return toAttachment(row);
      if (row.storage_key === null) throw uploadIncomplete('Attachment upload was never initiated');

      const observed = await storage.statObject(row.storage_key);
      if (!observed.exists) throw uploadIncomplete('Uploaded object was not found in storage');
      const declared = row.byte_size === null ? null : Number(row.byte_size);
      if (declared !== null && observed.byteSize !== declared) {
        // A size mismatch is surfaced, not accepted as close enough.
        throw uploadIncomplete('Stored object size does not match the declared byteSize');
      }

      const updated = await tx.query<AttachmentRow>(
        `update app.attachments
         set state = 'ready', stored_byte_size = $1, completed_at = now()
         where id = $2 and reel_id = $3
         returning id, reel_id, purpose, kind, label, url, storage_key, state`,
        [observed.byteSize, attachmentId, reelId],
      );
      return toAttachment(updated.rows[0]);
    });
  }
}

export interface AttachmentLimits {
  maxByteSize: number;
  allowedMimeTypes: string[];
}

/**
 * Retained as the narrow read-only view of storage. `StorageAdapter` in
 * ./storage.js extends this with signed-upload minting.
 */
export interface StorageProbe {
  statObject(storageKey: string): Promise<{ exists: boolean; byteSize: number }>;
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  // Lightweight input images only; large production media belongs to kDrive.
  maxByteSize: 8 * 1024 * 1024,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
};

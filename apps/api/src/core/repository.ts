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

import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';

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
import { deriveSourceUrl, initialSourceMetadata } from '../source/metadata.js';
import {
  CoreError,
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
import {
  digestUploadToken,
  type SignedUpload,
  type StorageAdapter,
  UPLOAD_TOKEN_HEADER,
  type ValidatedStoredObject,
} from './storage.js';

/** A composite selected-hook reference that names no hook of this Reel. */
const PG_FOREIGN_KEY_VIOLATION = '23503';

const REEL_COLUMNS = `
  id, version, title, status, priority, input_note, original_input, source_link, script, editing_notes,
  publication_source, source_metadata,
  script_revision, editor_id, selected_hook_id, current_export, verification, programme_state, programme_attachment,
  programme_input_hash, programme_document_version_id, kdrive_folder, editing_started_at,
  published_at, publication_urls, publication_description, publication_hashtags,
  feed_cover_done, feed_cover_asset, created_by, created_at, updated_at, deleted_at,
  to_char(planned_publication_date, 'YYYY-MM-DD') as planned_publication_date,
  planned_publication_slot
`;

/** Scalar fields PATCH may touch. Anything else is refused, not ignored. */
export const PATCHABLE_FIELDS = [
  'title', 'status', 'priority', 'inputNote', 'script', 'editingNotes',
  'editorId', 'publishedAt', 'publicationUrls', 'publicationDescription',
  'publicationHashtags', 'publicationSource', 'sourceLink', 'feedCoverDone', 'plannedPublicationDate', 'plannedPublicationSlot',
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
  publicationSource: 'publication_source',
  sourceLink: 'source_link',
  feedCoverDone: 'feed_cover_done',
  plannedPublicationDate: 'planned_publication_date',
  plannedPublicationSlot: 'planned_publication_slot',
};

const PLANNED_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PUBLICATION_SLOTS = ['morning', 'afternoon', 'evening'];

/** A real calendar date in `YYYY-MM-DD`; `2026-02-30` is refused rather than rolled over. */
function isCalendarDate(value: string): boolean {
  const match = PLANNED_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && year <= 2100 && date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

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
        'select meme_id from app.reel_memes where reel_id = $1 order by position asc',
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
    tx: Queryable, operationId: string, route: string, hash: string, acceptedHashes: readonly string[] = [],
  ): Promise<T | null> {
    const existing = await tx.query<{ payload_hash: string; result: T }>(
      'select payload_hash, result from app.operations where operation_id = $1',
      [operationId],
    );
    const row = existing.rows[0];
    if (!row) return null;
    if (row.payload_hash !== hash && !acceptedHashes.includes(row.payload_hash)) throw idempotencyConflict();
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
  /**
   * `legacyPayloads`: earlier canonical shapes of the same request. A replay recorded under one
   * of them is the same operation (e.g. a capture queued offline before a contract gained a
   * defaulted field), so it returns the original result instead of a false conflict.
   */
  private async idempotent<T>(
    actor: Actor, operationId: string, route: string, payload: unknown,
    body: (tx: Queryable) => Promise<T>, legacyPayloads: readonly unknown[] = [],
  ): Promise<T> {
    const hash = payloadHash(payload);
    const accepted = legacyPayloads.map(payloadHash);
    try {
      return await this.db.transaction(async (tx) => {
        const replayed = await this.replay<T>(tx, operationId, route, hash, accepted);
        if (replayed !== null) return replayed;
        const result = await body(tx);
        await this.record(tx, operationId, actor.id, route, hash, result);
        return result;
      });
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
        const replayed = await this.replay<T>(this.db, operationId, route, hash, accepted);
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
    request: { operationId: string; reelId: string; input: CaptureInput; initialScript?: string; initialHook?: string; priority?: Priority },
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
    if (request.initialScript !== undefined && (
      typeof request.initialScript !== 'string' ||
      request.initialScript.trim() === '' ||
      request.input.text !== request.initialScript
    )) {
      throw validationError('initialScript must be nonempty and exactly match input.text');
    }

    return this.idempotent(actor, request.operationId, 'POST /reels', request, async (tx) => {
      await tx.query(
        `insert into app.reels (id, original_input, input_note, script, script_revision, priority, created_by, source_metadata)
         values ($1, $2, $3, $4, 0, coalesce($5, 'normal'), $6, $7)`,
        [
          request.reelId,
          JSON.stringify(request.input),
          request.initialScript === undefined ? request.input.text ?? '' : '',
          request.initialScript ?? '',
          request.priority ?? null,
          actor.id,
          JSON.stringify(initialSourceMetadata(request.input)),
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

      if (Object.hasOwn(changes, 'sourceLink') && deriveSourceUrl(before.originalInput) !== null) {
        throw validationError('A captured link already exists', { reason: 'capture_has_link' });
      }

      // The publish gate is evaluated on the EFFECTIVE updated Reel, so a single
      // patch may mark the cover done and publish at once.
      const nextStatus = (changes.status as ReelStatus | undefined) ?? before.status;
      const nextCover = (changes.feedCoverDone as boolean | undefined) ?? before.feedCoverDone;
      if (nextStatus === 'published' && before.status !== 'published' && nextCover !== true) {
        throw feedCoverRequired();
      }

      // CONTENT-PLANNER-01: the slot (Rano/Popołudnie/Wieczór) is detail of a date. Clearing
      // the date alone clears the slot with it (unscheduling is one action); a slot without
      // any date is refused.
      const planEntries: Array<[string, unknown]> = [...entries];
      const clearsDateOnly = Object.hasOwn(changes, 'plannedPublicationDate')
        && changes.plannedPublicationDate === null && !Object.hasOwn(changes, 'plannedPublicationSlot');
      if (clearsDateOnly && before.plannedPublicationSlot !== null) planEntries.push(['plannedPublicationSlot', null]);
      const nextDate = Object.hasOwn(changes, 'plannedPublicationDate') ? changes.plannedPublicationDate : before.plannedPublicationDate;
      const nextSlot = Object.hasOwn(changes, 'plannedPublicationSlot')
        ? changes.plannedPublicationSlot
        : clearsDateOnly ? null : before.plannedPublicationSlot;
      if (nextSlot !== null && nextSlot !== undefined && (nextDate === null || nextDate === undefined)) {
        throw validationError('plannedPublicationSlot requires plannedPublicationDate', { field: 'plannedPublicationSlot' });
      }
      // IDEAS-PLAN: only the first date assignment promotes an idea. Keep this in
      // the same version-checked UPDATE as the plan fields; an explicit status wins.
      const promotesIdea = before.status === 'idea'
        && before.plannedPublicationDate === null
        && nextDate !== null && nextDate !== undefined
        && !Object.hasOwn(changes, 'status');
      const effectiveStatus = promotesIdea ? 'to_record' : nextStatus;
      if (promotesIdea) planEntries.push(['status', 'to_record']);

      const assignments: string[] = [];
      const params: unknown[] = [];
      for (const [field, value] of planEntries) {
        params.push(this.patchValue(field as (typeof PATCHABLE_FIELDS)[number], value));
        assignments.push(`${PATCH_COLUMNS[field as (typeof PATCHABLE_FIELDS)[number]]} = $${params.length}`);
      }

      const normalizedSourceLink = Object.hasOwn(changes, 'sourceLink')
        ? this.patchValue('sourceLink', changes.sourceLink) as string | null : before.sourceLink;
      if (Object.hasOwn(changes, 'sourceLink') && normalizedSourceLink !== before.sourceLink) {
        params.push(JSON.stringify(initialSourceMetadata(before.originalInput, new Date(), randomUUID(), normalizedSourceLink)));
        assignments.push(`source_metadata = $${params.length}`);
      }

      // Only a script change advances scriptRevision. An unrelated metadata edit
      // bumps `version` but must leave this counter alone, or every AI run would
      // look stale after a priority change.
      if (Object.hasOwn(changes, 'script') && changes.script !== before.script) {
        assignments.push('script_revision = script_revision + 1');
      }

      // Entering editing from another status stamps a server timestamp; re-saving
      // editing does not reset it, and priority or editor changes never do.
      if (effectiveStatus === 'editing' && before.status !== 'editing') {
        assignments.push('editing_started_at = now()');
      } else if (effectiveStatus !== 'editing' && before.status === 'editing') {
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
      case 'plannedPublicationDate':
        if (value !== null && (typeof value !== 'string' || !isCalendarDate(value))) {
          throw validationError('plannedPublicationDate must be a YYYY-MM-DD date or null', { field });
        }
        return value;
      case 'plannedPublicationSlot':
        if (value !== null) this.assertOneOf(value, PUBLICATION_SLOTS, field);
        return value;
      case 'publicationUrls':
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
          throw validationError('publicationUrls must be an array of strings');
        }
        return value;
      case 'publicationSource':
        if (value !== null && (typeof value !== 'string' || value.length > 1000)) {
          throw validationError('publicationSource must be a string of at most 1000 characters or null', { field });
        }
        return value;
      case 'sourceLink': {
        if (value === null) return null;
        if (typeof value !== 'string') throw validationError('sourceLink must be a URL or null');
        const trimmed = value.trim();
        if (trimmed === '') return null;
        if (trimmed.length > 2048 || !/^https?:\/\//i.test(trimmed)) throw validationError('sourceLink must be a valid HTTP(S) URL of at most 2048 characters');
        try { const parsed = new URL(trimmed); if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol'); }
        catch { throw validationError('sourceLink must be a valid HTTP(S) URL of at most 2048 characters'); }
        return trimmed;
      }
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
      // Deleting the selected hook clears `selected_hook_id` in this same statement through
      // the ON DELETE SET NULL reference; any other selection is left exactly as it was.
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

  /**
   * Explicit hook selection (HOOKS-SELECT-EDIT). Only the ID is stored; `null` clears it.
   *
   * The version bump locks the Reel row first, so this serialises with hook deletion, which
   * bumps the same row. The hook is then checked within this Reel so a wrong ID is a clear
   * 404, and the composite foreign key refuses any other Reel's, deleted or invented hook
   * regardless of interleaving. Re-selecting the current hook is still a recorded mutation.
   * Script, `scriptRevision` and hook provenance are untouched.
   */
  async selectHook(
    actor: Actor, reelId: string,
    request: { operationId: string; expectedVersion: number; hookId: string | null },
  ): Promise<Reel> {
    const route = `PUT /reels/${reelId}/selected-hook`;
    return this.idempotent(actor, request.operationId, route, request, async (tx) => {
      await this.bumpVersion(tx, reelId, request.expectedVersion);
      if (request.hookId !== null) {
        const hook = await tx.query('select 1 from app.reel_hooks where id = $1 and reel_id = $2', [request.hookId, reelId]);
        if (hook.rows.length === 0) throw notFound('Hook not found');
      }
      try {
        await tx.query('update app.reels set selected_hook_id = $1 where id = $2', [request.hookId, reelId]);
      } catch (error) {
        if (pgErrorCode(error) === PG_FOREIGN_KEY_VIOLATION) throw notFound('Hook not found');
        throw error;
      }
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
   * KDRIVE-01: the recorded result of an already-applied operation, or null when it has not
   * been seen. Read-only; a reused id with a different payload is IDEMPOTENCY_CONFLICT. Lets
   * the kDrive command answer a retry from the ledger before touching the provider again.
   */
  async recordedOperation<T>(operationId: string, route: string, payload: unknown): Promise<T | null> {
    return this.replay<T>(this.db, operationId, route, payloadHash(payload));
  }

  /**
   * KDRIVE-01: store a Reel's kDrive folder reference `{ driveId, folderId }` (never a path),
   * version-checked and idempotent like every other Reel mutation. `result` builds the value
   * recorded in the ledger from the updated Reel, so a replay returns exactly what the first
   * call returned.
   */
  async setKdriveFolder<T>(
    actor: Actor, reelId: string,
    request: { operationId: string; expectedVersion: number },
    payload: unknown,
    folder: { driveId: string; folderId: string },
    result: (reel: Reel) => T,
  ): Promise<T> {
    const route = `POST /reels/${reelId}/kdrive-folder`;
    return this.idempotent(actor, request.operationId, route, payload, async (tx) => {
      const before = await this.loadReel(tx, reelId);
      if (before.version !== request.expectedVersion) throw editConflict(before.version);
      const updated = await tx.query<ReelRow>(
        `update app.reels set kdrive_folder = $1, version = version + 1, updated_at = now()
         where id = $2 and version = $3 and deleted_at is null
         returning ${REEL_COLUMNS}`,
        [JSON.stringify(folder), reelId, request.expectedVersion],
      );
      const row = updated.rows[0];
      if (!row) throw editConflict(before.version);
      return result(await this.assemble(tx, row));
    });
  }

  /** Atomic finish-file attachment used by KDRIVE-02. The provider file is never deleted on conflict. */
  async attachKdriveFile(actor: Actor, reelId: string, request: {
    operationId: string; expectedVersion: number; uploadId: string; purpose: 'video' | 'cover';
    driveId: string; fileId: string; name: string; byteSize: number; url: string;
  }): Promise<Reel> {
    const route = `POST /reels/${reelId}/kdrive-uploads/${request.uploadId}/attach`;
    return this.idempotent(actor, request.operationId, route, request, async (tx) => {
      const upload = await tx.query<{ requested_by: string; purpose: string; state: string; kdrive_file_id: string; final_name: string | null; byte_size: string | number }>(
        'select requested_by,purpose,state,kdrive_file_id,final_name,byte_size from app.kdrive_uploads where id=$1 and reel_id=$2 for update',
        [request.uploadId, reelId],
      );
      const completed = upload.rows[0];
      if (!completed) throw notFound('Finished kDrive upload not found');
      if (completed.requested_by !== actor.id) throw forbidden('Upload belongs to another user');
      if (completed.purpose !== request.purpose || completed.kdrive_file_id !== request.fileId
          || completed.final_name !== request.name || Number(completed.byte_size) !== request.byteSize) throw validationError('Upload metadata changed before attachment');
      const before = await this.loadReel(tx, reelId);
      if (completed.state === 'attached') return before;
      if (completed.state !== 'finished') throw validationError('Upload is not finished', { reason: 'upload_not_open' });
      if (before.version !== request.expectedVersion) throw editConflict(before.version);
      const asset = { driveId: request.driveId, fileId: request.fileId, name: request.name, byteSize: request.byteSize,
        uploadedAt: new Date().toISOString(), uploadedBy: actor.id };
      if (request.purpose === 'cover') {
        const updated = await tx.query<ReelRow>(
          `update app.reels set feed_cover_asset=$1, feed_cover_done=true, version=version+1, updated_at=now()
           where id=$2 and version=$3 and deleted_at is null returning ${REEL_COLUMNS}`,
          [JSON.stringify(asset), reelId, request.expectedVersion],
        );
        if (!updated.rows[0]) throw editConflict(before.version);
        const attached = await tx.query(`update app.kdrive_uploads set state='attached',attach_operation_id=$1,updated_at=now()
          where id=$2 and reel_id=$3 and purpose='cover' and state='finished'`,
        [request.operationId, request.uploadId, reelId]);
        if (attached.rowCount !== 1) throw validationError('Upload is not available for attachment', { reason: 'upload_not_open' });
        return this.assemble(tx, updated.rows[0]);
      }
      const revision = (before.currentExport?.revision ?? 0) + 1;
      const currentExport: ExportReference = { url: request.url, label: request.name, driveId: request.driveId, fileId: request.fileId, revision };
      const updated = await tx.query<ReelRow>(
        `update app.reels set current_export=$1,version=version+1,updated_at=now()
         where id=$2 and version=$3 and deleted_at is null returning ${REEL_COLUMNS}`,
        [JSON.stringify(currentExport), reelId, request.expectedVersion],
      );
      if (!updated.rows[0]) throw editConflict(before.version);
      const attached = await tx.query(`update app.kdrive_uploads set state='attached',attach_operation_id=$1,updated_at=now()
        where id=$2 and reel_id=$3 and purpose='video' and state='finished'`,
      [request.operationId, request.uploadId, reelId]);
      if (attached.rowCount !== 1) throw validationError('Upload is not available for attachment', { reason: 'upload_not_open' });
      return this.assemble(tx, updated.rows[0]);
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

  async initiateAttachment(
    actor: Actor, reelId: string,
    request: {
      operationId: string; attachmentId: string; fileName: string;
      mimeType: string; byteSize: number; purpose?: 'input' | 'source' | 'material' | 'meme'; kind?: 'image' | 'video';
    },
    limits: AttachmentLimits,
    storage: StorageAdapter,
  ): Promise<{ attachment: AttachmentReference; storageKey: string; upload: SignedUpload }> {
    const kind = request.kind ?? 'image';
    const purpose: 'input' | 'source' | 'material' | 'meme' = request.purpose ?? 'input';
    const validMime = kind === 'video'
      ? (purpose === 'meme' && (/^video\/[a-z0-9.+-]+$/i.test(request.mimeType) || request.mimeType === 'application/octet-stream'))
      : (limits.allowedMimeTypes.includes(request.mimeType) || request.mimeType === 'image/gif');
    if (!validMime) {
      throw validationError(`Unsupported attachment type: ${request.mimeType}`, { mimeType: request.mimeType });
    }
    const maxByteSize = kind === 'video' ? 25 * 1024 * 1024 : limits.maxByteSize;
    if (!Number.isSafeInteger(request.byteSize) || request.byteSize <= 0 || request.byteSize > maxByteSize) {
      throw validationError('Attachment byteSize is outside the configured bound', {
        ...(kind === 'video' && request.byteSize > maxByteSize ? { reason: 'too_large' } : {}),
        maxByteSize,
      });
    }
    if (request.fileName.length > 255 || request.fileName.includes('\0')) {
      throw validationError('Attachment fileName is outside the configured bound');
    }

    if (!['input', 'source', 'material', 'meme'].includes(purpose)
        || (kind === 'video' && purpose !== 'meme')) {
      throw validationError('Unsupported attachment purpose', { purpose: request.purpose });
    }

    const route = `POST /reels/${reelId}/attachments/initiate`;
    return this.idempotent(actor, request.operationId, route, { ...request, kind }, async (tx) => {
      await this.loadReel(tx, reelId);
      const storageKey = `reels/${reelId}/${request.attachmentId}`;
      await tx.query(
        `insert into app.attachments (id, reel_id, purpose, kind, label, state, file_name, mime_type, byte_size)
         values ($1, $2, $3, $4, $5, 'pending', $5, $6, $7)
         on conflict (id) do nothing`,
        [
          request.attachmentId, reelId, purpose, kind,
          request.fileName, request.mimeType, request.byteSize,
        ],
      );
      const selected = await tx.query<AttachmentUploadRow>(
        `select a.id, a.reel_id, a.purpose, a.kind, a.label, a.url, a.storage_key, a.state,
                a.file_name, a.mime_type, a.byte_size, a.upload_actor_id,
                a.upload_token_digest, a.upload_token_expires_at,
                a.validated_mime_type, a.validated_width, a.validated_height,
                a.validated_pixel_count
         from app.attachments a where a.id = $1 for update`,
        [request.attachmentId],
      );
      const row = selected.rows[0];
      if (!row || row.reel_id !== reelId) throw validationError('Attachment id is already in use');
      if (row.state !== 'pending') throw validationError('Attachment is not pending');
      if (row.storage_key !== null) {
        // Same-operation retries replay above. A new operation cannot silently
        // mint another ticket; transport renewal has its own endpoint.
        throw validationError('Attachment upload was already initiated');
      }
      if (row.kind !== kind || row.file_name !== request.fileName || row.mime_type !== request.mimeType
          || Number(row.byte_size) !== request.byteSize || row.purpose !== purpose) {
        throw validationError('Initiation metadata does not match the pending attachment');
      }

      const upload = await storage.createSignedUpload(storageKey, {
        mimeType: request.mimeType,
        byteSize: request.byteSize,
        scope: { actorId: actor.id, reelId, attachmentId: request.attachmentId },
      });
      const token = upload.headers[UPLOAD_TOKEN_HEADER];
      if (!token || token.length > 512 || !Number.isInteger(upload.expiresAt)) {
        throw new Error('Storage adapter returned an invalid upload authorization');
      }
      await tx.query(
        `update app.attachments
         set storage_key = $1, upload_actor_id = $2, upload_token_digest = $3,
             upload_token_expires_at = to_timestamp($4), upload_authorized_at = now()
         where id = $5 and reel_id = $6`,
        [storageKey, actor.id, digestUploadToken(token), upload.expiresAt, request.attachmentId, reelId],
      );
      return { attachment: toAttachment({ ...row, storage_key: storageKey }), storageKey, upload };
    // Before MEME-VIDEO-01 an image initiation was hashed without `kind`.
    }, kind === 'image' ? [(({ kind: _kind, ...legacy }) => legacy)(request)] : []);
  }

  async renewAttachmentUpload(
    actor: Actor,
    reelId: string,
    attachmentId: string,
    storage: StorageAdapter,
  ): Promise<{ upload: SignedUpload }> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<AttachmentUploadRow & { deleted_at: Date | string | null }>(
        `select a.id, a.reel_id, a.purpose, a.kind, a.label, a.url, a.storage_key, a.state,
                a.file_name, a.mime_type, a.byte_size, a.upload_actor_id,
                a.upload_token_digest, a.upload_token_expires_at,
                a.validated_mime_type, a.validated_width, a.validated_height,
                a.validated_pixel_count, r.deleted_at
         from app.attachments a join app.reels r on r.id = a.reel_id
         where a.id = $1 and a.reel_id = $2 for update`,
        [attachmentId, reelId],
      );
      const row = rows.rows[0];
      if (!row || row.deleted_at !== null) throw notFound('Pending attachment not found');
      if (row.state !== 'pending' || row.storage_key === null || row.mime_type === null || row.byte_size === null) {
        throw uploadIncomplete('Attachment is not available for upload authorization renewal');
      }
      if (row.upload_actor_id !== actor.id) throw forbidden('Upload authorization belongs to another user');
      const upload = await storage.createSignedUpload(row.storage_key, {
        mimeType: row.mime_type,
        byteSize: Number(row.byte_size),
        scope: { actorId: actor.id, reelId, attachmentId },
      });
      const token = upload.headers[UPLOAD_TOKEN_HEADER];
      if (!token || token.length > 512 || !Number.isInteger(upload.expiresAt)) {
        throw new Error('Storage adapter returned an invalid upload authorization');
      }
      await tx.query(
        `update app.attachments
         set upload_token_digest = $1, upload_token_expires_at = to_timestamp($2),
             upload_authorized_at = now()
         where id = $3 and reel_id = $4`,
        [digestUploadToken(token), upload.expiresAt, attachmentId, reelId],
      );
      return { upload };
    });
  }

  async authorizeAttachmentUpload(
    actor: Actor,
    reelId: string,
    attachmentId: string,
    token: string,
    now: Date = new Date(),
  ): Promise<AttachmentUploadPlan> {
    const rows = await this.db.query<AttachmentUploadRow & { deleted_at: Date | string | null }>(
      `select a.id, a.reel_id, a.purpose, a.kind, a.label, a.url, a.storage_key, a.state,
              a.file_name, a.mime_type, a.byte_size, a.upload_actor_id,
              a.upload_token_digest, a.upload_token_expires_at,
              a.validated_mime_type, a.validated_width, a.validated_height,
              a.validated_pixel_count, r.deleted_at
       from app.attachments a join app.reels r on r.id = a.reel_id
       where a.id = $1 and a.reel_id = $2`,
      [attachmentId, reelId],
    );
    const row = rows.rows[0];
    if (!row || row.deleted_at !== null) throw notFound('Pending attachment not found');
    if (row.state !== 'pending' || row.storage_key === null || row.mime_type === null || row.byte_size === null) {
      throw uploadIncomplete('Attachment is not pending an upload');
    }
    if (row.upload_actor_id !== actor.id) throw forbidden('Upload authorization belongs to another user');
    if (typeof token !== 'string' || token.length < 32 || token.length > 512 || row.upload_token_digest === null) {
      throw forbidden('Upload authorization is invalid');
    }
    const supplied = Buffer.from(digestUploadToken(token), 'hex');
    const expected = Buffer.from(row.upload_token_digest, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw forbidden('Upload authorization is invalid');
    }
    const expiresAt = row.upload_token_expires_at === null
      ? Number.NaN : new Date(row.upload_token_expires_at).getTime();
    if (!Number.isFinite(expiresAt) || now.getTime() >= expiresAt) {
      throw new CoreError({
        status: 422,
        code: 'UPLOAD_INCOMPLETE',
        message: 'Upload authorization expired',
        details: { reason: 'upload_authorization_expired' },
      });
    }
    return {
      actorId: actor.id,
      reelId,
      attachmentId,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
      kind: row.kind as 'image' | 'video',
      byteSize: Number(row.byte_size),
      expiresAt: new Date(expiresAt),
    };
  }

  async recordValidatedAttachmentUpload(plan: AttachmentUploadPlan, object: ValidatedStoredObject): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx.query<AttachmentUploadRow & { deleted_at: Date | string | null }>(
        `select a.id, a.reel_id, a.purpose, a.kind, a.label, a.url, a.storage_key, a.state,
                a.file_name, a.mime_type, a.byte_size, a.upload_actor_id,
                a.upload_token_digest, a.upload_token_expires_at,
                a.validated_mime_type, a.validated_width, a.validated_height,
                a.validated_pixel_count, r.deleted_at
         from app.attachments a join app.reels r on r.id = a.reel_id
         where a.id = $1 and a.reel_id = $2 for update`,
        [plan.attachmentId, plan.reelId],
      );
      const row = rows.rows[0];
      if (!row || row.deleted_at !== null || row.state !== 'pending' || row.storage_key !== plan.storageKey
          || row.upload_actor_id !== plan.actorId) {
        throw uploadIncomplete('Attachment changed while the upload was in progress');
      }
      const derivedVideoMime = (row.kind as string) === 'video' && row.mime_type === 'application/octet-stream'
        && object.mimeType.startsWith('video/');
      // The declared image type is the browser's guess from the file name (Android shares a
      // WebP saved as `.jpg` as image/jpeg). The decoded, supported type is the truth.
      const decodedImageMime = row.kind === 'image' && object.mimeType.startsWith('image/');
      if ((!derivedVideoMime && !decodedImageMime && row.mime_type !== object.mimeType) || Number(row.byte_size) !== object.byteSize) {
        throw uploadIncomplete('Validated object does not match declared attachment metadata');
      }
      if (row.validated_mime_type !== null
          && (row.validated_mime_type !== object.mimeType || (row.kind === 'image'
            && (Number(row.validated_width) !== object.width || Number(row.validated_height) !== object.height
              || Number(row.validated_pixel_count) !== object.pixelCount)))) {
        throw uploadIncomplete('A different validated object is already associated with this attachment');
      }
      await tx.query(
        `update app.attachments
         set validated_mime_type = $1, validated_width = $2, validated_height = $3,
             validated_pixel_count = $4, validated_at = now()
         where id = $5 and reel_id = $6`,
        [object.mimeType, object.width, object.height, object.pixelCount, plan.attachmentId, plan.reelId],
      );
    });
  }

  async completeAttachment(
    actor: Actor, reelId: string, attachmentId: string,
    request: { operationId: string },
    storage: StorageAdapter,
  ): Promise<AttachmentReference> {
    const route = `POST /reels/${reelId}/attachments/${attachmentId}/complete`;
    return this.idempotent(actor, request.operationId, route, { ...request, attachmentId }, async (tx) => {
      const rows = await tx.query<AttachmentUploadRow>(
        `select id, reel_id, purpose, kind, label, url, storage_key, state,
                file_name, mime_type, byte_size, upload_actor_id, upload_token_digest,
                upload_token_expires_at, validated_mime_type, validated_width,
                validated_height, validated_pixel_count
         from app.attachments where id = $1 and reel_id = $2 for update`,
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
      if (row.validated_mime_type === null) {
        // Legacy doubles have size-only evidence. The VPS filesystem always sets
        // validated metadata before complete; it cannot acknowledge a size-only file.
        if (storage.writeObject && storage.openObject) {
          throw uploadIncomplete('Uploaded object has not completed image validation');
        }
      } else if (row.kind === 'image' && observed.mimeType !== undefined && observed.mimeType !== row.validated_mime_type) {
        throw uploadIncomplete('Stored object type changed after validation');
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

  async resolveAttachmentDownload(
    actor: Actor,
    reelId: string,
    attachmentId: string,
  ): Promise<AttachmentDownloadPlan> {
    void actor; // Both authenticated allowlisted users share Reel attachments.
    const rows = await this.db.query<AttachmentUploadRow>(
      `select id, reel_id, purpose, kind, label, url, storage_key, state,
              file_name, mime_type, byte_size, upload_actor_id, upload_token_digest,
              upload_token_expires_at, validated_mime_type, validated_width,
              validated_height, validated_pixel_count
       from app.attachments where id = $1 and reel_id = $2`,
      [attachmentId, reelId],
    );
    const row = rows.rows[0];
    if (!row || row.state !== 'ready' || row.storage_key === null || row.validated_mime_type === null) {
      throw notFound('Ready attachment not found');
    }
    return {
      storageKey: row.storage_key,
      fileName: row.file_name ?? row.label,
      mimeType: row.validated_mime_type,
      byteSize: Number(row.byte_size),
    };
  }
}

interface AttachmentUploadRow extends AttachmentRow {
  file_name: string | null;
  mime_type: string | null;
  byte_size: string | number | null;
  upload_actor_id: string | null;
  upload_token_digest: string | null;
  upload_token_expires_at: Date | string | null;
  validated_mime_type: string | null;
  validated_width: number | null;
  validated_height: number | null;
  validated_pixel_count: string | number | null;
}

export interface AttachmentUploadPlan {
  actorId: string;
  reelId: string;
  attachmentId: string;
  storageKey: string;
  mimeType: string;
  kind: 'image' | 'video';
  byteSize: number;
  expiresAt: Date;
}

export interface AttachmentDownloadPlan {
  storageKey: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
}

export interface AttachmentLimits {
  maxByteSize: number;
  allowedMimeTypes: string[];
  maxPixelCount: number;
  maxDimension: number;
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
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  maxPixelCount: 40_000_000,
  maxDimension: 20_000,
};

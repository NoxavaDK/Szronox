/**
 * STREAM-LIVE-01 live messages.
 *
 * Users create messages (session routes); the streaming PC reads the feed and reports what
 * happened to each one (device routes). Messages are never edited by users and never touch
 * Reels, so there is no version: creation is idempotent on `operationId` through the shared
 * operations ledger, exactly like every other authenticated mutation.
 */

import type {
  CreateLiveMessageRequest, LiveFeedItem, LiveFeedResponse, LiveMessage, LiveMessageKind,
  LiveMessageStatus, LiveSignalLevel,
} from '@szronox/contracts';

import { CoreError, idempotencyConflict, notFound, validationError } from '../core/errors.js';
import { type Actor, payloadHash } from '../core/repository.js';
import { type Database, pgErrorCode, PG_UNIQUE_VIOLATION, type Queryable } from '../db/client.js';

export const QUOTE_MAX = 400;
export const SOURCE_MAX = 120;
export const MINE_LIMIT = 20;
export const FEED_DEFAULT_LIMIT = 50;
export const FEED_MAX_LIMIT = 100;

const ROUTE = 'POST /live/messages';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: readonly LiveMessageKind[] = ['quote', 'signal', 'signal_cancel'];
const LEVELS: readonly LiveSignalLevel[] = ['urgent', 'moment'];

/**
 * Allowed status changes per kind. The PC may report only an outcome, so `sent` may jump to any
 * later state of its kind; terminal states have no successors.
 */
const TRANSITIONS: Record<LiveMessageKind, Partial<Record<LiveMessageStatus, readonly LiveMessageStatus[]>>> = {
  quote: {
    sent: ['delivered', 'waiting', 'shown', 'dismissed'],
    delivered: ['waiting', 'shown', 'dismissed'],
    waiting: ['shown', 'dismissed'],
  },
  signal: {
    sent: ['delivered', 'seen', 'expired', 'replaced'],
    delivered: ['seen', 'expired', 'replaced'],
  },
  signal_cancel: {
    sent: ['delivered'],
  },
};
const REPORTABLE: readonly LiveMessageStatus[] = ['delivered', 'waiting', 'shown', 'dismissed', 'seen', 'expired', 'replaced'];

interface Row {
  id: string;
  seq: string;
  kind: LiveMessageKind;
  text: string | null;
  source: string | null;
  level: LiveSignalLevel | null;
  status: LiveMessageStatus;
  status_at: unknown;
  created_at: unknown;
  author_name?: 'NOXAVA' | 'SZRON';
}

const COLUMNS = 'm.id, m.seq::text as seq, m.kind, m.text, m.source, m.level, m.status, m.status_at, m.created_at';
const iso = (value: unknown) => new Date(value as string).toISOString();

function toMessage(row: Row): LiveMessage {
  return {
    id: row.id, kind: row.kind, text: row.text, source: row.source, level: row.level, status: row.status,
    statusAt: row.status_at ? iso(row.status_at) : null, createdAt: iso(row.created_at),
  };
}

/** Normalise and validate a create request; returns exactly what is stored and hashed. */
export function parseCreate(body: unknown): { operationId: string; kind: LiveMessageKind; text: string | null; source: string | null; level: LiveSignalLevel | null } {
  const source = (body ?? {}) as Record<string, unknown>;
  if (typeof source.operationId !== 'string' || !UUID.test(source.operationId)) {
    throw validationError('operationId must be a UUID', { field: 'operationId' });
  }
  const kind = source.kind as LiveMessageKind;
  if (!KINDS.includes(kind)) throw validationError('Unknown live message kind', { field: 'kind' });
  const present = (field: string) => source[field] !== undefined && source[field] !== null;
  if (kind === 'quote') {
    if (typeof source.text !== 'string') throw validationError('A quote needs text', { field: 'text' });
    const text = source.text.trim();
    if (text.length < 1 || text.length > QUOTE_MAX) {
      throw validationError(`Quote text must be 1–${QUOTE_MAX} characters`, { field: 'text', max: QUOTE_MAX });
    }
    if (present('source') && typeof source.source !== 'string') throw validationError('source must be text', { field: 'source' });
    const quoteSource = typeof source.source === 'string' ? source.source.trim() : '';
    if (quoteSource.length > SOURCE_MAX) {
      throw validationError(`Source must be at most ${SOURCE_MAX} characters`, { field: 'source', max: SOURCE_MAX });
    }
    if (present('level')) throw validationError('A quote has no level', { field: 'level' });
    return { operationId: source.operationId, kind, text, source: quoteSource || null, level: null };
  }
  if (present('text') || present('source')) throw validationError('A signal has no text or source', { field: 'text' });
  if (kind === 'signal') {
    const level = source.level as LiveSignalLevel;
    if (!LEVELS.includes(level)) throw validationError('Signal level must be urgent or moment', { field: 'level' });
    return { operationId: source.operationId, kind, text: null, source: null, level };
  }
  if (present('level')) throw validationError('A cancel has no level', { field: 'level' });
  return { operationId: source.operationId, kind, text: null, source: null, level: null };
}

export class LiveRepository {
  constructor(private readonly db: Database) {}

  async create(actor: Actor, request: CreateLiveMessageRequest): Promise<LiveMessage> {
    const parsed = parseCreate(request);
    const { operationId, ...payload } = parsed;
    const hash = payloadHash(payload);
    const run = () => this.db.transaction(async (tx) => {
      const replay = await this.replay(tx, operationId, hash);
      if (replay) return replay;
      const inserted = await tx.query<Row>(
        `insert into app.live_messages as m (id, author_id, kind, text, source, level)
         values (gen_random_uuid(), $1, $2, $3, $4, $5) returning ${COLUMNS}`,
        [actor.id, parsed.kind, parsed.text, parsed.source, parsed.level],
      );
      const message = toMessage(inserted.rows[0]);
      await tx.query(
        `insert into app.operations (operation_id, actor_id, route, payload_hash, result) values ($1, $2, $3, $4, $5)`,
        [operationId, actor.id, ROUTE, hash, JSON.stringify(message)],
      );
      return message;
    });
    try {
      return await run();
    } catch (error) {
      // A concurrent duplicate lost the race on the ledger key: answer as a replay.
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
        const replay = await this.replay(this.db, operationId, hash);
        if (replay) return replay;
      }
      throw error;
    }
  }

  private async replay(tx: Queryable, operationId: string, hash: string): Promise<LiveMessage | null> {
    const existing = await tx.query<{ payload_hash: string; route: string; result: LiveMessage }>(
      'select payload_hash, route, result from app.operations where operation_id = $1', [operationId],
    );
    const row = existing.rows[0];
    if (!row) return null;
    if (row.route !== ROUTE || row.payload_hash !== hash) throw idempotencyConflict();
    return typeof row.result === 'string' ? JSON.parse(row.result) as LiveMessage : row.result;
  }

  /** The caller's own most recent messages, newest first. Never the other user's. */
  async listMine(actor: Actor): Promise<LiveMessage[]> {
    const result = await this.db.query<Row>(
      `select ${COLUMNS} from app.live_messages m where m.author_id = $1 order by m.seq desc limit $2`,
      [actor.id, MINE_LIMIT],
    );
    return result.rows.map(toMessage);
  }

  /**
   * Device feed: both users' messages after the cursor, oldest first. Without a cursor the
   * reader starts at "now", so a freshly started PC does not replay earlier broadcasts.
   */
  async feed(after: string | undefined, limit: number): Promise<LiveFeedResponse> {
    if (after === undefined) {
      const latest = await this.db.query<{ cursor: string }>(
        'select coalesce(max(seq), 0)::text as cursor from app.live_messages',
      );
      return { items: [], cursor: latest.rows[0].cursor };
    }
    const result = await this.db.query<Row>(
      `select ${COLUMNS}, u.name as author_name from app.live_messages m
       join app.users u on u.id = m.author_id
       where m.seq > $1::bigint order by m.seq asc limit $2`,
      [after, limit],
    );
    const items: LiveFeedItem[] = result.rows.map((row) => ({ ...toMessage(row), authorName: row.author_name! }));
    const last = result.rows[result.rows.length - 1];
    return { items, cursor: last ? last.seq : after };
  }

  /** Apply a status reported by the PC. Same status again is a no-op. */
  async setStatus(id: string, status: LiveMessageStatus, now: Date): Promise<void> {
    if (!UUID.test(id)) throw validationError('id must be a UUID', { field: 'id' });
    if (!REPORTABLE.includes(status)) throw validationError('Unknown status', { field: 'status' });
    await this.db.transaction(async (tx) => {
      const current = await tx.query<{ kind: LiveMessageKind; status: LiveMessageStatus }>(
        'select kind, status from app.live_messages where id = $1 for update', [id],
      );
      const row = current.rows[0];
      if (!row) throw notFound('Live message not found');
      if (row.status === status) return;
      if (!(TRANSITIONS[row.kind][row.status] ?? []).includes(status)) {
        throw new CoreError({
          status: 422, code: 'VALIDATION_ERROR', message: 'Status change not allowed',
          details: { reason: 'invalid_transition', from: row.status, to: status },
        });
      }
      await tx.query('update app.live_messages set status = $2, status_at = $3 where id = $1', [id, status, now.toISOString()]);
    });
  }
}

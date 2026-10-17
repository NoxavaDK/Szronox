/**
 * STREAM-PLAN-01: stream plans — the stream screen set up per broadcast, separate from Reels.
 *
 * A plan is one row whose topics are a JSON document edited as a whole: the screen autosaves the
 * plan with `expectedVersion`, and each mutation is idempotent on `operationId` through the same
 * operations ledger as every Reel mutation (`CoreRepository.idempotent`). A topic's `reelId` is a
 * live reference: the plan never copies or changes that Reel, it only reads its status.
 */

import type {
  CreateStreamPlanRequest, LiveStreamPlan, PublicationSlot, ReelStatus, SourceMetadata, CaptureInput,
  StreamPlan, StreamPlanCandidatesResponse, StreamPlanLink, StreamPlanSummary, StreamPlanTopic,
  StreamPlanTopicReel, UpdateStreamPlanRequest, StreamPlanLiveResponse, LiveStreamPositionResponse,
} from '@szronox/contracts';

import { CoreError, notFound, validationError } from '../core/errors.js';
import { type Actor, CoreRepository } from '../core/repository.js';
import type { Database, Queryable } from '../db/client.js';

/** T00 STREAM-PLAN-01 limits; they match StreamControl's agenda so an import never truncates. */
export const LIMITS = {
  title: 120, topics: 8, topicTitle: 180, extraLinks: 11, linkLabel: 120, link: 2000, points: 12, point: 200,
  highlights: 5, highlight: 300,
} as const;

/** How long a StreamControl report counts as fresh before the device's write is repeated. */
const PC_REPORT_REFRESH_SECONDS = 10;
/** Topic ids StreamControl reports: the plan's own ids (UUIDs), at most one per agenda topic. */
const TOPIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SESSION = /^[A-Za-z0-9_-]{1,64}$/;
/** Without a search term the picker shows the most recent work only. */
export const RECENT_CANDIDATES = 30;
export const SEARCH_CANDIDATES = 100;

interface PlanRow {
  id: string;
  title: string;
  scheduled_for: string | null;
  comments_session: string | null;
  topics: StreamPlanTopic[] | string;
  is_current: boolean;
  version: number;
  created_at: unknown;
  updated_at: unknown;
}

const COLUMNS = `id, title, to_char(scheduled_for, 'YYYY-MM-DD') as scheduled_for, comments_session, topics,
  is_current, version, created_at, updated_at`;
const iso = (value: unknown) => new Date(value as string).toISOString();
// Topics saved before STREAM-PLAN-02 have no highlights; they read as empty lists.
const topicsOf = (row: PlanRow): StreamPlanTopic[] => (typeof row.topics === 'string' ? JSON.parse(row.topics) as StreamPlanTopic[] : row.topics)
  .map((topic) => ({
    ...topic,
    mainHighlights: topic.mainHighlights ?? [],
    extraLinks: topic.extraLinks.map((link) => ({ ...link, highlights: link.highlights ?? [] })),
  }));

/** A plan as the streaming PC sees it: broadcast content only, no Reel ids or Reel data. */
function devicePlan(row: PlanRow): LiveStreamPlan {
  return {
    id: row.id, title: row.title, scheduledFor: row.scheduled_for, version: row.version, updatedAt: iso(row.updated_at),
    topics: topicsOf(row).map(({ id, title, mainLink, mainHighlights, extraLinks, points }) => ({ id, title, mainLink, mainHighlights, extraLinks, points })),
  };
}

/** Plans have their own version, but a stale write is the same 409 every editor already handles. */
function planConflict(currentVersion: number) {
  return new CoreError({ status: 409, code: 'EDIT_CONFLICT', message: 'Stream plan was modified by another write', currentVersion });
}

// ── Validation ─────────────────────────────────────────────────────────────────

function text(value: unknown, field: string, max: number, options: { required: boolean }): string {
  if (typeof value !== 'string') throw validationError(`${field} must be text`, { field });
  const trimmed = value.trim();
  if ((options.required && trimmed.length < 1) || trimmed.length > max) {
    throw validationError(`${field} must be ${options.required ? 1 : 0}–${max} characters`, { field, max });
  }
  return trimmed;
}

export function parseTitle(value: unknown): string {
  return text(value, 'title', LIMITS.title, { required: true });
}

export function parseDate(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !DATE.test(value)) throw validationError('scheduledFor must be YYYY-MM-DD', { field: 'scheduledFor' });
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw validationError('scheduledFor must be a real date', { field: 'scheduledFor' });
  }
  return value;
}

function parseSession(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw validationError('commentsSession must be text', { field: 'commentsSession' });
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!SESSION.test(trimmed)) {
    throw validationError('commentsSession must be a Social Stream Ninja session ID (letters, digits, - and _)', { field: 'commentsSession' });
  }
  return trimmed;
}

function parseLink(value: unknown, field: string): string {
  if (typeof value !== 'string') throw validationError(`${field} must be a link`, { field });
  const trimmed = value.trim();
  let parsed: URL | null = null;
  try { parsed = new URL(trimmed); } catch { /* reported below */ }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || trimmed.length > LIMITS.link) {
    throw validationError(`${field} must be a full http(s) link of at most ${LIMITS.link} characters`, { field });
  }
  return trimmed;
}

function parseHighlights(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validationError(`${field} must be a list`, { field });
  // Blank lines are a half-typed entry in the editor, not content: dropped, like points.
  const highlights = value
    .map((entry, position) => text(entry, `${field}[${position}]`, LIMITS.highlight, { required: false }).replace(/\s+/g, ' '))
    .filter((entry) => entry !== '');
  if (highlights.length > LIMITS.highlights) throw validationError(`At most ${LIMITS.highlights} passages to highlight per link`, { field, max: LIMITS.highlights });
  return highlights;
}

function parseTopic(value: unknown, index: number): StreamPlanTopic {
  const at = (field: string) => `topics[${index}].${field}`;
  if (typeof value !== 'object' || value === null) throw validationError('Each topic must be an object', { field: `topics[${index}]` });
  const topic = value as Record<string, unknown>;
  if (typeof topic.id !== 'string' || !UUID.test(topic.id)) throw validationError('Topic id must be a UUID', { field: at('id') });
  if (topic.reelId !== null && (typeof topic.reelId !== 'string' || !UUID.test(topic.reelId))) {
    throw validationError('reelId must be a UUID or null', { field: at('reelId') });
  }
  const mainLink = topic.mainLink === null || topic.mainLink === undefined || topic.mainLink === ''
    ? null : parseLink(topic.mainLink, at('mainLink'));
  if (!Array.isArray(topic.extraLinks) || topic.extraLinks.length > LIMITS.extraLinks) {
    throw validationError(`At most ${LIMITS.extraLinks} extra links per topic`, { field: at('extraLinks'), max: LIMITS.extraLinks });
  }
  const extraLinks: StreamPlanLink[] = topic.extraLinks.map((link, position) => {
    const entry = (link ?? {}) as Record<string, unknown>;
    return {
      url: parseLink(entry.url, at(`extraLinks[${position}].url`)),
      label: text(entry.label ?? '', at(`extraLinks[${position}].label`), LIMITS.linkLabel, { required: false }),
      highlights: parseHighlights(entry.highlights, at(`extraLinks[${position}].highlights`)),
    };
  });
  if (!Array.isArray(topic.points)) throw validationError('points must be a list', { field: at('points') });
  // Blank points are a half-typed line in the editor, not content: they are dropped, not refused.
  const points = topic.points
    .map((point, position) => text(point, at(`points[${position}]`), LIMITS.point, { required: false }))
    .filter((point) => point !== '');
  if (points.length > LIMITS.points) {
    throw validationError(`At most ${LIMITS.points} points per topic`, { field: at('points'), max: LIMITS.points });
  }
  return {
    id: topic.id.toLowerCase(),
    reelId: typeof topic.reelId === 'string' ? topic.reelId.toLowerCase() : null,
    title: text(topic.title, at('title'), LIMITS.topicTitle, { required: true }),
    mainLink,
    mainHighlights: mainLink ? parseHighlights(topic.mainHighlights, at('mainHighlights')) : [],
    extraLinks,
    points,
  };
}

export function parseTopics(value: unknown): StreamPlanTopic[] {
  if (!Array.isArray(value) || value.length > LIMITS.topics) {
    throw validationError(`A stream plan has at most ${LIMITS.topics} topics`, { field: 'topics', max: LIMITS.topics });
  }
  const topics = value.map(parseTopic);
  if (new Set(topics.map((topic) => topic.id)).size !== topics.length) {
    throw validationError('Topic ids must be unique', { field: 'topics', reason: 'duplicate_topic' });
  }
  const reels = topics.map((topic) => topic.reelId).filter((id): id is string => id !== null);
  if (new Set(reels).size !== reels.length) {
    throw validationError('A Reel can be a topic only once per plan', { field: 'topics', reason: 'duplicate_reel' });
  }
  return topics;
}

export function parseUpdate(body: unknown): Omit<UpdateStreamPlanRequest, 'operationId' | 'expectedVersion'> {
  const source = (body ?? {}) as Record<string, unknown>;
  return {
    title: parseTitle(source.title),
    scheduledFor: parseDate(source.scheduledFor),
    commentsSession: parseSession(source.commentsSession),
    topics: parseTopics(source.topics),
  };
}

// ── Repository ─────────────────────────────────────────────────────────────────

export class StreamPlansRepository {
  constructor(private readonly db: Database, private readonly core: CoreRepository) {}

  private async lock(tx: Queryable, id: string): Promise<PlanRow> {
    const rows = await tx.query<PlanRow>(`select ${COLUMNS} from app.stream_plans where id = $1 and deleted_at is null for update`, [id]);
    const row = rows.rows[0];
    if (!row) throw notFound('Stream plan not found');
    return row;
  }

  private async view(tx: Queryable, row: PlanRow): Promise<StreamPlan> {
    const topics = topicsOf(row);
    const ids = topics.map((topic) => topic.reelId).filter((id): id is string => id !== null);
    const reels = new Map<string, StreamPlanTopicReel>();
    if (ids.length > 0) {
      const found = await tx.query<{ id: string; status: ReelStatus; deleted_at: unknown }>(
        'select id, status, deleted_at from app.reels where id = any($1::uuid[])', [ids],
      );
      for (const reel of found.rows) reels.set(reel.id, { id: reel.id, status: reel.status, deleted: reel.deleted_at !== null });
    }
    return {
      id: row.id,
      title: row.title,
      scheduledFor: row.scheduled_for,
      commentsSession: row.comments_session,
      isCurrent: row.is_current,
      topics: topics.map((topic) => ({ ...topic, reel: topic.reelId ? reels.get(topic.reelId) ?? null : null })),
      version: row.version,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  /** Every referenced Reel must exist and be a Reel, not a STREAM-01 stream. Deleted ones may stay. */
  private async checkReels(tx: Queryable, topics: readonly StreamPlanTopic[], before: readonly StreamPlanTopic[]): Promise<void> {
    const kept = new Set(before.map((topic) => topic.reelId));
    // A reference already in the plan stays valid even if its Reel was deleted since.
    const added = topics.map((topic) => topic.reelId).filter((id): id is string => id !== null && !kept.has(id));
    if (added.length === 0) return;
    const found = await tx.query<{ id: string; format: string; absorbed_into: string | null; deleted_at: unknown }>(
      'select id, format, absorbed_into, deleted_at from app.reels where id = any($1::uuid[])', [added],
    );
    const byId = new Map(found.rows.map((row) => [row.id, row]));
    for (const id of added) {
      const reel = byId.get(id);
      if (!reel || reel.format !== 'reel' || reel.absorbed_into !== null || reel.deleted_at !== null) {
        throw validationError('A topic can only be picked from an existing Reel', { field: 'topics', reason: 'reel_unavailable', reelId: id });
      }
    }
  }

  async list(): Promise<StreamPlanSummary[]> {
    const rows = await this.db.query<PlanRow>(
      `select ${COLUMNS} from app.stream_plans where deleted_at is null
       order by scheduled_for desc nulls last, created_at desc limit 100`,
    );
    return rows.rows.map((row) => ({
      id: row.id, title: row.title, scheduledFor: row.scheduled_for, isCurrent: row.is_current,
      topicCount: topicsOf(row).length, updatedAt: iso(row.updated_at),
    }));
  }

  async get(id: string): Promise<StreamPlan> {
    const rows = await this.db.query<PlanRow>(`select ${COLUMNS} from app.stream_plans where id = $1 and deleted_at is null`, [id]);
    const row = rows.rows[0];
    if (!row) throw notFound('Stream plan not found');
    return this.view(this.db, row);
  }

  async create(actor: Actor, request: CreateStreamPlanRequest): Promise<StreamPlan> {
    const payload = { id: request.id.toLowerCase(), title: parseTitle(request.title), scheduledFor: parseDate(request.scheduledFor) };
    return this.core.idempotent(actor, request.operationId, 'POST /stream-plans', payload, async (tx) => {
      const exists = await tx.query('select 1 from app.stream_plans where id = $1', [payload.id]);
      if (exists.rows.length > 0) throw validationError('A stream plan with this id already exists', { field: 'id', reason: 'id_taken' });
      const rows = await tx.query<PlanRow>(
        `insert into app.stream_plans (id, title, scheduled_for, created_by) values ($1, $2, $3, $4) returning ${COLUMNS}`,
        [payload.id, payload.title, payload.scheduledFor, actor.id],
      );
      return this.view(tx, rows.rows[0]);
    });
  }

  async update(actor: Actor, id: string, request: UpdateStreamPlanRequest): Promise<StreamPlan> {
    const fields = parseUpdate(request);
    const payload = { id, expectedVersion: request.expectedVersion, ...fields };
    return this.core.idempotent(actor, request.operationId, 'PUT /stream-plans/:id', payload, async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== request.expectedVersion) throw planConflict(before.version);
      await this.checkReels(tx, fields.topics, topicsOf(before));
      const rows = await tx.query<PlanRow>(
        `update app.stream_plans set title = $2, scheduled_for = $3, comments_session = $4, topics = $5::jsonb,
           version = version + 1, updated_at = now()
         where id = $1 returning ${COLUMNS}`,
        [id, fields.title, fields.scheduledFor, fields.commentsSession, JSON.stringify(fields.topics)],
      );
      return this.view(tx, rows.rows[0]);
    });
  }

  /** Marking a plan current unmarks the previous one: StreamControl imports exactly one. */
  async setCurrent(actor: Actor, id: string, request: { operationId: string; expectedVersion: number; current: boolean }): Promise<StreamPlan> {
    if (typeof request.current !== 'boolean') throw validationError('current must be true or false', { field: 'current' });
    const payload = { id, expectedVersion: request.expectedVersion, current: request.current };
    return this.core.idempotent(actor, request.operationId, 'PUT /stream-plans/:id/current', payload, async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== request.expectedVersion) throw planConflict(before.version);
      if (request.current) {
        await tx.query('update app.stream_plans set is_current = false, updated_at = now() where is_current and id <> $1', [id]);
      }
      const rows = await tx.query<PlanRow>(
        `update app.stream_plans set is_current = $2, version = version + 1, updated_at = now() where id = $1 returning ${COLUMNS}`,
        [id, request.current],
      );
      return this.view(tx, rows.rows[0]);
    });
  }

  async remove(actor: Actor, id: string, request: { operationId: string; expectedVersion: number }): Promise<{ id: string }> {
    const payload = { id, expectedVersion: request.expectedVersion };
    return this.core.idempotent(actor, request.operationId, 'DELETE /stream-plans/:id', payload, async (tx) => {
      const before = await this.lock(tx, id);
      if (before.version !== request.expectedVersion) throw planConflict(before.version);
      await tx.query(
        'update app.stream_plans set deleted_at = now(), is_current = false, version = version + 1, updated_at = now() where id = $1', [id],
      );
      return { id };
    });
  }

  /** Recent Reels to pick a topic from: newest work first, the same search as STREAM-01's picker. */
  async candidates(q: string | undefined): Promise<StreamPlanCandidatesResponse> {
    const query = (q ?? '').trim();
    const escaped = query.replace(/[\\%_]/g, (character) => `\\${character}`);
    const rows = await this.db.query<{
      id: string; title: string; status: ReelStatus;
      planned_publication_date: string | null; planned_publication_slot: PublicationSlot | null;
      original_input: CaptureInput; script: string; selected_hook_text: string | null;
      source_metadata: SourceMetadata | null; source_link: string | null;
    }>(
      `select r.id, r.title, r.status,
              to_char(r.planned_publication_date, 'YYYY-MM-DD') as planned_publication_date,
              r.planned_publication_slot, r.original_input, r.script, r.source_metadata, r.source_link,
              h.text as selected_hook_text
       from app.reels r
       left join app.reel_hooks h on h.id = r.selected_hook_id
       where r.format = 'reel' and r.deleted_at is null and r.absorbed_into is null
         and (r.title ilike $1 or r.input_note ilike $1 or r.script ilike $1
              or r.original_input::text ilike $1 or coalesce(h.text, '') ilike $1
              or coalesce(r.source_metadata->>'headline', '') ilike $1)
       order by r.updated_at desc, r.id asc
       limit $2`,
      [`%${escaped}%`, query === '' ? RECENT_CANDIDATES : SEARCH_CANDIDATES],
    );
    return {
      items: rows.rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        plannedPublicationDate: row.planned_publication_date ?? null,
        plannedPublicationSlot: row.planned_publication_slot ?? null,
        originalInput: row.original_input,
        script: row.script,
        selectedHookText: row.selected_hook_text ?? null,
        sourceMetadata: row.source_metadata ?? null,
        sourceLink: row.source_link ?? null,
      })),
    };
  }

  // ── STREAM-PLAN-02: switching topics from the screen ─────────────────────────

  /** Live state for the stream screen: the latest cue and what the streaming PC last reported. */
  async live(id: string): Promise<StreamPlanLiveResponse> {
    const rows = await this.db.query<{
      cue_seq: number; cue_topic_id: string | null; cued_at: unknown;
      on_air_topic_id: string | null; pc_topic_ids: string[] | string; pc_seen_at: unknown;
    }>(
      `select cue_seq, cue_topic_id, cued_at, on_air_topic_id, pc_topic_ids, pc_seen_at
       from app.stream_plans where id = $1 and deleted_at is null`, [id],
    );
    const row = rows.rows[0];
    if (!row) throw notFound('Stream plan not found');
    const topicIds = typeof row.pc_topic_ids === 'string' ? JSON.parse(row.pc_topic_ids) as string[] : row.pc_topic_ids;
    return {
      cue: row.cue_seq > 0 && row.cue_topic_id && row.cued_at ? { seq: row.cue_seq, topicId: row.cue_topic_id, at: iso(row.cued_at) } : null,
      pc: row.pc_seen_at ? { topicId: row.on_air_topic_id, topicIds, seenAt: iso(row.pc_seen_at) } : null,
    };
  }

  /**
   * Put a topic on air: a cue the streaming PC applies on its next poll. Not version-checked and
   * no version bump — it never changes the plan's content, so it cannot collide with autosave.
   */
  async cue(actor: Actor, id: string, request: { operationId: string; topicId: unknown }): Promise<StreamPlanLiveResponse> {
    if (typeof request.topicId !== 'string' || !TOPIC_ID.test(request.topicId)) {
      throw validationError('topicId must be a topic id of this plan', { field: 'topicId' });
    }
    const topicId = request.topicId.toLowerCase();
    await this.core.idempotent(actor, request.operationId, 'PUT /stream-plans/:id/cue', { id, topicId }, async (tx) => {
      const before = await this.lock(tx, id);
      if (!topicsOf(before).some((topic) => topic.id === topicId)) {
        throw validationError('topicId must be a topic id of this plan', { field: 'topicId', reason: 'unknown_topic' });
      }
      await tx.query('update app.stream_plans set cue_seq = cue_seq + 1, cue_topic_id = $2, cued_at = now() where id = $1', [id, topicId]);
      return { id, topicId };
    });
    return this.live(id);
  }

  /**
   * Device report from StreamControl for the plan it imported, answered with that plan's latest
   * cue (seq 0 before any; StreamControl takes its first answer as the baseline). Null when the
   * plan no longer exists. The row is rewritten only when the report changed or has gone stale,
   * so a 2-second poll does not mean a write every 2 seconds.
   */
  async reportPosition(body: unknown): Promise<LiveStreamPositionResponse> {
    const source = (body ?? {}) as Record<string, unknown>;
    if (typeof source.planId !== 'string' || !UUID.test(source.planId)) throw validationError('planId must be a UUID', { field: 'planId' });
    const topicId = source.topicId;
    if (topicId !== null && (typeof topicId !== 'string' || !TOPIC_ID.test(topicId))) {
      throw validationError('topicId must be a topic id or null', { field: 'topicId' });
    }
    const topicIds = source.topicIds;
    if (!Array.isArray(topicIds) || topicIds.length > LIMITS.topics || !topicIds.every((value) => typeof value === 'string' && TOPIC_ID.test(value))) {
      throw validationError(`topicIds must be at most ${LIMITS.topics} topic ids`, { field: 'topicIds' });
    }
    const planId = source.planId.toLowerCase();
    const ids = topicIds.map((value) => (value as string).toLowerCase());
    const onAir = typeof topicId === 'string' ? topicId.toLowerCase() : null;
    await this.db.query(
      `update app.stream_plans set on_air_topic_id = $2, pc_topic_ids = $3::jsonb, pc_seen_at = now()
       where id = $1 and deleted_at is null
         and (on_air_topic_id is distinct from $2 or pc_topic_ids <> $3::jsonb or pc_seen_at is null
              or pc_seen_at < now() - make_interval(secs => $4))`,
      [planId, onAir, JSON.stringify(ids), PC_REPORT_REFRESH_SECONDS],
    );
    const rows = await this.db.query<PlanRow & { cue_seq: number; cue_topic_id: string | null }>(
      `select ${COLUMNS}, cue_seq, cue_topic_id from app.stream_plans where id = $1 and deleted_at is null`, [planId],
    );
    const row = rows.rows[0];
    if (!row) return { cue: null };
    const answer: LiveStreamPositionResponse = { cue: { seq: row.cue_seq, topicId: row.cue_topic_id } };
    // Edits made after the import reach the PC with this answer, so nobody presses download again.
    if (source.version !== row.version) answer.plan = devicePlan(row);
    return answer;
  }

  /** Device read for StreamControl: the current plan's broadcast content, nothing about Reels. */
  async currentForDevice(): Promise<LiveStreamPlan | null> {
    const rows = await this.db.query<PlanRow>(`select ${COLUMNS} from app.stream_plans where is_current and deleted_at is null`);
    const row = rows.rows[0];
    return row ? devicePlan(row) : null;
  }
}

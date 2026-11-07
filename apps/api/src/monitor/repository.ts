import { createHash, randomUUID } from 'node:crypto';

import type {
  CreateMonitorSourceRequest,
  MonitorCollectSource,
  MonitorCollectSourcesResponse,
  MonitorPlatform,
  MonitorPost,
  MonitorPostBatchResponse,
  MonitorReport,
  MonitorReportSourceStatus,
  MonitorRunFinishRequest,
  MonitorSource,
  MonitorSourcePatchRequest,
  MonitorSourceStatus,
  MonitorSynthesis,
} from '@szronox/contracts';

import { editConflict, notFound, unauthenticated, validationError } from '../core/errors.js';
import { CoreRepository, type Actor } from '../core/repository.js';
import { PG_UNIQUE_VIOLATION, pgErrorCode, type Database, type Queryable } from '../db/client.js';
import { canonicalPostUrl } from './canonical-url.js';

const PROMPT_ID = 'monitor-provisional-v1';
const DEFAULT_MODEL = 'gemini-3.8-flash';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_STATUSES: readonly MonitorSourceStatus[] = ['ok', 'login_wall', 'parse_failure', 'error'];

function validUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw validationError(`${field} must be a UUID`, { field });
  return value;
}

function asIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(value as string).toISOString();
}

function asJson<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return (value ?? fallback) as T;
}

function sourceFrom(row: Record<string, unknown>): MonitorSource {
  return {
    id: String(row.id), name: String(row.name), groupLabel: String(row.group_label),
    platform: row.platform as MonitorPlatform, profileUrl: String(row.profile_url),
    active: row.active === true, version: Number(row.version), createdBy: String(row.created_by),
    createdAt: asIso(row.created_at), updatedAt: asIso(row.updated_at),
    lastCollectedAt: row.last_collected_at ? asIso(row.last_collected_at) : null,
    lastStatus: (row.last_status as MonitorSourceStatus | null) ?? null,
    lastStatusAt: row.last_status_at ? asIso(row.last_status_at) : null,
  };
}

function postFrom(row: Record<string, unknown>): MonitorPost {
  return {
    id: String(row.id), sourceId: String(row.source_id), sourceName: String(row.source_name),
    groupLabel: String(row.group_label), platform: row.platform as MonitorPlatform,
    url: String(row.url), author: String(row.author ?? ''),
    publishedAt: row.published_at ? asIso(row.published_at) : null,
    text: String(row.text ?? ''), media: asJson<string[]>(row.media, []),
    engagement: asJson<Record<string, string>>(row.engagement, {}),
    isRepost: row.is_repost === true, isPinned: row.is_pinned === true,
    firstSeenAt: asIso(row.first_seen_at), lastSeenAt: asIso(row.last_seen_at),
    reelId: (row.reel_id as string | null) ?? null,
  };
}

function validateProfileUrl(value: unknown): string {
  if (typeof value !== 'string') throw validationError('profileUrl must be a full HTTPS URL', { field: 'profileUrl' });
  const profileUrl = value.trim();
  try {
    const parsed = new URL(profileUrl);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || profileUrl.length > 2048) {
      throw new Error('invalid profile URL');
    }
  } catch {
    throw validationError('profileUrl must be a full HTTPS URL of at most 2048 characters', { field: 'profileUrl' });
  }
  return profileUrl;
}

function validateText(value: unknown, field: 'name' | 'groupLabel', max: number): string {
  if (typeof value !== 'string') throw validationError(`${field} must be text`, { field });
  const text = value.trim();
  if (text.length < 1 || text.length > max) throw validationError(`${field} must be 1–${max} characters`, { field });
  return text;
}

function reportDayIsValid(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

interface PostCursor { firstSeenAt: string; seq: string }
function decodeCursor(value: string): PostCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<PostCursor>;
    if (typeof parsed.firstSeenAt !== 'string' || Number.isNaN(Date.parse(parsed.firstSeenAt))
      || typeof parsed.seq !== 'string' || !/^\d{1,20}$/.test(parsed.seq)) throw new Error('bad cursor');
    return { firstSeenAt: new Date(parsed.firstSeenAt).toISOString(), seq: parsed.seq };
  } catch {
    throw validationError('before must be a cursor returned by the monitor post list', { field: 'before' });
  }
}

function encodeCursor(row: { first_seen_at: unknown; seq: unknown }): string {
  return Buffer.from(JSON.stringify({ firstSeenAt: asIso(row.first_seen_at), seq: String(row.seq) }), 'utf8').toString('base64url');
}

interface ValidPost {
  url: string;
  author: string;
  publishedAt: string | null;
  text: string;
  media: string[];
  engagement: Record<string, string>;
  isRepost: boolean;
  isPinned: boolean;
  contentHash: string;
}

function validatePost(input: unknown, platform: MonitorPlatform): { post: ValidPost } | { reason: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { reason: 'invalid_post' };
  const row = input as Record<string, unknown>;
  const canonical = canonicalPostUrl(row.url, platform);
  if (!canonical.ok) return { reason: canonical.reason };
  if (typeof row.author !== 'string' || row.author.length > 300) return { reason: 'invalid_author' };
  if (typeof row.text !== 'string' || row.text.length > 20_000) return { reason: 'invalid_text' };
  if (!Array.isArray(row.media) || row.media.length > 20
    || !row.media.every((item) => typeof item === 'string' && item.length <= 2048 && /^https:\/\//i.test(item))) {
    return { reason: 'invalid_media' };
  }
  let publishedAt: string | null = null;
  if (row.publishedAt !== null) {
    if (typeof row.publishedAt !== 'string' || Number.isNaN(Date.parse(row.publishedAt))) return { reason: 'invalid_published_at' };
    publishedAt = new Date(row.publishedAt).toISOString();
  }
  if (!row.engagement || typeof row.engagement !== 'object' || Array.isArray(row.engagement)) return { reason: 'invalid_engagement' };
  const engagement = row.engagement as Record<string, unknown>;
  const entries = Object.entries(engagement);
  if (entries.length > 8 || entries.some(([key, value]) => key.length < 1 || key.length > 40 || typeof value !== 'string' || value.length > 40)) {
    return { reason: 'invalid_engagement' };
  }
  if (typeof row.isRepost !== 'boolean' || typeof row.isPinned !== 'boolean') return { reason: 'invalid_flags' };
  const media = (row.media as string[]).slice();
  const contentHash = createHash('sha256').update(JSON.stringify({ text: row.text, media: [...media].sort() }), 'utf8').digest('hex');
  return {
    post: {
      url: canonical.url, author: row.author, publishedAt, text: row.text,
      media, engagement: engagement as Record<string, string>,
      isRepost: row.isRepost, isPinned: row.isPinned, contentHash,
    },
  };
}

export class MonitorRepository {
  private readonly core: CoreRepository;

  constructor(private readonly db: Database, core?: CoreRepository) {
    this.core = core ?? new CoreRepository(db);
  }

  async listSources(): Promise<MonitorSource[]> {
    const rows = await this.db.query<Record<string, unknown>>(
      `select id,name,group_label,platform,profile_url,active,version,created_by,created_at,updated_at,
              last_collected_at,last_status,last_status_at
         from app.monitor_sources
        order by active desc, group_label collate "C", name collate "C", id`,
    );
    return rows.rows.map(sourceFrom);
  }

  async createSource(actor: Actor, request: CreateMonitorSourceRequest): Promise<MonitorSource> {
    const sourceId = validUuid(request.sourceId, 'sourceId');
    const operationId = validUuid(request.operationId, 'operationId');
    const name = validateText(request.name, 'name', 120);
    const groupLabel = validateText(request.groupLabel, 'groupLabel', 80);
    if (request.platform !== 'facebook' && request.platform !== 'x') throw validationError('platform must be facebook or x', { field: 'platform' });
    const profileUrl = validateProfileUrl(request.profileUrl);
    try {
      return await this.core.idempotent(actor, operationId, 'POST /monitor/sources',
        { sourceId, name, groupLabel, platform: request.platform, profileUrl }, async (tx) => {
          const rows = await tx.query<Record<string, unknown>>(
            `insert into app.monitor_sources (id,name,group_label,platform,profile_url,created_by)
             values ($1,$2,$3,$4,$5,$6)
             returning id,name,group_label,platform,profile_url,active,version,created_by,created_at,updated_at,
                       last_collected_at,last_status,last_status_at`,
            [sourceId, name, groupLabel, request.platform, profileUrl, actor.id],
          );
          return sourceFrom(rows.rows[0]);
        });
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw validationError('A source with this profile URL already exists', { reason: 'duplicate_profile' });
      throw error;
    }
  }

  async patchSource(actor: Actor, sourceIdValue: string, request: MonitorSourcePatchRequest): Promise<MonitorSource> {
    const sourceId = validUuid(sourceIdValue, 'id');
    const operationId = validUuid(request.operationId, 'operationId');
    if (!Number.isInteger(request.expectedVersion) || request.expectedVersion < 1) {
      throw validationError('expectedVersion must be a positive integer', { field: 'expectedVersion' });
    }
    const changes = request.changes as Record<string, unknown>;
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw validationError('changes is required');
    const allowed = ['name', 'groupLabel', 'profileUrl', 'active'];
    const keys = Object.keys(changes);
    if (keys.length === 0 || keys.some((key) => !allowed.includes(key))) throw validationError('changes must include an editable source field');
    const normalized: Record<string, unknown> = {};
    if (Object.hasOwn(changes, 'name')) normalized.name = validateText(changes.name, 'name', 120);
    if (Object.hasOwn(changes, 'groupLabel')) normalized.group_label = validateText(changes.groupLabel, 'groupLabel', 80);
    if (Object.hasOwn(changes, 'profileUrl')) normalized.profile_url = validateProfileUrl(changes.profileUrl);
    if (Object.hasOwn(changes, 'active')) {
      if (typeof changes.active !== 'boolean') throw validationError('active must be boolean', { field: 'active' });
      normalized.active = changes.active;
    }

    try {
      return await this.core.idempotent(actor, operationId, `PATCH /monitor/sources/${sourceId}`,
        { sourceId, expectedVersion: request.expectedVersion, changes: normalized }, async (tx) => {
          const setSql = Object.keys(normalized).map((key, index) => `${key}=$${index + 3}`).join(', ');
          const values = Object.values(normalized);
          const updated = await tx.query<Record<string, unknown>>(
            `update app.monitor_sources set ${setSql}, version=version+1, updated_at=now()
              where id=$1 and version=$2
              returning id,name,group_label,platform,profile_url,active,version,created_by,created_at,updated_at,
                        last_collected_at,last_status,last_status_at`,
            [sourceId, request.expectedVersion, ...values],
          );
          if (updated.rows[0]) return sourceFrom(updated.rows[0]);
          const current = await tx.query<{ version: number }>('select version from app.monitor_sources where id=$1', [sourceId]);
          if (!current.rows[0]) throw notFound('Monitor source not found');
          throw editConflict(current.rows[0].version);
        });
    } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw validationError('A source with this profile URL already exists', { reason: 'duplicate_profile' });
      throw error;
    }
  }

  async listCollectSources(limit: number): Promise<MonitorCollectSourcesResponse> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 20);
    const rows = await this.db.query<{ id: string; platform: MonitorPlatform; profile_url: string; known_urls: string[] }>(
      `select s.id,s.platform,s.profile_url,
              coalesce((select array_agg(p.url order by p.first_seen_at desc,p.seq desc)
                from (select url,first_seen_at,seq from app.monitor_posts where source_id=s.id
                      order by first_seen_at desc,seq desc limit 20) p), '{}'::text[]) as known_urls
         from app.monitor_sources s where s.active=true
        order by s.last_collected_at nulls first,s.created_at,s.id limit $1`, [bounded],
    );
    return { items: rows.rows.map((row): MonitorCollectSource => ({
      id: row.id, platform: row.platform, profileUrl: row.profile_url, knownUrls: row.known_urls ?? [],
    })) };
  }

  async startRun(accessKeyId: string, runIdValue: string): Promise<{ runId: string; startedAt: string }> {
    const runId = validUuid(runIdValue, 'runId');
    const accessKey = validUuid(accessKeyId, 'accessKeyId');
    return this.db.transaction(async (tx) => {
      await tx.query(
        `insert into app.monitor_runs (id,access_key_id) values ($1,$2)
         on conflict (id) do nothing`, [runId, accessKey],
      );
      const row = await tx.query<{ id: string; access_key_id: string; started_at: unknown }>(
        'select id,access_key_id,started_at from app.monitor_runs where id=$1', [runId],
      );
      if (!row.rows[0] || row.rows[0].access_key_id !== accessKey) throw unauthenticated();
      return { runId: row.rows[0].id, startedAt: asIso(row.rows[0].started_at) };
    });
  }

  async addPostBatch(accessKeyId: string, runIdValue: string, sourceIdValue: string, inputs: unknown[]): Promise<MonitorPostBatchResponse> {
    if (!Array.isArray(inputs) || inputs.length > 100) throw validationError('posts must be an array with at most 100 items', { field: 'posts' });
    const runId = validUuid(runIdValue, 'runId');
    const sourceId = validUuid(sourceIdValue, 'sourceId');
    const sourceInfo = await this.db.query<{ platform: MonitorPlatform; active: boolean }>(
      'select platform,active from app.monitor_sources where id=$1', [sourceId],
    );
    if (!sourceInfo.rows[0] || !sourceInfo.rows[0].active) throw validationError('The monitor source is not active', { reason: 'source_inactive' });
    const valid: Array<{ index: number; post: ValidPost }> = [];
    const rejected: Array<{ index: number; reason: string }> = [];
    for (let index = 0; index < inputs.length; index += 1) {
      const result = validatePost(inputs[index], sourceInfo.rows[0].platform);
      if (!('post' in result)) rejected.push({ index, reason: result.reason });
      else valid.push({ index, post: result.post });
    }
    return this.db.transaction(async (tx) => {
      const run = await tx.query<{ access_key_id: string; finished_at: unknown }>(
        'select access_key_id,finished_at from app.monitor_runs where id=$1 for update', [runId],
      );
      if (!run.rows[0] || run.rows[0].access_key_id !== accessKeyId) throw unauthenticated();
      if (run.rows[0].finished_at) throw validationError('The monitor run is already finished', { reason: 'run_finished' });
      const source = await tx.query<{ active: boolean }>(
        'select platform,active from app.monitor_sources where id=$1 for share', [sourceId],
      );
      if (!source.rows[0] || !source.rows[0].active) throw validationError('The monitor source is not active', { reason: 'source_inactive' });
      let inserted = 0; let updated = 0; let unchanged = 0;
      for (const { post: item } of valid) {
        const added = await tx.query<{ id: string }>(
          `insert into app.monitor_posts
             (id,source_id,url,author,published_at,text,media,engagement,is_repost,is_pinned,content_hash)
           values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11)
           on conflict (url) do nothing returning id`,
          [randomUUID(), sourceId, item.url, item.author, item.publishedAt, item.text,
            JSON.stringify(item.media), JSON.stringify(item.engagement), item.isRepost, item.isPinned, item.contentHash],
        );
        if (added.rows[0]) { inserted += 1; continue; }
        const existing = await tx.query<{ id: string; content_hash: string }>(
          'select id,content_hash from app.monitor_posts where url=$1 for update', [item.url],
        );
        if (!existing.rows[0]) throw new Error('post upsert lost a conflicting row');
        if (existing.rows[0].content_hash === item.contentHash) {
          await tx.query('update app.monitor_posts set last_seen_at=now() where id=$1', [existing.rows[0].id]);
          unchanged += 1;
        } else {
          await tx.query(
            `update app.monitor_posts set author=$2,published_at=$3,text=$4,media=$5::jsonb,engagement=$6::jsonb,
                    is_repost=$7,is_pinned=$8,content_hash=$9,content_changed_at=now(),last_seen_at=now()
              where id=$1`,
            [existing.rows[0].id, item.author, item.publishedAt, item.text, JSON.stringify(item.media),
              JSON.stringify(item.engagement), item.isRepost, item.isPinned, item.contentHash],
          );
          updated += 1;
        }
      }
      return { inserted, updated, unchanged, rejected: rejected.sort((a, b) => a.index - b.index) };
    });
  }

  async finishRun(accessKeyId: string, runIdValue: string, request: MonitorRunFinishRequest): Promise<boolean> {
    const runId = validUuid(runIdValue, 'runId');
    const accessKey = validUuid(accessKeyId, 'accessKeyId');
    if (!Array.isArray(request.results)) throw validationError('results must be an array', { field: 'results' });
    const sourceIds = new Set<string>();
    const results = request.results.map((item, index) => {
      const sourceId = validUuid(item.sourceId, `results[${index}].sourceId`);
      if (sourceIds.has(sourceId)) throw validationError('sourceId may appear once in results', { field: 'results' });
      sourceIds.add(sourceId);
      if (!SOURCE_STATUSES.includes(item.status) || !Number.isInteger(item.seen) || item.seen < 0
        || !Number.isInteger(item.new) || item.new < 0 || item.new > item.seen) {
        throw validationError('Each result needs a status and non-negative seen/new counts', { field: `results[${index}]` });
      }
      return { sourceId, status: item.status, seen: item.seen, new: item.new };
    });
    return this.db.transaction(async (tx) => {
      const selected = await tx.query<{ started_at: unknown; access_key_id: string; finished_at: unknown }>(
        'select started_at,access_key_id,finished_at from app.monitor_runs where id=$1 for update', [runId],
      );
      const run = selected.rows[0];
      if (!run || run.access_key_id !== accessKey) throw unauthenticated();
      if (run.finished_at) return false;
      const finish = await tx.query(
        'update app.monitor_runs set finished_at=now(),results=$2::jsonb where id=$1 and finished_at is null',
        [runId, JSON.stringify(results)],
      );
      if (finish.rowCount !== 1) return false;
      for (const result of results) {
        await tx.query(
          `update app.monitor_sources set last_status=$2,last_status_at=now(),last_collected_at=now()
            where id=$1`, [result.sourceId, result.status],
        );
      }
      const day = await tx.query<{ report_date: string }>(
        `select to_char(($1::timestamptz at time zone 'Europe/Warsaw')::date,'YYYY-MM-DD') as report_date`, [asIso(run.started_at)],
      );
      await this.queueReport(tx, day.rows[0].report_date, null);
      return true;
    });
  }

  async listPosts(query: {
    date: string; group?: string; platform?: MonitorPlatform; sourceId?: string; before?: string; limit: number;
  }): Promise<{ items: MonitorPost[]; nextBefore: string | null }> {
    if (!reportDayIsValid(query.date)) throw validationError('date must use YYYY-MM-DD', { field: 'date' });
    const limit = Math.min(Math.max(Math.trunc(query.limit), 1), 100);
    const params: unknown[] = [query.date];
    const where = ["(p.first_seen_at at time zone 'Europe/Warsaw')::date=$1::date"];
    if (query.group !== undefined) { params.push(query.group); where.push(`s.group_label=$${params.length}`); }
    if (query.platform !== undefined) {
      if (query.platform !== 'facebook' && query.platform !== 'x') throw validationError('platform must be facebook or x', { field: 'platform' });
      params.push(query.platform); where.push(`p.platform=$${params.length}`);
    }
    if (query.sourceId !== undefined) { params.push(validUuid(query.sourceId, 'sourceId')); where.push(`p.source_id=$${params.length}`); }
    if (query.before !== undefined) {
      const cursor = decodeCursor(query.before);
      params.push(cursor.firstSeenAt, cursor.seq);
      where.push(`(p.first_seen_at < $${params.length - 1}::timestamptz or (p.first_seen_at=$${params.length - 1}::timestamptz and p.seq<$${params.length}::bigint))`);
    }
    params.push(limit + 1);
    const rows = await this.db.query<Record<string, unknown> & { first_seen_at: unknown; seq: unknown }>(
      `select p.id,p.source_id,s.name as source_name,s.group_label,s.platform,p.url,p.author,p.published_at,p.text,
              p.media,p.engagement,p.is_repost,p.is_pinned,p.first_seen_at,p.last_seen_at,p.reel_id,p.seq
         from app.monitor_posts p join app.monitor_sources s on s.id=p.source_id
        where ${where.join(' and ')} order by p.first_seen_at desc,p.seq desc limit $${params.length}`,
      params,
    );
    const hasMore = rows.rows.length > limit;
    const page = rows.rows.slice(0, limit);
    return { items: page.map(postFrom), nextBefore: hasMore && page.length ? encodeCursor(page[page.length - 1]) : null };
  }

  async getReport(date: string): Promise<MonitorReport> {
    if (!reportDayIsValid(date)) throw validationError('date must use YYYY-MM-DD', { field: 'date' });
    const report = await this.db.query<Record<string, unknown>>(
      `select report_date,state,result,post_count,model,error,completed_at
         from app.monitor_reports where report_date=$1::date`, [date],
    );
    if (!report.rows[0]) throw notFound('Monitor report not found');
    return this.reportFrom(this.db, report.rows[0]);
  }

  async regenerateReport(actor: Actor, date: string, operationIdValue: string): Promise<MonitorReport> {
    if (!reportDayIsValid(date)) throw validationError('date must use YYYY-MM-DD', { field: 'date' });
    const operationId = validUuid(operationIdValue, 'operationId');
    return this.core.idempotent(actor, operationId, `POST /monitor/reports/${date}/regenerate`, { date }, async (tx) => {
      await this.queueReport(tx, date, actor.id);
      const row = await tx.query<Record<string, unknown>>(
        `select report_date,state,result,post_count,model,error,completed_at
           from app.monitor_reports where report_date=$1::date`, [date],
      );
      return this.reportFrom(tx, row.rows[0]);
    });
  }

  private async queueReport(tx: Queryable, date: string, requestedBy: string | null): Promise<void> {
    const count = await tx.query<{ count: number }>(
      `select count(*)::int as count from app.monitor_posts
        where (first_seen_at at time zone 'Europe/Warsaw')::date=$1::date`, [date],
    );
    await tx.query(
      `insert into app.monitor_reports (id,report_date,state,requested_by,model,prompt_id,post_count)
       values ($1,$2::date,'queued',$3,$4,$5,$6)
       on conflict (report_date) do update set state='queued',requested_by=excluded.requested_by,
         model=excluded.model,prompt_id=excluded.prompt_id,post_count=excluded.post_count,
         next_attempt_at=now(),attempt_count=0,lease_token=null,lease_expires_at=null,error=null,completed_at=null
       where app.monitor_reports.state not in ('queued','running')`,
      [randomUUID(), date, requestedBy, process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL, PROMPT_ID, count.rows[0].count],
    );
  }

  private async reportFrom(db: Queryable, row: Record<string, unknown>): Promise<MonitorReport> {
    const date = typeof row.report_date === 'string' ? row.report_date.slice(0, 10) : asIso(row.report_date).slice(0, 10);
    const sourceRows = await db.query<Record<string, unknown>>(
      `select s.id,s.name,s.platform,
              coalesce(latest.value->>'status','not_visited') as status,
              coalesce((latest.value->>'seen')::int,0) as seen,
              coalesce((latest.value->>'new')::int,0) as new
         from app.monitor_sources s
         left join lateral (
           select entry.value from app.monitor_runs r
             cross join lateral jsonb_array_elements(r.results) as entry(value)
            where (r.started_at at time zone 'Europe/Warsaw')::date=$1::date
              and entry.value->>'sourceId'=s.id::text
            order by r.started_at desc limit 1
         ) latest on true
        where s.active=true order by s.group_label collate "C",s.name collate "C",s.id`, [date],
    );
    const sources: MonitorReportSourceStatus[] = sourceRows.rows.map((source) => ({
      sourceId: String(source.id), sourceName: String(source.name), platform: source.platform as MonitorPlatform,
      status: source.status as MonitorSourceStatus | 'not_visited', seen: Number(source.seen), new: Number(source.new),
    }));
    const synthesis = asJson<MonitorSynthesis | null>(row.result, null);
    return {
      date, state: row.state as MonitorReport['state'], synthesis, postCount: Number(row.post_count),
      model: String(row.model), sources,
      errorCode: asJson<{ code?: string } | null>(row.error, null)?.code ?? null,
      completedAt: row.completed_at ? asIso(row.completed_at) : null,
    };
  }
}

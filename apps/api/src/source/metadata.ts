import { randomUUID, createHash } from 'node:crypto';
import type { SourceMetadata } from '@szronox/contracts';
import { fetchPublicHtml, extractSourceMetadata, SourceError } from '@szronox/source-fetch';
import type { SourceFetchFailure } from '@szronox/contracts';
import type { Database } from '../db/client.js';
import { CoreError, idempotencyConflict, notFound } from '../core/errors.js';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../db/client.js';
const RETRY_MS = [30_000, 120_000];
const iso = (date = new Date()) => date.toISOString();
/** SOURCE-01a: a refusal or an unreadable link won't change on retry; only transient failures retry. */
export function sourceFailure(error: unknown): SourceFetchFailure {
  if (!(error instanceof SourceError)) return 'unavailable';
  if (error.code === 'SOURCE_ACCESS_DENIED') return error.status === 429 ? 'unavailable' : 'blocked';
  if (error.code === 'SOURCE_UNAVAILABLE') return 'unavailable';
  return 'unsupported';
}
function hostOf(raw: string): string { try { return new URL(raw).hostname.replace(/^www\./i, '').toLowerCase(); } catch { return 'źródło'; } }
export function deriveSourceUrl(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const capture = input as Record<string, unknown>;
  if (typeof capture.url === 'string' && /^https?:\/\//i.test(capture.url)) return capture.url;
  const text = [capture.text, capture.additionalText].filter((value): value is string => typeof value === 'string').join('\n');
  return text.match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.;!?]+$/, '') ?? null;
}
export function initialSourceMetadata(input: unknown, now = new Date(), rawRequestId: string = randomUUID()): SourceMetadata {
  const requestId = rawRequestId as SourceMetadata['requestId'];
  const url = deriveSourceUrl(input); const requestedAt = iso(now);
  if (!url) return { state: 'no_url', url: null, author: null, siteName: null, publishedDate: null, line: null, requestId, requestedAt, fetchedAt: null, attempts: 0 };
  const siteName = hostOf(url);
  return { state: 'pending', url, author: null, siteName, publishedDate: null, line: `Źródło: ${siteName}`, requestId, requestedAt, fetchedAt: null, attempts: 0 };
}
export class SourceMetadataService {
  private readonly queued = new Set<string>(); private readonly active = new Map<string, Promise<void>>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private timer: NodeJS.Timeout | null = null; private inSweep = false; private readonly recentRefreshes = new Map<string, number[]>();
  constructor(private readonly db: Database, private readonly fetchHtml = fetchPublicHtml, start = true) { if (start) this.start(); }
  start(): void { if (this.timer) return; this.timer = setInterval(() => { void this.sweep().catch(() => undefined); }, 5 * 60_000); this.timer.unref(); }
  stop(): void {
    if (this.timer) clearInterval(this.timer); this.timer = null;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }
  async enqueue(reelId: string, requestId: string): Promise<void> {
    const key = `${reelId}:${requestId}`; if (this.queued.has(key) || this.active.has(key)) return;
    this.queued.add(key); while (this.active.size >= 2) await Promise.race(this.active.values());
    const work = this.fetchOne(reelId, requestId).finally(() => { this.active.delete(key); this.queued.delete(key); }); this.active.set(key, work); await work;
  }
  async sweep(now = Date.now()): Promise<void> {
    if (this.inSweep) return; this.inSweep = true;
    try { const rows = await this.db.query<{ id: string; source_metadata: SourceMetadata }>(`select id, source_metadata from app.reels
      where deleted_at is null and source_metadata->>'state'='pending' and source_metadata->>'requestedAt' < $1
      and (source_metadata->>'attempts')::int < 3 order by id limit 50`, [new Date(now - 120_000).toISOString()]);
      for (const row of rows.rows) void this.enqueue(row.id, row.source_metadata.requestId);
    } finally { this.inSweep = false; }
  }
  allowRefresh(actorId: string, now = Date.now()): boolean {
    const next = (this.recentRefreshes.get(actorId) ?? []).filter((value) => now - value < 60_000);
    if (next.length >= 10) { this.recentRefreshes.set(actorId, next); return false; }
    next.push(now); this.recentRefreshes.set(actorId, next); return true;
  }
  async refresh(actorId: string, reelId: string, operationId: string): Promise<{ metadata: SourceMetadata; enqueue: boolean }> {
    const hash = createHash('sha256').update(JSON.stringify({ reelId, operationId })).digest('hex');
    try { return await this.db.transaction(async (tx) => {
      const existing = await tx.query<{ payload_hash: string; result: { metadata: SourceMetadata; enqueue: boolean } }>('select payload_hash,result from app.operations where operation_id=$1', [operationId]);
      if (existing.rows[0]) { if (existing.rows[0].payload_hash !== hash) throw idempotencyConflict(); return existing.rows[0].result; }
      if (!this.allowRefresh(actorId)) throw new CoreError({ status: 429, code: 'RATE_LIMITED', message: 'Too many source refresh requests', retryable: true });
      const selected = await tx.query<{ original_input: unknown; source_metadata: SourceMetadata | null; deleted_at: unknown }>('select original_input,source_metadata,deleted_at from app.reels where id=$1', [reelId]);
      const reel = selected.rows[0]; if (!reel || reel.deleted_at) throw notFound('Reel not found');
      const current = reel.source_metadata;
      if (current?.state === 'pending' && Date.now() - Date.parse(current.requestedAt) < 30_000) {
        const result = { metadata: current, enqueue: false };
        await tx.query('insert into app.operations(operation_id,actor_id,route,payload_hash,result) values($1,$2,$3,$4,$5)', [operationId, actorId, `POST /reels/${reelId}/source-metadata/refresh`, hash, JSON.stringify(result)]); return result;
      }
      const metadata = initialSourceMetadata(reel.original_input, new Date(), operationId);
      await tx.query('update app.reels set source_metadata=$1 where id=$2 and deleted_at is null', [JSON.stringify(metadata), reelId]);
      const result = { metadata, enqueue: metadata.state === 'pending' };
      await tx.query('insert into app.operations(operation_id,actor_id,route,payload_hash,result) values($1,$2,$3,$4,$5)', [operationId, actorId, `POST /reels/${reelId}/source-metadata/refresh`, hash, JSON.stringify(result)]); return result;
    }); } catch (error) {
      if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
        const existing = await this.db.query<{ payload_hash: string; result: { metadata: SourceMetadata; enqueue: boolean } }>('select payload_hash,result from app.operations where operation_id=$1', [operationId]);
        if (existing.rows[0]) {
          if (existing.rows[0].payload_hash !== hash) throw idempotencyConflict();
          return existing.rows[0].result;
        }
      }
      throw error;
    }
  }
  private async fetchOne(reelId: string, requestId: string): Promise<void> {
    const loaded = await this.db.query<{ source_metadata: SourceMetadata; deleted_at: unknown }>('select source_metadata,deleted_at from app.reels where id=$1', [reelId]);
    const current = loaded.rows[0]?.source_metadata;
    if (!current || loaded.rows[0]?.deleted_at || current.requestId !== requestId || current.state !== 'pending' || current.attempts >= 3 || !current.url) return;
    const attempt = current.attempts + 1;
    await this.db.query(`update app.reels set source_metadata=jsonb_set(source_metadata,'{attempts}',to_jsonb($1::int)) where id=$2 and deleted_at is null and source_metadata->>'requestId'=$3`, [attempt, reelId, requestId]);
    try {
      const fetched = await this.fetchHtml(current.url); const parsed = extractSourceMetadata(fetched.bytes, fetched.finalUrl);
      const metadata: SourceMetadata = { ...current, ...parsed, url: fetched.finalUrl, state: parsed.state, attempts: attempt, fetchedAt: iso() };
      await this.db.query("update app.reels set source_metadata=$1 where id=$2 and deleted_at is null and source_metadata->>'requestId'=$3", [JSON.stringify(metadata), reelId, requestId]);
    } catch (error) {
      const failure = sourceFailure(error);
      const final = failure !== 'unavailable' || attempt >= 3;
      const metadata: SourceMetadata = { ...current, attempts: attempt, fetchedAt: final ? iso() : null, state: final ? 'failed' : 'pending', failure: final ? failure : null };
      await this.db.query("update app.reels set source_metadata=$1 where id=$2 and deleted_at is null and source_metadata->>'requestId'=$3", [JSON.stringify(metadata), reelId, requestId]);
      if (!final) {
        const timer = setTimeout(() => { this.retryTimers.delete(timer); void this.enqueue(reelId, requestId).catch(() => undefined); }, RETRY_MS[attempt - 1]);
        this.retryTimers.add(timer); timer.unref();
      }
    }
  }
}

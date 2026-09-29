import type { Database } from '../db/client.js';
import type { StorageAdapter } from '../core/storage.js';
import { KdriveError, type KdriveClient } from './client.js';
import { httpKdriveUploadClient, type KdriveUploadClient } from './upload-client.js';
import type { KdriveConfig } from './config.js';

const FOLDER_NAME = 'SzroNox Memy';
const MAX_BYTES = 25 * 1024 * 1024;
const NAME_BAD = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const extension = (mime: string) => ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' } as Record<string, string>)[mime] ?? null;

export interface MemeCopyOptions {
  db: Database; storage: StorageAdapter; config: KdriveConfig | null; folders?: KdriveClient | null; uploads?: KdriveUploadClient | null;
}

/** Best-effort server copy. Errors update the row and never roll back meme creation. */
export class MemeCopyService {
  private folderId: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly queued = new Set<string>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly folders: KdriveClient | null;
  private readonly uploads: KdriveUploadClient | null;
  constructor(private readonly options: MemeCopyOptions) {
    this.folders = options.config ? options.folders ?? null : null;
    this.uploads = options.config ? options.uploads ?? httpKdriveUploadClient({ driveId: options.config.driveId, token: options.config.token }) : null;
  }

  async enqueue(memeId: string): Promise<void> {
    if (!this.options.config || !this.folders || !this.uploads || !this.options.storage.openObject) {
      await this.options.db.query(`update app.memes set kdrive_copy_state='not_configured' where id=$1 and kdrive_copy_state='pending'`, [memeId]);
      return;
    }
    if (this.queued.has(memeId) || this.inFlight.has(memeId)) return;
    this.queued.add(memeId);
    await this.runCopy(memeId);
  }

  /** Start one explicitly requested retry cycle after the API atomically resets a failed row. */
  async retry(memeId: string): Promise<void> {
    const current = this.inFlight.get(memeId);
    if (current) await current;
    this.queued.delete(memeId);
    this.queued.add(memeId);
    await this.runCopy(memeId);
  }

  startRetryLoop(): void {
    if (!this.options.config || this.timer) return;
    this.timer = setInterval(() => { void this.retryPending().catch(() => undefined); }, 5 * 60_000);
    this.timer.unref();
  }

  async retryPending(): Promise<void> {
    if (this.running || !this.options.config) return;
    this.running = true;
    try {
      // Rows with attempts=0 predate this process's create hook and belong to the
      // explicit operator CLI. A pending row with attempts>0 is a copy this worker
      // already started, so it is safe to recover after an API restart.
      const retryable = await this.options.db.query<{ id: string }>(`select id from app.memes
        where kdrive_copy_state='pending' and kdrive_copy_attempts>0 order by id limit 25`);
      const ids = [...new Set([...this.queued, ...retryable.rows.map((row) => row.id)])].slice(0, 25);
      for (const id of ids) {
        await this.runCopy(id);
        const status = await this.options.db.query<{ kdrive_copy_state: string; kdrive_copy_attempts: number }>('select kdrive_copy_state,kdrive_copy_attempts from app.memes where id=$1', [id]);
        if (!status.rows[0] || status.rows[0].kdrive_copy_state === 'copied' || status.rows[0].kdrive_copy_attempts >= 3) this.queued.delete(id);
      }
    } finally { this.running = false; }
  }

  /** Explicit operator run for existing rows; copied rows are idempotently skipped. */
  async copyExistingPending(): Promise<{ selected: number; copied: number }> {
    if (!this.options.config) return { selected: 0, copied: 0 };
    const rows = await this.options.db.query<{ id: string }>(`select id from app.memes where kdrive_copy_state<>'copied' order by id`);
    let copied = 0;
    for (const row of rows.rows) {
      await this.options.db.query(`update app.memes set kdrive_copy_state='pending',kdrive_copy_attempts=0,kdrive_copy_error=null where id=$1 and kdrive_copy_state<>'copied'`, [row.id]);
      this.queued.delete(row.id);
      this.queued.add(row.id);
      await this.runCopy(row.id, true);
      const result = await this.options.db.query<{ kdrive_copy_state: string }>('select kdrive_copy_state from app.memes where id=$1', [row.id]);
      if (result.rows[0]?.kdrive_copy_state === 'copied') copied += 1;
    }
    return { selected: rows.rows.length, copied };
  }

  private async targetFolder(): Promise<string> {
    if (this.folderId) return this.folderId;
    const config = this.options.config!; const folders = this.folders!;
    if (config.memeFolderId) {
      const configured = await folders.getFolder(config.memeFolderId);
      if (configured.type !== 'dir' || configured.status !== 'ok') throw new Error('meme_folder_unavailable');
      this.folderId = configured.id; return this.folderId;
    }
    const children = await folders.listChildren(config.rootFolderId);
    const existing = children.find((child) => child.type === 'dir' && child.status === 'ok' && child.name === FOLDER_NAME);
    if (existing) { this.folderId = existing.id; return existing.id; }
    try {
      const created = await folders.createFolder(config.rootFolderId, FOLDER_NAME); this.folderId = created.id; return created.id;
    } catch (error) {
      if (error instanceof KdriveError && (error.failure === 'already_exists' || error.failure === 'unavailable')) {
        const found = (await folders.listChildren(config.rootFolderId).catch(() => [])).find((child) => child.type === 'dir' && child.status === 'ok' && child.name === FOLDER_NAME);
        if (found) { this.folderId = found.id; return found.id; }
      }
      throw error;
    }
  }

  private runCopy(id: string, force = false): Promise<void> {
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const task = (async () => {
      await this.copyOne(id, force);
      const status = await this.options.db.query<{ kdrive_copy_state: string; kdrive_copy_attempts: number }>(
        'select kdrive_copy_state,kdrive_copy_attempts from app.memes where id=$1', [id]);
      if (!status.rows[0] || status.rows[0].kdrive_copy_state === 'copied' || status.rows[0].kdrive_copy_attempts >= 3) this.queued.delete(id);
    })().finally(() => { this.inFlight.delete(id); });
    this.inFlight.set(id, task);
    return task;
  }

  private async copyOne(id: string, force = false): Promise<void> {
    const db = this.options.db;
    const rowResult = await db.query<{ id: string; name: string; asset_ref: string; kdrive_copy_state: string; kdrive_copy_attempts: number }>(
      `select id,name,asset_ref,kdrive_copy_state,kdrive_copy_attempts from app.memes where id=$1`, [id]);
    const row = rowResult.rows[0]; if (!row || row.kdrive_copy_state === 'copied' || row.kdrive_copy_state === 'not_configured' || (!force && row.kdrive_copy_attempts >= 3)) return;
    await db.query(`update app.memes set kdrive_copy_attempts=kdrive_copy_attempts+1,kdrive_copy_state='pending' where id=$1`, [id]);
    try {
      if (!this.options.storage.openObject) throw new Error('storage_unavailable');
      const opened = await this.options.storage.openObject(row.asset_ref);
      const ext = extension(opened.object.mimeType); if (!ext || opened.object.byteSize > MAX_BYTES) { opened.stream.destroy(); throw new Error('unsupported_image'); }
      const chunks: Buffer[] = []; let total = 0;
      for await (const item of opened.stream) { const chunk = Buffer.from(item); total += chunk.length; if (total > MAX_BYTES) throw new Error('image_too_large'); chunks.push(chunk); }
      if (total !== opened.object.byteSize) throw new Error('stored_size_mismatch');
      const safe = row.name.replace(NAME_BAD, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'mem';
      const prefix = 'MEM - '; const fileName = `${safe.toLocaleLowerCase('pl').startsWith(prefix.toLocaleLowerCase('pl')) ? '' : prefix}${safe}${ext}`;
      const file = await this.uploads!.uploadSmall(await this.targetFolder(), fileName, Buffer.concat(chunks));
      await db.query(`update app.memes set kdrive_file=$1,kdrive_copy_state='copied',kdrive_copy_error=null where id=$2`,
        [JSON.stringify({ driveId: this.options.config!.driveId, fileId: file.id, name: file.name, copiedAt: new Date().toISOString() }), id]);
    } catch (error) {
      const attempts = row.kdrive_copy_attempts + 1;
      await db.query(`update app.memes set kdrive_copy_state=$1,kdrive_copy_error=$2 where id=$3`,
        [attempts >= 3 ? 'failed' : 'pending', JSON.stringify({ reason: error instanceof KdriveError ? error.failure : 'copy_failed' }), id]);
    }
  }
}

export function createMemeCopyService(options: MemeCopyOptions): MemeCopyService { return new MemeCopyService(options); }

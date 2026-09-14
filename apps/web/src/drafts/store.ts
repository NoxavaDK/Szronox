import type { CaptureInput, Priority, ReelPatchRequest } from '../../../../packages/contracts/src/index.js';

export type QueueKind = 'create' | 'patch' | 'remove-hook' | 'delete' | 'restore';
export interface QueueItem {
  id: string;
  accountId: string;
  kind: QueueKind;
  reelId: string;
  createdAt: number;
  state: 'pending' | 'running' | 'conflict' | 'failed';
  payload: unknown;
  error?: string;
}
export interface CaptureDraft {
  id: string;
  accountId: string;
  operationId: string;
  reelId: string;
  input: CaptureInput;
  initialHook?: string;
  priority: Priority;
  fileNames: Record<string, string>;
  updatedAt: number;
  state: 'draft' | 'queued' | 'conflict';
}
export interface ReelDraft {
  id: string;
  accountId: string;
  reelId: string;
  expectedVersion: number;
  changes: ReelPatchRequest['changes'];
  updatedAt: number;
  conflictSnapshot?: unknown;
}
export interface QuarantinedShare { id: string; input: CaptureInput; fileNames: Record<string, string>; createdAt: number }

const DB_NAME = 'szronox-drafts-v1';
const DB_VERSION = 1;
const stores = ['captureDrafts', 'reelDrafts', 'blobs', 'queue', 'quarantine'] as const;

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
}
function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
}

export class DraftStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private db() {
    if (!this.dbPromise) this.dbPromise = new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        for (const name of stores) if (!open.result.objectStoreNames.contains(name)) open.result.createObjectStore(name, { keyPath: 'id' });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return this.dbPromise;
  }
  private async put(store: typeof stores[number], value: unknown) {
    const db = await this.db(); const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value); await transactionDone(tx);
  }
  private async get<T>(store: typeof stores[number], id: string) {
    const db = await this.db(); const tx = db.transaction(store, 'readonly'); return request(tx.objectStore(store).get(id)) as Promise<T | undefined>;
  }
  private async delete(store: typeof stores[number], id: string) {
    const db = await this.db(); const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).delete(id); await transactionDone(tx);
  }
  private async all<T>(store: typeof stores[number]) {
    const db = await this.db(); const tx = db.transaction(store, 'readonly'); return request(tx.objectStore(store).getAll()) as Promise<T[]>;
  }
  async saveCapture(draft: CaptureDraft, blobs: Map<string, Blob>) {
    const db = await this.db(); const tx = db.transaction(['captureDrafts', 'blobs'], 'readwrite');
    tx.objectStore('captureDrafts').put(draft);
    for (const [attachmentId, blob] of blobs) tx.objectStore('blobs').put({ id: `${draft.accountId}:${attachmentId}`, accountId: draft.accountId, attachmentId, blob });
    await transactionDone(tx);
  }
  capture = (accountId: string, id: string) => this.get<CaptureDraft>('captureDrafts', `${accountId}:${id}`);
  captures = async (accountId: string) => (await this.all<CaptureDraft>('captureDrafts')).filter((x) => x.accountId === accountId);
  deleteCapture = (accountId: string, id: string) => this.delete('captureDrafts', `${accountId}:${id}`);
  blob = async (accountId: string, attachmentId: string) => (await this.get<{ blob: Blob }>('blobs', `${accountId}:${attachmentId}`))?.blob;
  saveReel = (draft: ReelDraft) => this.put('reelDrafts', draft);
  reel = (accountId: string, reelId: string) => this.get<ReelDraft>('reelDrafts', `${accountId}:${reelId}`);
  deleteReel = (accountId: string, reelId: string) => this.delete('reelDrafts', `${accountId}:${reelId}`);
  enqueue = (item: QueueItem) => this.put('queue', item);
  updateQueue = (item: QueueItem) => this.put('queue', item);
  deleteQueue = (id: string) => this.delete('queue', id);
  queue = async (accountId: string) => (await this.all<QueueItem>('queue')).filter((x) => x.accountId === accountId).sort((a, b) => a.createdAt - b.createdAt);
  async saveQuarantine(share: QuarantinedShare, blobs: Map<string, Blob>) {
    const db = await this.db(); const tx = db.transaction(['quarantine', 'blobs'], 'readwrite');
    tx.objectStore('quarantine').put(share);
    for (const [attachmentId, blob] of blobs) tx.objectStore('blobs').put({ id: `quarantine:${share.id}:${attachmentId}`, accountId: null, attachmentId, blob });
    await transactionDone(tx);
  }
  quarantined = () => this.all<QuarantinedShare>('quarantine');
  async bindQuarantine(shareId: string, accountId: string): Promise<CaptureDraft> {
    const share = await this.get<QuarantinedShare>('quarantine', shareId); if (!share) throw new Error('SHARE_NOT_FOUND');
    const reelId = crypto.randomUUID();
    const draft: CaptureDraft = { id: `${accountId}:${reelId}`, accountId, reelId, operationId: crypto.randomUUID(), input: share.input, fileNames: share.fileNames, priority: 'normal', updatedAt: Date.now(), state: 'draft' };
    const db = await this.db(); const tx = db.transaction(['quarantine', 'captureDrafts', 'blobs'], 'readwrite');
    tx.objectStore('captureDrafts').put(draft); tx.objectStore('quarantine').delete(shareId);
    for (const image of share.input.images) {
      const sourceId = `quarantine:${share.id}:${image.attachmentId}`;
      const stored = await request(tx.objectStore('blobs').get(sourceId)) as { blob: Blob } | undefined;
      if (stored) { tx.objectStore('blobs').put({ id: `${accountId}:${image.attachmentId}`, accountId, attachmentId: image.attachmentId, blob: stored.blob }); tx.objectStore('blobs').delete(sourceId); }
    }
    await transactionDone(tx); return draft;
  }
}

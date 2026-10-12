import type { CaptureInput, Priority, ReelFormat, ReelPatchRequest } from '../../../../packages/contracts/src/index.js';

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
  /** Meaning of the main TEKST field; absent legacy drafts remain Pomysł. */
  textMode?: 'idea' | 'script';
  initialHook?: string;
  /** WIRE-01/D2: absent (legacy) drafts read as 'reel' — see `createRequestFromDraft`. */
  format?: ReelFormat;
  /** WIRE-01/D2: `Tytuł streamu`; only meaningful when `format === 'stream'`. */
  streamTitle?: string;
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
  /**
   * Consume a quarantined share into one account, atomically.
   *
   * Replaces the previous `bindQuarantine`, which had two defects found in PWA-01. It read the
   * share in one transaction and consumed it in another, so two tabs — or the OS reopening the
   * app twice — could both bind the same share; and it minted a fresh `reelId`/`operationId` on
   * every call, so a replay produced a different capture the server could not deduplicate.
   *
   * Both are fixed here. The identifiers are derived by the caller *before* this runs, because
   * they come from an async hash and awaiting crypto inside an IndexedDB write transaction
   * would deactivate it. The quarantine record is read and deleted inside the same readwrite
   * transaction, so it acts as the lock: whichever account's transaction commits first wins,
   * and the loser finds nothing.
   *
   * There is deliberately **no `await` inside the transaction**. Every write is issued
   * synchronously from the `onsuccess` handler of the authoritative read, where the spec
   * guarantees the transaction is still active. Awaiting an IndexedDB request there is the one
   * form IndexedDB tolerates, but it depends on microtask timing; this does not.
   *
   * Outcomes are deliberately narrow, so a replay cannot disclose another account's payload:
   *
   *   `bound`            this call consumed the share, or this same account already had it
   *   `already_consumed` the share is gone and this account has no capture for it
   *
   * `already_consumed` carries no payload and is identical whichever account asks, so an
   * account replaying someone else's share id learns only that it is no longer available.
   */
  async consumeQuarantine(
    shareId: string,
    accountId: string,
    ids: { reelId: string; operationId: string },
  ): Promise<{ outcome: 'bound'; draft: CaptureDraft } | { outcome: 'already_consumed' }> {
    const draftId = `${accountId}:${ids.reelId}`;

    // Read-only preparation. The blobs are written once at receipt and never mutated, so
    // reading them here cannot go stale; doing it now keeps the write transaction free of
    // any await at all.
    const share = await this.get<QuarantinedShare>('quarantine', shareId);
    const carried: Array<{ attachmentId: string; blob: Blob }> = [];
    if (share) {
      for (const image of share.input.images) {
        const stored = await this.get<{ blob: Blob }>('blobs', `quarantine:${shareId}:${image.attachmentId}`);
        if (stored) carried.push({ attachmentId: image.attachmentId, blob: stored.blob });
      }
    }

    const db = await this.db();
    const tx = db.transaction(['quarantine', 'captureDrafts', 'blobs'], 'readwrite');
    let bound: CaptureDraft | undefined;
    let existing: CaptureDraft | undefined;

    const authoritative = tx.objectStore('quarantine').get(shareId);
    authoritative.onsuccess = () => {
      const record = authoritative.result as QuarantinedShare | undefined;
      if (record === undefined) {
        // Already consumed by someone. Was it this account? Its own draft key is the only
        // thing this account is allowed to learn about.
        const own = tx.objectStore('captureDrafts').get(draftId);
        own.onsuccess = () => { existing = own.result as CaptureDraft | undefined; };
        return;
      }
      const draft: CaptureDraft = {
        id: draftId,
        accountId,
        reelId: ids.reelId,
        operationId: ids.operationId,
        input: record.input,
        fileNames: record.fileNames,
        priority: 'normal',
        updatedAt: Date.now(),
        state: 'draft',
      };
      tx.objectStore('captureDrafts').put(draft);
      tx.objectStore('quarantine').delete(shareId);
      for (const entry of carried) {
        tx.objectStore('blobs').put({
          id: `${accountId}:${entry.attachmentId}`,
          accountId,
          attachmentId: entry.attachmentId,
          blob: entry.blob,
        });
        tx.objectStore('blobs').delete(`quarantine:${shareId}:${entry.attachmentId}`);
      }
      bound = draft;
    };

    await transactionDone(tx);
    if (bound) return { outcome: 'bound', draft: bound };
    if (existing) return { outcome: 'bound', draft: existing };
    return { outcome: 'already_consumed' };
  }
}

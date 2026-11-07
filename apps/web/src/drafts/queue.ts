import type { CreateReelRequest, ReelPatchRequest } from '../../../../packages/contracts/src/index.js';
import { ClientApiError } from '../data/errors.js';
import type { CoreApiClient } from '../data/api.js';
import type { DraftStore, QueueItem } from './store.js';

export class SyncQueue {
  private running = false;
  constructor(private readonly store: DraftStore, private readonly api: CoreApiClient, private readonly account: () => string | null) {}
  async flush() {
    // `navigator.onLine` is not consulted. Android can report false while requests
    // still succeed (roaming, data saver), which held every save on the device while
    // the rest of the app loaded normally. A real outage surfaces as a network error
    // below and keeps the item pending, which is the same outcome.
    if (this.running) return;
    const accountId = this.account(); if (!accountId) return;
    this.running = true;
    try {
      // Operations on one Reel stay in order, so a stuck operation holds back only the
      // later operations on the same Reel. It used to stop the whole queue, which left
      // every new capture pending behind one old conflict.
      const held = new Set<string>();
      for (const item of await this.store.queue(accountId)) {
        if (this.account() !== accountId) break;
        if (held.has(item.reelId) || item.state === 'conflict') { held.add(item.reelId); continue; }
        const running = { ...item, state: 'running' as const }; await this.store.updateQueue(running);
        try {
          await this.execute(running);
          await this.store.deleteQueue(item.id);
          // A created Reel deliberately leaves its capture draft in place. The draft is
          // the only index of the local image blobs, and those blobs are the only copy
          // until the server acknowledges each attachment's completion. Deleting the
          // draft here — as this queue previously did — discarded that index while the
          // bytes had not been uploaded at all, which made recovery impossible. The
          // controller removes the draft once every attachment is authoritatively ready.
          if (item.kind === 'patch') await this.store.deleteReel(accountId, item.reelId);
        } catch (error) {
          if (error instanceof ClientApiError && error.status === 401) { await this.store.updateQueue({ ...item, state: 'pending', error: error.api.code }); break; }
          if (error instanceof ClientApiError && error.status === 409) { await this.store.updateQueue({ ...item, state: 'conflict', error: error.api.code }); held.add(item.reelId); continue; }
          // No response at all: the server is unreachable for every item, so stop and retry later.
          if (!(error instanceof ClientApiError)) { await this.store.updateQueue({ ...item, state: 'pending', error: 'NETWORK_ERROR' }); break; }
          await this.store.updateQueue({ ...item, state: 'failed', error: error.message });
          held.add(item.reelId);
        }
      }
    } finally { this.running = false; }
  }
  private execute(item: QueueItem) {
    if (item.kind === 'create') return this.api.create(item.payload as CreateReelRequest);
    if (item.kind === 'patch') return this.api.patch(item.reelId, item.payload as ReelPatchRequest);
    if (item.kind === 'remove-hook') { const p = item.payload as { hookId: string; request: { operationId: string; expectedVersion: number } }; return this.api.removeHook(item.reelId, p.hookId, p.request); }
    if (item.kind === 'delete') return this.api.remove(item.reelId, item.payload as { operationId: string; expectedVersion: number });
    return this.api.restore(item.reelId, item.payload as { operationId: string; expectedVersion: number });
  }
}

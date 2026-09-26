export interface DraftWriteResult {
  ok: boolean;
  error?: unknown;
}

export interface DraftWriteRecord {
  revision: number;
  promise: Promise<DraftWriteResult>;
}

/** Serialize local save/delete transactions per Reel so an older delete cannot erase new text. */
export function enqueueDraftStoreOperation<T>(queues: Map<string, Promise<void>>, reelId: string, operation: () => Promise<T>): Promise<T> {
  const prior = queues.get(reelId) ?? Promise.resolve();
  const result = prior.then(operation);
  const settled = result.then(() => undefined, () => undefined);
  queues.set(reelId, settled);
  void settled.then(() => { if (queues.get(reelId) === settled) queues.delete(reelId); });
  return result;
}

export function hasUnfinishedHookEditForReel(edits: Readonly<Record<string, { reelId: string }>>, reelId: string | null | undefined): boolean {
  return reelId !== null && reelId !== undefined && Object.values(edits).some((edit) => edit.reelId === reelId);
}

export async function deleteDraftIfNoNewerWrite(
  sentRevision: number,
  latestWrite: () => DraftWriteRecord | undefined,
  deleteDraft: () => Promise<void>,
): Promise<boolean> {
  if ((latestWrite()?.revision ?? sentRevision) > sentRevision) return false;
  await deleteDraft();
  return true;
}

export function withConflictSnapshot<T extends { conflictSnapshot?: unknown }>(latest: T | undefined, fallback: T, snapshot: unknown): T {
  return { ...(latest ?? fallback), conflictSnapshot: snapshot };
}

export function changesForConflictResolution<T>(latestDraftChanges: T | undefined, pendingChanges: T | undefined, sentChanges: T): T {
  return pendingChanges ?? latestDraftChanges ?? sentChanges;
}

export function canMarkSavedAfterSend(reelId: string, currentReelId: string | null, pendingReelId: string | null, deletedDraft: boolean): boolean {
  return deletedDraft && currentReelId === reelId && pendingReelId !== reelId;
}

/**
 * Wait until the old Reel's newest scalar draft is stored before allowing navigation.
 *
 * A Reel with an unresolved conflict never sends (its edits wait for the explicit choice), so
 * for it a durably stored draft is enough: selection moves and the conflict stays with it.
 */
export async function retainPendingDraftBeforeSwitch(
  reelId: string,
  pendingFor: () => string | null,
  latestWrite: () => DraftWriteRecord | undefined,
  flush: () => Promise<void> | null,
  conflictBlocked: () => boolean = () => false,
): Promise<DraftWriteResult> {
  while (pendingFor() === reelId) {
    const write = latestWrite();
    if (!write) return { ok: false, error: new Error('Pending Reel draft has no local write') };
    const result = await write.promise;
    if (!result.ok) return result;
    if (latestWrite() !== write) continue;
    if (pendingFor() !== reelId) return { ok: true };
    if (conflictBlocked()) return { ok: true };
    const send = flush();
    if (!send) return { ok: false, error: new Error('Pending Reel draft was not scheduled for sending') };
    // Durable local retention is enough to navigate. The pending patch remains keyed to
    // this Reel and can finish in the background without delaying the next selection.
    return { ok: true };
  }
  return { ok: true };
}

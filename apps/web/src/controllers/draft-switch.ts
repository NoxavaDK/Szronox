export interface DraftWriteResult {
  ok: boolean;
  error?: unknown;
}

export interface DraftWriteRecord {
  revision: number;
  promise: Promise<DraftWriteResult>;
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

/** Wait until the old Reel's newest scalar draft is stored before allowing navigation. */
export async function retainPendingDraftBeforeSwitch(
  reelId: string,
  pendingFor: () => string | null,
  latestWrite: () => DraftWriteRecord | undefined,
  flush: () => Promise<void> | null,
): Promise<DraftWriteResult> {
  while (pendingFor() === reelId) {
    const write = latestWrite();
    if (!write) return { ok: false, error: new Error('Pending Reel draft has no local write') };
    const result = await write.promise;
    if (!result.ok) return result;
    if (latestWrite() !== write) continue;
    if (pendingFor() !== reelId) return { ok: true };
    const send = flush();
    if (!send) return { ok: false, error: new Error('Pending Reel draft was not scheduled for sending') };
    if (pendingFor() !== reelId) return { ok: true };
    await send;
  }
  return { ok: true };
}

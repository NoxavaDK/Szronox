import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canMarkSavedAfterSend, changesForConflictResolution, deleteDraftIfNoNewerWrite, enqueueDraftStoreOperation, hasUnfinishedHookEditForReel, retainPendingDraftBeforeSwitch, withConflictSnapshot } from '../draft-switch.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('an immediate Reel switch waits for local draft retention before sending', async () => {
  const write = deferred();
  let pendingReelId = 'reel-a';
  let sent = false;
  const record = { revision: 1, promise: write.promise };
  const switching = retainPendingDraftBeforeSwitch('reel-a', () => pendingReelId, () => record, async () => {
    sent = true;
    pendingReelId = null;
  });

  await Promise.resolve();
  assert.equal(sent, false);
  write.resolve({ ok: true });
  assert.deepEqual(await switching, { ok: true });
  assert.equal(sent, true);
});

test('a slow server request does not delay switching after the newest draft is durable', async () => {
  const network = deferred();
  let sent = false;
  const record = { revision: 1, promise: Promise.resolve({ ok: true }) };
  const result = await retainPendingDraftBeforeSwitch('reel-a', () => 'reel-a', () => record, () => {
    sent = true;
    return network.promise;
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(sent, true);
  // Intentionally unresolved here: the local-retention gate has already released navigation.
  network.resolve();
});

test('a failed local draft write prevents the Reel switch and does not send', async () => {
  const write = deferred();
  let pendingReelId = 'reel-a';
  let sent = false;
  const record = { revision: 1, promise: write.promise };
  const switching = retainPendingDraftBeforeSwitch('reel-a', () => pendingReelId, () => record, async () => {
    sent = true;
    pendingReelId = null;
  });
  const failure = new Error('draft storage unavailable');

  write.resolve({ ok: false, error: failure });
  const result = await switching;
  assert.equal(result.ok, false);
  assert.equal(result.error, failure);
  assert.equal(pendingReelId, 'reel-a');
  assert.equal(sent, false);
});

test('only unfinished hook edits for the current Reel block publication generation', () => {
  const edits = { one: { reelId: 'reel-a' }, two: { reelId: 'reel-b' } };
  assert.equal(hasUnfinishedHookEditForReel(edits, 'reel-a'), true);
  assert.equal(hasUnfinishedHookEditForReel(edits, 'reel-b'), true);
  assert.equal(hasUnfinishedHookEditForReel(edits, 'reel-c'), false);
  assert.equal(hasUnfinishedHookEditForReel(edits, null), false);
});

test('an older in-flight save cannot delete a newer draft for the same Reel', async () => {
  let latest = { revision: 2, promise: Promise.resolve({ ok: true }) };
  let deleted = false;
  assert.equal(await deleteDraftIfNoNewerWrite(1, () => latest, async () => { deleted = true; }), false);
  assert.equal(deleted, false);

  latest = { revision: 1, promise: Promise.resolve({ ok: true }) };
  assert.equal(await deleteDraftIfNoNewerWrite(1, () => latest, async () => { deleted = true; }), true);
  assert.equal(deleted, true);
});

test('local Reel draft saves remain ordered after a queued deletion', async () => {
  const queue = new Map();
  const deleteGate = deferred();
  const order = [];
  const deletion = enqueueDraftStoreOperation(queue, 'reel-a', async () => { order.push('delete-start'); await deleteGate.promise; order.push('delete-end'); });
  const newerSave = enqueueDraftStoreOperation(queue, 'reel-a', async () => { order.push('save-newer'); });
  await Promise.resolve();
  assert.deepEqual(order, ['delete-start']);
  deleteGate.resolve();
  await Promise.all([deletion, newerSave]);
  assert.deepEqual(order, ['delete-start', 'delete-end', 'save-newer']);
});

test('local conflict resolution uses newer typing and survives a failed latest draft write', () => {
  const oldDraft = { reelId: 'reel-a', expectedVersion: 4, changes: { title: 'pierwsza wartość' } };
  const newDraft = { reelId: 'reel-a', expectedVersion: 4, changes: { title: 'nowsza wartość' } };
  const latestWriteResult = { ok: false, error: new Error('draft storage unavailable') };
  assert.equal(latestWriteResult.ok, false);
  assert.deepEqual(withConflictSnapshot(newDraft, oldDraft, { title: 'serwer' }), {
    ...newDraft, conflictSnapshot: { title: 'serwer' },
  });
  // A failed local write leaves the new text in the pending in-memory patch; it must take
  // precedence over the older durable draft when constructing the conflict's local choice.
  const conflictChanges = changesForConflictResolution(oldDraft.changes, newDraft.changes, oldDraft.changes);
  assert.deepEqual(conflictChanges, newDraft.changes);
  assert.equal(conflictChanges.title, 'nowsza wartość');
  assert.deepEqual({ changes: conflictChanges }, { changes: { title: 'nowsza wartość' } }, 'choosing local submits the latest values');
  assert.equal(canMarkSavedAfterSend('reel-a', 'reel-a', 'reel-a', false), false);
  assert.equal(canMarkSavedAfterSend('reel-a', 'reel-b', null, true), false);
  assert.equal(canMarkSavedAfterSend('reel-a', 'reel-a', null, true), true);
});

test('a conflicted Reel with a stored draft can be left without sending', async () => {
  let flushed = false;
  const record = { revision: 3, promise: Promise.resolve({ ok: true }) };
  // Its edits wait for the explicit conflict choice, so nothing is scheduled to send.
  const result = await retainPendingDraftBeforeSwitch('reel-a', () => 'reel-a', () => record, () => { flushed = true; return null; }, () => true);
  assert.deepEqual(result, { ok: true });
  assert.equal(flushed, false);
});

test('a conflicted Reel whose local draft write failed still cannot be left', async () => {
  const failure = new Error('quota');
  const record = { revision: 4, promise: Promise.resolve({ ok: false, error: failure }) };
  const result = await retainPendingDraftBeforeSwitch('reel-a', () => 'reel-a', () => record, () => null, () => true);
  assert.deepEqual(result, { ok: false, error: failure });
});

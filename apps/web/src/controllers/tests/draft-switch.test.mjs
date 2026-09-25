import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canMarkSavedAfterSend, changesForConflictResolution, deleteDraftIfNoNewerWrite, hasUnfinishedHookEditForReel, retainPendingDraftBeforeSwitch, withConflictSnapshot } from '../draft-switch.ts';

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

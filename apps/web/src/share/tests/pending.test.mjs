import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  INCOMING_PARAM,
  SHARE_ERROR_PARAM,
  claimIncomingShare,
  derivedShareId,
  readIncomingSignal,
  shareFailureMessage,
  shareIdentifiers,
} from '../pending.ts';
import { INCOMING_PARAM as WORKER_INCOMING, SHARE_ERROR_PARAM as WORKER_ERROR } from '../receive.ts';

/**
 * Picking a share up on the page side.
 *
 * Identifier derivation and signal parsing are exercised for real. The consumption *sequence*
 * is exercised against a hand-written stand-in store, because Node has no IndexedDB — so those
 * cases show that this module calls the store correctly, and say nothing about whether
 * IndexedDB itself is atomic. The atomicity guarantee lives in `DraftStore.consumeQuarantine`,
 * and the part of it that can be checked without a browser is checked in the last test here.
 * The rest is a browser fact and is reported as an open gate, not simulated into a pass.
 */

test('the page and the worker agree on the parameters they pass between them', () => {
  // The names are stated on both sides so each module stays runtime-import-free and directly
  // testable. This is the check that keeps the duplication honest: if one side is renamed and
  // the other is not, the share would arrive and never be picked up.
  assert.equal(INCOMING_PARAM, WORKER_INCOMING);
  assert.equal(SHARE_ERROR_PARAM, WORKER_ERROR);
});

test('derived identifiers are stable, distinct per purpose, and well-formed UUIDs', async () => {
  const shareId = 'a7ad9d2e-2f07-4e4c-9f6a-9a2b6c1d0e3f';
  const first = await shareIdentifiers(shareId);
  const second = await shareIdentifiers(shareId);

  // A replayed share must produce the same capture, not a second one.
  assert.deepEqual(first, second);
  // Domain separation: the reel and the operation can never collide.
  assert.notEqual(first.reelId, first.operationId);
  for (const value of [first.reelId, first.operationId]) {
    assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }

  // A different share is a different capture.
  const other = await shareIdentifiers('0f7b3c11-9d44-4f2a-8f11-5c0b2d7e9a01');
  assert.notEqual(other.reelId, first.reelId);
  assert.notEqual(await derivedShareId(shareId, 'reel'), await derivedShareId(shareId, 'operation'));
});

test('the incoming signal is read from the query string and bounded', () => {
  assert.deepEqual(readIncomingSignal(`?${INCOMING_PARAM}=abc`), { shareId: 'abc', failure: null });
  assert.deepEqual(readIncomingSignal(`?${SHARE_ERROR_PARAM}=body_too_large`), {
    shareId: null,
    failure: 'body_too_large',
  });
  assert.deepEqual(readIncomingSignal(''), { shareId: null, failure: null });
  assert.deepEqual(readIncomingSignal(`?${INCOMING_PARAM}=`), { shareId: null, failure: null });
  // An id this app never minted is simply too long to be one, and is discarded here rather
  // than being carried into a store lookup.
  assert.equal(readIncomingSignal(`?${INCOMING_PARAM}=${'x'.repeat(65)}`).shareId, null);
});

test('every rejection reason has its own Polish message, and none echoes shared content', () => {
  const reasons = [
    'body_too_large', 'aggregate_too_large', 'file_too_large', 'too_many_files',
    'nothing_usable', 'storage_failed', 'worker_unavailable', 'unreadable',
  ];
  for (const reason of reasons) {
    const message = shareFailureMessage(reason);
    assert.ok(message.length > 0, `${reason} should have a message`);
    // The reason vocabulary is internal; the user sees Polish, not an identifier.
    assert.doesNotMatch(message, /_|http/, `${reason} message should not leak an identifier`);
  }
});

/** A stand-in for the store. Not IndexedDB: it records calls so the sequence can be checked. */
function stubStore(outcome) {
  const calls = [];
  return {
    calls,
    async consumeQuarantine(shareId, accountId, ids) {
      calls.push({ shareId, accountId, ids });
      return outcome;
    },
  };
}

test('an unsaved capture defers the share instead of replacing it', async () => {
  const store = stubStore({ outcome: 'bound', draft: { id: 'x' } });
  const result = await claimIncomingShare(store, 'share-1', 'account-a', { hasUnsavedCapture: true });
  assert.deepEqual(result, { status: 'deferred' });
  // Nothing was consumed, so the share is still in quarantine for later.
  assert.equal(store.calls.length, 0);
});

test('exactly the named share is consumed, for exactly the confirmed account', async () => {
  const draft = { id: 'account-a:reel', accountId: 'account-a' };
  const store = stubStore({ outcome: 'bound', draft });
  const result = await claimIncomingShare(store, 'share-1', 'account-a', { hasUnsavedCapture: false });

  assert.deepEqual(result, { status: 'opened', draft });
  assert.equal(store.calls.length, 1, 'one share, one consumption — the store is never swept');
  assert.equal(store.calls[0].shareId, 'share-1');
  assert.equal(store.calls[0].accountId, 'account-a');
  // The identifiers reached the store already derived, which is what keeps the async hash
  // outside the write transaction.
  assert.deepEqual(store.calls[0].ids, await shareIdentifiers('share-1'));
});

test('a share consumed elsewhere discloses nothing about who took it', async () => {
  const store = stubStore({ outcome: 'already_consumed' });
  const result = await claimIncomingShare(store, 'share-1', 'account-b', { hasUnsavedCapture: false });
  // No draft, no account, no payload — the same answer whichever account asks.
  assert.deepEqual(result, { status: 'already_consumed' });
});

test('no await sits inside the quarantine write transaction (PWA-01 hazard)', () => {
  const source = readFileSync(fileURLToPath(new URL('../../drafts/store.ts', import.meta.url)), 'utf8');
  // Comments are stripped first, so this file's prose and the store's own cannot satisfy or
  // break the check — only executable code is examined.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const start = code.indexOf('async consumeQuarantine');
  assert.ok(start > 0, 'consumeQuarantine should exist');
  const body = code.slice(start);

  const opened = body.indexOf("db.transaction(['quarantine', 'captureDrafts', 'blobs'], 'readwrite')");
  assert.ok(opened > 0, 'the readwrite transaction should be opened over the three stores');
  const committed = body.indexOf('await transactionDone(tx)', opened);
  assert.ok(committed > opened, 'the transaction should be awaited to completion');

  // Between opening the transaction and awaiting its completion there must be no await at
  // all: crypto or a network call there would deactivate the transaction, and even an
  // IndexedDB await depends on microtask timing.
  const inside = body.slice(opened, committed);
  assert.equal(/\bawait\b/.test(inside), false, 'no await may appear inside the write transaction');
  assert.equal(/crypto\./.test(inside), false, 'no crypto may be used inside the write transaction');

  // The authoritative decision is the in-transaction read, not the read-only preparation
  // above it — that is what makes the quarantine record the cross-account lock.
  assert.ok(
    inside.includes("tx.objectStore('quarantine').get(shareId)") &&
      inside.includes("tx.objectStore('quarantine').delete(shareId)"),
    'the share must be read and deleted inside the same transaction',
  );

  // And the caller supplies the identifiers, so none is minted per call.
  assert.equal(/crypto\.randomUUID/.test(body.slice(0, committed)), false, 'ids come from the caller');
});

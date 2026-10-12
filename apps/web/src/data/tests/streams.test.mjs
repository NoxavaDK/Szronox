import assert from 'node:assert/strict';
import test from 'node:test';
import {
  flushTopicBeforeSwitch,
  groupStreamCandidates,
  isDirectLinkCandidate,
  streamDeleteConfirmBody,
  topicLabel,
} from '../streams.ts';

// `topicLabel` takes its fallback (the `reelLabel`-derived text) as a parameter — see
// `data/streams.ts` for why: it must not import `reel-label.ts`'s runtime exports itself.

test('topicLabel: typed title wins outright, ignoring the hook and the fallback', () => {
  assert.equal(topicLabel({ title: 'Mój temat', selectedHookText: 'Hook' }, 'Fallback'), 'Mój temat');
});

test('topicLabel: falls back to the selected hook text before the caller-supplied fallback', () => {
  assert.equal(topicLabel({ title: '', selectedHookText: 'Najlepszy hook' }, 'Fallback'), 'Najlepszy hook');
});

test('topicLabel: an empty/whitespace hook is not used — falls through to the fallback', () => {
  assert.equal(topicLabel({ title: '', selectedHookText: '   ' }, 'Fallback'), 'Fallback');
  assert.equal(topicLabel({ title: '', selectedHookText: null }, 'Fallback'), 'Fallback');
});

test('topicLabel: a long hook is collapsed and cut with an ellipsis, like reel-label.ts does', () => {
  const long = `Hook ${'x'.repeat(90)}`;
  const label = topicLabel({ title: '', selectedHookText: long }, 'Fallback');
  assert.ok(label.endsWith('…'));
  assert.ok(label.length <= 80);
});

test('groupStreamCandidates: ROLKI in the fixed status order, then POMYSŁY, never re-sorted within a group', () => {
  const items = [
    { id: '1', status: 'published', title: 'P' },
    { id: '2', status: 'idea', title: 'I1' },
    { id: '3', status: 'to_record', title: 'T' },
    { id: '4', status: 'idea', title: 'I2' },
    { id: '5', status: 'editing', title: 'E' },
  ];
  const grouped = groupStreamCandidates(items);
  assert.deepEqual(grouped.rolki.map((g) => g.status), ['to_record', 'editing', 'published']);
  assert.deepEqual(grouped.rolki.map((g) => g.items.map((i) => i.id)), [['3'], ['5'], ['1']]);
  assert.deepEqual(grouped.pomysly.map((i) => i.id), ['2', '4']);
});

test('isDirectLinkCandidate: only an idea requires the absorb/link choice', () => {
  assert.equal(isDirectLinkCandidate('idea'), false);
  for (const status of ['to_record', 'editing', 'ready', 'published']) assert.equal(isDirectLinkCandidate(status), true);
});

test('flushTopicBeforeSwitch: idle/saved switch immediately without calling flush', async () => {
  let called = false;
  const flush = async () => { called = true; return true; };
  assert.equal(await flushTopicBeforeSwitch('idle', flush), true);
  assert.equal(await flushTopicBeforeSwitch('saved', flush), true);
  assert.equal(called, false);
});

test('flushTopicBeforeSwitch: an already failed/conflicted state refuses the switch outright', async () => {
  const flush = async () => true;
  assert.equal(await flushTopicBeforeSwitch('error', flush), false);
  assert.equal(await flushTopicBeforeSwitch('conflict', flush), false);
});

test('flushTopicBeforeSwitch: dirty/saving waits for the flush and follows its result', async () => {
  assert.equal(await flushTopicBeforeSwitch('dirty', async () => true), true);
  assert.equal(await flushTopicBeforeSwitch('dirty', async () => false), false);
  assert.equal(await flushTopicBeforeSwitch('saving', async () => true), true);
});

test('streamDeleteConfirmBody: the exact two-topic wording from design/oct-2026-delta-spec.md D9', () => {
  assert.equal(
    streamDeleteConfirmBody('Mój stream', 2),
    'Usunąć stream „Mój stream”? Razem z nim zostaną usunięte 2 tematy przeniesione z pomysłów. Możesz je przywrócić razem ze streamem z „Usunięte”.',
  );
});

test('streamDeleteConfirmBody: singular agreement', () => {
  assert.equal(
    streamDeleteConfirmBody('X', 1),
    'Usunąć stream „X”? Razem z nim zostanie usunięty 1 temat przeniesiony z pomysłów. Możesz je przywrócić razem ze streamem z „Usunięte”.',
  );
});

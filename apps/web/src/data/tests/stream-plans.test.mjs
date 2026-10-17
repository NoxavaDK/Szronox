import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blankTopic, broadcastTitle, draftProblems, dockUrl, mainLinkOf, moveTopic, nextTopicId, onAirView, requestOf, sessionFrom, topicFromCandidate,
} from '../stream-plans.ts';

const candidate = (overrides = {}) => ({
  id: 'r1', title: '', status: 'to_record', plannedPublicationDate: null, plannedPublicationSlot: null,
  originalInput: { url: 'https://portal.pl/capture' }, script: '', selectedHookText: null, sourceMetadata: null, sourceLink: null, ...overrides,
});
const draft = (overrides = {}) => ({ title: 'Podsumowanie', scheduledFor: '2026-10-18', commentsSession: '', topics: [], ...overrides });

test('mainLinkOf: the article link wins, else the captured link, never a non-http value', () => {
  assert.equal(mainLinkOf(candidate({ sourceLink: 'https://portal.pl/artykul' })), 'https://portal.pl/artykul');
  assert.equal(mainLinkOf(candidate()), 'https://portal.pl/capture');
  assert.equal(mainLinkOf(candidate({ originalInput: { text: 'notatka' } })), null);
  assert.equal(mainLinkOf(candidate({ originalInput: { url: 'ftp://x' } })), null);
});

test('topicFromCandidate keeps the Reel as a live reference and fits the title into 180 characters', () => {
  const topic = topicFromCandidate(candidate(), `Bardzo ${'długi '.repeat(60)}tytuł`, 't1');
  assert.equal(topic.reelId, 'r1');
  assert.equal(topic.mainLink, 'https://portal.pl/capture');
  assert.ok(topic.title.length <= 180);
  assert.ok(topic.title.endsWith('…'));
  assert.deepEqual(topic.reel, { id: 'r1', status: 'to_record', deleted: false });
  assert.equal(broadcastTitle('  Krótki   tytuł '), 'Krótki tytuł');
});

test('sessionFrom accepts a bare ID or an SSN link, refuses anything else', () => {
  assert.equal(sessionFrom(' AbC_1-2 '), 'AbC_1-2');
  assert.equal(sessionFrom('https://socialstream.ninja/dock.html?session=XyZ9'), 'XyZ9');
  assert.equal(sessionFrom(''), '');
  assert.equal(sessionFrom('ma spacje'), null);
  assert.equal(sessionFrom('https://socialstream.ninja/dock.html'), null);
  assert.equal(dockUrl('XyZ9'), 'https://socialstream.ninja/dock.html?session=XyZ9');
});

test('draftProblems blocks autosave on half-typed links and empty titles, in Polish', () => {
  assert.deepEqual(draftProblems(draft()), []);
  const problems = draftProblems(draft({
    title: ' ', commentsSession: 'zła sesja',
    topics: [{ ...blankTopic('t1'), mainLink: 'portal.pl', extraLinks: [{ url: 'www.x.pl', label: '' }] }],
  }));
  assert.equal(problems.length, 5);
  assert.ok(problems.every((problem) => /[a-ząćęłńóśźż]/i.test(problem)));
});

test('requestOf trims, drops empty link rows and maps an SSN link to its ID', () => {
  const body = requestOf(draft({
    scheduledFor: '', commentsSession: 'https://socialstream.ninja/dock.html?session=Abc',
    topics: [{ ...blankTopic('t1'), title: ' Temat ', mainLink: ' ', extraLinks: [{ url: '', label: 'pusty' }, { url: ' https://gus.gov.pl ', label: ' GUS ' }], points: ['A', ''] }],
  }), 'op', 3);
  assert.equal(body.expectedVersion, 3);
  assert.equal(body.scheduledFor, null);
  assert.equal(body.commentsSession, 'Abc');
  assert.deepEqual(body.topics, [{ id: 't1', reelId: null, title: 'Temat', mainLink: null, extraLinks: [{ url: 'https://gus.gov.pl', label: 'GUS' }], points: ['A', ''] }]);
  assert.equal('reel' in body.topics[0], false);
});

test('moveTopic swaps neighbours and ignores moves past either end', () => {
  assert.deepEqual(moveTopic(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
  assert.deepEqual(moveTopic(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
  assert.deepEqual(moveTopic(['a', 'b'], 0, -1), ['a', 'b']);
  assert.deepEqual(moveTopic(['a', 'b'], 1, 1), ['a', 'b']);
});

test('onAirView: on air only while the PC reports; topics missing on a connected PC cannot be switched to', () => {
  const now = Date.parse('2026-10-18T18:00:20Z');
  const report = (seenAt) => ({ cue: null, pc: { topicId: 'b', topicIds: ['a', 'b'], seenAt } });
  const fresh = onAirView(report('2026-10-18T18:00:10Z'), now);
  assert.equal(fresh.connected, true);
  assert.equal(fresh.onAir, 'b');
  assert.equal(fresh.onPc('a'), true);
  assert.equal(fresh.onPc('c'), false);
  const stale = onAirView(report('2026-10-18T17:59:00Z'), now);
  assert.equal(stale.connected, false);
  assert.equal(stale.onAir, null);
  assert.equal(stale.onPc('c'), true);
  assert.equal(onAirView(null, now).connected, false);
});

test('nextTopicId: first when nothing is on air, the following one, null at the end', () => {
  assert.equal(nextTopicId(['a', 'b'], null), 'a');
  assert.equal(nextTopicId(['a', 'b'], 'a'), 'b');
  assert.equal(nextTopicId(['a', 'b'], 'b'), null);
  assert.equal(nextTopicId(['a', 'b'], 'gone'), 'a');
  assert.equal(nextTopicId([], null), null);
});

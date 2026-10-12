import assert from 'node:assert/strict';
import test from 'node:test';
import { composePublicationText, composeStreamPublicationText, composeStreamSourceSection } from '../publication.ts';

test('composeStreamSourceSection drops empty lines, removes exact duplicates, keeps order, joins by one newline', () => {
  assert.equal(composeStreamSourceSection([]), '');
  assert.equal(composeStreamSourceSection(['', '']), '');
  assert.equal(composeStreamSourceSection(['A', '', 'B']), 'A\nB');
  assert.equal(composeStreamSourceSection(['A', 'B', 'A']), 'A\nB');
  // Near-duplicates that are not byte-identical are kept — nothing is rewritten.
  assert.equal(composeStreamSourceSection(['A', 'A ']), 'A\nA ');
});

test('composeStreamPublicationText composes Opis / ŹRÓDŁA / Hashtagi, two-newline join, empty sections skipped', () => {
  assert.equal(composeStreamPublicationText('', [], ''), '');
  assert.equal(composeStreamPublicationText('Opis', [], ''), 'Opis');
  assert.equal(composeStreamPublicationText('', ['A', 'B'], ''), 'A\nB');
  assert.equal(composeStreamPublicationText('Opis', ['A', 'B', 'A'], '#tag'), 'Opis\n\nA\nB\n\n#tag');
  // Nothing is trimmed or rewritten.
  assert.equal(composeStreamPublicationText('Opis\n', ['  A  '], '\n#tag\n'), 'Opis\n\n\n  A  \n\n\n#tag\n');
});

test('stream composition matches ordinary Reel composition when there is exactly one source line', () => {
  assert.equal(composeStreamPublicationText('D', ['S'], 'H'), composePublicationText('D', 'S', 'H'));
});

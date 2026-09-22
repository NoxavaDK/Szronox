import assert from 'node:assert/strict';
import test from 'node:test';
import { composePublicationText } from '../publication.ts';

test('publication copy preserves fields and inserts exactly two newlines only between two nonempty values', () => {
  assert.equal(composePublicationText('Opis', '#tag'), 'Opis\n\n#tag');
  assert.equal(composePublicationText('Opis\n', '#tag'), 'Opis\n\n\n#tag');
  assert.equal(composePublicationText('Opis', ''), 'Opis');
  assert.equal(composePublicationText('', '#tag'), '#tag');
  assert.equal(composePublicationText('', ''), '');
});

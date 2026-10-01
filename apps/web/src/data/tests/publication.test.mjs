import assert from 'node:assert/strict';
import test from 'node:test';
import { composePublicationText } from '../publication.ts';

test('publication copy composes all eight exact empty/nonempty combinations', () => {
  const parts = ['', 'D', 'S', 'H'];
  for (const mask of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const values = parts.slice(1).map((part, index) => mask & (1 << (2 - index)) ? part : '');
    assert.equal(composePublicationText(...values), values.filter((value) => value !== '').join('\n\n'));
  }
});
test('publication copy preserves whitespace and newlines and includes current unsaved field values', () => {
  assert.equal(composePublicationText('Opis\n', '  ', '\n#tag\n'), 'Opis\n\n\n  \n\n\n#tag\n');
  const editedDescription = 'new description';
  const editedSource = 'manual source';
  const editedHashtags = '#edited';
  assert.equal(composePublicationText(editedDescription, editedSource, editedHashtags), 'new description\n\nmanual source\n\n#edited');
});

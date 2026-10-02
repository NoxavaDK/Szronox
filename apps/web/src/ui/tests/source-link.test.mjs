import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = async (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('SOURCE-02 link editor follows capture immutability and frozen validation/undo flow', async () => {
  const detail = await read('../detail-sections.tsx');
  assert.match(detail, /!capturedHasLink/);
  assert.match(detail, /Link do artykułu/);
  assert.match(detail, /placeholder="https:\/\/…"/);
  assert.match(detail, /Wklej pełny link \(https:\/\/…\)\./);
  assert.match(detail, /onChangeSourceLink\(null\)/);
  assert.match(detail, /Usunięto link\./);
  assert.match(detail, /Cofnij/);
  assert.match(detail, /aria-label=\{sourceLink\}/);
});

test('PUBLIKACJA opens and focuses the added-link field when no link exists', async () => {
  const publication = await read('../../screens/PublicationSection.tsx');
  const app = await read('../../app/App.tsx');
  const detail = await read('../detail-sections.tsx');
  assert.match(publication, /sourceMetadataState === 'no_url' \? <TextAction onClick=\{onAddArticleLink\}>Dodaj link/);
  assert.match(app, /setArticleLinkFocus\(\(value\) => value \+ 1\)/);
  assert.match(app, /sourceLink: reel\.sourceLink/);
  assert.match(detail, /requestAnimationFrame\(\(\) => linkInput\.current\?\.focus\(\)\)/);
});

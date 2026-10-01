import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = async (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('PublicationSection maps each frozen automatic/manual source state to one line and action', async () => {
  const screen = await read('../../screens/PublicationSection.tsx');
  for (const copy of [
    'Automatycznie z linku', 'Automatycznie z adresu strony', 'Pobieranie danych źródła…',
    'Pobieranie trwa dłużej niż zwykle.', 'Nie udało się pobrać danych źródła.', 'Brak linku w materiale.',
    'Pobierz dane źródła z linku.', 'Wpisane ręcznie', 'Przywrócono automatyczne źródło.',
    'Odśwież', 'Sprawdź', 'Ponów', 'Pobierz', 'Przywróć automatyczne', 'Cofnij',
  ]) assert.ok(screen.includes(copy), `missing ${copy}`);
  assert.ok(screen.indexOf('aria-label="Opis publikacji"') < screen.indexOf('aria-label="Źródło"'));
  assert.ok(screen.indexOf('aria-label="Źródło"') < screen.indexOf('aria-label="Hashtagi"'));
});

test('PublicationSection action target wraps below its metadata line on 320–360px widths', async () => {
  const css = await read('../../screens/PublicationSection.module.css');
  assert.match(css, /@media \(max-width: 360px\)\s*\{\s*\.sourceMeta \{ display: block; \}/);
  assert.match(css, /\.sourceMeta :global\(button\).*min-height: 44px/);
});

test('source polling is scoped to expanded PUBLIKACJA and merges metadata only', async () => {
  const app = await read('../../app/App.tsx');
  const controller = await read('../../controllers/useAppController.ts');
  assert.match(app, /publicationIsExpanded/);
  assert.match(app, /setInterval\([\s\S]*?5_000\)/);
  assert.match(app, /4 \* 60_000/);
  assert.ok(controller.includes('const next = { ...currentRef.current, sourceMetadata };'));
  assert.match(controller, /changeReel\(\{ publicationSource: null \}, true\)/);
  assert.match(controller, /setTimeout\(\(\) => \{ setSourceUndo\(null\)/);
  assert.match(controller, /changeReel\(\{ publicationSource: undo\.text \}\)/);
  assert.match(app, /c\.sourceUndo\?\.reelId === reel\.id \? c\.sourceUndo\.text : reel\.publicationSource/);
  assert.match(controller, /sourceUndo\?\.reelId === current\.id \? sourceUndo\.text : current\.publicationSource/);
});

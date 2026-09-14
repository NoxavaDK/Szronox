/**
 * Frozen-copy conformance.
 *
 * The frozen Reel Detail batch pins exact Polish strings. This asserts that each
 * one appears verbatim in the contracts file, by reading the spec and the source
 * rather than restating the strings a third time — a test that hardcoded its own
 * copy could drift with the code it is meant to guard.
 *
 * Run: node --test apps/web/src/ui/frozen-copy.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const spec = readFileSync(path.join(repoRoot, 'design/frozen-reel-detail-language-spec.md'), 'utf8');
const contracts = readFileSync(path.join(here, 'screen-contracts.ts'), 'utf8');
const sections = readFileSync(path.join(here, 'detail-sections.tsx'), 'utf8');

/** Strings the spec pins and the UI must reproduce exactly. */
const PINNED = [
  // sec. 3 — status values
  'Pomysł', 'Do nagrania', 'Montaż', 'Gotowe', 'Opublikowane',
  // sec. 3 — priority values, glyphs included
  '! Pilne', '● Normalne', '∞ Evergreen',
  // sec. 3 — MONTUJE and its null option
  'MONTUJE', 'Brak',
  // sec. 3 — the publish gate
  'Przed zmianą statusu na „Opublikowane” oznacz „Okładka do feedu” jako ukończoną.',
  // sec. 5
  'ŹRÓDŁA / WEJŚCIE', 'ORYGINALNE WEJŚCIE', 'DODATKOWY TEKST', 'ZAŁĄCZNIKI',
  'NOTATKA DO WEJŚCIA', 'Otwórz źródło',
  // sec. 6
  'UWAGI DO MONTAŻU',
  // sec. 2
  'MATERIAŁY', 'FOLDER kDrive', 'Brak folderu', '+ Utwórz folder kDrive', 'Otwórz kDrive',
  'AKTUALNY EKSPORT', 'Zmień eksport', 'WERYFIKACJA',
  'Wybierz montażystę, aby wskazać osobę sprawdzającą.',
  '○ Nie sprawdzone', 'Oznacz jako sprawdzony', '◷ Nieaktualne',
  'Oznacz nowy eksport jako sprawdzony',
  // sec. 7
  'Usuń rolkę', 'Usunąć rolkę?',
  'Rolka zniknie z aktywnych widoków. Będzie można ją później przywrócić.',
  'Anuluj', 'Usuń',
  // sec. 8
  'Usunięte', 'Przywróć rolkę',
];

test('every pinned string exists in the frozen spec', () => {
  for (const value of PINNED) {
    assert.ok(spec.includes(value), `the spec must contain: ${value}`);
  }
});

test('every pinned string is reproduced verbatim in the contracts', () => {
  for (const value of PINNED) {
    assert.ok(contracts.includes(value), `screen-contracts.ts must define: ${value}`);
  }
});

test('the derived verification labels use the real identity, not a hardcoded name', () => {
  // The spec shows `○ Czeka na Szron` and `✓ Szron` as EXAMPLES using the actual
  // peer identity, so the code must interpolate rather than hardcode a name.
  assert.match(contracts, /awaitingVerifierLabel[\s\S]{0,200}\$\{peerName\}/);
  assert.match(contracts, /verifiedByLabel[\s\S]{0,200}\$\{verifierName\}/);
  assert.match(contracts, /previousExportVerifiedBy[\s\S]{0,220}\$\{verifierName\}/);
  assert.ok(!/'○ Czeka na Szron'/.test(contracts), 'the peer name must not be hardcoded');
  assert.ok(!/'✓ Szron'/.test(contracts), 'the verifier name must not be hardcoded');
});

test('attention thresholds are mapped per priority, as the batch specifies', () => {
  assert.match(contracts, /urgent:\s*24/);
  assert.match(contracts, /normal:\s*96/);
  assert.match(contracts, /evergreen:\s*168/);
});

/** Read just the object literal body of `export const <name> ... = { ... };`. */
function literalBody(source, name) {
  const start = source.indexOf(`export const ${name}`);
  assert.notEqual(start, -1, `${name} must be exported`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('};', open);
  return source.slice(open, close);
}

test('Usunięte is a secondary entry, never a sixth status or a primary tab', () => {
  // Only the literal VALUES are inspected: an explanatory comment mentioning
  // `Usunięte` must not make this pass or fail by accident.
  assert.ok(!literalBody(contracts, 'STATUS_LABELS').includes('Usunięte'), 'not a status label');
  assert.ok(!literalBody(contracts, 'STATUS_TAB_LABELS').includes('Usunięte'), 'not a primary tab');
  // The five statuses are the whole set; a sixth would be a contract change.
  assert.equal((literalBody(contracts, 'STATUS_TAB_LABELS').match(/:/g) ?? []).length, 5);
  // It is still reachable: the list screen exposes an explicit secondary intent.
  assert.match(contracts, /onOpenDeleted/);
});

test('the overflow menu carries only the delete action', () => {
  // sec. 7 forbids status, priority, editor, AI, export, kDrive and meme entries here.
  const overflow = sections.slice(sections.indexOf('export function ReelOverflow'));
  const menu = overflow.slice(0, overflow.indexOf('export function RestoreBanner'));
  for (const value of ['AKTUALNY EKSPORT', 'FOLDER kDrive', 'PRIORYTET', 'Zmień eksport']) {
    assert.ok(!menu.includes(value), `the overflow menu must not contain: ${value}`);
  }
});

test('the editing-notes section stays one plain shared field', () => {
  // sec. 6 forbids threads, per-user notes, checklists and rich-text toolbars.
  const notes = sections.slice(sections.indexOf('export function EditingNotesSection'));
  const body = notes.slice(0, notes.indexOf('// ── MATERIAŁY'));
  assert.match(body, /<textarea/, 'one multiline plain-text field');
  for (const forbidden of ['comment', 'thread', 'checklist', 'toolbar']) {
    assert.ok(!new RegExp(forbidden, 'i').test(body), `must not introduce: ${forbidden}`);
  }
});

test('the input note is documented as mutable and separate from originalInput', () => {
  const sourcesBlock = contracts.slice(contracts.indexOf('export interface SourcesSectionProps'));
  assert.match(sourcesBlock, /NOT part of immutable `originalInput`/);
});

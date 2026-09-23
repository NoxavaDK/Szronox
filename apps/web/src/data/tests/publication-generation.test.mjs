/**
 * PUBLICATION-01 boundary checks for the web client.
 *
 * Error mapping is executed; the workspace wiring is asserted on source because this
 * package has no DOM renderer. Run: node --experimental-strip-types --test src/data/tests/*.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ClientApiError, polishError, SCRIPT_REQUIRED, UNSAVED_BEFORE_PUBLICATION } from '../errors.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(path.join(here, relative), 'utf8');

test('publication refusals map to truthful Polish copy', () => {
  const error = (code, details) => new ClientApiError(409, { code, message: code, retryable: false, details });
  assert.equal(polishError(error('STALE_PUBLICATION_RESULT')), 'Skrypt zmienił się od wygenerowania opisu. Wygeneruj opis ponownie.');
  assert.equal(polishError(error('VALIDATION_ERROR', { reason: 'script_required' })), SCRIPT_REQUIRED);
  assert.match(polishError(error('VALIDATION_ERROR', { reason: 'wrong_action' })), /Wygeneruj opis/);
  assert.match(UNSAVED_BEFORE_PUBLICATION, /zachowane/);
});

test('Opracuj no longer offers publication copy; its script applies only via Zastosuj', () => {
  const workspace = read('../../screens/AiWorkspace.tsx');
  const developBlock = workspace.slice(workspace.indexOf('{d ? <>'), workspace.indexOf("{run?.action === 'generate_hooks'"));
  assert.ok(developBlock.length > 0);
  assert.equal(/publication/i.test(developBlock), false);
  assert.equal(developBlock.includes('OPIS DO PUBLIKACJI'), false);
  assert.ok(developBlock.includes(">Zastosuj</button>"));
  assert.equal(workspace.includes('Użyj scenariusza'), false);
  assert.ok(developBlock.includes('+ Wygeneruj więcej'), 'hook generation is unchanged');
});

test('Wygeneruj opis lives in PUBLIKACJA and opens the typed publication view', () => {
  assert.ok(read('../../screens/PublicationSection.tsx').includes('Wygeneruj opis'));
  const app = read('../../app/App.tsx');
  assert.ok(app.includes("view: 'generate_publication'"));
  assert.ok(app.includes('c.hasUnsavedChanges()'), 'unsaved edits are checked before generation');
  const workspace = read('../../screens/AiWorkspace.tsx');
  assert.ok(workspace.includes("publicationField('publication_description'"));
  assert.ok(workspace.includes("publicationField('publication_hashtags'"));
});

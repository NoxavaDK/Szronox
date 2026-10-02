import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('HOOK-ADD-01: Reel Detail offers + Dodaj hook and never selects the new hook', async () => {
  const [detail, controller, app] = await Promise.all([
    read('../../screens/ReelDetailScreen.tsx'), read('../../controllers/useAppController.ts'), read('../../app/App.tsx')]);
  // Offered whenever the Detail is editable, also with a selected hook (outside the collapsed list).
  assert.match(detail, /\{!readOnly && !newHook \? <TextAction onClick=\{onStartNewHook\}>\+ Dodaj hook<\/TextAction> : null\}/);
  assert.match(detail, /<HookEditor edit=\{newHook\} onChange=\{onChangeNewHook\} onSave=\{onSaveNewHook\} onCancel=\{onCancelNewHook\} \/>/);
  // Uses the existing add endpoint with a retry-stable operation id; no selection call follows.
  const save = controller.slice(controller.indexOf('const saveNewHook'), controller.indexOf('const saveHookEdit'));
  assert.match(save, /api\.addHook\(reel\.id, \{ operationId: draft\.operationId, expectedVersion: reel\.version, text: draft\.text \}\)/);
  assert.doesNotMatch(save, /selectHook/);
  // Failure keeps the typed text; an unsaved draft counts as unsaved work.
  assert.match(save, /setNewHook\(\{ \.\.\.draft, saving: false, error: message, operationId \}\)/);
  assert.match(controller, /newHook !== null && newHook\.reelId === activeReelId && newHook\.text !== ''/);
  assert.match(app, /onSaveNewHook=\{\(\) => void c\.saveNewHook\(\)\}/);
});

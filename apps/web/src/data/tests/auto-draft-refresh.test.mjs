import assert from 'node:assert/strict';
import test from 'node:test';
import { onlyHooksChanged } from '../auto-draft.ts';

const base = { id: 'r', version: 3, updatedAt: '2026-10-12T10:00:00.000Z', title: '', script: 'Szkic', hooks: [], autoDraft: { runId: 'a', state: 'running', titleSuggestion: null, isStale: false } };

test('a finished draft that only appended hooks counts as hooks-only', () => {
  const after = { ...base, version: 4, updatedAt: '2026-10-12T10:00:09.000Z', hooks: [{ id: 'h', text: 'Nowy hak' }], autoDraft: { ...base.autoDraft, state: 'succeeded', titleSuggestion: 'Tytuł' } };
  assert.equal(onlyHooksChanged(base, after), true);
});

test('any other server-side change is not hooks-only', () => {
  assert.equal(onlyHooksChanged(base, { ...base, version: 4, script: 'Zmieniony przez kogoś innego' }), false);
  assert.equal(onlyHooksChanged(base, { ...base, version: 4, title: 'Tytuł od drugiej osoby' }), false);
});

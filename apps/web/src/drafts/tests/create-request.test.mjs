import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestFromDraft } from '../create-request.ts';

const draft = (overrides = {}) => ({
  id: 'account:reel', accountId: 'account', reelId: 'reel', operationId: 'operation',
  input: { text: 'Wiersz 1.\nWiersz 2. ', url: 'https://example.com', additionalText: 'Kontekst', images: [] },
  priority: 'normal', fileNames: {}, updatedAt: 1, state: 'draft', ...overrides,
});

test('the queued create request keeps script choice and exact mixed input together', () => {
  const input = draft();
  const request = createRequestFromDraft({ ...input, textMode: 'script' });
  assert.equal(request.initialScript, input.input.text);
  assert.equal(request.input, input.input);

  // IndexedDB stores a structured-clone snapshot. Later UI edits and mode changes
  // create a new draft value and cannot reinterpret the already queued request.
  const queuedSnapshot = structuredClone(request);
  const editedDraft = { ...input, textMode: 'idea', input: { ...input.input, text: 'Późniejsza zmiana' } };
  assert.equal(createRequestFromDraft(editedDraft).initialScript, undefined);
  assert.equal(queuedSnapshot.initialScript, input.input.text);
  assert.equal(queuedSnapshot.input.text, input.input.text);
  assert.equal(queuedSnapshot.input.url, input.input.url);
  assert.equal(queuedSnapshot.input.additionalText, input.input.additionalText);
});

test('legacy drafts default to idea semantics and empty scripts do not block other input', () => {
  assert.equal(createRequestFromDraft(draft()).initialScript, undefined);
  assert.equal(createRequestFromDraft(draft({ textMode: 'script', input: { text: '  ', url: 'https://example.com', images: [] } })).initialScript, undefined);
});

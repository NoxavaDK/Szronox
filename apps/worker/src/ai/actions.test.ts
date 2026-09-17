import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { executeAction, type WorkRun } from './actions.js';

const candidate = (value: unknown) => ({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }],
});

function run(action: string): WorkRun {
  return { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', action, model: 'gemini-3.8-flash', input_hash: 'a'.repeat(64),
    input_snapshot: { title: '', originalInput: { text: 'Opis' }, inputNote: '', script: 'Liczba 10.', hooks: [],
      priority: 'normal', reelVersion: 1, imageObjects: [],
      memeCandidates: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Znany mem' }], programmeEvidence: [] } };
}

test('develop validates the bounded candidate ID and preserves separate publication drafts', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'szronox-ai-actions-'));
  try {
    await mkdir(path.join(storageRoot, 'objects'));
    const input = run('develop');
    let inspected = false;
    const work = await executeAction(input, { storageRoot, call: async (_model, request) => {
      inspected = true;
      assert.equal((request.generationConfig as { responseMimeType: string }).responseMimeType, 'application/json');
      return candidate({ titleSuggestion: 'Tytuł', eventSummary: 'Zdarzenie', verificationIssues: [],
        hookAdditions: ['Hook 1', 'Hook 2'], scriptSuggestion: 'Scenariusz',
        publicationDescriptionSuggestion: 'Osobny opis', publicationHashtagsSuggestion: '#osobno',
        possibleProgrammeConnection: null, prioritySuggestion: null,
        memeSuggestion: { memeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', rationale: 'Powód' } });
    } });
    assert.equal(inspected, true);
    const result = work.result as { memeSuggestion: unknown; publicationDescriptionSuggestion: string; publicationHashtagsSuggestion: string; hookAdditions: string[] };
    assert.equal(result.memeSuggestion, null, 'unlisted meme ID cannot escape as a suggestion');
    assert.equal(result.publicationDescriptionSuggestion, 'Osobny opis');
    assert.equal(result.publicationHashtagsSuggestion, '#osobno');
    assert.deepEqual(result.hookAdditions, ['Hook 1', 'Hook 2']);
  } finally { await rm(storageRoot, { recursive: true, force: true }); }
});

test('fact check downgrades unsupported factual status while retaining exact checked span', async () => {
  const work = await executeAction(run('fact_check'), { storageRoot: '/tmp', call: async (_model, request) => {
    if ('tools' in request) return candidate({ ok: true });
    return candidate({ coverage: 'complete', warnings: [], claims: [{ location: 'script', originalText: '10',
      claimText: 'Liczba 10', status: 'confirmed', explanation: 'Bez źródła', sourceIds: [],
      evidenceQuote: null, correction: null }] });
  } });
  const result = work.result as { claims: Array<{ status: string; origin: { span: { start: number; end: number; text: string } } }> };
  assert.equal(result.claims[0].status, 'uncertain');
  assert.deepEqual(result.claims[0].origin.span, { start: 7, end: 9, text: '10', offsetUnit: 'utf16_code_units' });
});

test('programme output cannot reference an unindexed chunk', async () => {
  const input = run('find_programme');
  input.input_snapshot.programmeEvidence = [{ documentVersionId: 'd', proposalId: 'p', chunkId: 'approved',
    category: 'Kategoria', proposal: 'Postulat', excerpt: 'Fragment', sourceTitle: 'Program',
    sourceUrl: 'https://example.org/programme.pdf', chapter: 'Rozdział', subchapter: null, pdfPage: 1, printedPage: null }];
  await assert.rejects(executeAction(input, { storageRoot: '/tmp', call: async () => candidate({
    candidates: [{ chunkId: 'invented', rationale: 'Powód', strength: 'strong' }],
  }) }), (error: { code?: string }) => error.code === 'INVALID_AI_RESULT');
});

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { executeAction, type WorkRun } from './actions.js';
import { finishRun } from './jobs.js';

const candidate = (value: unknown) => ({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }],
});

function run(action: string): WorkRun {
  return { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', action, model: 'gemini-3.8-flash', input_hash: 'a'.repeat(64),
    input_snapshot: { title: '', originalInput: { text: 'Opis' }, inputNote: '', script: 'Liczba 10.', hooks: [],
      priority: 'normal', reelVersion: 1, imageObjects: [],
      memeCandidates: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Znany mem' }], programmeEvidence: [] } };
}

test('develop validates the bounded candidate ID and no longer drafts publication copy', async () => {
  const storageRoot = await mkdtemp(path.join(tmpdir(), 'szronox-ai-actions-'));
  try {
    await mkdir(path.join(storageRoot, 'objects'));
    const input = run('develop');
    let prompt = '';
    let schema = '';
    const work = await executeAction(input, { storageRoot, call: async (_model, request) => {
      assert.equal((request.generationConfig as { responseMimeType: string }).responseMimeType, 'application/json');
      prompt = (request.contents as Array<{ parts: Array<{ text: string }> }>)[0].parts[0].text;
      schema = JSON.stringify((request.generationConfig as { responseJsonSchema: unknown }).responseJsonSchema);
      // A model that still volunteers publication copy has it dropped, never passed on.
      return candidate({ titleSuggestion: 'Tytuł', eventSummary: 'Zdarzenie', verificationIssues: [],
        hookAdditions: ['Hook 1', 'Hook 2'], scriptSuggestion: 'Scenariusz',
        publicationDescriptionSuggestion: 'Opis', publicationHashtagsSuggestion: '#tag',
        possibleProgrammeConnection: null, prioritySuggestion: null,
        memeSuggestion: { memeId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', rationale: 'Powód' } });
    } });
    const result = work.result as Record<string, unknown>;
    assert.equal(result.memeSuggestion, null, 'unlisted meme ID cannot escape as a suggestion');
    assert.deepEqual(result.hookAdditions, ['Hook 1', 'Hook 2']);
    assert.equal('publicationDescriptionSuggestion' in result, false);
    assert.equal('publicationHashtagsSuggestion' in result, false);
    assert.equal(/publication|hashtag/i.test(prompt), false, 'prompt no longer asks for publication copy');
    assert.equal(/publication/i.test(schema), false, 'schema no longer carries publication fields');
  } finally { await rm(storageRoot, { recursive: true, force: true }); }
});

test('generate_publication writes from the saved script only, without source retrieval or images', async () => {
  const input = run('generate_publication');
  input.input_snapshot.script = 'Zapisany skrypt o tramwajach.';
  input.input_snapshot.originalInput = { text: 'Materiał źródłowy XYZ', url: 'http://127.0.0.1/private' };
  // Would fail if read: the storage root is relative and the object does not exist.
  input.input_snapshot.imageObjects = [{ id: 'i', storageKey: 'missing', mimeType: 'image/png', byteSize: 1 }];
  const requests: Array<Record<string, unknown>> = [];
  const work = await executeAction(input, { storageRoot: 'relative', call: async (_model, request) => {
    requests.push(request);
    return candidate({ publicationDescriptionSuggestion: 'Opis rolki', publicationHashtagsSuggestion: '#tramwaje', titleSuggestion: 'Ignoruj' });
  } });
  assert.equal(requests.length, 1);
  const parts = (requests[0].contents as Array<{ parts: Array<{ text?: string; inlineData?: unknown }> }>)[0].parts;
  assert.equal(parts.length, 1, 'no image parts');
  assert.ok(parts[0].text?.includes('Zapisany skrypt o tramwajach.'));
  assert.equal(parts[0].text?.includes('Materiał źródłowy XYZ'), false, 'original materials are not substituted');
  assert.ok(parts[0].text?.startsWith('Provisional development prompt.'));
  assert.deepEqual(work.result, { publicationDescriptionSuggestion: 'Opis rolki', publicationHashtagsSuggestion: '#tramwaje' });
  assert.equal((work.provenance as { source: unknown }).source, null);
  assert.deepEqual((work.provenance as { images: unknown[] }).images, []);
  await assert.rejects(executeAction(input, { storageRoot: 'relative', call: async () =>
    candidate({ publicationDescriptionSuggestion: '  ', publicationHashtagsSuggestion: '#x' }) }),
  (error: { code?: string }) => error.code === 'INVALID_AI_RESULT');
});

test('finalizing generate_publication stores the result and mutates no Reel content', async () => {
  const statements: string[] = [];
  const query = async (sql: string) => {
    statements.push(sql.replace(/\s+/g, ' ').trim());
    if (sql.startsWith('select state,lease_token')) return { rows: [{ state: 'running', lease_token: 'token' }], rowCount: 1 };
    if (sql.startsWith('select id,deleted_at')) return { rows: [{ id: 'reel', deleted_at: null }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  const pool = { connect: async () => ({ query, release: () => undefined }), query } as unknown as Pool;
  const claimed = { ...run('generate_publication'), lease_token: 'token', attempt_count: 1, reel_id: 'reel' };
  const result = { publicationDescriptionSuggestion: 'Opis', publicationHashtagsSuggestion: '#tag' };
  assert.equal(await finishRun(pool, claimed, { result, warnings: [], provenance: {} }), true);
  assert.equal(statements.some((sql) => /reel_hooks|update app\.reels/.test(sql)), false, 'no hook append or Reel write');
  assert.ok(statements.some((sql) => sql.startsWith("update app.ai_runs set state='succeeded'")));
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

const evidence = {
  releaseId: 'r', documentVersionId: 'd', proposalId: 'p', chunkId: 'approved',
  category: 'Kategoria', proposal: 'Postulat', excerpt: 'Fragment',
  sourceTitle: 'Program', sourceUrl: '/api/v1/programme/versions/d/source#page=7',
  chapter: 'Rozdział', subchapter: null, pdfPages: [7, 8], printedPages: ['5', '6'],
};

test('programme output cannot reference an unindexed chunk', async () => {
  const input = run('find_programme');
  input.input_snapshot.programmeEvidence = [evidence];
  await assert.rejects(executeAction(input, { storageRoot: '/tmp', call: async () => candidate({
    candidates: [{ chunkId: 'invented', rationale: 'Powód', strength: 'strong' }],
  }) }), (error: { code?: string }) => error.code === 'INVALID_AI_RESULT');
});

test('a selected candidate carries pages and source resolved from the index, not from the model', async () => {
  const input = run('find_programme');
  input.input_snapshot.programmeEvidence = [evidence];
  let offered: unknown = null;
  const work = await executeAction(input, { storageRoot: '/tmp', call: async (_model, request) => {
    const parts = (request.contents as Array<{ parts: Array<{ text: string }> }>)[0].parts;
    offered = parts[0].text;
    return candidate({ candidates: [{
      chunkId: 'approved', rationale: 'Powód',  strength: 'strong',
      // Everything below is ignored: the server cites, the model only ranks.
      pdfPages: [1], sourceUrl: 'https://wymyslone.example/inny.pdf', proposal: 'Wymyślony postulat',
    }] });
  } });
  const result = work.result as { candidates: Array<Record<string, unknown>> };
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].pdfPages, [7, 8]);
  assert.deepEqual(result.candidates[0].printedPages, ['5', '6']);
  assert.equal(result.candidates[0].sourceUrl, '/api/v1/programme/versions/d/source#page=7');
  assert.equal(result.candidates[0].proposal, 'Postulat');
  assert.equal(result.candidates[0].documentVersionId, 'd');
  // The prompt never carries a page, a URL or a version the model could quote back.
  const prompt = String(offered);
  assert.equal(prompt.includes('/api/v1/programme/versions'), false);
  assert.equal(prompt.includes('"pdfPages"'), false);
});

test('empty retrieval answers without calling the provider at all', async () => {
  const input = run('find_programme');
  input.input_snapshot.programmeEvidence = [];
  const work = await executeAction(input, { storageRoot: '/tmp', call: async () => {
    throw new Error('the provider must not be consulted when there is no evidence');
  } });
  assert.deepEqual((work.result as { candidates: unknown[] }).candidates, []);
  assert.equal(work.warnings.length, 1);
});

test('two chunks of one proposal cannot become two candidates', async () => {
  const input = run('find_programme');
  input.input_snapshot.programmeEvidence = [evidence, { ...evidence, chunkId: 'approved-2' }];
  await assert.rejects(executeAction(input, { storageRoot: '/tmp', call: async () => candidate({
    candidates: [
      { chunkId: 'approved', rationale: 'Powód', strength: 'strong' },
      { chunkId: 'approved-2', rationale: 'Powód', strength: 'indirect' },
    ],
  }) }), (error: { code?: string }) => error.code === 'INVALID_AI_RESULT');
});

/**
 * PUBLICATION-02 v3 (UI-02 amendment H): source precedence, bounded search fallback and
 * provider-backed provenance. Every provider and network call is faked.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeAction, type WorkRun } from './actions.js';

type Req = Record<string, unknown>;
const candidate = (value: unknown) => ({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }],
});
const promptOf = (request: Req) =>
  (request.contents as Array<{ parts: Array<{ text?: string }> }>)[0].parts.map((part) => part.text ?? '').join('\n');
const isSearch = (request: Req) => Array.isArray(request.tools);
const retrievedAs = (url: string, excerpt: string) => ({
  url, retrievedAt: '2026-09-28T10:00:00.000Z', status: 200, contentType: 'text/html', excerpt, sha256: 'f'.repeat(64),
});
/** A search answer whose prose names a URL the provider never returned as grounding. */
const grounding = (uris: string[]) => ({
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Model prose citing https://invented.example/fake' }] },
    groundingMetadata: { groundingChunks: uris.map((uri, index) => ({ web: { uri, title: `Źródło ${index + 1}` } })) } }],
});

function v3(overrides: Partial<WorkRun['input_snapshot']> = {}): WorkRun {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', action: 'generate_publication', model: 'gemini-3.8-flash', input_hash: 'a'.repeat(64),
    input_snapshot: {
      publicationContextVersion: 3, title: '', originalInput: {}, inputNote: '',
      script: 'Od stycznia bilety miesięczne w Krakowie zdrożeją.',
      hooks: [{ id: 'h', text: 'Zapłacisz więcej za tramwaj', source: 'user', position: 0 }], selectedHookId: 'h',
      priority: 'normal', reelVersion: 1, imageObjects: [], memeCandidates: [], programmeEvidence: [], ...overrides,
    },
  };
}

test('grounded saved source: description uses it and search never runs', async () => {
  const requests: Req[] = [];
  const retrieved: string[] = [];
  const work = await executeAction(v3({ originalInput: { text: 'Uchwała rady miasta: cena biletu miesięcznego wzrośnie ze 110 do 129 zł od 1 stycznia 2027.' } }), {
    storageRoot: 'relative', retrieve: async (url) => { retrieved.push(url); throw new Error('unexpected'); },
    call: async (_model, request) => {
      requests.push(request);
      return candidate({ publicationDescriptionSuggestion: 'Bilet miesięczny podrożeje ze 110 do 129 zł.', publicationHashtagsSuggestion: '#Kraków', addsSupportedContext: true });
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests.some(isSearch), false, 'no googleSearch tool');
  assert.deepEqual(retrieved, []);
  const prompt = promptOf(requests[0]);
  assert.ok(prompt.includes('129 zł'), 'saved source reaches the prompt');
  assert.ok(prompt.includes('Zapłacisz więcej za tramwaj') && /tone only/.test(prompt), 'selected hook frames tone');
  assert.match(prompt, /Do not summarize or paraphrase the script/);
  assert.match(prompt, /do not repeat the hook mechanically/);
  assert.match(prompt, /no call to action, no emoji/);
  const result = work.result as Record<string, unknown>;
  assert.equal(result.publicationGrounding, 'saved_material');
  assert.deepEqual(result.publicationSources, []);
  assert.equal((work.provenance.publication as { searchRan: boolean }).searchRan, false);
});

test('a readable linked source is used and listed as the saved link, without search', async () => {
  const requests: Req[] = [];
  const work = await executeAction(v3({ originalInput: { url: 'https://krakow.example/uchwala' } }), {
    storageRoot: 'relative',
    retrieve: async (url) => retrievedAs(url, 'Rada Miasta przyjęła uchwałę o nowych cenach biletów komunikacji miejskiej od 2027 roku.'),
    call: async (_model, request) => {
      requests.push(request);
      return candidate({ publicationDescriptionSuggestion: 'Opis', publicationHashtagsSuggestion: '#x', addsSupportedContext: true });
    },
  });
  assert.equal(requests.length, 1);
  assert.ok(promptOf(requests[0]).includes('Rada Miasta przyjęła uchwałę'));
  const sources = (work.result as { publicationSources: Array<{ url: string; origin: string }> }).publicationSources;
  assert.deepEqual(sources.map(({ url, origin }) => ({ url, origin })), [{ url: 'https://krakow.example/uchwala', origin: 'saved_link' }]);
});

test('no source: bounded search; only provider-returned, retrieved and quoted sources become evidence', async () => {
  const requests: Req[] = [];
  const retrieved: string[] = [];
  const excerpts: Record<string, string> = {
    'https://grounding.example/a': 'Zarząd Transportu Publicznego podał, że bilet miesięczny będzie kosztował 129 zł, a ulgowy 64,50 zł.',
    'https://grounding.example/b': 'Zupełnie inny tekst o pogodzie w Krakowie, bez związku z tematem.',
  };
  const work = await executeAction(v3(), {
    storageRoot: 'relative',
    retrieve: async (url) => { retrieved.push(url); if (url.endsWith('/c')) throw new Error('unreadable'); return retrievedAs(url, excerpts[url]); },
    call: async (_model, request) => {
      requests.push(request);
      if (isSearch(request)) return grounding(['https://grounding.example/a', 'https://grounding.example/b', 'https://grounding.example/c']);
      return candidate({ publicationDescriptionSuggestion: 'Normalny bilet miesięczny ma kosztować 129 zł, ulgowy 64,50 zł.', publicationHashtagsSuggestion: '#Kraków',
        evidence: [{ sourceId: 'web-1', quote: 'bilet miesięczny będzie kosztował 129 zł' }, { sourceId: 'web-9', quote: 'https://invented.example/fake' }] });
    },
  });
  assert.equal(requests.length, 2, 'search + one generation; no material call without material');
  assert.ok(isSearch(requests[0]));
  assert.ok(promptOf(requests[0]).includes('bilety miesięczne') && promptOf(requests[0]).includes('Zapłacisz więcej'), 'search context = saved script + selected hook');
  assert.deepEqual(retrieved, ['https://grounding.example/a', 'https://grounding.example/b', 'https://grounding.example/c']);
  const result = work.result as { publicationGrounding: string; publicationSources: Array<{ url: string; providerReference: string; origin: string }> };
  assert.equal(result.publicationGrounding, 'web_search');
  assert.deepEqual(result.publicationSources.map(({ url, providerReference, origin }) => ({ url, providerReference, origin })),
    [{ url: 'https://grounding.example/a', providerReference: 'groundingChunks:0', origin: 'google_search' }]);
  assert.equal(JSON.stringify(work).includes('invented.example'), false, 'a model-written URL never becomes evidence');
  const stored = work.provenance.publication as { searchRan: boolean; groundingReferences: unknown[]; retainedSources: unknown[] };
  assert.equal(stored.searchRan, true);
  assert.equal(stored.groundingReferences.length, 3);
  assert.equal(stored.retainedSources.length, 2);
});

test('an inaccessible link with no other material falls back to search', async () => {
  const requests: Req[] = [];
  const work = await executeAction(v3({ originalInput: { url: 'https://paywall.example/x' } }), {
    storageRoot: 'relative', retrieve: async () => { throw new Error('403'); },
    call: async (_model, request) => {
      requests.push(request);
      return isSearch(request) ? grounding([]) : candidate({ publicationDescriptionSuggestion: 'Krótko.', publicationHashtagsSuggestion: '' });
    },
  });
  assert.ok(isSearch(requests[0]), 'search is the first provider call');
  assert.equal((work.provenance.publication as { linkedSourceFailure: string }).linkedSourceFailure, 'SOURCE_UNAVAILABLE');
  assert.equal((work.result as { publicationGrounding: string }).publicationGrounding, 'script_only');
});

test('no reliable search evidence: script-only prompt, explicit warning, no invented facts or sources', async () => {
  for (const scenario of ['no-results', 'unquoted'] as const) {
    const requests: Req[] = [];
    const work = await executeAction(v3(), {
      storageRoot: 'relative', retrieve: async (url) => retrievedAs(url, 'Artykuł o czymś zupełnie innym niż bilety, dość długi, by go przeczytać.'),
      call: async (_model, request) => {
        requests.push(request);
        if (isSearch(request)) return grounding(scenario === 'no-results' ? [] : ['https://grounding.example/a']);
        if (promptOf(request).includes('Sources:')) {
          return candidate({ publicationDescriptionSuggestion: 'Bilet kosztuje 999 zł.', publicationHashtagsSuggestion: '',
            evidence: [{ sourceId: 'web-1', quote: 'Bilet kosztuje 999 zł według ZTP' }] });
        }
        return candidate({ publicationDescriptionSuggestion: 'Bilety zdrożeją od stycznia.', publicationHashtagsSuggestion: '#Kraków' });
      },
    });
    const last = promptOf(requests[requests.length - 1]);
    assert.match(last, /No source material is available/, `${scenario}: final call is script-only`);
    assert.match(last, /add no facts absent from it/);
    const result = work.result as { publicationGrounding: string; publicationSources: unknown[]; publicationDescriptionSuggestion: string };
    assert.equal(result.publicationGrounding, 'script_only');
    assert.deepEqual(result.publicationSources, []);
    assert.equal(result.publicationDescriptionSuggestion.includes('999'), false, `${scenario}: unsupported fact discarded`);
    assert.ok(work.warnings.some((warning) => warning.includes('Nie znaleziono wiarygodnych materiałów')));
  }
});

test('material without additional context triggers search; nothing found keeps the short material-based copy', async () => {
  const requests: Req[] = [];
  const work = await executeAction(v3({ originalInput: { text: 'Od stycznia bilety miesięczne w Krakowie zdrożeją.' } }), {
    storageRoot: 'relative', retrieve: async () => { throw new Error('none'); },
    call: async (_model, request) => {
      requests.push(request);
      return isSearch(request) ? grounding([])
        : candidate({ publicationDescriptionSuggestion: 'Nowe ceny od stycznia.', publicationHashtagsSuggestion: '#Kraków', addsSupportedContext: false });
    },
  });
  assert.equal(requests.length, 2, 'material call + search, no third call');
  assert.ok(isSearch(requests[1]));
  assert.equal((work.result as { publicationDescriptionSuggestion: string }).publicationDescriptionSuggestion, 'Nowe ceny od stycznia.');
  assert.equal((work.result as { publicationGrounding: string }).publicationGrounding, 'script_only');
});

test('a bare shared URL is not treated as usable textual grounding', async () => {
  const requests: Req[] = [];
  await executeAction(v3({ originalInput: { text: 'https://instagram.example/reel/h7v9vwm' } }), {
    storageRoot: 'relative', retrieve: async () => { throw new Error('none'); },
    call: async (_model, request) => { requests.push(request); return isSearch(request) ? grounding([]) : candidate({ publicationDescriptionSuggestion: 'K.', publicationHashtagsSuggestion: '' }); },
  });
  assert.ok(isSearch(requests[0]));
});

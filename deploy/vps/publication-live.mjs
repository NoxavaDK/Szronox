// UI-02 / PUBLICATION-02 v3 live DEV acceptance over the real HTTP API, worker and Gemini.
// Run on the VPS from /opt/szronox-dev/app:
//   /opt/szronox-dev/config/dc-gemini.sh run --rm --no-deps -T \
//     -v /opt/szronox-dev/app/deploy/vps/publication-live.mjs:/app/publication-live.mjs:ro api node /app/publication-live.mjs
// Session minted through the app's own store (no credential read) and revoked at the end. Two
// disposable SMOKE Reels are created and soft-deleted (restorable from Usunięte). Provider budget:
// exactly two generate_publication runs — P1 grounded (1 Gemini call, no search) and P2 with an
// unreachable link and no other material (1 search call + 1–2 generation calls).
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const ORIGIN = process.env.APP_ORIGIN;
const BASE = process.env.SMOKE_BASE ?? 'http://api:3000';
const results = [];
let cookie = '';
let csrf = '';
const ok = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`); };
const pool = new pg.Pool({
  host: process.env.DATABASE_HOST, port: Number(process.env.DATABASE_PORT ?? 5432),
  database: process.env.DATABASE_NAME, user: process.env.DATABASE_USER,
  password: (await readFile(process.env.DATABASE_PASSWORD_FILE, 'utf8')).trim(), max: 2,
});
async function call(method, path, body) {
  const headers = { origin: ORIGIN, cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: response.status, json, text };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForRun(runId, seconds = 240) {
  for (let i = 0; i < seconds; i += 3) {
    const response = await call('GET', `/api/v1/ai-runs/${runId}`);
    if (['succeeded', 'failed'].includes(response.json?.state)) return response.json;
    await sleep(3000);
  }
  return { state: 'timeout' };
}
const reelOf = async (id) => (await call('GET', `/api/v1/reels/${id}`)).json;
const provenanceOf = async (runId) => (await pool.query('select provenance, prompt_id, input_snapshot from app.ai_runs where id=$1', [runId])).rows[0];

const sessions = await import('/app/apps/api/dist/auth/sessions.js');
const userId = (await pool.query("select id from app.users where name='NOXAVA'")).rows[0].id;
const csrfSecret = (await readFile(process.env.APP_CSRF_SECRET_FILE, 'utf8')).trim();
const store = sessions.createSessionStore({
  query: (text, params) => pool.query(text, params),
  transaction: async (fn) => fn({ query: (text, params) => pool.query(text, params) }),
});
const session = await store.create({ userId, csrfSecret, lifetimeMs: 30 * 60 * 1000 });
cookie = `__Host-szronox_session=${session.secret}`; csrf = session.csrfToken;
ok('P0 operator session authenticates', (await call('GET', '/api/v1/me')).status === 200);

const created = [];
async function smokeReel(input, script, hookText) {
  const reelId = randomUUID();
  created.push(reelId);
  let reel = (await call('POST', '/api/v1/reels', { operationId: randomUUID(), reelId, input: { images: [], ...input } })).json;
  reel = (await call('PATCH', `/api/v1/reels/${reelId}`, { operationId: randomUUID(), expectedVersion: reel.version, changes: { title: 'SMOKE UI-02 publikacja', script } })).json;
  if (hookText) {
    reel = (await call('POST', `/api/v1/reels/${reelId}/hooks`, { operationId: randomUUID(), expectedVersion: reel.version, text: hookText })).json;
    reel = (await call('PUT', `/api/v1/reels/${reelId}/selected-hook`, { operationId: randomUUID(), expectedVersion: reel.version, hookId: reel.hooks[0].id })).json;
  }
  return reel;
}
async function generate(reel) {
  const queued = await call('POST', `/api/v1/reels/${reel.id}/ai-runs`, { operationId: randomUUID(), expectedVersion: reel.version, action: 'generate_publication' });
  if (queued.status !== 202 && queued.status !== 200) return { state: 'enqueue_failed', detail: queued.text.slice(0, 200) };
  return waitForRun(queued.json.id);
}

try {
  // ── P1: grounded saved source → no search; description adds source facts absent from the script.
  // Fictional town (Testowo) so the fixture can never be mistaken for real news.
  const script = 'Od stycznia w Testowie podrożeją bilety miesięczne. Rada miasta już podjęła decyzję.';
  const hook = 'Zapłacisz więcej za tramwaj w Testowie';
  const p1 = await smokeReel({ text: 'SMOKE (fikcja testowa): Uchwała Rady Miasta Testowo z 24 września 2026 r. Od 1 stycznia 2027 r. normalny bilet miesięczny zdrożeje ze 110 do 129 zł, a ulgowy będzie kosztował 64,50 zł. Podwyżka nie obejmuje biletów semestralnych dla studentów.' }, script, hook);
  const run1 = await generate(p1);
  ok('P1 grounded run succeeded', run1.state === 'succeeded', run1.state === 'succeeded' ? '' : JSON.stringify(run1.error ?? run1).slice(0, 200));
  const stored1 = await provenanceOf(run1.id);
  ok('P1 v3 snapshot and prompt id', stored1?.input_snapshot?.publicationContextVersion === 3 && stored1?.prompt_id === 'gemini-02-publication-provisional-v3');
  const pub1 = run1.result ?? {};
  ok('P1 grounded in saved material, search NOT invoked', pub1.publicationGrounding === 'saved_material' && stored1?.provenance?.publication?.searchRan === false,
    `grounding=${pub1.publicationGrounding} searchRan=${stored1?.provenance?.publication?.searchRan}`);
  const description = pub1.publicationDescriptionSuggestion ?? '';
  console.log(`      P1 description: ${JSON.stringify(description)}`);
  console.log(`      P1 hashtags: ${JSON.stringify(pub1.publicationHashtagsSuggestion ?? '')}`);
  ok('P1 adds source information absent from the script', /129|64,50|semestr|24 wrze/.test(description) && description.trim() !== script);
  ok('P1 selected hook not mechanically repeated', !description.includes(hook));
  ok('P1 no emoji / CTA', !/\p{Extended_Pictographic}/u.test(description) && !/obserwuj|zasubskrybuj|kliknij|link w bio/i.test(description));
  ok('P1 generation wrote nothing to the Reel', (await reelOf(p1.id)).publicationDescription === '');

  // Freshness: unrelated metadata keeps the proposal fresh; hook and script changes stale it.
  let reel = await reelOf(p1.id);
  reel = (await call('PATCH', `/api/v1/reels/${p1.id}`, { operationId: randomUUID(), expectedVersion: reel.version, changes: { priority: 'urgent', editingNotes: 'SMOKE' } })).json;
  ok('P1 unrelated metadata does not stale', (await call('GET', `/api/v1/ai-runs/${run1.id}`)).json.isStale === false);
  reel = (await call('PUT', `/api/v1/reels/${p1.id}/selected-hook`, { operationId: randomUUID(), expectedVersion: reel.version, hookId: null })).json;
  ok('P1 changing the selected hook stales', (await call('GET', `/api/v1/ai-runs/${run1.id}`)).json.isStale === true);
  reel = (await call('PUT', `/api/v1/reels/${p1.id}/selected-hook`, { operationId: randomUUID(), expectedVersion: reel.version, hookId: reel.hooks[0].id })).json;
  ok('P1 restoring the same hook is fresh again', (await call('GET', `/api/v1/ai-runs/${run1.id}`)).json.isStale === false);
  reel = (await call('PATCH', `/api/v1/reels/${p1.id}`, { operationId: randomUUID(), expectedVersion: reel.version, changes: { script: `${script} Zmiana.` } })).json;
  ok('P1 changing the script stales', (await call('GET', `/api/v1/ai-runs/${run1.id}`)).json.isStale === true);
  const staleApply = await call('POST', `/api/v1/ai-runs/${run1.id}/apply`, { operationId: randomUUID(), expectedVersion: reel.version,
    selection: 'publication_description', text: description, replaceCurrentValue: '', confirmReplacement: true });
  ok('P1 stale proposal cannot be applied', staleApply.status === 409 && staleApply.json?.error?.code === 'STALE_PUBLICATION_RESULT', `HTTP ${staleApply.status}`);

  // ── P2: unreachable link and no other material → bounded search fallback with real provenance.
  const p2 = await smokeReel({ url: 'https://smoke-ui02.invalid/artykul' },
    'Unia Europejska zdecydowała, że od 2035 roku nowe samochody osobowe sprzedawane w UE mają nie emitować CO2 z rury wydechowej.', null);
  const run2 = await generate(p2);
  ok('P2 fallback run succeeded', run2.state === 'succeeded', run2.state === 'succeeded' ? '' : JSON.stringify(run2.error ?? run2).slice(0, 200));
  const stored2 = await provenanceOf(run2.id);
  const pub2 = run2.result ?? {};
  const prov2 = stored2?.provenance?.publication ?? {};
  ok('P2 inaccessible link recorded and search invoked', prov2.searchRan === true && typeof prov2.linkedSourceFailure === 'string', `failure=${prov2.linkedSourceFailure}`);
  console.log(`      P2 grounding=${pub2.publicationGrounding} groundingReferences=${(prov2.groundingReferences ?? []).length} retained=${(prov2.retainedSources ?? []).length}`);
  console.log(`      P2 description: ${JSON.stringify(pub2.publicationDescriptionSuggestion ?? '')}`);
  for (const source of pub2.publicationSources ?? []) console.log(`      P2 source: ${source.url} (${source.providerReference})`);
  const retained = new Map((prov2.retainedSources ?? []).map((item) => [item.id, item]));
  const references = new Set((prov2.groundingReferences ?? []).map((item) => item.reference));
  const sourcesBacked = (pub2.publicationSources ?? []).every((source) => source.origin === 'google_search'
    && retained.get(source.id)?.url === source.url && references.has(source.providerReference));
  ok('P2 every returned source is a retrieved provider grounding result', sourcesBacked);
  ok('P2 outcome is web-grounded or explicitly script-only', pub2.publicationGrounding === 'web_search'
    ? (pub2.publicationSources ?? []).length > 0
    : pub2.publicationGrounding === 'script_only' && (pub2.publicationSources ?? []).length === 0 && run2.warnings.some((w) => w.startsWith('Nie znaleziono wiarygodnych')),
  `grounding=${pub2.publicationGrounding}`);

  // Explicit apply and collision protection are unchanged.
  let reel2 = await reelOf(p2.id);
  ok('P2 generation wrote nothing to the Reel', reel2.publicationDescription === '' && reel2.publicationHashtags === '');
  const applied = await call('POST', `/api/v1/ai-runs/${run2.id}/apply`, { operationId: randomUUID(), expectedVersion: reel2.version,
    selection: 'publication_description', text: pub2.publicationDescriptionSuggestion, replaceCurrentValue: '', confirmReplacement: true });
  ok('P2 explicit apply writes OPIS only', applied.status === 200 && applied.json.publicationDescription === pub2.publicationDescriptionSuggestion && applied.json.publicationHashtags === '');
  reel2 = applied.json;
  const collision = await call('POST', `/api/v1/ai-runs/${run2.id}/apply`, { operationId: randomUUID(), expectedVersion: reel2.version,
    selection: 'publication_description', text: 'Inny tekst', replaceCurrentValue: '', confirmReplacement: true });
  ok('P2 no silent overwrite (stale replaceCurrentValue → conflict)', collision.status === 409 && collision.json?.error?.code === 'EDIT_CONFLICT', `HTTP ${collision.status}`);
} finally {
  for (const id of created) {
    const current = await call('GET', `/api/v1/reels/${id}`);
    if (current.status === 200 && !current.json.deletedAt) {
      const removed = await call('POST', `/api/v1/reels/${id}/delete`, { operationId: randomUUID(), expectedVersion: current.json.version });
      console.log(`cleanup soft-delete ${id} status=${removed.status}`);
    }
  }
  await store.revoke(session.secret);
  await pool.end();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);

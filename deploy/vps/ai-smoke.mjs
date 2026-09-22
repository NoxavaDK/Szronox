/**
 * GEMINI-02 development smoke test — the real application pipeline, not provider probes.
 *
 * Drives the live DEV API over HTTP: capture, upload lifecycle, AI enqueue, result
 * application, meme attachment order, programme fail-closed behaviour and idempotency
 * scope. It asserts that authored content survives every AI path.
 *
 * Six assertions need one successful provider response and are the checks blocked by the
 * free-tier daily quota recorded in GEMINI-02-integration-result.md §5. Re-run this after
 * the quota resets to close that gate.
 *
 * Run on the DEV host, from /opt/szronox-dev/app:
 *
 *   /opt/szronox-dev/config/dc-gemini.sh run --rm --no-deps -T \
 *     -v /opt/szronox-dev/config/ai-smoke.mjs:/app/smoke.mjs:ro api node /app/smoke.mjs
 *
 * It mints a session through the application's own session store for the existing NOXAVA
 * identity and revokes it at the end: no user credential is read, changed or printed, and
 * the cookie never leaves the container. It creates Reels labelled SMOKE in the target
 * environment — development only.
 */
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';

const ORIGIN = process.env.APP_ORIGIN;
const BASE = process.env.SMOKE_BASE ?? 'http://api:3000';
const results = [];
const gates = [];
let cookie = '';
let csrf = '';

const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
};
const gate = (name, detail) => { gates.push({ name, detail }); console.log(`GATE  ${name} :: ${detail}`); };

const pool = new pg.Pool({
  host: process.env.DATABASE_HOST, port: Number(process.env.DATABASE_PORT ?? 5432),
  database: process.env.DATABASE_NAME, user: process.env.DATABASE_USER,
  password: (await readFile(process.env.DATABASE_PASSWORD_FILE, 'utf8')).trim(), max: 3,
});

async function call(method, path, body, extraHeaders = {}) {
  const headers = { origin: ORIGIN, cookie, ...extraHeaders };
  if (body !== undefined && !(body instanceof Uint8Array)) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  const response = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { status: response.status, json, text };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForRun(runId, seconds = 180) {
  for (let i = 0; i < seconds; i += 3) {
    const response = await call('GET', `/api/v1/ai-runs/${runId}`);
    if (response.status !== 200) return { state: 'http_error', response };
    if (['succeeded', 'failed'].includes(response.json.state)) return response.json;
    await sleep(3000);
  }
  return { state: 'timeout' };
}

// ── S0. Mint an operator session for NOXAVA without touching credentials ───────
const sessions = await import('/app/apps/api/dist/auth/sessions.js');
const users = await pool.query("select id, name from app.users where name='NOXAVA'");
const userId = users.rows[0].id;
const csrfSecret = (await readFile(process.env.APP_CSRF_SECRET_FILE, 'utf8')).trim();
const store = sessions.createSessionStore({
  query: (text, params) => pool.query(text, params),
  transaction: async (fn) => fn({ query: (text, params) => pool.query(text, params) }),
});
const session = await store.create({ userId, csrfSecret, lifetimeMs: 30 * 60 * 1000 });
cookie = `__Host-szronox_session=${session.secret}`;
csrf = session.csrfToken;
const me = await call('GET', '/api/v1/me');
ok('S0 operator session authenticates', me.status === 200 && me.json?.user?.name === 'NOXAVA',
  `status=${me.status} user=${me.json?.user?.name} peer=${me.json?.peer?.name}`);

const capabilities = await call('GET', '/api/v1/ai/capabilities');
ok('S0 AI capability enabled', capabilities.json?.enabled === true,
  `enabled=${capabilities.json?.enabled} programmeIndexed=${capabilities.json?.programmeIndexed}`);

// ── S1. Text capture ──────────────────────────────────────────────────────────
const AUTHORED_SCRIPT = 'Rząd zapowiada podwyżki cen energii od stycznia. To uderzy w najuboższych.';
const AUTHORED_HOOK = 'Kto naprawdę zapłaci za drożejący prąd?';
const AUTHORED_DESCRIPTION = 'MÓJ WŁASNY OPIS — nie do nadpisania.';
const textReelId = randomUUID();
let created = await call('POST', '/api/v1/reels', {
  operationId: randomUUID(), reelId: textReelId,
  input: { text: 'SMOKE tekst: rząd zapowiada podwyżki cen energii od stycznia 2027.', images: [] },
  initialHook: AUTHORED_HOOK,
});
ok('S1 text capture created', created.status === 201, `status=${created.status}`);
let reel = created.json;
ok('S1 capture stores no title', reel?.title === '', `title="${reel?.title}"`);
ok('S1 originalInput preserved', reel?.originalInput?.text?.startsWith('SMOKE tekst'), '');

const patched = await call('PATCH', `/api/v1/reels/${textReelId}`, {
  operationId: randomUUID(), expectedVersion: reel.version,
  changes: { script: AUTHORED_SCRIPT, publicationDescription: AUTHORED_DESCRIPTION },
});
ok('S1 authored script and description saved', patched.status === 200, `status=${patched.status}`);
reel = patched.json;
const baselineHooks = reel.hooks.map((hook) => ({ id: hook.id, text: hook.text, position: hook.position }));
const baselineRevision = reel.scriptRevision;

// ── S2. Opracuj end to end ────────────────────────────────────────────────────
let enqueued = await call('POST', `/api/v1/reels/${textReelId}/ai-runs`, {
  operationId: randomUUID(), expectedVersion: reel.version, action: 'develop',
});
ok('S2 develop enqueued (202)', enqueued.status === 202, `status=${enqueued.status} ${enqueued.json?.error?.code ?? ''}`);
const developRun = await waitForRun(enqueued.json?.id);
ok('S2 develop run completed', developRun.state === 'succeeded',
  `state=${developRun.state} error=${developRun.error?.code ?? 'none'}`);

if (developRun.state === 'succeeded') {
  const r = developRun.result;
  ok('S2 result carries all frozen fields',
    typeof r.titleSuggestion === 'string' && typeof r.eventSummary === 'string' &&
    Array.isArray(r.verificationIssues) && Array.isArray(r.hookAdditions) &&
    typeof r.scriptSuggestion === 'string' && typeof r.publicationDescriptionSuggestion === 'string' &&
    typeof r.publicationHashtagsSuggestion === 'string',
    `hooks=${r.hookAdditions.length} scriptChars=${r.scriptSuggestion.length}`);
  ok('S2 at most three hook additions', r.hookAdditions.length <= 3, `count=${r.hookAdditions.length}`);
  ok('S2 meme suggestion is null or a real candidate',
    r.memeSuggestion === null || developRun.input.memeCandidateIds.includes(r.memeSuggestion.memeId),
    `suggestion=${r.memeSuggestion === null ? 'null' : r.memeSuggestion.memeId}`);
  ok('S2 programme connection is a hint, not a citation',
    r.possibleProgrammeConnection === null || typeof r.possibleProgrammeConnection === 'string', '');

  const after = (await call('GET', `/api/v1/reels/${textReelId}`)).json;
  ok('S2 AUTHORED SCRIPT PRESERVED', after.script === AUTHORED_SCRIPT, '');
  ok('S2 AUTHORED DESCRIPTION PRESERVED', after.publicationDescription === AUTHORED_DESCRIPTION, '');
  ok('S2 authored hashtags untouched', after.publicationHashtags === '', '');
  ok('S2 script revision unchanged by AI run', after.scriptRevision === baselineRevision,
    `${baselineRevision} -> ${after.scriptRevision}`);
  const existing = after.hooks.filter((hook) => baselineHooks.some((base) => base.id === hook.id));
  ok('S2 EXISTING HOOK PRESERVED verbatim and in place',
    existing.length === baselineHooks.length &&
    existing.every((hook) => baselineHooks.find((base) => base.id === hook.id).text === hook.text &&
      baselineHooks.find((base) => base.id === hook.id).position === hook.position), '');
  const appended = after.hooks.filter((hook) => developRun.appliedHookIds.includes(hook.id));
  ok('S2 hooks appended additively as ai source',
    appended.length === r.hookAdditions.length && appended.every((hook) => hook.source === 'ai'),
    `appended=${appended.length}`);

  // Private provenance must not leak through the run response.
  const raw = JSON.stringify(developRun);
  ok('S2 no private provenance in run response',
    !raw.includes('storageKey') && !raw.includes('programmeEvidence') && !raw.includes('imageObjects') &&
    developRun.provenance === undefined, '');

  // ── S3. Explicit application and publication collision safeguard ────────────
  let current = after;
  const appliedTitle = await call('POST', `/api/v1/ai-runs/${developRun.id}/apply`, {
    operationId: randomUUID(), expectedVersion: current.version, selection: 'title', text: r.titleSuggestion,
  });
  ok('S3 explicit title application', appliedTitle.status === 200 && appliedTitle.json.title === r.titleSuggestion,
    `status=${appliedTitle.status}`);
  current = appliedTitle.json;

  const wrongBaseline = await call('POST', `/api/v1/ai-runs/${developRun.id}/apply`, {
    operationId: randomUUID(), expectedVersion: current.version, selection: 'publication_description',
    text: r.publicationDescriptionSuggestion, replaceCurrentValue: 'coś zupełnie innego', confirmReplacement: true,
  });
  ok('S3 publication replacement REFUSED on a stale baseline',
    wrongBaseline.status === 409 && wrongBaseline.json?.error?.code === 'EDIT_CONFLICT',
    `status=${wrongBaseline.status} code=${wrongBaseline.json?.error?.code}`);
  const unconfirmed = await call('POST', `/api/v1/ai-runs/${developRun.id}/apply`, {
    operationId: randomUUID(), expectedVersion: current.version, selection: 'publication_description',
    text: r.publicationDescriptionSuggestion, replaceCurrentValue: AUTHORED_DESCRIPTION,
  });
  ok('S3 publication replacement REFUSED without explicit confirmation',
    unconfirmed.status === 422 && unconfirmed.json?.error?.code === 'VALIDATION_ERROR',
    `status=${unconfirmed.status} code=${unconfirmed.json?.error?.code}`);
  const stillThere = (await call('GET', `/api/v1/reels/${textReelId}`)).json;
  ok('S3 authored description survived both refusals', stillThere.publicationDescription === AUTHORED_DESCRIPTION, '');

  const confirmed = await call('POST', `/api/v1/ai-runs/${developRun.id}/apply`, {
    operationId: randomUUID(), expectedVersion: stillThere.version, selection: 'publication_description',
    text: r.publicationDescriptionSuggestion, replaceCurrentValue: AUTHORED_DESCRIPTION, confirmReplacement: true,
  });
  ok('S3 confirmed publication replacement applies',
    confirmed.status === 200 && confirmed.json.publicationDescription === r.publicationDescriptionSuggestion,
    `status=${confirmed.status}`);
  current = confirmed.json;

  // ── S4. Wygeneruj więcej — additive hooks ───────────────────────────────────
  const hooksBefore = current.hooks.map((hook) => ({ id: hook.id, text: hook.text, position: hook.position }));
  const more = await call('POST', `/api/v1/reels/${textReelId}/ai-runs`, {
    operationId: randomUUID(), expectedVersion: current.version, action: 'generate_hooks',
  });
  const moreRun = await waitForRun(more.json?.id);
  ok('S4 generate_hooks completed', moreRun.state === 'succeeded',
    `state=${moreRun.state} error=${moreRun.error?.code ?? 'none'}`);
  if (moreRun.state === 'succeeded') {
    const afterHooks = (await call('GET', `/api/v1/reels/${textReelId}`)).json.hooks;
    ok('S4 previous hooks all still present, unchanged, same positions',
      hooksBefore.every((base) => {
        const now = afterHooks.find((hook) => hook.id === base.id);
        return now && now.text === base.text && now.position === base.position;
      }), `before=${hooksBefore.length} after=${afterHooks.length}`);
    ok('S4 additions appended at the end (<=3)',
      afterHooks.length - hooksBefore.length === moreRun.result.hookAdditions.length &&
      moreRun.result.hookAdditions.length <= 3,
      `added=${afterHooks.length - hooksBefore.length}`);
  }
}

// ── S5. Link capture exercises bounded public source retrieval ────────────────
const linkReelId = randomUUID();
const linkReel = (await call('POST', '/api/v1/reels', {
  operationId: randomUUID(), reelId: linkReelId,
  input: { url: 'https://example.com/', images: [] },
})).json;
const linkRun = await call('POST', `/api/v1/reels/${linkReelId}/ai-runs`, {
  operationId: randomUUID(), expectedVersion: linkReel.version, action: 'develop',
});
const linkResult = await waitForRun(linkRun.json?.id);
ok('S5 link capture develop completed', linkResult.state === 'succeeded',
  `state=${linkResult.state} error=${linkResult.error?.code ?? 'none'}`);
const provenance = await pool.query(
  "select provenance->'source' as source from app.ai_runs where id=$1", [linkRun.json?.id]);
const sourceProvenance = provenance.rows[0]?.source;
ok('S5 bounded public URL retrieval recorded with hash and status',
  Boolean(sourceProvenance) && sourceProvenance.status === 200 && typeof sourceProvenance.sha256 === 'string' &&
  sourceProvenance.url === 'https://example.com/',
  `status=${sourceProvenance?.status} excerptChars=${sourceProvenance?.excerpt?.length ?? 0}`);

// ── S6. Image capture, upload lifecycle, and meme library ─────────────────────
// 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const imageReelId = randomUUID();
const attachmentId = randomUUID();
const imageReel = (await call('POST', '/api/v1/reels', {
  operationId: randomUUID(), reelId: imageReelId,
  input: { text: 'SMOKE zdjęcie: mem do sprawdzenia biblioteki.',
    images: [{ attachmentId, fileName: 'smoke.png', mimeType: 'image/png', byteSize: PNG.byteLength }] },
})).json;
ok('S6 image capture created with pending attachment',
  imageReel?.attachments?.length === 1 && imageReel.attachments[0].state === 'pending',
  `state=${imageReel?.attachments?.[0]?.state}`);

const tooEarly = await call('POST', `/api/v1/reels/${imageReelId}/ai-runs`, {
  operationId: randomUUID(), expectedVersion: imageReel.version, action: 'develop',
});
ok('S6 Opracuj refuses an incomplete upload without losing the capture',
  tooEarly.status === 422 && tooEarly.json?.error?.code === 'UPLOAD_INCOMPLETE',
  `status=${tooEarly.status} code=${tooEarly.json?.error?.code}`);

const initiated = (await call('POST', `/api/v1/reels/${imageReelId}/attachments/initiate`, {
  operationId: randomUUID(), attachmentId, fileName: 'smoke.png', mimeType: 'image/png',
  byteSize: PNG.byteLength, purpose: 'input',
})).json;
const uploaded = await call('PUT', `/api/v1/reels/${imageReelId}/attachments/${attachmentId}/content`,
  new Uint8Array(PNG), { 'content-type': 'image/png', ...initiated.upload.headers });
ok('S6 image bytes uploaded', uploaded.status === 204, `status=${uploaded.status}`);
const completed = await call('POST', `/api/v1/reels/${imageReelId}/attachments/${attachmentId}/complete`,
  { operationId: randomUUID() });
ok('S6 attachment completed and validated', completed.status === 200 && completed.json.state === 'ready',
  `state=${completed.json?.state}`);

const imageReelNow = (await call('GET', `/api/v1/reels/${imageReelId}`)).json;
const imageRun = await call('POST', `/api/v1/reels/${imageReelId}/ai-runs`, {
  operationId: randomUUID(), expectedVersion: imageReelNow.version, action: 'develop',
});
const imageResult = await waitForRun(imageRun.json?.id);
ok('S6 image capture develop completed', imageResult.state === 'succeeded',
  `state=${imageResult.state} error=${imageResult.error?.code ?? 'none'}`);
const imageProvenance = await pool.query(
  "select provenance->'images' as images from app.ai_runs where id=$1", [imageRun.json?.id]);
ok('S6 validated image actually reached the model',
  Array.isArray(imageProvenance.rows[0]?.images) && imageProvenance.rows[0].images.length === 1,
  `images=${JSON.stringify(imageProvenance.rows[0]?.images)?.slice(0, 120)}`);

// Meme library: create from the validated image, attach, order, detach.
const memeOne = await call('POST', '/api/v1/memes', {
  operationId: randomUUID(), name: 'SMOKE mem pierwszy', imageAssetId: attachmentId,
  attachToReel: { reelId: imageReelId, expectedVersion: (await call('GET', `/api/v1/reels/${imageReelId}`)).json.version },
});
ok('S6 meme created and attached atomically',
  memeOne.status === 201 && memeOne.json.reel.memeIds.length === 1,
  `status=${memeOne.status} memeIds=${memeOne.json?.reel?.memeIds?.length}`);
const firstMemeId = memeOne.json?.meme?.id;
const memeTwo = await call('POST', '/api/v1/memes', {
  operationId: randomUUID(), name: 'SMOKE mem drugi', imageAssetId: attachmentId,
  attachToReel: { reelId: imageReelId, expectedVersion: memeOne.json.reel.version },
});
ok('S6 second meme appends, first stays primary',
  memeTwo.status === 201 && memeTwo.json.reel.memeIds[0] === firstMemeId && memeTwo.json.reel.memeIds.length === 2,
  `order=${JSON.stringify(memeTwo.json?.reel?.memeIds?.map((id) => id === firstMemeId ? 'first' : 'second'))}`);
const secondMemeId = memeTwo.json?.meme?.id;
const detached = await call('DELETE', `/api/v1/reels/${imageReelId}/memes/${firstMemeId}`, {
  operationId: randomUUID(), expectedVersion: memeTwo.json.reel.version,
});
ok('S6 detach preserves remaining order and the shared library record',
  detached.status === 200 && detached.json.memeIds.length === 1 && detached.json.memeIds[0] === secondMemeId,
  `remaining=${detached.json?.memeIds?.length}`);
const library = await call('GET', '/api/v1/memes');
ok('S6 detached meme still exists in the shared library',
  (library.json?.items ?? []).some((meme) => meme.id === firstMemeId) === true,
  `libraryItems=${(library.json?.items ?? []).length}`);

// ── S7. Sprawdź język ─────────────────────────────────────────────────────────
const langBase = (await call('GET', `/api/v1/reels/${textReelId}`)).json;
const langEnqueued = await call('POST', `/api/v1/reels/${textReelId}/ai-runs`, {
  operationId: randomUUID(), expectedVersion: langBase.version, action: 'language_check',
});
const langRun = await waitForRun(langEnqueued.json?.id);
ok('S7 language_check completed', langRun.state === 'succeeded',
  `state=${langRun.state} error=${langRun.error?.code ?? 'none'}`);
if (langRun.state === 'succeeded') {
  ok('S7 A/B versions available and script untouched until applied',
    typeof langRun.result.scriptSuggestion === 'string' && Array.isArray(langRun.result.notes) &&
    (await call('GET', `/api/v1/reels/${textReelId}`)).json.script === langBase.script,
    `notes=${langRun.result.notes.length}`);
  const versionNow = (await call('GET', `/api/v1/reels/${textReelId}`)).json;
  const appliedB = await call('POST', `/api/v1/ai-runs/${langRun.id}/apply`, {
    operationId: randomUUID(), expectedVersion: versionNow.version,
    selection: 'language_version', version: 'B', text: langRun.result.scriptSuggestion,
  });
  ok('S7 explicit application replaces the whole script and bumps revision',
    appliedB.status === 200 && appliedB.json.script === langRun.result.scriptSuggestion &&
    appliedB.json.scriptRevision === versionNow.scriptRevision + 1,
    `status=${appliedB.status} revision=${versionNow.scriptRevision}->${appliedB.json?.scriptRevision}`);
  ok('S7 hooks untouched by language application',
    appliedB.json?.hooks?.length === versionNow.hooks.length, '');
  const reapply = await call('POST', `/api/v1/ai-runs/${langRun.id}/apply`, {
    operationId: randomUUID(), expectedVersion: appliedB.json.version,
    selection: 'language_version', version: 'B', text: langRun.result.scriptSuggestion,
  });
  ok('S7 STALE_LANGUAGE_RESULT once the script has changed',
    reapply.status === 409 && reapply.json?.error?.code === 'STALE_LANGUAGE_RESULT',
    `status=${reapply.status} code=${reapply.json?.error?.code}`);
}

// ── S8. Sprawdź fakty — known Google Search grounding gate ────────────────────
const factBase = (await call('GET', `/api/v1/reels/${textReelId}`)).json;
const factEnqueued = await call('POST', `/api/v1/reels/${textReelId}/ai-runs`, {
  operationId: randomUUID(), expectedVersion: factBase.version, action: 'fact_check',
});
const factRun = await waitForRun(factEnqueued.json?.id, 300);
if (factRun.state === 'succeeded') {
  const claims = factRun.result.claims ?? [];
  ok('S8 fact check uses exactly the three frozen statuses',
    claims.every((claim) => ['confirmed', 'uncertain', 'contradicted'].includes(claim.status)), '');
  ok('S8 confirmed claims carry retained evidence',
    claims.filter((claim) => claim.status === 'confirmed').every((claim) => claim.evidence.length > 0),
    `claims=${claims.length}`);
  ok('S8 no confidence scores in the result', !JSON.stringify(factRun.result).match(/"(confidence|score|probability)"/), '');
} else {
  gate('S8 Sprawdź fakty blocked by provider grounding quota',
    `state=${factRun.state} code=${factRun.error?.code} retryable=${factRun.error?.retryable} result=${factRun.result === null ? 'null (no fabricated evidence)' : 'NON-NULL'}`);
  ok('S8 failed fact check fabricates nothing', factRun.state === 'failed' && factRun.result === null &&
    factRun.error?.code === 'PROVIDER_UNAVAILABLE', `code=${factRun.error?.code}`);
}

// ── S9. Sprawdź postulat — fail closed with no approved corpus ────────────────
const programmeBase = (await call('GET', `/api/v1/reels/${textReelId}`)).json;
const programme = await call('POST', `/api/v1/reels/${textReelId}/ai-runs`, {
  operationId: randomUUID(), expectedVersion: programmeBase.version, action: 'find_programme',
});
ok('S9 programme search FAILS CLOSED without an approved corpus',
  programme.status === 422 && programme.json?.error?.code === 'INSUFFICIENT_EVIDENCE',
  `status=${programme.status} code=${programme.json?.error?.code}`);
const programmeRuns = await pool.query(
  "select count(*)::int as count from app.ai_runs where action='find_programme'");
ok('S9 no programme run was enqueued at all', programmeRuns.rows[0].count === 0,
  `runs=${programmeRuns.rows[0].count}`);

// ── S10. Idempotency scope ───────────────────────────────────────────────────
const idemBase = (await call('GET', `/api/v1/reels/${textReelId}`)).json;
const operationId = randomUUID();
const firstCall = await call('POST', `/api/v1/reels/${textReelId}/ai-runs`, {
  operationId, expectedVersion: idemBase.version, action: 'generate_hooks',
});
const replayCall = await call('POST', `/api/v1/reels/${textReelId}/ai-runs`, {
  operationId, expectedVersion: idemBase.version, action: 'generate_hooks',
});
ok('S10 identical retry replays the same run',
  replayCall.status === 202 && replayCall.json?.id === firstCall.json?.id, `same=${replayCall.json?.id === firstCall.json?.id}`);
const differentPayload = await call('POST', `/api/v1/reels/${textReelId}/ai-runs`, {
  operationId, expectedVersion: idemBase.version, action: 'language_check',
});
ok('S10 same operation id with a different payload conflicts',
  differentPayload.status === 409 && differentPayload.json?.error?.code === 'IDEMPOTENCY_CONFLICT',
  `status=${differentPayload.status} code=${differentPayload.json?.error?.code}`);

// ── Teardown ─────────────────────────────────────────────────────────────────
await store.revoke(session.secret);
console.log('\n--- SUMMARY ---');
console.log(`PASS ${results.filter((entry) => entry.pass).length} / ${results.length}`);
const failed = results.filter((entry) => !entry.pass);
if (failed.length) console.log(`FAILED: ${failed.map((entry) => entry.name).join(' | ')}`);
console.log(`GATES ${gates.length}${gates.length ? `: ${gates.map((entry) => entry.name).join(' | ')}` : ''}`);
console.log(`SMOKE REELS: text=${textReelId} link=${linkReelId} image=${imageReelId}`);
await pool.end();

// CONTENT-PLANNER-01 live DEV acceptance over the real HTTP API. Run on the VPS from /opt/szronox-dev/app:
//   /opt/szronox-dev/config/dc-gemini.sh run --rm --no-deps -T \
//     -v /opt/szronox-dev/app/deploy/vps/planner-live.mjs:/app/planner-live.mjs:ro api node /app/planner-live.mjs
// Session minted through the app's own store (no credential read) and revoked at the end. One
// disposable SMOKE Reel is created and soft-deleted (restorable from Usunięte). Existing Reels
// are only read. No provider call.
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
  return { status: response.status, json };
}
const patch = (reel, changes) => call('PATCH', `/api/v1/reels/${reel.id}`, { operationId: randomUUID(), expectedVersion: reel.version, changes });
const pad = (n) => String(n).padStart(2, '0');
const day = (offset) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };

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

const countBefore = Number((await pool.query('select count(*) from app.reels')).rows[0].count);
const existing = (await call('GET', '/api/v1/reels?limit=100')).json;
ok('P1 existing Reels load with valid, unplanned-by-default plan fields',
  existing.items.length > 0 && existing.items.every((r) => (r.plannedPublicationDate === null || /^\d{4}-\d{2}-\d{2}$/.test(r.plannedPublicationDate))
    && (r.plannedPublicationSlot === null || (r.plannedPublicationDate !== null && ['morning', 'afternoon', 'evening'].includes(r.plannedPublicationSlot)))
    && !('plannedPublicationTime' in r)),
  `active=${existing.items.length}`);

const reelId = randomUUID();
try {
  let reel = (await call('POST', '/api/v1/reels', { operationId: randomUUID(), reelId,
    input: { text: 'SMOKE CONTENT-PLANNER-01: rolka testowa planu publikacji.', images: [] } })).json;
  ok('P2 new Reel is unplanned', reel.plannedPublicationDate === null && reel.plannedPublicationSlot === null);
  reel = (await patch(reel, { status: 'editing' })).json;

  let r = await patch(reel, { plannedPublicationDate: day(1), plannedPublicationSlot: null });
  ok('P3 schedule date only (slot optional)', r.status === 200 && r.json.plannedPublicationDate === day(1) && r.json.plannedPublicationSlot === null
    && r.json.status === 'editing' && r.json.scriptRevision === reel.scriptRevision, `status=${r.status}`);
  reel = r.json;
  ok('P3 persisted on detail reload', (await call('GET', `/api/v1/reels/${reelId}`)).json.plannedPublicationDate === day(1));

  r = await patch(reel, { plannedPublicationDate: day(2), plannedPublicationSlot: 'evening' });
  ok('P4 move to another day with slot Wieczór', r.status === 200 && r.json.plannedPublicationDate === day(2) && r.json.plannedPublicationSlot === 'evening');
  reel = r.json;
  const listed = (await call('GET', '/api/v1/reels?limit=100')).json.items.filter((item) => item.id === reelId);
  ok('P5 exactly one Reel carries the plan (no duplicate)', listed.length === 1 && listed[0].plannedPublicationSlot === 'evening');

  const stale = await call('PATCH', `/api/v1/reels/${reelId}`, { operationId: randomUUID(), expectedVersion: reel.version - 1, changes: { plannedPublicationDate: day(3) } });
  ok('P6 stale plan change conflicts', stale.status === 409 && stale.json?.error?.code === 'EDIT_CONFLICT');
  const bad = await patch(reel, { plannedPublicationDate: day(3).replace(/-\d{2}$/, '-32') });
  const orphan = await patch(reel, { plannedPublicationDate: null, plannedPublicationSlot: 'morning' });
  const freeTime = await patch(reel, { plannedPublicationSlot: '18:30' });
  const retired = await patch(reel, { plannedPublicationTime: '18:30' });
  ok('P7 invalid date, slot-without-date, free time and the retired time field refused',
    bad.status === 422 && orphan.status === 422 && freeTime.status === 422 && retired.status === 422);

  r = await patch(reel, { plannedPublicationDate: null });
  ok('P8 unschedule clears date and slot, status unchanged', r.status === 200 && r.json.plannedPublicationDate === null
    && r.json.plannedPublicationSlot === null && r.json.status === 'editing');
  reel = r.json;

  const noCsrf = await fetch(`${BASE}/api/v1/reels/${reelId}`, { method: 'PATCH', headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: randomUUID(), expectedVersion: reel.version, changes: { plannedPublicationDate: day(1) } }) });
  ok('P9 plan write requires CSRF like every mutation', noCsrf.status === 403);

  const del = await call('POST', `/api/v1/reels/${reelId}/delete`, { operationId: randomUUID(), expectedVersion: reel.version });
  ok('P10 SMOKE Reel soft-deleted', del.status === 200);
} finally {
  // Cleanup even on a failed check: the SMOKE Reel ends soft-deleted.
  const current = await call('GET', `/api/v1/reels/${reelId}`);
  if (current.status === 200) {
    const removed = await call('POST', `/api/v1/reels/${reelId}/delete`, { operationId: randomUUID(), expectedVersion: current.json.version });
    console.log(`cleanup soft-delete ${reelId} status=${removed.status}`);
  }
}
const countAfter = Number((await pool.query('select count(*) from app.reels')).rows[0].count);
ok('P11 only the one SMOKE Reel was added', countAfter === countBefore + 1, `${countBefore} -> ${countAfter}`);
await store.revoke(session.secret);
ok('P12 session revoked', (await call('GET', '/api/v1/me')).status === 401);
await pool.end();
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);

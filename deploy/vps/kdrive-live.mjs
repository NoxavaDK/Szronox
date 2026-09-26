// KDRIVE-01 live DEV acceptance over the real HTTP API and the real kDrive. Run on the VPS from /opt/szronox-dev/app:
//   /opt/szronox-dev/config/dc-gemini.sh run --rm --no-deps -T \
//     -v /opt/szronox-dev/app/deploy/vps/kdrive-live.mjs:/app/kdrive-live.mjs:ro api node /app/kdrive-live.mjs
// Session minted through the app's own store (no credential read) and revoked at the end. One
// disposable SMOKE Reel is created and soft-deleted (restorable from Usunięte). Its kDrive folder
// is created inside the configured base folder and deliberately NOT deleted. No existing kDrive
// content is read beyond folder metadata/listing, and nothing existing is modified.
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

const sessions = await import('/app/apps/api/dist/auth/sessions.js');
const userId = (await pool.query("select id from app.users where name='NOXAVA'")).rows[0].id;
const csrfSecret = (await readFile(process.env.APP_CSRF_SECRET_FILE, 'utf8')).trim();
const store = sessions.createSessionStore({
  query: (text, params) => pool.query(text, params),
  transaction: async (fn) => fn({ query: (text, params) => pool.query(text, params) }),
});
const session = await store.create({ userId, csrfSecret, lifetimeMs: 30 * 60 * 1000 });
cookie = `__Host-szronox_session=${session.secret}`; csrf = session.csrfToken;
ok('K0 operator session authenticates', (await call('GET', '/api/v1/me')).status === 200);

const token = (await readFile(process.env.KDRIVE_TOKEN_FILE, 'utf8')).trim();
const reelId = randomUUID();
let folderId = null;
try {
  let reel = (await call('POST', '/api/v1/reels', { operationId: randomUUID(), reelId,
    input: { text: 'SMOKE KDRIVE-01: rolka testowa folderu kDrive.', images: [] } })).json;
  reel = (await call('PATCH', `/api/v1/reels/${reelId}`, { operationId: randomUUID(), expectedVersion: reel.version, changes: { title: 'SMOKE KDRIVE-01' } })).json;

  const none = await call('GET', `/api/v1/reels/${reelId}/kdrive-folder`);
  ok('K1 resolve before: none, configured', none.status === 200 && none.json.state === 'none' && none.json.configured === true, JSON.stringify(none.json));

  const opId = randomUUID();
  const body = { operationId: opId, expectedVersion: reel.version, mode: 'create' };
  const created = await call('POST', `/api/v1/reels/${reelId}/kdrive-folder`, body);
  folderId = created.json?.folder?.folderId ?? null;
  ok('K2 create/link folder', created.status === 200 && created.json.folder.state === 'available'
    && created.json.reel.kdriveFolder?.folderId === folderId && created.json.reel.kdriveFolder?.driveId === process.env.KDRIVE_DRIVE_ID,
    `status=${created.status} name=${created.json?.folder?.name ?? created.text.slice(0, 160)}`);
  ok('K2 folder name carries the Reel tag', typeof created.json?.folder?.name === 'string' && created.json.folder.name.endsWith(`[${reelId.slice(0, 8)}]`));
  ok('K2 status unchanged, version +1', created.json?.reel?.status === reel.status && created.json?.reel?.version === reel.version + 1);

  const replay = await call('POST', `/api/v1/reels/${reelId}/kdrive-folder`, body);
  ok('K3 replay returns the same folder', replay.status === 200 && replay.json.folder.folderId === folderId);
  const again = await call('POST', `/api/v1/reels/${reelId}/kdrive-folder`, { operationId: randomUUID(), expectedVersion: created.json.reel.version, mode: 'create' });
  ok('K3 second create refused (already linked)', again.status === 422 && again.json?.error?.details?.reason === 'already_linked');

  const resolved = await call('GET', `/api/v1/reels/${reelId}/kdrive-folder`);
  ok('K4 resolve after: available, same folder', resolved.status === 200 && resolved.json.state === 'available' && resolved.json.folderId === folderId);
  ok('K4 web reference', resolved.json?.webUrl === `https://ksuite.infomaniak.com/kdrive/app/drive/${process.env.KDRIVE_DRIVE_ID}/files/${folderId}`, resolved.json?.webUrl);

  // Independent confirmation at kDrive itself (read-only metadata): it exists, is a folder,
  // and sits directly in the configured base folder.
  const meta = await fetch(`https://api.infomaniak.com/3/drive/${process.env.KDRIVE_DRIVE_ID}/files/${folderId}`, { headers: { authorization: `Bearer ${token}` } });
  const metaJson = await meta.json().catch(() => ({}));
  ok('K5 kDrive confirms the folder under the base folder', meta.status === 200 && metaJson.data?.type === 'dir'
    && String(metaJson.data?.parent_id) === process.env.KDRIVE_ROOT_FOLDER_ID, `parent=${metaJson.data?.parent_id}`);

  const web = await fetch(resolved.json.webUrl, { redirect: 'manual' });
  ok('K6 web reference answers (login redirect without a browser session)', [200, 301, 302, 303].includes(web.status), `HTTP ${web.status}`);

  const leak = [none, created, replay, again, resolved].some((entry) => entry.text.includes(token));
  ok('K7 no response contains the token', !leak);

  const unauth = await fetch(`${BASE}/api/v1/reels/${reelId}/kdrive-folder`, { headers: { origin: ORIGIN } });
  ok('K8 resolve requires a session', unauth.status === 401);
  const noCsrf = await fetch(`${BASE}/api/v1/reels/${reelId}/kdrive-folder`, { method: 'POST', headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ operationId: randomUUID(), expectedVersion: 1, mode: 'create' }) });
  ok('K8 create requires CSRF', noCsrf.status === 403);
} finally {
  const current = await call('GET', `/api/v1/reels/${reelId}`);
  if (current.status === 200) {
    const removed = await call('POST', `/api/v1/reels/${reelId}/delete`, { operationId: randomUUID(), expectedVersion: current.json.version });
    console.log(`cleanup soft-delete ${reelId} status=${removed.status}; kDrive folder ${folderId ?? '-'} left in place by design`);
  }
  await store.revoke(session.secret);
  await pool.end();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);

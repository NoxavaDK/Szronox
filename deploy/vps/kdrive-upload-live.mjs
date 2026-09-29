// KDRIVE-02 live acceptance helper. Authoring this file does not authorize execution.
// Run only after the operator separately approves a DEV live acceptance pass. It creates
// one disposable Reel, explicitly creates its folder as part of a cover upload, verifies
// the attached cover, then soft-deletes the Reel. The kDrive file/folder remain in place.
// It never prints credentials, session cookies, upload tokens, or provider session data.
//
// Example from /opt/szronox-dev/app after approval:
//   ALLOW_KDRIVE_UPLOAD_LIVE=YES /opt/szronox-dev/config/dc-gemini.sh run --rm --no-deps -T \
//     -v /opt/szronox-dev/app/deploy/vps/kdrive-upload-live.mjs:/app/kdrive-upload-live.mjs:ro \
//     api node /app/kdrive-upload-live.mjs
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

if (process.env.ALLOW_KDRIVE_UPLOAD_LIVE !== 'YES') {
  throw new Error('Set ALLOW_KDRIVE_UPLOAD_LIVE=YES only after separate operator approval');
}
const ORIGIN = process.env.APP_ORIGIN;
const BASE = process.env.SMOKE_BASE ?? 'http://api:3000';
if (!ORIGIN) throw new Error('APP_ORIGIN is required');
const results = [];
let cookie = '';
let csrf = '';
let reelId = '';
let pool;
let sessionStore;

const check = (name, passed, detail = '') => {
  results.push(Boolean(passed));
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
};
const json = async (response) => {
  const text = await response.text();
  try { return { status: response.status, body: text ? JSON.parse(text) : null }; }
  catch { return { status: response.status, body: null }; }
};
async function call(method, path, body) {
  const headers = { origin: ORIGIN, cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  return json(await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
}

try {
  pool = new pg.Pool({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT ?? 5432),
    database: process.env.DATABASE_NAME,
    user: process.env.DATABASE_USER,
    password: (await readFile(process.env.DATABASE_PASSWORD_FILE, 'utf8')).trim(),
    max: 2,
  });
  const sessions = await import('/app/apps/api/dist/auth/sessions.js');
  const userRow = (await pool.query("select id from app.users where name='NOXAVA'")).rows[0];
  if (!userRow) throw new Error('NOXAVA operator account was not found');
  const csrfSecret = (await readFile(process.env.APP_CSRF_SECRET_FILE, 'utf8')).trim();
  sessionStore = sessions.createSessionStore({
    query: (text, params) => pool.query(text, params),
    transaction: async (fn) => fn({ query: (text, params) => pool.query(text, params) }),
  });
  const session = await sessionStore.create({ userId: userRow.id, csrfSecret, lifetimeMs: 30 * 60 * 1000 });
  cookie = `__Host-szronox_session=${session.secret}`;
  csrf = session.csrfToken;
  check('operator session authenticates', (await call('GET', '/api/v1/me')).status === 200);

  reelId = randomUUID();
  const created = await call('POST', '/api/v1/reels', {
    operationId: randomUUID(), reelId,
    input: { text: 'SMOKE KDRIVE-02: test okładki.', images: [] },
  });
  check('disposable Reel created', created.status === 201 || created.status === 200);
  if (!created.body?.version) throw new Error('Reel creation response did not include a version');

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6360000002000154a24f5d0000000049454e44ae426082', 'hex');
  const started = await call('POST', `/api/v1/reels/${reelId}/kdrive-uploads`, {
    operationId: randomUUID(), expectedVersion: created.body.version, purpose: 'cover',
    fileName: 'OKLADKA - KDRIVE-02 smoke.png', mimeType: 'image/png', byteSize: png.length, createFolder: true,
  });
  check('cover session created with explicit folder action', started.status === 201, `HTTP ${started.status}`);
  const uploadId = started.body?.uploadId;
  if (!uploadId) throw new Error('Cover upload session was not created');

  const chunk = await fetch(`${BASE}/api/v1/kdrive-uploads/${uploadId}/chunks/0`, {
    method: 'PUT', headers: { origin: ORIGIN, cookie, 'x-csrf-token': csrf,
      'content-type': 'application/octet-stream', 'content-length': String(png.length) }, body: png,
  });
  check('cover chunk accepted', chunk.status === 204, `HTTP ${chunk.status}`);
  const finished = await call('POST', `/api/v1/kdrive-uploads/${uploadId}/finish`, {});
  check('provider file finished', finished.status === 200 && finished.body?.state === 'finished', `HTTP ${finished.status}`);

  const current = await call('GET', `/api/v1/reels/${reelId}`);
  const attached = await call('POST', `/api/v1/kdrive-uploads/${uploadId}/attach`, {
    operationId: randomUUID(), expectedVersion: current.body?.version,
  });
  check('cover reference and ready state saved together', attached.status === 200
    && attached.body?.feedCoverDone === true
    && attached.body?.feedCoverAsset?.fileId === finished.body?.fileId,
  `HTTP ${attached.status}`);
} finally {
  if (reelId && cookie && csrf) {
    const current = await call('GET', `/api/v1/reels/${reelId}`).catch(() => ({ status: 0, body: null }));
    if (current.body?.version) {
      const removed = await call('POST', `/api/v1/reels/${reelId}/delete`, {
        operationId: randomUUID(), expectedVersion: current.body.version,
      });
      console.log(`cleanup soft-delete ${reelId}: HTTP ${removed.status}; kDrive file/folder retained`);
    }
  }
  if (sessionStore && cookie) {
    const secret = cookie.slice('__Host-szronox_session='.length);
    await sessionStore.revoke(secret).catch(() => undefined);
  }
  await pool?.end();
}
console.log(`${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.length > 0 && results.every(Boolean) ? 0 : 1);

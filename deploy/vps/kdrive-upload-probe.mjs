// KDRIVE-02 GATE 1: live probe of the kDrive upload API. Operator-approved 2026-09-29.
// Disposable only: creates ONE probe subfolder inside the configured base folder (DEV 1349) and
// uploads generated dummy bytes into it. Nothing existing is read beyond metadata or modified.
// The bearer token is read from KDRIVE_TOKEN_FILE and never printed; session tokens are shortened.
// Run on the VPS from /opt/szronox-dev/app:
//   /opt/szronox-dev/config/dc-gemini.sh run --rm --no-deps -T \
//     -v /opt/szronox-dev/config/kdrive-upload-probe.mjs:/app/probe.mjs:ro api node /app/probe.mjs
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';

const API = 'https://api.infomaniak.com';
const drive = process.env.KDRIVE_DRIVE_ID;
const base = process.env.KDRIVE_ROOT_FOLDER_ID;
const token = (await readFile(process.env.KDRIVE_TOKEN_FILE, 'utf8')).trim();
const MiB = 1024 * 1024;
const redact = (value) => JSON.stringify(value, (key, v) => (typeof v === 'string' && v.length > 24 && /token/i.test(key) ? `${v.slice(0, 6)}…(${v.length})` : v))
  .replaceAll(token, '<TOKEN>');
const log = (label, value) => console.log(`${label}: ${typeof value === 'string' ? value : redact(value)}`.slice(0, 1600));

async function call(method, url, { json, body, headers = {} } = {}) {
  const started = Date.now();
  const response = await fetch(url.startsWith('http') ? url : `${API}${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
    body: json ? JSON.stringify(json) : body,
  });
  const text = await response.text();
  let parsed = null; try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 300); }
  return { status: response.status, ms: Date.now() - started, body: parsed };
}
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const chunkUrl = (session, uploadUrl, n, chunk, hashOverride) => {
  const host = uploadUrl ? uploadUrl.replace(/\/$/, '') : API;
  const hash = hashOverride ?? `sha256:${sha256(chunk)}`;
  return `${host}/3/drive/${drive}/upload/session/${session}/chunk?chunk_number=${n}&chunk_size=${chunk.length}&chunk_hash=${encodeURIComponent(hash)}`;
};

log('P0 base folder', (await call('GET', `/3/drive/${drive}/files/${base}`)).status);
const folder = await call('POST', `/3/drive/${drive}/files/${base}/directory`, { json: { name: `KDRIVE-02 probe ${new Date().toISOString().replace(/[:.]/g, '-')}`, only_for_me: false } });
const folderId = folder.body?.data?.id;
log('P1 probe folder', { status: folder.status, id: folderId, name: folder.body?.data?.name });
if (!folderId) process.exit(1);

// ── P2: session upload, 3 chunks (16 MiB, 16 MiB, 1 MiB) — our planned chunk size ──────────
async function sessionUpload(name, sizes, { badHashOn = null, cancelAfter = null } = {}) {
  const chunks = sizes.map((size) => randomBytes(size));
  const total = sizes.reduce((a, b) => a + b, 0);
  const start = await call('POST', `/3/drive/${drive}/upload/session/start`, { json: {
    conflict: 'rename', directory_id: Number(folderId), file_name: name, total_chunks: chunks.length, total_size: total,
  } });
  log(`  start ${name}`, { status: start.status, ms: start.ms, body: start.body });
  const session = start.body?.data?.token;
  const uploadUrl = start.body?.data?.upload_url;
  if (!session) return { start };
  const results = [];
  for (const [index, chunk] of chunks.entries()) {
    const n = index + 1;
    const r = await call('POST', chunkUrl(session, uploadUrl, n, chunk, badHashOn === n ? `sha256:${'0'.repeat(64)}` : undefined), {
      body: chunk, headers: { 'content-type': 'application/octet-stream' } });
    results.push(r);
    log(`  chunk ${n} (${chunk.length} B)`, { status: r.status, ms: r.ms, body: r.body });
    if (cancelAfter === n) {
      const cancel = await call('DELETE', `/3/drive/${drive}/upload/session/${session}`);
      log('  cancel', { status: cancel.status, body: cancel.body });
      const after = await call('POST', chunkUrl(session, uploadUrl, n + 1, chunks[n] ?? chunk), { body: chunks[n] ?? chunk, headers: { 'content-type': 'application/octet-stream' } });
      log('  chunk after cancel', { status: after.status, body: after.body });
      return { start, results, cancel };
    }
  }
  const totalHash = createHash('sha256'); chunks.forEach((c) => totalHash.update(c));
  const finish = await call('POST', `/3/drive/${drive}/upload/session/${session}/finish`, { json: { total_chunk_hash: `sha256:${totalHash.digest('hex')}` } });
  log(`  finish ${name}`, { status: finish.status, ms: finish.ms, body: finish.body });
  // Replay finish: is it idempotent?
  const again = await call('POST', `/3/drive/${drive}/upload/session/${session}/finish`, { json: {} });
  log('  finish replay', { status: again.status, body: again.body });
  return { start, results, finish };
}

console.log('P2 session upload 16+16+1 MiB');
const p2 = await sessionUpload('EKSPORT - probe.mp4', [16 * MiB, 16 * MiB, 1 * MiB]);
const fileId = p2.finish?.body?.data?.file?.id ?? p2.finish?.body?.data?.id;
log('P2 file id', String(fileId));

console.log('P3 conflict=rename with the same name (small, 1 chunk)');
const p3 = await sessionUpload('EKSPORT - probe.mp4', [256 * 1024]);
log('P3 final name', p3.finish?.body?.data?.file?.name ?? p3.finish?.body?.data?.name ?? '?');

console.log('P4 wrong chunk hash on chunk 1');
await sessionUpload('EKSPORT - bad-hash.mp4', [MiB, MiB], { badHashOn: 1 });

console.log('P5 cancel after chunk 1, then another chunk');
await sessionUpload('EKSPORT - cancelled.mp4', [MiB, MiB, MiB], { cancelAfter: 1 });

console.log('P6 small non-final chunk (100 KiB, 100 KiB) — is there a minimum chunk size?');
await sessionUpload('OKLADKA - small-chunks.png', [100 * 1024, 100 * 1024]);

console.log('P7 direct upload (single request) of a small file');
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const direct = await call('POST', `/3/drive/${drive}/upload?directory_id=${folderId}&file_name=${encodeURIComponent('MEM - probe.png')}&total_size=${png.length}&conflict=rename`, {
  body: png, headers: { 'content-type': 'application/octet-stream' } });
log('P7 direct', { status: direct.status, ms: direct.ms, body: direct.body });

if (fileId) {
  const meta = await call('GET', `/3/drive/${drive}/files/${fileId}`);
  log('P8 file metadata', { status: meta.status, data: meta.body?.data });
}
const listing = await call('GET', `/3/drive/${drive}/files/${folderId}/listing`);
log('P9 probe folder listing', (listing.body?.data?.files ?? listing.body?.data ?? []).map?.((f) => ({ id: f.id, name: f.name, size: f.size, mime: f.mime_type, status: f.status })) ?? listing.body);
console.log(`probe folder ${folderId} left in place by design`);

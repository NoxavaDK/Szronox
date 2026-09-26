/**
 * KDRIVE-01 tests. The provider is an in-memory fake behind a fake `fetch` that reproduces the
 * behaviour the T04 spike observed live: `{ result, data }` envelopes, `{ error: { code } }`
 * failures, `destination_already_exists` on a duplicate name, `404 object_not_found`, and a
 * listing of `data.files` with `has_more`/`cursor`. The database is real PostgreSQL (PGlite).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';

import { sessionHarness } from './auth/test-support.js';
import { CoreRepository } from './core/repository.js';
import { memoryStorageAdapter } from './core/storage.js';
import { type Database, pgliteDatabase } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';
import { httpKdriveClient, KdriveError, kdriveWebUrl } from './kdrive/client.js';
import { KdriveConfigError, parseKdriveConfig } from './kdrive/config.js';
import { folderName, folderTag } from './kdrive/service.js';

const NOXAVA = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' as const };
const SZRON = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' as const };
const DRIVE = '1990403';
const ROOT = '1349';
const TOKEN = 'test-token-0123456789-abcdefghijklmnopqrstuvwxyz';

interface FakeFile { id: number; name: string; parent_id: number; type: 'dir' | 'file'; status: string }

/** In-memory kDrive with failure injection. Records every request it saw. */
function fakeKdrive(options: { pageSize?: number } = {}) {
  const files = new Map<number, FakeFile>([[Number(ROOT), { id: Number(ROOT), name: 'Rolki', parent_id: 11, type: 'dir', status: 'ok' }]]);
  let nextId = 2000;
  const requests: Array<{ method: string; path: string; authorization: string | null }> = [];
  const failNext: Array<{ match: (method: string, path: string) => boolean; respond: () => Response | Promise<Response> }> = [];
  /** When set, a create is applied at kDrive but the client sees a failure (the ambiguous case). */
  let createThenFail: (() => Response) | null = null;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const ok = (data: unknown, extra: Record<string, unknown> = {}) => json(200, { result: 'success', data, ...extra });
  const error = (status: number, code: string) => json(status, { result: 'error', error: { code, description: code } });

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    requests.push({ method, path: url.pathname + url.search, authorization: headers.get('authorization') });
    const injected = failNext.findIndex((entry) => entry.match(method, url.pathname));
    if (injected !== -1) { const [entry] = failNext.splice(injected, 1); return entry.respond(); }
    if (headers.get('authorization') !== `Bearer ${TOKEN}`) return error(401, 'not_authorized');
    const match = url.pathname.match(/^\/3\/drive\/(\d+)\/files\/(\d+)(\/listing|\/directory)?$/);
    if (!match || match[1] !== DRIVE) return error(404, 'object_not_found');
    const id = Number(match[2]);
    const file = files.get(id);
    if (!file) return error(404, 'object_not_found');
    if (match[3] === '/listing' && method === 'GET') {
      const children = [...files.values()].filter((entry) => entry.parent_id === id);
      const size = options.pageSize ?? 1000;
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const page = children.slice(start, start + size);
      const more = start + size < children.length;
      return ok({ files: page, actions: [], actions_files: [] }, { has_more: more, cursor: more ? String(start + size) : 'end' });
    }
    if (match[3] === '/directory' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { name: string };
      if ([...files.values()].some((entry) => entry.parent_id === id && entry.name === body.name)) return error(400, 'destination_already_exists');
      const created: FakeFile = { id: nextId++, name: body.name, parent_id: id, type: 'dir', status: 'ok' };
      files.set(created.id, created);
      if (createThenFail) { const respond = createThenFail; createThenFail = null; return respond(); }
      return ok(created);
    }
    if (!match[3] && method === 'GET') return ok(file);
    return error(400, 'invalid_request');
  }) as typeof fetch;

  return {
    fetchImpl, files, requests,
    failOnce(match: (method: string, path: string) => boolean, respond: () => Response | Promise<Response>) { failNext.push({ match, respond }); },
    createAppliedButFail(respond: () => Response) { createThenFail = respond; },
    add(file: Omit<FakeFile, 'id'> & { id?: number }) { const id = file.id ?? nextId++; files.set(id, { ...file, id }); return id; },
    childrenOf(id: string) { return [...files.values()].filter((entry) => entry.parent_id === Number(id)); },
  };
}

const noSleep = async () => undefined;

async function server(fake = fakeKdrive(), configured = true) {
  const { default: Fastify } = await import('fastify');
  const { registerCoreRoutes } = await import('./core/routes.js');
  const { registerKdriveRoutes } = await import('./kdrive/routes.js');
  const db: Database = pgliteDatabase(await PGlite.create());
  await migrate(db);
  await seedUsers(db, [NOXAVA, SZRON]);
  const harness = sessionHarness(db);
  const app = Fastify({ logger: false });
  harness.register(app);
  const dependencies = {
    db, storage: memoryStorageAdapter(), authenticate: harness.authenticate,
    allowlist: [{ ...NOXAVA, avatarUrl: null }, { ...SZRON, avatarUrl: null }],
    kdrive: configured ? { driveId: DRIVE, rootFolderId: ROOT, token: TOKEN } : null,
  };
  registerCoreRoutes(app, dependencies);
  registerKdriveRoutes(app, dependencies, configured
    ? httpKdriveClient({ driveId: DRIVE, token: TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep })
    : undefined);
  await app.ready();
  const session = await harness.issue(NOXAVA.id);
  const repo = new CoreRepository(db);
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown, withSession = true) => {
    const response = await app.inject({ method, url, headers: withSession ? harness.headers(session, method) : {}, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: response.statusCode, body: response.json() as Record<string, any> };
  };
  const newReel = async (title = '') => {
    const reel = await repo.createReel(NOXAVA, { operationId: randomUUID(), reelId: randomUUID(), input: { text: 'Pomysł o tramwajach\nszczegóły', images: [] } } as never);
    if (!title) return reel;
    return repo.patchReel(NOXAVA, reel.id, { operationId: randomUUID(), expectedVersion: reel.version, changes: { title } });
  };
  return { app, db, repo, fake, call, newReel, close: async () => { await app.close(); await db.close(); } };
}

const create = (reel: { id: string; version: number }, operationId = randomUUID()) =>
  ['POST', `/api/v1/reels/${reel.id}/kdrive-folder`, { operationId, expectedVersion: reel.version, mode: 'create' }] as const;

// ── configuration ─────────────────────────────────────────────────────────────

test('configuration is all-or-nothing and never exposes the token', () => {
  assert.equal(parseKdriveConfig({}), null);
  assert.deepEqual(parseKdriveConfig({ KDRIVE_DRIVE_ID: DRIVE, KDRIVE_ROOT_FOLDER_ID: ROOT, KDRIVE_TOKEN_FILE: '/run/secrets/kdrive_token' }, () => `${TOKEN}\n`),
    { driveId: DRIVE, rootFolderId: ROOT, token: TOKEN });
  assert.throws(() => parseKdriveConfig({ KDRIVE_DRIVE_ID: DRIVE }), KdriveConfigError);
  assert.throws(() => parseKdriveConfig({ KDRIVE_DRIVE_ID: 'abc', KDRIVE_ROOT_FOLDER_ID: ROOT, KDRIVE_TOKEN_FILE: '/x' }, () => TOKEN), /numeric/);
  assert.throws(() => parseKdriveConfig({ KDRIVE_DRIVE_ID: DRIVE, KDRIVE_ROOT_FOLDER_ID: ROOT, KDRIVE_TOKEN_FILE: '/x' }, () => '  \n'), /exactly one token/);
  try {
    parseKdriveConfig({ KDRIVE_DRIVE_ID: DRIVE, KDRIVE_ROOT_FOLDER_ID: ROOT, KDRIVE_TOKEN_FILE: '/missing' }, () => { throw new Error(TOKEN); });
    assert.fail('expected a configuration error');
  } catch (error) {
    assert.ok(error instanceof KdriveConfigError);
    assert.ok(!String((error as Error).message).includes(TOKEN));
  }
});

// ── client transport ──────────────────────────────────────────────────────────

test('client: token only in the Authorization header; reads retry transient failures, create never retries', async () => {
  const fake = fakeKdrive();
  const client = httpKdriveClient({ driveId: DRIVE, token: TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep });
  fake.failOnce((method) => method === 'GET', () => new Response('', { status: 503 }));
  const folder = await client.getFolder(ROOT);
  assert.equal(folder.id, ROOT);
  assert.equal(fake.requests.filter((entry) => entry.method === 'GET').length, 2, 'a 503 read is retried once and succeeds');
  assert.ok(fake.requests.every((entry) => !entry.path.includes(TOKEN) && entry.authorization === `Bearer ${TOKEN}`));

  fake.failOnce((method) => method === 'POST', () => new Response('', { status: 503 }));
  await assert.rejects(client.createFolder(ROOT, 'x'), (error) => error instanceof KdriveError && error.failure === 'unavailable' && !error.message.includes(TOKEN));
  assert.equal(fake.requests.filter((entry) => entry.method === 'POST').length, 1, 'create is a single attempt');

  await assert.rejects(client.getFolder('424242'), (error) => error instanceof KdriveError && error.failure === 'missing' && error.providerCode === 'object_not_found');
  fake.failOnce(() => true, () => new Response(JSON.stringify({ result: 'error', error: { code: 'forbidden' } }), { status: 403 }));
  await assert.rejects(client.getFolder(ROOT), (error) => error instanceof KdriveError && error.failure === 'access_denied');
  fake.failOnce(() => true, () => { throw new TypeError('fetch failed'); });
  fake.failOnce(() => true, () => { throw new TypeError('fetch failed'); });
  fake.failOnce(() => true, () => { throw new TypeError('fetch failed'); });
  await assert.rejects(client.getFolder(ROOT), (error) => error instanceof KdriveError && error.failure === 'unavailable' && error.retryable);
});

test('client: listing follows has_more/cursor pages', async () => {
  const fake = fakeKdrive({ pageSize: 2 });
  for (let index = 0; index < 5; index += 1) fake.add({ name: `f${index}`, parent_id: Number(ROOT), type: 'dir', status: 'ok' });
  const client = httpKdriveClient({ driveId: DRIVE, token: TOKEN, fetchImpl: fake.fetchImpl, sleep: noSleep });
  assert.deepEqual((await client.listChildren(ROOT)).map((entry) => entry.name), ['f0', 'f1', 'f2', 'f3', 'f4']);
});

test('folder names are readable, cleaned, bounded and tagged with the Reel id', () => {
  const id = '1a2b3c4d-0000-4000-8000-000000000000';
  assert.equal(folderTag(id), '[1a2b3c4d]');
  assert.equal(folderName({ id, title: 'Tramwaje: 3 nowe linie / 2027?', originalInput: { images: [] } }), 'Tramwaje 3 nowe linie 2027 [1a2b3c4d]');
  assert.equal(folderName({ id, title: '', originalInput: { text: '\n  Pierwsza linia\ndruga', images: [] } }), 'Pierwsza linia [1a2b3c4d]');
  assert.equal(folderName({ id, title: '', originalInput: { url: 'https://www.example.com/a', images: [] } }), 'example.com [1a2b3c4d]');
  assert.equal(folderName({ id, title: '', originalInput: { images: [] } }), 'Rolka [1a2b3c4d]');
  const long = folderName({ id, title: 'x'.repeat(200), originalInput: { images: [] } });
  assert.ok(long.length <= 72 && long.endsWith('… [1a2b3c4d]'));
});

// ── routes ────────────────────────────────────────────────────────────────────

test('resolve → create → resolve: one folder under the base folder, stored as {driveId, folderId}', async () => {
  const ctx = await server();
  try {
    const reel = await ctx.newReel('Tramwaje nocą');
    const before = await ctx.call('GET', `/api/v1/reels/${reel.id}/kdrive-folder`);
    assert.deepEqual(before, { status: 200, body: { state: 'none', configured: true } });

    const created = await ctx.call(...create(reel));
    assert.equal(created.status, 200);
    const folder = created.body.folder;
    assert.equal(folder.state, 'available');
    assert.equal(folder.name, `Tramwaje nocą ${folderTag(reel.id)}`);
    assert.equal(folder.webUrl, kdriveWebUrl(DRIVE, folder.folderId));
    assert.deepEqual(created.body.reel.kdriveFolder, { driveId: DRIVE, folderId: folder.folderId });
    assert.equal(created.body.reel.version, reel.version + 1);
    assert.equal(created.body.reel.status, reel.status, 'no status change');
    assert.equal(ctx.fake.childrenOf(ROOT).length, 1);

    const after = await ctx.call('GET', `/api/v1/reels/${reel.id}/kdrive-folder`);
    assert.equal(after.body.state, 'available');
    assert.equal(after.body.folderId, folder.folderId);
    assert.equal((await ctx.repo.getReel(reel.id)).version, reel.version + 1, 'resolve does not write');
  } finally { await ctx.close(); }
});

test('a replayed create answers from the ledger without calling kDrive; a reused id with another payload conflicts', async () => {
  const ctx = await server();
  try {
    const reel = await ctx.newReel('A');
    const operationId = randomUUID();
    const first = await ctx.call(...create(reel, operationId));
    const calls = ctx.fake.requests.length;
    const again = await ctx.call(...create(reel, operationId));
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, first.body);
    assert.equal(ctx.fake.requests.length, calls, 'no provider call on replay');
    const reused = await ctx.call('POST', `/api/v1/reels/${reel.id}/kdrive-folder`, { operationId, expectedVersion: reel.version, mode: 'link', folderId: ROOT });
    assert.equal(reused.status, 409);
    assert.equal(reused.body.error.code, 'IDEMPOTENCY_CONFLICT');
  } finally { await ctx.close(); }
});

test('an ambiguous create (applied at kDrive, failed for the client) is reconciled, never duplicated', async () => {
  const ctx = await server();
  try {
    const reel = await ctx.newReel('Niepewne');
    ctx.fake.createAppliedButFail(() => new Response('', { status: 504 }));
    const created = await ctx.call(...create(reel));
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(ctx.fake.childrenOf(ROOT).length, 1, 'exactly one folder exists');
    assert.equal(created.body.folder.folderId, String(ctx.fake.childrenOf(ROOT)[0].id));
  } finally { await ctx.close(); }
});

test('a folder left by an earlier failed attempt is found by its tag and reused, even after a title change', async () => {
  const ctx = await server();
  try {
    const reel = await ctx.newReel('Stary tytuł');
    const orphan = ctx.fake.add({ name: `Stary tytuł ${folderTag(reel.id)}`, parent_id: Number(ROOT), type: 'dir', status: 'ok' });
    const renamed = await ctx.repo.patchReel(NOXAVA, reel.id, { operationId: randomUUID(), expectedVersion: reel.version, changes: { title: 'Nowy tytuł' } });
    const created = await ctx.call(...create(renamed));
    assert.equal(created.body.folder.folderId, String(orphan));
    assert.equal(ctx.fake.childrenOf(ROOT).length, 1);
    // A trashed folder with the tag is not reused.
    const other = await ctx.newReel('Kosz');
    ctx.fake.add({ name: `Kosz ${folderTag(other.id)}`, parent_id: Number(ROOT), type: 'dir', status: 'trashed' });
    const fresh = await ctx.call(...create(other));
    assert.equal(fresh.status, 200);
    assert.notEqual(ctx.fake.files.get(Number(fresh.body.folder.folderId))?.status, 'trashed');
    assert.equal(fresh.body.folder.name, `Kosz (2) ${folderTag(other.id)}`);
  } finally { await ctx.close(); }
});

test('a duplicate name at kDrive resolves to the existing folder of this Reel', async () => {
  const ctx = await server();
  try {
    const reel = await ctx.newReel('Duplikat');
    // Listing misses it (e.g. eventual consistency), create then collides, second lookup finds it.
    const existing = ctx.fake.add({ name: `Duplikat ${folderTag(reel.id)}`, parent_id: Number(ROOT), type: 'dir', status: 'ok' });
    ctx.fake.failOnce((method, path) => method === 'GET' && path.endsWith('/listing'), () => new Response(JSON.stringify({ result: 'success', data: { files: [] }, has_more: false }), { status: 200 }));
    const created = await ctx.call(...create(reel));
    assert.equal(created.status, 200);
    assert.equal(created.body.folder.folderId, String(existing));
  } finally { await ctx.close(); }
});

test('create is refused when a folder is already linked, and version conflicts write nothing', async () => {
  const ctx = await server();
  try {
    const reel = await ctx.newReel('Raz');
    const first = await ctx.call(...create(reel));
    const again = await ctx.call(...create(first.body.reel));
    assert.equal(again.status, 422);
    assert.equal(again.body.error.details.reason, 'already_linked');
    const other = await ctx.newReel('Stara wersja');
    await ctx.repo.patchReel(NOXAVA, other.id, { operationId: randomUUID(), expectedVersion: other.version, changes: { title: 'Zmieniona' } });
    const stale = await ctx.call(...create(other));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, 'EDIT_CONFLICT');
    assert.equal((await ctx.repo.getReel(other.id)).kdriveFolder, null);
  } finally { await ctx.close(); }
});

test('link stores an existing folder (relink); a missing id or a file is refused', async () => {
  const ctx = await server();
  try {
    const reel = await ctx.newReel('Link');
    const target = ctx.fake.add({ name: 'Istniejący', parent_id: Number(ROOT), type: 'dir', status: 'ok' });
    const linked = await ctx.call('POST', `/api/v1/reels/${reel.id}/kdrive-folder`, { operationId: randomUUID(), expectedVersion: reel.version, mode: 'link', folderId: String(target) });
    assert.equal(linked.status, 200);
    assert.deepEqual(linked.body.reel.kdriveFolder, { driveId: DRIVE, folderId: String(target) });
    const missing = await ctx.call('POST', `/api/v1/reels/${reel.id}/kdrive-folder`, { operationId: randomUUID(), expectedVersion: linked.body.reel.version, mode: 'link', folderId: '999999' });
    assert.equal(missing.status, 422);
    assert.equal(missing.body.error.code, 'PROVIDER_RESOURCE_MISSING');
    const file = ctx.fake.add({ name: 'plik.mp4', parent_id: Number(ROOT), type: 'file', status: 'ok' });
    const notDir = await ctx.call('POST', `/api/v1/reels/${reel.id}/kdrive-folder`, { operationId: randomUUID(), expectedVersion: linked.body.reel.version, mode: 'link', folderId: String(file) });
    assert.equal(notDir.status, 422);
    assert.equal(notDir.body.error.details.reason, 'not_a_folder');
    const bad = await ctx.call('POST', `/api/v1/reels/${reel.id}/kdrive-folder`, { operationId: randomUUID(), expectedVersion: 1, mode: 'link', folderId: '../1' });
    assert.equal(bad.status, 422);
  } finally { await ctx.close(); }
});

test('resolve distinguishes missing, access denied and unavailable, and keeps the stored reference', async () => {
  const ctx = await server();
  try {
    const reel = await ctx.newReel('Stany');
    const created = await ctx.call(...create(reel));
    const folderId = created.body.folder.folderId as string;
    const url = `/api/v1/reels/${reel.id}/kdrive-folder`;

    ctx.fake.failOnce(() => true, () => new Response(JSON.stringify({ result: 'error', error: { code: 'forbidden' } }), { status: 403 }));
    assert.deepEqual((await ctx.call('GET', url)).body, { state: 'access_denied', driveId: DRIVE, folderId, webUrl: kdriveWebUrl(DRIVE, folderId), retryable: false });
    for (let index = 0; index < 3; index += 1) ctx.fake.failOnce(() => true, () => new Response('', { status: 502 }));
    assert.equal((await ctx.call('GET', url)).body.state, 'unavailable');
    ctx.fake.files.get(Number(folderId))!.status = 'trashed';
    assert.equal((await ctx.call('GET', url)).body.state, 'missing');
    ctx.fake.files.delete(Number(folderId));
    const gone = await ctx.call('GET', url);
    assert.equal(gone.body.state, 'missing');
    assert.deepEqual((await ctx.repo.getReel(reel.id)).kdriveFolder, { driveId: DRIVE, folderId }, 'reference retained');
  } finally { await ctx.close(); }
});

test('provider failures on create map to the shared envelope without leaking the token', async () => {
  const ctx = await server();
  try {
    const reel = await ctx.newReel('Błędy');
    ctx.fake.failOnce(() => true, () => new Response(JSON.stringify({ result: 'error', error: { code: 'forbidden' } }), { status: 403 }));
    const denied = await ctx.call(...create(reel));
    assert.equal(denied.status, 502);
    assert.equal(denied.body.error.code, 'PROVIDER_ACCESS_DENIED');
    for (let index = 0; index < 3; index += 1) ctx.fake.failOnce(() => true, () => new Response('', { status: 500 }));
    const down = await ctx.call(...create(reel));
    assert.equal(down.status, 503);
    assert.equal(down.body.error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(down.body.error.retryable, true);
    assert.ok(!JSON.stringify([denied.body, down.body]).includes(TOKEN));
    assert.equal((await ctx.repo.getReel(reel.id)).kdriveFolder, null);
  } finally { await ctx.close(); }
});

test('routes require a session; an unconfigured deployment answers truthfully and never calls out', async () => {
  const configured = await server();
  try {
    const reel = await configured.newReel('Sesja');
    assert.equal((await configured.call('GET', `/api/v1/reels/${reel.id}/kdrive-folder`, undefined, false)).status, 401);
    assert.equal((await configured.call(create(reel)[0], create(reel)[1], create(reel)[2], false)).status, 401);
    assert.equal((await configured.call('GET', `/api/v1/reels/${randomUUID()}/kdrive-folder`)).status, 404);
  } finally { await configured.close(); }

  const fake = fakeKdrive();
  const bare = await server(fake, false);
  try {
    const reel = await bare.newReel('Bez konfiguracji');
    assert.deepEqual((await bare.call('GET', `/api/v1/reels/${reel.id}/kdrive-folder`)).body, { state: 'none', configured: false });
    const refused = await bare.call(...create(reel));
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error.details.reason, 'kdrive_not_configured');
    assert.equal(fake.requests.length, 0);
  } finally { await bare.close(); }
});

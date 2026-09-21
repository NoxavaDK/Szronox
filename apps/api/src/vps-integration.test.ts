/** Integration boundary only: combined migrations + real auth seam + private filesystem. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import sharp from 'sharp';
import { PGlite } from '@electric-sql/pglite';
import { pgliteDatabase } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';
import { registerCoreRoutes } from './core/routes.js';
import { filesystemStorageAdapter, initializeDisposableStorageRoot } from './storage/filesystem.js';
import { provisionTestCredentials, sessionHarness, TEST_PASSWORDS, TEST_ORIGIN, TEST_AUTH_ENV, testSecretFile } from './auth/test-support.js';
import { buildAuthConfig } from './auth/config.js';

const users = [
  { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' as const },
  { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' as const },
];

test('combined migrations, /me sessions and filesystem attachment routes compose without alternate auth', async () => {
  const db = pgliteDatabase(await PGlite.create());
  const parent = await mkdtemp(path.join(tmpdir(), 'szronox-integrated-'));
  const app = Fastify();
  try {
    const first = await migrate(db);
    // Every committed migration, in order. GEMINI-02's 0005 was never added here;
    // CORPUS-01 adds 0006 and restores the assertion; CORPUS-02 adds 0007.
    assert.deepEqual(first.map(x => x.name), ['0001_core_schema.sql', '0002_script_revision.sql',
      '0003_vps_auth.sql', '0004_vps_storage.sql', '0005_ai_pipeline.sql', '0006_programme_corpus.sql',
      '0007_programme_enrichment_revisions.sql']);
    assert.ok((await migrate(db)).every(x => x.alreadyApplied));
    await seedUsers(db, users);
    await provisionTestCredentials(db, users);
    const root = path.join(parent, 'storage');
    await initializeDisposableStorageRoot(root);
    const storage = filesystemStorageAdapter({ root, appOrigin: TEST_ORIGIN, expectedUid: process.getuid?.(), expectedGid: process.getgid?.() });
    await storage.initialize();
    const auth = sessionHarness(db);
    auth.register(app);
    registerCoreRoutes(app, { db, storage, authenticate: auth.authenticate, allowlist: users });
    await app.ready();
    assert.equal((await app.inject({method: 'GET', url: '/api/v1/auth/session'})).statusCode, 404);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: {origin: TEST_ORIGIN}, payload: {name: 'NOXAVA', password: TEST_PASSWORDS.NOXAVA} });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const csrf = login.json().csrfToken;
    const headers = { cookie, origin: TEST_ORIGIN, 'x-csrf-token': csrf };
    const me = await app.inject({method: 'GET', url: '/api/v1/me', headers: {cookie}});
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(me.json().user.id, users[0].id);
    assert.equal(me.json().csrfToken, csrf);
    assert.ok(me.json().expiresAt);
    assert.equal(me.headers['cache-control'], 'no-store');
    const reelId = randomUUID(), attachmentId = randomUUID();
    const created = await app.inject({ method: 'POST', url: '/api/v1/reels', headers, payload: {operationId: randomUUID(), reelId, input: {text: 'Test integracji', images: []}} });
    assert.equal(created.statusCode, 201, created.body);
    const bytes = await sharp({create:{width:2,height:2,channels:3,background:'white'}}).png().toBuffer();
    const base = `/api/v1/reels/${reelId}/attachments`;
    const initiated = await app.inject({method:'POST',url:`${base}/initiate`,headers,payload:{operationId:randomUUID(),attachmentId,fileName:'a.png',mimeType:'image/png',byteSize:bytes.length}});
    assert.equal(initiated.statusCode, 201, initiated.body);
    const uploadHeaders = {...headers, ...initiated.json().upload.headers, 'content-type':'image/png'};
    const denied = await app.inject({method:'PUT',url:`${base}/${attachmentId}/content`,headers:{...uploadHeaders,'x-csrf-token':'wrong'},payload:bytes});
    assert.equal(denied.statusCode,403,denied.body);
    const uploaded = await app.inject({method:'PUT',url:`${base}/${attachmentId}/content`,headers:uploadHeaders,payload:bytes});
    assert.equal(uploaded.statusCode,204,uploaded.body);
    const operationId = randomUUID();
    const complete = await app.inject({method:'POST',url:`${base}/${attachmentId}/complete`,headers,payload:{operationId}});
    assert.equal(complete.statusCode,200,complete.body);
    assert.equal(complete.json().state,'ready');
    const replay = await app.inject({method:'POST',url:`${base}/${attachmentId}/complete`,headers,payload:{operationId}});
    assert.deepEqual(replay.json(),complete.json());
    const read = await app.inject({method:'GET',url:`${base}/${attachmentId}/content`,headers:{cookie}});
    assert.equal(read.statusCode,200,read.body);
    assert.deepEqual(read.rawPayload,bytes);
    const logout = await app.inject({method:'POST',url:'/api/v1/auth/logout',headers});
    assert.equal(logout.statusCode,204,logout.body);
    assert.equal((await app.inject({method:'GET',url:`${base}/${attachmentId}/content`,headers:{cookie}})).statusCode,401);
    // Unknown names share one limiter key, independent of their spelling.
    for(let i=0;i<5;i++) {
      assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:TEST_ORIGIN},payload:{name:`unknown-${i}`,password:'incorrect'}})).statusCode,401);
    }
    assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:TEST_ORIGIN},payload:{name:'another-unknown',password:'incorrect'}})).statusCode,429);
  } finally { await app.close(); await db.close(); await rm(parent,{recursive:true,force:true}); }
});

test('approved auth secret-file, expiry and concurrency bounds fail closed', () => {
  assert.equal(buildAuthConfig(TEST_AUTH_ENV).sessionLifetimeMs,604800000);
  assert.throws(()=>buildAuthConfig({...TEST_AUTH_ENV,APP_SESSION_TTL_SECONDS:'604801'}),/must not exceed/);
  assert.throws(()=>buildAuthConfig({...TEST_AUTH_ENV,AUTH_PASSWORD_CONCURRENCY:'3'}),/must not exceed/);
  assert.throws(()=>buildAuthConfig({...TEST_AUTH_ENV,APP_ORIGIN:'https://one.test,https://two.test'}),/one exact origin/);
  assert.throws(()=>buildAuthConfig({...TEST_AUTH_ENV,APP_CSRF_SECRET_FILE:testSecretFile('short')}),/at least 32/);
});

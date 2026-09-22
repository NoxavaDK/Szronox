/**
 * VPS-04 runtime assembly, at the boundary only.
 *
 * What is real here: the production `buildApp`, `registerAuthRoutes`,
 * `registerCoreRoutes`, `registerAttachmentRoutes`, the filesystem storage adapter
 * against a real disposable directory, the real migrations, real Argon2id verification,
 * and the real readiness and provisioning code.
 *
 * What is a stand-in, labelled as such: the database is **PGlite** — real PostgreSQL 18
 * compiled to WASM, so the SQL and the constraints are genuine, but single-connection, so
 * it cannot show a race and cannot show role separation (PGlite has one role and it is a
 * superuser). Role privileges, Compose, Linux and the browser are all explicitly out of
 * reach here and are named in VPS-04-result.md as the gates that remain.
 *
 * These tests deliberately do not repeat the child tasks' suites. They assert only the
 * things that first become true when the pieces are assembled: readiness versus liveness,
 * truthful failure on a missing dependency, an end-to-end acknowledged upload, and that a
 * restart finds durable server metadata and recoverable client work.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import sharp from 'sharp';

import { buildApp } from './app.js';
import { buildAuthConfig } from './auth/config.js';
import { createPasswordHasher } from './auth/passwords.js';
import { registerAuthRoutes } from './auth/routes.js';
import { createAuthService, requestAuthenticator } from './auth/service.js';
import { TEST_AUTH_ENV, TEST_ORIGIN, TEST_PASSWORDS } from './auth/test-support.js';
import { assertProvisioned, provisionUsers, ProvisioningError } from './auth/users.js';
import { buildStorage, ConfigError, parseAllowlist } from './core/config.js';
import { registerCoreRoutes } from './core/routes.js';
import { type Database, pgliteDatabase } from './db/client.js';
import { migrate } from './db/migrate.js';
import { filesystemStorageAdapter, initializeDisposableStorageRoot } from './storage/filesystem.js';
import { composeApiRuntime } from './runtime/api.js';
import { buildLoggerOptions, parseLogLevel, REDACT_PATHS } from './runtime/logging.js';
import { apiPrivilegeViolations, workerPrivilegeViolations, type RoleFacts } from './runtime/privileges.js';
import { runtimeReadiness, storageRootProbe, unconfiguredReadiness } from './runtime/readiness.js';
import { databaseConfigured, readDatabaseSettings, RuntimeConfigError } from './runtime/database.js';
import {
  formatOutcomes, parsePasswordInput, parseReplaceArguments, readBoundedInput,
  MAX_PROVISION_INPUT_BYTES, ProvisionInputError,
} from './runtime/provision-cli.js';

const NOXAVA = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' as const };
const SZRON = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' as const };
const ALLOWLIST = [NOXAVA, SZRON];

interface Assembled {
  db: Database;
  root: string;
  parent: string;
  app: ReturnType<typeof buildApp>;
  readiness: ReturnType<typeof runtimeReadiness>;
  close(): Promise<void>;
}

/**
 * Assemble the real app over PGlite and a disposable storage root.
 *
 * `reuse` lets a second assembly run over the same database and the same directory, which
 * is what "restart" means for this test: the process is new, the durable state is not.
 */
async function assemble(options: { reuse?: { db: Database; parent: string }; provision?: boolean } = {}): Promise<Assembled> {
  const db = options.reuse?.db ?? pgliteDatabase(await PGlite.create());
  const parent = options.reuse?.parent ?? await mkdtemp(path.join(tmpdir(), 'szronox-runtime-'));
  const root = path.join(parent, 'storage');

  if (!options.reuse) {
    await migrate(db);
    await initializeDisposableStorageRoot(root);
  }

  const storage = filesystemStorageAdapter({
    root,
    appOrigin: TEST_ORIGIN,
    expectedUid: process.getuid?.(),
    expectedGid: process.getgid?.(),
  });
  // The same call the API composition root awaits before listening.
  await storage.initialize();

  if (options.provision !== false && !options.reuse) {
    await provisionUsers(db, createPasswordHasher(1), {
      allowlist: ALLOWLIST,
      passwords: { NOXAVA: TEST_PASSWORDS.NOXAVA, SZRON: TEST_PASSWORDS.SZRON },
    });
  }

  const config = buildAuthConfig(TEST_AUTH_ENV);
  const service = createAuthService({ db, config, hasher: createPasswordHasher(2) });
  const readiness = runtimeReadiness({
    db,
    expectedUsers: ALLOWLIST,
    probes: { storage: storageRootProbe(root) },
  });

  const app = buildApp({
    auth: { service },
    core: {
      db,
      storage,
      authenticate: requestAuthenticator(service),
      allowlist: ALLOWLIST.map((user) => ({ ...user, avatarUrl: null })),
    },
    readiness,
  });
  await app.ready();

  return {
    db, root, parent, app, readiness,
    async close() { await app.close(); },
  };
}

interface Session { cookie: string; csrf: string }

async function login(context: Assembled, name: 'NOXAVA' | 'SZRON'): Promise<Session> {
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: TEST_ORIGIN },
    payload: { name, password: TEST_PASSWORDS[name] },
  });
  assert.equal(response.statusCode, 200, response.body);
  return {
    cookie: String(response.headers['set-cookie']).split(';')[0],
    csrf: response.json().csrfToken as string,
  };
}

const writeHeaders = (session: Session) => ({
  cookie: session.cookie, origin: TEST_ORIGIN, 'x-csrf-token': session.csrf,
});

// ══════════════════════ readiness versus liveness ═══════════════════════════

test('runtime rejects missing or malformed APP_ORIGIN before database configuration', async () => {
  const env = { APP_ALLOWLIST: 'NOXAVA:11111111-1111-4111-8111-111111111111,SZRON:22222222-2222-4222-8222-222222222222' };

  await assert.rejects(composeApiRuntime(env), /APP_ORIGIN is required/);
  await assert.rejects(composeApiRuntime({ ...env, APP_ORIGIN: 'https://example.test/path' }), /no path/);
});

test('a scaffold app is live but never ready, and a composed app is both', async () => {
  const scaffold = buildApp();
  try {
    await scaffold.ready();
    const health = await scaffold.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(health.statusCode, 200, 'liveness must keep answering exactly as before');
    assert.deepEqual(health.json(), { status: 'ok' });

    // The distinction VPS-04 exists to make: the same process that answers liveness
    // says plainly that it cannot serve the application.
    const ready = await scaffold.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(ready.statusCode, 503);
    assert.equal(ready.json().status, 'not_ready');
    assert.equal(ready.json().reason, 'runtime_not_configured');
    assert.equal(ready.headers['cache-control'], 'no-store');
  } finally {
    await scaffold.close();
  }

  const context = await assemble();
  try {
    assert.equal((await context.app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode, 200);
    // Not ready until the composition root says so, even though every dependency works.
    assert.equal((await context.app.inject({ method: 'GET', url: '/api/v1/ready' })).statusCode, 503);

    context.readiness.markReady();
    const ready = await context.app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(ready.statusCode, 200, ready.body);
    assert.deepEqual(ready.json().checks, { roster: 'pass', storage: 'pass' });
    assert.equal(ready.json().reason, null);
  } finally {
    await context.close();
    await rm(context.parent, { recursive: true, force: true });
  }
});

test('readiness stops reporting ready when a dependency it named goes away', async () => {
  const context = await assemble();
  try {
    context.readiness.markReady();
    assert.equal((await context.app.inject({ method: 'GET', url: '/api/v1/ready' })).statusCode, 200);

    // A volume that disappeared. A cached startup result would still say ready, which is
    // exactly the failure the live probe exists to catch.
    await rm(context.root, { recursive: true, force: true });
    const afterLoss = await context.app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(afterLoss.statusCode, 503);
    assert.equal(afterLoss.json().checks.storage, 'fail');
    assert.equal(afterLoss.json().status, 'not_ready');

    // A roster that lost a user, with storage restored.
    await initializeDisposableStorageRoot(context.root);
    await context.db.query('delete from app.users where id = $1', [SZRON.id]);
    const afterRoster = await context.app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(afterRoster.statusCode, 503);
    assert.equal(afterRoster.json().checks.roster, 'fail');

    // Draining reports stopping rather than a dependency fault.
    context.readiness.markStopping();
    const stopping = await context.app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(stopping.statusCode, 503);
    assert.equal(stopping.json().reason, 'shutting_down');
  } finally {
    await context.close();
    await rm(context.parent, { recursive: true, force: true });
  }
});

test('readiness never returns a driver message to an unauthenticated caller', async () => {
  // VPS-06 found this on the live deployment: with PostgreSQL stopped, the public
  // /api/v1/ready returned {"reason":"getaddrinfo ENOTFOUND postgres"} — the driver's own
  // message, naming an internal host, to anybody who asked. /ready is unauthenticated by
  // design, so the body must carry a code and nothing else.
  const context = await assemble();
  const logged: Array<{ check: string; detail: string }> = [];
  try {
    context.readiness.markReady();
    assert.equal((await context.app.inject({ method: 'GET', url: '/api/v1/ready' })).statusCode, 200);

    // A tracker whose database is gone, with a sink for the detail.
    const broken = runtimeReadiness({
      db: {
        query: () => Promise.reject(new Error('getaddrinfo ENOTFOUND postgres')),
        execScript: () => Promise.reject(new Error('unused')),
        transaction: () => Promise.reject(new Error('unused')),
        close: () => Promise.resolve(),
      },
      expectedUsers: ALLOWLIST,
      onFailure: (check, detail) => logged.push({ check, detail }),
    });
    broken.markReady();
    const unreachable = await broken.report();
    assert.equal(unreachable.status, 'not_ready');
    assert.equal(unreachable.reason, 'roster_unavailable', 'a code, not the driver message');
    assert.ok(!JSON.stringify(unreachable).includes('ENOTFOUND'), 'the driver message must not be in the body');
    assert.ok(!JSON.stringify(unreachable).includes('postgres'), 'no internal hostname in the body');
    // The operator still gets the cause, server-side.
    assert.deepEqual(logged.map((entry) => entry.check), ['roster']);
    assert.match(logged[0].detail, /ENOTFOUND postgres/);

    // A failing probe names itself without describing the failure. The roster must still
    // be intact here, or it would fail first and the probe would never run.
    const probeFailure = runtimeReadiness({
      db: context.db,
      expectedUsers: ALLOWLIST,
      probes: { storage: { check: () => Promise.reject(new Error('/var/lib/szronox/storage: EACCES')) } },
    });
    probeFailure.markReady();
    const probeReport = await probeFailure.report();
    assert.equal(probeReport.checks.roster, 'pass', 'the roster must pass so the probe is reached');
    assert.equal(probeReport.reason, 'storage_unavailable');
    assert.ok(!JSON.stringify(probeReport).includes('EACCES'));
    assert.ok(!JSON.stringify(probeReport).includes('/var/lib'), 'no filesystem path in the body');

    // A reachable database with a broken roster is a different code, because it needs a
    // different response: provision, not restart. Done last, since it breaks the roster.
    await context.db.query('delete from app.users where id = $1', [SZRON.id]);
    const incomplete = await context.readiness.report();
    assert.equal(incomplete.reason, 'roster_incomplete');
    assert.equal(incomplete.checks.roster, 'fail');
  } finally {
    await context.close();
    await rm(context.parent, { recursive: true, force: true });
  }
});

test('a missing dependency fails truthfully instead of degrading', async () => {
  // Storage: no root at all, and no silent fallback to the memory adapter.
  assert.throws(() => buildStorage({ APP_ORIGIN: TEST_ORIGIN }), ConfigError);
  assert.throws(() => buildStorage({ APP_STORAGE_ROOT: '/tmp/x' }), /APP_ORIGIN is required/);

  // Roster: a configuration that does not name exactly the two users.
  assert.throws(() => parseAllowlist(`NOXAVA:${NOXAVA.id}`), /exactly two/);
  assert.throws(() => parseAllowlist(undefined), /required/);

  // Database: no password source, or two of them.
  assert.throws(
    () => readDatabaseSettings({ DATABASE_HOST: 'h', DATABASE_NAME: 'd', DATABASE_USER: 'u' }, { poolMax: 4 }),
    RuntimeConfigError,
  );
  assert.throws(
    () => readDatabaseSettings(
      { DATABASE_HOST: 'h', DATABASE_NAME: 'd', DATABASE_USER: 'u', DATABASE_PASSWORD: 'p', DATABASE_PASSWORD_FILE: '/f' },
      { poolMax: 4 },
    ),
    /exactly one of/,
  );
  assert.throws(
    () => readDatabaseSettings({ DATABASE_NAME: 'd', DATABASE_USER: 'u', DATABASE_PASSWORD: 'p' }, { poolMax: 4 }),
    /DATABASE_HOST is required/,
  );
  // Out-of-range bounds are refused rather than clamped: a silently clamped pool size is
  // a configuration the operator did not choose.
  assert.throws(
    () => readDatabaseSettings(
      { DATABASE_HOST: 'h', DATABASE_NAME: 'd', DATABASE_USER: 'u', DATABASE_PASSWORD: 'p', DATABASE_POOL_MAX: '1000' },
      { poolMax: 4 },
    ),
    /DATABASE_POOL_MAX/,
  );

  // The mode decision itself: absent versus present configuration.
  assert.equal(databaseConfigured({}), false);
  assert.equal(databaseConfigured({ DATABASE_HOST: 'postgres' }), true);

  // A half-provisioned roster is refused rather than served.
  const db = pgliteDatabase(await PGlite.create());
  try {
    await migrate(db);
    await assert.rejects(assertProvisioned(db, ALLOWLIST), ProvisioningError);
    await db.query('insert into app.users (id, name) values ($1, $2)', [NOXAVA.id, 'NOXAVA']);
    await db.query('insert into app.users (id, name) values ($1, $2)', [SZRON.id, 'SZRON']);
    await assert.rejects(assertProvisioned(db, ALLOWLIST), /no password is set for/);
  } finally {
    await db.close();
  }

  // And the unconfigured tracker cannot be talked into readiness.
  const tracker = unconfiguredReadiness();
  assert.throws(() => tracker.markReady(), /cannot become ready/);
  assert.equal((await tracker.report()).status, 'not_ready');
});

// ══════════════════════ acknowledged upload ═════════════════════════════════

test('create, upload and complete preserves the acknowledgement boundary', async () => {
  const context = await assemble();
  try {
    context.readiness.markReady();
    const session = await login(context, 'NOXAVA');
    const reelId = randomUUID();
    const attachmentId = randomUUID();

    const created = await context.app.inject({
      method: 'POST', url: '/api/v1/reels', headers: writeHeaders(session),
      payload: { operationId: randomUUID(), reelId, input: { text: 'Notatka', images: [] } },
    });
    assert.equal(created.statusCode, 201, created.body);

    const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'white' } }).png().toBuffer();
    const base = `/api/v1/reels/${reelId}/attachments`;
    const initiated = await context.app.inject({
      method: 'POST', url: `${base}/initiate`, headers: writeHeaders(session),
      payload: {
        operationId: randomUUID(), attachmentId, fileName: 'a.png',
        mimeType: 'image/png', byteSize: bytes.length,
      },
    });
    assert.equal(initiated.statusCode, 201, initiated.body);
    const upload = initiated.json().upload;
    // The ticket is a same-origin absolute URL the browser can use directly.
    assert.ok(upload.uploadUrl.startsWith(`${TEST_ORIGIN}${base}/${attachmentId}/content`), upload.uploadUrl);
    assert.equal(initiated.json().attachment.state, 'pending');

    // Byte transfer succeeds — and the attachment is still not ready. This is the
    // boundary: a 204 here is not an acknowledgement, and a client that released its
    // local blob at this point would have nothing if completion then failed.
    const put = await context.app.inject({
      method: 'PUT',
      url: `${base}/${attachmentId}/content`,
      headers: { ...writeHeaders(session), ...upload.headers, 'content-type': 'image/png' },
      payload: bytes,
    });
    assert.equal(put.statusCode, 204, put.body);
    const midway = await context.app.inject({
      method: 'GET', url: `/api/v1/reels/${reelId}`, headers: { cookie: session.cookie },
    });
    assert.equal(
      midway.json().attachments.find((a: { id: string }) => a.id === attachmentId).state,
      'pending',
      'the bytes are stored and validated, but the attachment is not acknowledged until completion',
    );

    const completeOperationId = randomUUID();
    const completed = await context.app.inject({
      method: 'POST', url: `${base}/${attachmentId}/complete`, headers: writeHeaders(session),
      payload: { operationId: completeOperationId },
    });
    assert.equal(completed.statusCode, 200, completed.body);
    assert.equal(completed.json().state, 'ready');
    assert.equal(completed.json().id, attachmentId);

    // A replayed completion with the same operation id returns the same acknowledgement,
    // so a client that retries after losing the response does not need new identifiers.
    const replayed = await context.app.inject({
      method: 'POST', url: `${base}/${attachmentId}/complete`, headers: writeHeaders(session),
      payload: { operationId: completeOperationId },
    });
    assert.equal(replayed.statusCode, 200);
    assert.deepEqual(replayed.json(), completed.json());

    // The peer can read the shared object; both users see the same Reel.
    const peer = await login(context, 'SZRON');
    const download = await context.app.inject({
      method: 'GET', url: `${base}/${attachmentId}/content`, headers: { cookie: peer.cookie },
    });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers['content-type'], 'image/png');
    assert.equal(download.headers['cache-control'], 'private, no-store');
    assert.equal(download.headers['x-content-type-options'], 'nosniff');
    assert.equal(download.rawPayload.length, bytes.length);
  } finally {
    await context.close();
    await rm(context.parent, { recursive: true, force: true });
  }
});

test('a restart finds durable server metadata and a readable object', async () => {
  const first = await assemble();
  let reelId = '';
  let attachmentId = '';
  try {
    first.readiness.markReady();
    const session = await login(first, 'NOXAVA');
    reelId = randomUUID();
    attachmentId = randomUUID();
    const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: 'red' } }).png().toBuffer();
    const base = `/api/v1/reels/${reelId}/attachments`;

    await first.app.inject({
      method: 'POST', url: '/api/v1/reels', headers: writeHeaders(session),
      payload: { operationId: randomUUID(), reelId, input: { text: 'Trwałość', images: [] } },
    });
    const initiated = await first.app.inject({
      method: 'POST', url: `${base}/initiate`, headers: writeHeaders(session),
      payload: {
        operationId: randomUUID(), attachmentId, fileName: 'b.png',
        mimeType: 'image/png', byteSize: bytes.length,
      },
    });
    await first.app.inject({
      method: 'PUT', url: `${base}/${attachmentId}/content`,
      headers: { ...writeHeaders(session), ...initiated.json().upload.headers, 'content-type': 'image/png' },
      payload: bytes,
    });
    await first.app.inject({
      method: 'POST', url: `${base}/${attachmentId}/complete`, headers: writeHeaders(session),
      payload: { operationId: randomUUID() },
    });
  } finally {
    await first.close();
  }

  // A new process over the same database and the same storage root. Nothing in memory
  // survives; only what was durably written.
  const second = await assemble({ reuse: { db: first.db, parent: first.parent } });
  try {
    second.readiness.markReady();
    assert.equal((await second.app.inject({ method: 'GET', url: '/api/v1/ready' })).statusCode, 200);

    // The session did not survive the restart in memory — it survived in PostgreSQL.
    const session = await login(second, 'NOXAVA');
    const reel = await second.app.inject({
      method: 'GET', url: `/api/v1/reels/${reelId}`, headers: { cookie: session.cookie },
    });
    assert.equal(reel.statusCode, 200, reel.body);
    const attachment = reel.json().attachments.find((a: { id: string }) => a.id === attachmentId);
    assert.equal(attachment.state, 'ready', 'acknowledged metadata must survive a restart');

    const content = await second.app.inject({
      method: 'GET', url: `/api/v1/reels/${reelId}/attachments/${attachmentId}/content`,
      headers: { cookie: session.cookie },
    });
    assert.equal(content.statusCode, 200, 'the published object must still be readable');

    // The file is genuinely on disk with private modes, not merely recorded in a row.
    const objects = await stat(path.join(second.root, 'objects'));
    assert.ok(objects.isDirectory());
    assert.equal(objects.mode & 0o777, 0o700);
  } finally {
    await second.close();
    await second.db.close();
    await rm(second.parent, { recursive: true, force: true });
  }
});

// ══════════════════════ operator provisioning ═══════════════════════════════

test('provisioning creates exactly two users and an ordinary rerun changes nothing', async () => {
  const db = pgliteDatabase(await PGlite.create());
  try {
    await migrate(db);
    const hasher = createPasswordHasher(1);

    const created = await provisionUsers(db, hasher, {
      allowlist: ALLOWLIST,
      passwords: { NOXAVA: 'pierwsze-hasło-ĄĘŁŻ', SZRON: 'drugie-hasło-ĄĘŁŻ' },
    });
    assert.deepEqual(created.map((outcome) => outcome.user), ['user_created', 'user_created']);
    assert.deepEqual(created.map((outcome) => outcome.credential), ['credential_created', 'credential_created']);
    assert.deepEqual(created.map((outcome) => outcome.name), ['NOXAVA', 'SZRON']);

    const hashesBefore = await db.query<{ user_id: string; password_hash: string }>(
      'select user_id, password_hash from app.user_credentials order by user_id',
    );

    // Ordinary rerun: no passwords supplied, nothing changed, and it does not fail for
    // want of a password it does not need.
    const rerun = await provisionUsers(db, hasher, { allowlist: ALLOWLIST, passwords: {} });
    assert.deepEqual(rerun.map((outcome) => outcome.user), ['user_unchanged', 'user_unchanged']);
    assert.deepEqual(rerun.map((outcome) => outcome.credential), ['credential_unchanged', 'credential_unchanged']);
    assert.deepEqual(rerun.map((outcome) => outcome.sessionsRevoked), [0, 0]);

    const hashesAfter = await db.query<{ user_id: string; password_hash: string }>(
      'select user_id, password_hash from app.user_credentials order by user_id',
    );
    assert.deepEqual(hashesAfter.rows, hashesBefore.rows, 'a rerun must not rotate a hash');
    assert.equal((await db.query('select 1 from app.users')).rows.length, 2);

    // Supplying a password without asking for replacement is refused, because both
    // silently applying it and silently ignoring it would mislead the operator.
    await assert.rejects(
      provisionUsers(db, hasher, { allowlist: ALLOWLIST, passwords: { NOXAVA: 'inne' } }),
      /pass --replace NOXAVA/,
    );
  } finally {
    await db.close();
  }
});

test('provisioning rejects a mapping mismatch instead of reassigning an identity', async () => {
  const db = pgliteDatabase(await PGlite.create());
  try {
    await migrate(db);
    const hasher = createPasswordHasher(1);
    await provisionUsers(db, hasher, {
      allowlist: ALLOWLIST,
      passwords: { NOXAVA: 'a-hasło', SZRON: 'b-hasło' },
    });

    // A configured id that disagrees with the stored one. Rewriting the row would orphan
    // every Reel that references the old id.
    await assert.rejects(
      provisionUsers(db, hasher, {
        allowlist: [{ id: randomUUID(), name: 'NOXAVA' }, SZRON],
        passwords: {},
      }),
      /must not be replaced/,
    );

    // A swapped pair: each name's configured id belongs to the other account.
    await assert.rejects(
      provisionUsers(db, hasher, {
        allowlist: [{ id: SZRON.id, name: 'NOXAVA' }, { id: NOXAVA.id, name: 'SZRON' }],
        passwords: {},
      }),
      /must not be replaced|already belongs to/,
    );

    // Nothing changed.
    const rows = await db.query<{ id: string; name: string }>('select id, name from app.users order by name');
    assert.deepEqual(rows.rows, [{ id: NOXAVA.id, name: 'NOXAVA' }, { id: SZRON.id, name: 'SZRON' }]);

    // And a roster that is not exactly the two product users is refused outright.
    await assert.rejects(
      provisionUsers(db, hasher, { allowlist: [NOXAVA], passwords: {} }),
      /exactly the two configured users/,
    );
  } finally {
    await db.close();
  }
});

test('explicit credential replacement revokes only that account\'s sessions', async () => {
  const context = await assemble();
  try {
    context.readiness.markReady();
    const mine = await login(context, 'NOXAVA');
    const peer = await login(context, 'SZRON');
    assert.equal((await context.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: mine.cookie } })).statusCode, 200);

    const outcomes = await provisionUsers(context.db, createPasswordHasher(1), {
      allowlist: ALLOWLIST,
      passwords: { NOXAVA: 'zmienione-hasło' },
      replace: ['NOXAVA'],
    });
    const noxava = outcomes.find((outcome) => outcome.name === 'NOXAVA');
    assert.equal(noxava?.credential, 'credential_replaced');
    assert.equal(noxava?.sessionsRevoked, 1);
    assert.equal(outcomes.find((outcome) => outcome.name === 'SZRON')?.credential, 'credential_unchanged');

    // The replaced account's cookie is dead; the peer's is untouched.
    assert.equal((await context.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: mine.cookie } })).statusCode, 401);
    assert.equal((await context.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: peer.cookie } })).statusCode, 200);

    // The new password works and the old one does not.
    const withNew = await context.app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { origin: TEST_ORIGIN },
      payload: { name: 'NOXAVA', password: 'zmienione-hasło' },
    });
    assert.equal(withNew.statusCode, 200);
    const withOld = await context.app.inject({
      method: 'POST', url: '/api/v1/auth/login', headers: { origin: TEST_ORIGIN },
      payload: { name: 'NOXAVA', password: TEST_PASSWORDS.NOXAVA },
    });
    assert.equal(withOld.statusCode, 401);
  } finally {
    await context.close();
    await rm(context.parent, { recursive: true, force: true });
  }
});

test('the provisioning command takes bounded stdin and never a password argument', async () => {
  // Names on argv, passwords never.
  assert.deepEqual(parseReplaceArguments([]), []);
  assert.deepEqual(parseReplaceArguments(['--replace', 'NOXAVA']), ['NOXAVA']);
  assert.deepEqual(parseReplaceArguments(['--replace', 'NOXAVA', '--replace', 'NOXAVA']), ['NOXAVA']);
  assert.throws(() => parseReplaceArguments(['--replace', 'INTRUDER']), ProvisionInputError);
  assert.throws(() => parseReplaceArguments(['--password', 'secret']), /unknown argument/);

  assert.deepEqual(parsePasswordInput('{"NOXAVA":"a b ","SZRON":"c\\nd"}'), { NOXAVA: 'a b ', SZRON: 'c\nd' });
  assert.deepEqual(parsePasswordInput('   '), {});
  assert.throws(() => parsePasswordInput('{"ADMIN":"x"}'), /unknown account name/);
  assert.throws(() => parsePasswordInput('not json'), /must be a JSON object/);
  assert.throws(() => parsePasswordInput('["NOXAVA"]'), /must be a JSON object/);
  assert.throws(() => parsePasswordInput('{"NOXAVA":""}'), /non-empty/);

  // Bounded: a mistaken `cat` of a large file is refused, not buffered.
  const oversized = 'x'.repeat(MAX_PROVISION_INPUT_BYTES + 1);
  await assert.rejects(readBoundedInput([oversized] as never), /exceeds/);
  assert.equal(await readBoundedInput(['{"NOXAVA":"a"}'] as never), '{"NOXAVA":"a"}');

  // Output names accounts and outcomes only.
  const summary = formatOutcomes([
    { name: 'NOXAVA', id: NOXAVA.id, user: 'user_created', credential: 'credential_created', sessionsRevoked: 0 },
    { name: 'SZRON', id: SZRON.id, user: 'user_unchanged', credential: 'credential_replaced', sessionsRevoked: 2 },
  ]);
  assert.match(summary, /NOXAVA: user_created, credential_created/);
  assert.match(summary, /SZRON: user_unchanged, credential_replaced, 2 session\(s\) revoked/);
  assert.ok(!summary.includes('$argon2id$'), 'no hash may appear in the summary');
});

// ══════════════════════ privilege and logging boundaries ════════════════════

test('the API and worker privilege rules refuse an over-privileged role', () => {
  const facts = (over: Partial<RoleFacts> = {}): RoleFacts => ({
    role: 'szronox_api',
    isSuperuser: false,
    canCreateDb: false,
    canCreateRole: false,
    canCreateInAppSchema: false,
    privileges: {
      'app.users': { select: true, insert: false, update: false, delete: false },
      'app.user_credentials': { select: true, insert: false, update: false, delete: false },
      'app.auth_sessions': { select: true, insert: true, update: true, delete: true },
      'app.reels': { select: true, insert: true, update: true, delete: true },
    },
    ...over,
  });

  // The intended API grants pass.
  assert.deepEqual(apiPrivilegeViolations(facts()), []);
  // The database owner does not.
  assert.ok(apiPrivilegeViolations(facts({ isSuperuser: true })).includes('it is a superuser'));
  assert.ok(apiPrivilegeViolations(facts({
    privileges: { ...facts().privileges, 'app.users': { select: true, insert: true, update: false, delete: false } },
  })).some((violation) => /INSERT into app.users/.test(violation)));
  assert.ok(apiPrivilegeViolations(facts({
    privileges: {
      ...facts().privileges,
      'app.user_credentials': { select: true, insert: false, update: true, delete: false },
    },
  })).some((violation) => /write app.user_credentials/.test(violation)));
  // Too few grants is also a refusal: an API that cannot read a hash can never log
  // anybody in, and discovering that at the first login attempt is worse.
  assert.ok(apiPrivilegeViolations(facts({
    privileges: { ...facts().privileges, 'app.user_credentials': { select: false, insert: false, update: false, delete: false } },
  })).some((violation) => /no login can succeed/.test(violation)));

  // The worker's intended grants: domain reads, nothing else.
  const workerFacts = facts({
    role: 'szronox_worker',
    privileges: {
      'app.users': { select: true, insert: false, update: false, delete: false },
      'app.user_credentials': { select: false, insert: false, update: false, delete: false },
      'app.auth_sessions': { select: false, insert: false, update: false, delete: false },
      'app.reels': { select: true, insert: false, update: false, delete: false },
    },
  });
  assert.deepEqual(workerPrivilegeViolations(workerFacts), []);
  // Any access at all to credentials or sessions is a refusal for the worker, even read.
  assert.ok(workerPrivilegeViolations(facts({ role: 'szronox_worker' }))
    .some((violation) => /app.user_credentials/.test(violation)));
  assert.ok(workerPrivilegeViolations(facts({ role: 'szronox_worker' }))
    .some((violation) => /app.auth_sessions/.test(violation)));
});

test('logger options redact credentials and drop the query string', () => {
  assert.equal(buildLoggerOptions('silent'), false);
  const options = buildLoggerOptions('info');
  assert.notEqual(options, false);
  if (options === false) return;

  for (const required of ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'req.body.password']) {
    assert.ok(options.redact.paths.includes(required), `${required} must be redacted`);
  }
  assert.equal(options.redact.remove, true, 'the field is dropped rather than marked present');
  assert.ok(REDACT_PATHS.includes('password_hash'));

  // The request serialiser allow-lists four fields, so a header added later is excluded
  // by default instead of being logged until somebody notices.
  const serialised = options.serializers.req({
    method: 'POST',
    url: '/api/v1/auth/login?token=leak',
    ip: '203.0.113.4',
    id: 'req-1',
    headers: { cookie: '__Host-szronox_session=secret' },
  } as never) as Record<string, unknown>;
  assert.deepEqual(serialised, { id: 'req-1', method: 'POST', url: '/api/v1/auth/login', remoteAddress: '203.0.113.4' });
  assert.ok(!JSON.stringify(serialised).includes('secret'));

  assert.equal(parseLogLevel(undefined, 'silent'), 'silent');
  assert.equal(parseLogLevel('WARN'), 'warn');
  assert.throws(() => parseLogLevel('chatty'), /LOG_LEVEL must be one of/);
});

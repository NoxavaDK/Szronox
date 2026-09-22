/**
 * T05 core tests, against a real PostgreSQL.
 *
 * PGlite is PostgreSQL 18 compiled to WASM, so the committed migration actually
 * applies, CHECK constraints actually fire, and transactions actually roll back.
 * These are real database results, not doubles.
 *
 * One honest limit: PGlite serialises everything on a single connection, so a
 * genuine race between two sessions cannot be produced here. Compare-and-update is
 * therefore written with its guard inside the UPDATE's WHERE clause, and the tests
 * below assert that a stale writer's UPDATE matches no row — which is the property
 * that makes the multi-session case safe too. Verifying it against two real
 * sessions still needs a Postgres server; see docs/implementation/T05-result.md.
 *
 * The only mocked collaborator is the storage probe, because object storage is not
 * part of T05's owned surface.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';

import { type Database, pgliteDatabase } from './db/client.js';
import { migrate, seedUsers } from './db/migrate.js';
import { CoreRepository, DEFAULT_ATTACHMENT_LIMITS, payloadHash } from './core/repository.js';
import { CoreError } from './core/errors.js';
import { deriveVerificationState } from './core/mapping.js';
import { memoryStorageAdapter, supabaseStorageAdapter, StorageError } from './core/storage.js';
import type { StorageAdapter } from './core/storage.js';
import { TEST_AUTH_ENV, TEST_CSRF_SECRET, sessionHarness } from './auth/test-support.js';

const NOXAVA = { id: '11111111-1111-4111-8111-111111111111', name: 'NOXAVA' as const };
const SZRON = { id: '22222222-2222-4222-8222-222222222222', name: 'SZRON' as const };

/** The in-memory adapter doubles as the "what is really stored" control. */
type MemoryStorage = ReturnType<typeof memoryStorageAdapter>;

async function freshDatabase(): Promise<Database> {
  const db = pgliteDatabase(await PGlite.create());
  await migrate(db);
  await seedUsers(db, [NOXAVA, SZRON]);
  return db;
}

interface Fixture {
  db: Database;
  repo: CoreRepository;
  storage: MemoryStorage;
}

async function fixture(): Promise<Fixture> {
  const db = await freshDatabase();
  return { db, repo: new CoreRepository(db), storage: memoryStorageAdapter() };
}

const capture = (over: Record<string, unknown> = {}) => ({
  operationId: randomUUID(),
  reelId: randomUUID(),
  input: { text: 'Notatka z przechwycenia', images: [] as unknown[] },
  ...over,
});

const image = (fileName = 'a.png', byteSize = 1024) => ({
  attachmentId: randomUUID(), fileName, mimeType: 'image/png', byteSize,
});

/** Assert a CoreError with an exact contract code. */
async function expectCode(body: () => Promise<unknown>, code: string, status?: number): Promise<CoreError> {
  try {
    await body();
  } catch (error) {
    assert.ok(error instanceof CoreError, `expected CoreError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return error;
  }
  throw new Error(`expected ${code} but the call succeeded`);
}

// ══════════════════════════ migrations and schema ═══════════════════════════

test('the committed migration applies to a bare database and is idempotent', async () => {
  const db = pgliteDatabase(await PGlite.create());
  try {
    const first = await migrate(db);
    assert.ok(first.length > 0, 'at least one migration file must be applied');
    assert.deepEqual(first.map((entry) => entry.alreadyApplied), first.map(() => false));

    // Re-running records nothing new.
    const second = await migrate(db);
    assert.deepEqual(second.map((entry) => entry.alreadyApplied), second.map(() => true));

    // Tables landed in the nonexposed schema, not public.
    const tables = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'app' order by table_name`,
    );
    // Every table the committed migrations create, listed so adding one is a deliberate
    // edit here. GEMINI-02's `ai_runs` and programme tables were missing from this list;
    // CORPUS-01 adds its own and restores the assertion. CORPUS-02 adds the enrichment
    // revision log (migration 0007).
    assert.deepEqual(tables.rows.map((r) => r.table_name), [
      'ai_runs', 'attachments', 'auth_sessions', 'memes', 'operations',
      'programme_chunks', 'programme_documents', 'programme_proposal_enrichment_revisions',
      'programme_proposals', 'programme_release_versions', 'programme_releases',
      'programme_sections', 'programme_versions', 'programme_vocabulary_entries',
      'reel_hooks', 'reel_memes', 'reels', 'user_credentials', 'users',
    ]);
  } finally {
    await db.close();
  }
});

test('schema constraints reject invalid domain values', async () => {
  const { db } = await fixture();
  try {
    const reelId = randomUUID();
    await db.query(
      `insert into app.reels (id, original_input, created_by) values ($1, '{"images":[]}'::jsonb, $2)`,
      [reelId, NOXAVA.id],
    );
    // Five statuses only.
    await assert.rejects(
      db.query('update app.reels set status = $1 where id = $2', ['archived', reelId]),
      /violates check constraint/i,
    );
    // Verification cannot exist without an export.
    await assert.rejects(
      db.query(`update app.reels set verification = '{"checkedBy":"x"}'::jsonb where id = $1`, [reelId]),
      /reels_verification_requires_export/i,
    );
    // Third user cannot be created.
    await assert.rejects(
      db.query('insert into app.users (id, name) values ($1, $2)', [randomUUID(), 'INTRUDER']),
      /violates check constraint/i,
    );
    // feed_cover_done defaults false, never inferred.
    const row = await db.query<{ feed_cover_done: boolean }>(
      'select feed_cover_done from app.reels where id = $1', [reelId],
    );
    assert.equal(row.rows[0].feed_cover_done, false);
  } finally {
    await db.close();
  }
});

// ══════════════════════════ authentication boundary ═════════════════════════
//
// VPS-01 replaced Supabase JWT verification with application-owned opaque session
// cookies, so the token-verifier and JWKS tests that used to live here have no
// subject any more and were removed rather than adapted. The equivalent boundary
// is now exercised end-to-end in `auth.test.ts`: login, `/me`, forged, expired and
// revoked sessions, CSRF, Origin and login throttling.

test('both allowlisted users reach the same shared Reel', async () => {
  const { db, repo } = await fixture();
  try {
    const request = capture();
    await repo.createReel(NOXAVA, request as never);
    // Reels are shared, not per-owner.
    const asPeer = await repo.getReel(request.reelId);
    assert.equal(asPeer.id, request.reelId);
    assert.equal(asPeer.createdBy, NOXAVA.id);
  } finally {
    await db.close();
  }
});

// ══════════════════════════ atomic capture ══════════════════════════════════

test('capture creates one Reel plus every pending image and the initial hook atomically', async () => {
  const { db, repo } = await fixture();
  try {
    const images = [image('a.png'), image('b.jpg'), image('c.webp')];
    const request = capture({
      input: { text: 'Opis', url: 'https://example.com/a', images },
      initialHook: 'Pierwszy hook',
    });
    const reel = await repo.createReel(NOXAVA, request as never);

    assert.equal(reel.version, 1);
    assert.equal(reel.attachments.length, 3, 'every supported image becomes a pending attachment');
    assert.deepEqual(reel.attachments.map((a) => a.state), ['pending', 'pending', 'pending']);
    assert.deepEqual([...reel.attachments.map((a) => a.id)].sort(), [...images.map((i) => i.attachmentId)].sort());
    assert.equal(reel.hooks.length, 1);
    assert.equal(reel.hooks[0].source, 'user');
    assert.equal(reel.hooks[0].position, 0);
    // originalInput is preserved verbatim, distinct from the editable note.
    assert.deepEqual(reel.originalInput.images.map((i) => i.fileName), ['a.png', 'b.jpg', 'c.webp']);
    assert.equal(reel.feedCoverDone, false);
    assert.equal(reel.verificationState, null, 'no export means no verification state at all');
  } finally {
    await db.close();
  }
});

test('a failing capture rolls back completely, leaving no truncated subset', async () => {
  const { db, repo } = await fixture();
  try {
    const duplicate = image('dup.png');
    // Two images sharing one attachmentId: the second insert violates the primary
    // key mid-transaction.
    const request = capture({ input: { text: 'Opis', images: [duplicate, { ...duplicate, fileName: 'other.png' }] } });
    await assert.rejects(repo.createReel(NOXAVA, request as never));

    const reels = await db.query('select id from app.reels where id = $1', [request.reelId]);
    const attachments = await db.query('select id from app.attachments where reel_id = $1', [request.reelId]);
    assert.equal(reels.rows.length, 0, 'the Reel must not survive a failed capture');
    assert.equal(attachments.rows.length, 0, 'nor any of its attachments');
  } finally {
    await db.close();
  }
});

test('a wholly unusable capture is refused', async () => {
  const { db, repo } = await fixture();
  try {
    await expectCode(
      () => repo.createReel(NOXAVA, capture({ input: { text: '   ', images: [] } }) as never),
      'VALIDATION_ERROR', 422,
    );
  } finally {
    await db.close();
  }
});

// ══════════════════════════ idempotency ═════════════════════════════════════

test('replaying the same operation and payload returns the original result, even after later edits', async () => {
  const { db, repo } = await fixture();
  try {
    const request = capture({ input: { text: 'Pierwotny', images: [] } });
    const first = await repo.createReel(NOXAVA, request as never);

    // An unrelated edit moves the Reel on.
    await repo.patchReel(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: first.version, changes: { title: 'Zmieniony' },
    });

    // The replay still returns what the original call returned.
    const replayed = await repo.createReel(NOXAVA, request as never);
    assert.deepEqual(replayed, first);
    assert.equal(replayed.title, '', 'the recorded result is returned, not a fresh read');

    const count = await db.query<{ count: string }>('select count(*)::text as count from app.reels');
    assert.equal(count.rows[0].count, '1', 'a replay must not create a second Reel');
  } finally {
    await db.close();
  }
});

test('the same operation id with a changed payload is an idempotency conflict', async () => {
  const { db, repo } = await fixture();
  try {
    const request = capture();
    await repo.createReel(NOXAVA, request as never);
    await expectCode(
      () => repo.createReel(NOXAVA, { ...request, input: { text: 'Inny tekst', images: [] } } as never),
      'IDEMPOTENCY_CONFLICT', 409,
    );
  } finally {
    await db.close();
  }
});

test('payload hashing ignores key order but not values', () => {
  assert.equal(payloadHash({ a: 1, b: { c: 2, d: 3 } }), payloadHash({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(payloadHash({ a: 1 }), payloadHash({ a: 2 }));
  assert.notEqual(payloadHash({ a: [1, 2] }), payloadHash({ a: [2, 1] }), 'array order is significant');
});

test('a replayed patch neither double-applies nor bumps the version twice', async () => {
  const { db, repo } = await fixture();
  try {
    const request = capture();
    const created = await repo.createReel(NOXAVA, request as never);
    const patch = { operationId: randomUUID(), expectedVersion: created.version, changes: { title: 'Raz' } };

    const once = await repo.patchReel(NOXAVA, request.reelId, patch);
    const twice = await repo.patchReel(NOXAVA, request.reelId, patch);
    assert.deepEqual(twice, once);
    assert.equal(once.version, created.version + 1);

    const current = await repo.getReel(request.reelId);
    assert.equal(current.version, created.version + 1, 'the replay must not bump the version again');
  } finally {
    await db.close();
  }
});

// ══════════════════════════ optimistic concurrency ══════════════════════════

test('a stale expectedVersion is rejected with the authoritative version', async () => {
  const { db, repo } = await fixture();
  try {
    const request = capture();
    const created = await repo.createReel(NOXAVA, request as never);
    await repo.patchReel(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: created.version, changes: { title: 'Pierwszy zapis' },
    });

    const conflict = await expectCode(
      () => repo.patchReel(NOXAVA, request.reelId, {
        operationId: randomUUID(), expectedVersion: created.version, changes: { title: 'Drugi zapis' },
      }),
      'EDIT_CONFLICT', 409,
    );
    assert.equal(conflict.currentVersion, created.version + 1, 'the client needs the current version to recover');

    const current = await repo.getReel(request.reelId);
    assert.equal(current.title, 'Pierwszy zapis', 'the losing write must not overwrite the winner');
  } finally {
    await db.close();
  }
});

test('two writers on the same expectedVersion cannot both land', async () => {
  // The guard lives in the UPDATE's WHERE clause, so exactly one statement can
  // match a given version. This asserts that directly against the database: the
  // property that makes the two-session case safe.
  const { db, repo } = await fixture();
  try {
    const request = capture();
    const created = await repo.createReel(NOXAVA, request as never);

    const attempt = (title: string) => db.query(
      `update app.reels set title = $1, version = version + 1
       where id = $2 and version = $3 and deleted_at is null returning version`,
      [title, request.reelId, created.version],
    );

    const first = await attempt('A');
    const second = await attempt('B');
    assert.equal(first.rows.length, 1, 'the first writer wins');
    assert.equal(second.rows.length, 0, 'the second writer matches no row and must not overwrite');

    const current = await repo.getReel(request.reelId);
    assert.equal(current.title, 'A');
    assert.equal(current.version, created.version + 1, 'exactly one version bump');
  } finally {
    await db.close();
  }
});

// ══════════════════════════ feed cover and publish gate ═════════════════════

test('publishing without a completed feed cover is refused', async () => {
  const { db, repo } = await fixture();
  try {
    const request = capture();
    const created = await repo.createReel(NOXAVA, request as never);
    await expectCode(
      () => repo.patchReel(NOXAVA, request.reelId, {
        operationId: randomUUID(), expectedVersion: created.version, changes: { status: 'published' },
      }),
      'FEED_COVER_REQUIRED', 422,
    );
    // Rejected without a partial write.
    const after = await repo.getReel(request.reelId);
    assert.equal(after.status, 'idea');
    assert.equal(after.version, created.version, 'a refused publish must not bump the version');
  } finally {
    await db.close();
  }
});

test('a single patch may complete the cover and publish at once', async () => {
  const { db, repo } = await fixture();
  try {
    const request = capture();
    const created = await repo.createReel(NOXAVA, request as never);
    const published = await repo.patchReel(NOXAVA, request.reelId, {
      operationId: randomUUID(),
      expectedVersion: created.version,
      changes: { status: 'published', feedCoverDone: true },
    });
    assert.equal(published.status, 'published');
    assert.equal(published.feedCoverDone, true);
  } finally {
    await db.close();
  }
});

test('a missing cover does not block editing or ready', async () => {
  const { db, repo } = await fixture();
  try {
    const request = capture();
    let reel = await repo.createReel(NOXAVA, request as never);
    for (const status of ['editing', 'ready'] as const) {
      reel = await repo.patchReel(NOXAVA, request.reelId, {
        operationId: randomUUID(), expectedVersion: reel.version, changes: { status },
      });
      assert.equal(reel.status, status);
      assert.equal(reel.feedCoverDone, false);
    }
  } finally {
    await db.close();
  }
});

// ══════════════════════════ editing timestamp ═══════════════════════════════

test('the editing timestamp is set on entry, survives re-saves, and restarts on re-entry', async () => {
  const { db, repo } = await fixture();
  try {
    const request = capture();
    let reel = await repo.createReel(NOXAVA, request as never);
    reel = await repo.patchReel(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: reel.version, changes: { status: 'editing' },
    });
    const entered = reel.editingStartedAt;
    assert.ok(entered, 'entering editing stamps a server timestamp');

    // Re-saving editing, and changing priority or editor, must not reset it.
    for (const changes of [{ status: 'editing' as const }, { priority: 'urgent' as const }, { editorId: SZRON.id }]) {
      reel = await repo.patchReel(NOXAVA, request.reelId, {
        operationId: randomUUID(), expectedVersion: reel.version, changes,
      });
      assert.equal(reel.editingStartedAt, entered, `changes ${JSON.stringify(changes)} must not reset the period`);
    }

    // Leaving ends the period; re-entering starts a new one.
    reel = await repo.patchReel(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: reel.version, changes: { status: 'to_record' },
    });
    assert.equal(reel.editingStartedAt, null);
    reel = await repo.patchReel(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: reel.version, changes: { status: 'editing' },
    });
    assert.ok(reel.editingStartedAt && reel.editingStartedAt !== entered, 're-entry starts a new period');
  } finally {
    await db.close();
  }
});

// ══════════════════════════ patch allowlist ═════════════════════════════════

test('a scalar patch cannot inject hooks, verification or a result', async () => {
  const { db, repo } = await fixture();
  try {
    const request = capture();
    const created = await repo.createReel(NOXAVA, request as never);
    for (const field of ['hooks', 'verification', 'originalInput', 'version', 'currentExport', 'memeIds']) {
      const error = await expectCode(
        () => repo.patchReel(NOXAVA, request.reelId, {
          operationId: randomUUID(), expectedVersion: created.version, changes: { [field]: 'anything' },
        }),
        'VALIDATION_ERROR', 422,
      );
      assert.match(error.message, /not patchable/);
    }
  } finally {
    await db.close();
  }
});

test('publication fields round-trip through the patch allowlist', async () => {
  const { db, repo } = await fixture();
  try {
    const request = capture();
    const created = await repo.createReel(NOXAVA, request as never);
    const patched = await repo.patchReel(NOXAVA, request.reelId, {
      operationId: randomUUID(),
      expectedVersion: created.version,
      changes: {
        publicationDescription: 'Opis do publikacji',
        publicationHashtags: '#szron #nox',
        publicationUrls: ['https://example.com/a', 'https://example.com/b'],
        publishedAt: '2026-09-15T10:00:00.000Z',
      },
    });
    assert.equal(patched.publicationDescription, 'Opis do publikacji');
    assert.equal(patched.publicationHashtags, '#szron #nox');
    assert.deepEqual(patched.publicationUrls, ['https://example.com/a', 'https://example.com/b']);
    assert.equal(patched.publishedAt, '2026-09-15T10:00:00.000Z');
  } finally {
    await db.close();
  }
});

// ══════════════════════════ hooks ═══════════════════════════════════════════

test('hooks are individually persistent, densely ordered, and insertable in the middle', async () => {
  const { db, repo } = await fixture();
  try {
    const request = capture({ initialHook: 'Pierwszy' });
    let reel = await repo.createReel(NOXAVA, request as never);

    const added = await repo.addHook(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: reel.version, text: 'Trzeci',
    });
    reel = added.reel;
    const middle = await repo.addHook(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: reel.version, text: 'Drugi', position: 1,
    });
    reel = middle.reel;

    assert.deepEqual(reel.hooks.map((h) => h.text), ['Pierwszy', 'Drugi', 'Trzeci']);
    assert.deepEqual(reel.hooks.map((h) => h.position), [0, 1, 2]);
    assert.equal(new Set(reel.hooks.map((h) => h.id)).size, 3, 'each hook keeps a distinct id');

    // Editing wording leaves provenance untouched.
    const target = reel.hooks[1];
    const edited = await repo.editHook(NOXAVA, request.reelId, target.id, {
      operationId: randomUUID(), expectedVersion: reel.version, text: 'Drugi poprawiony',
    });
    const after = edited.hooks.find((h) => h.id === target.id);
    assert.equal(after?.text, 'Drugi poprawiony');
    assert.equal(after?.source, target.source);
    assert.equal(after?.createdAt, target.createdAt, 'created_at is server-owned provenance');

    // Removal closes the gap without disturbing the others' identity.
    const removed = await repo.removeHook(NOXAVA, request.reelId, target.id, {
      operationId: randomUUID(), expectedVersion: edited.version,
    });
    assert.deepEqual(removed.hooks.map((h) => h.text), ['Pierwszy', 'Trzeci']);
    assert.deepEqual(removed.hooks.map((h) => h.position), [0, 1]);
  } finally {
    await db.close();
  }
});

test('hook mutations are version-checked and reject unknown hooks', async () => {
  const { db, repo } = await fixture();
  try {
    const request = capture({ initialHook: 'Hook' });
    const reel = await repo.createReel(NOXAVA, request as never);

    await expectCode(
      () => repo.addHook(NOXAVA, request.reelId, {
        operationId: randomUUID(), expectedVersion: reel.version + 5, text: 'Nowy',
      }),
      'EDIT_CONFLICT', 409,
    );
    await expectCode(
      () => repo.editHook(NOXAVA, request.reelId, randomUUID(), {
        operationId: randomUUID(), expectedVersion: reel.version, text: 'Nowy',
      }),
      'NOT_FOUND', 404,
    );
    await expectCode(
      () => repo.addHook(NOXAVA, request.reelId, {
        operationId: randomUUID(), expectedVersion: reel.version, text: '   ',
      }),
      'VALIDATION_ERROR', 422,
    );
  } finally {
    await db.close();
  }
});

// ══════════════════════════ export and verification ════════════════════════

test('replacing an export increments the application-owned revision even for the same URL', async () => {
  const { db, repo } = await fixture();
  try {
    const request = capture();
    let reel = await repo.createReel(NOXAVA, request as never);
    const reference = { url: 'https://drive.example/file', label: 'Montaż v1' };

    reel = await repo.replaceExport(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: reel.version, export: reference,
    });
    assert.equal(reel.currentExport?.revision, 1);
    assert.equal(reel.verificationState, 'not_verified', 'an export with no check is not verified');

    // Same URL and label: the revision still increments.
    reel = await repo.replaceExport(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: reel.version, export: reference,
    });
    assert.equal(reel.currentExport?.revision, 2);
  } finally {
    await db.close();
  }
});

test('verification requires a selected editor and the other allowlisted user as actor', async () => {
  const { db, repo } = await fixture();
  try {
    const request = capture();
    let reel = await repo.createReel(NOXAVA, request as never);
    reel = await repo.replaceExport(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: reel.version, export: { url: 'https://drive.example/f', label: 'v1' },
    });

    // No editor selected yet: 422, never a guess at who the verifier is.
    await expectCode(
      () => repo.verifyExport(SZRON, request.reelId, {
        operationId: randomUUID(), expectedVersion: reel.version, exportRevision: 1,
      }),
      'EDITOR_REQUIRED', 422,
    );

    reel = await repo.patchReel(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: reel.version, changes: { editorId: NOXAVA.id },
    });

    // The editor cannot verify their own export.
    await expectCode(
      () => repo.verifyExport(NOXAVA, request.reelId, {
        operationId: randomUUID(), expectedVersion: reel.version, exportRevision: 1,
      }),
      'FORBIDDEN', 403,
    );

    // A stale revision is refused rather than silently verifying the current one.
    await expectCode(
      () => repo.verifyExport(SZRON, request.reelId, {
        operationId: randomUUID(), expectedVersion: reel.version, exportRevision: 99,
      }),
      'EXPORT_CHANGED', 409,
    );

    const verified = await repo.verifyExport(SZRON, request.reelId, {
      operationId: randomUUID(), expectedVersion: reel.version, exportRevision: 1,
    });
    assert.equal(verified.verification?.checkedBy, SZRON.id);
    assert.equal(verified.verificationState, 'verified');

    // Replacing the export makes the retained check derive `outdated`.
    const replaced = await repo.replaceExport(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: verified.version, export: { url: 'https://drive.example/f2', label: 'v2' },
    });
    assert.equal(replaced.verificationState, 'outdated');
    assert.equal(replaced.verification?.exportRevision, 1, 'history is retained to derive outdated');
  } finally {
    await db.close();
  }
});

test('verification state is derived, not stored', () => {
  const record = { checkedBy: SZRON.id, checkedAt: '2026-09-14T00:00:00.000Z', exportRevision: 2 };
  assert.equal(deriveVerificationState(null, null), null, 'no export means no state at all');
  assert.equal(deriveVerificationState(null, record), null);
  assert.equal(deriveVerificationState({ revision: 2, url: 'u', label: 'l' }, null), 'not_verified');
  assert.equal(deriveVerificationState({ revision: 2, url: 'u', label: 'l' }, record), 'verified');
  assert.equal(deriveVerificationState({ revision: 3, url: 'u', label: 'l' }, record), 'outdated');
});

// ══════════════════════════ attachments ═════════════════════════════════════

test('upload completion is validated server-side, not accepted on assertion', async () => {
  const { db, repo, storage } = await fixture();
  try {
    const request = capture();
    const reel = await repo.createReel(NOXAVA, request as never);
    const initiated = await repo.initiateAttachment(NOXAVA, request.reelId, {
      operationId: randomUUID(), attachmentId: randomUUID(),
      fileName: 'obraz.png', mimeType: 'image/png', byteSize: 2048,
    }, DEFAULT_ATTACHMENT_LIMITS, storage);
    assert.equal(initiated.attachment.state, 'pending');

    // Nothing in storage yet: completion is refused.
    await expectCode(
      () => repo.completeAttachment(NOXAVA, request.reelId, initiated.attachment.id, {
        operationId: randomUUID(),
      }, storage),
      'UPLOAD_INCOMPLETE', 422,
    );

    // Present but the wrong size: still refused rather than rounded off.
    storage.put(initiated.storageKey, 999);
    await expectCode(
      () => repo.completeAttachment(NOXAVA, request.reelId, initiated.attachment.id, {
        operationId: randomUUID(),
      }, storage),
      'UPLOAD_INCOMPLETE', 422,
    );

    storage.put(initiated.storageKey, 2048);
    const ready = await repo.completeAttachment(NOXAVA, request.reelId, initiated.attachment.id, {
      operationId: randomUUID(),
    }, storage);
    assert.equal(ready.state, 'ready');
    void reel;
  } finally {
    await db.close();
  }
});

test('attachment initiation enforces the configured type and size bounds', async () => {
  const { db, repo, storage } = await fixture();
  try {
    const request = capture();
    await repo.createReel(NOXAVA, request as never);
    await expectCode(
      () => repo.initiateAttachment(NOXAVA, request.reelId, {
        operationId: randomUUID(), attachmentId: randomUUID(),
        fileName: 'film.mp4', mimeType: 'video/mp4', byteSize: 1024,
      }, DEFAULT_ATTACHMENT_LIMITS, storage),
      'VALIDATION_ERROR', 422,
    );
    await expectCode(
      () => repo.initiateAttachment(NOXAVA, request.reelId, {
        operationId: randomUUID(), attachmentId: randomUUID(),
        fileName: 'duzy.png', mimeType: 'image/png',
        byteSize: DEFAULT_ATTACHMENT_LIMITS.maxByteSize + 1,
      }, DEFAULT_ATTACHMENT_LIMITS, storage),
      'VALIDATION_ERROR', 422,
    );
  } finally {
    await db.close();
  }
});

// ══════════════════════════ soft delete and listing ════════════════════════

test('soft delete hides a Reel from the list and restore brings it back', async () => {
  const { db, repo } = await fixture();
  try {
    const request = capture();
    const created = await repo.createReel(NOXAVA, request as never);

    const deleted = await repo.setDeleted(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: created.version,
    }, true);
    assert.ok(deleted.deletedAt);
    assert.equal((await repo.listReels({})).items.length, 0);
    await expectCode(() => repo.getReel(request.reelId), 'NOT_FOUND', 404);

    const restored = await repo.setDeleted(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: deleted.version,
    }, false);
    assert.equal(restored.deletedAt, null);
    assert.equal((await repo.listReels({})).items.length, 1);
  } finally {
    await db.close();
  }
});

test('the list applies fixed ordering, status filtering and keyset pagination', async () => {
  const { db, repo } = await fixture();
  try {
    // Urgent first, then newest. created_at is set explicitly for determinism.
    const seeded: Array<{ id: string; priority: string; createdAt: string }> = [
      { id: randomUUID(), priority: 'normal', createdAt: '2026-09-01T00:00:00Z' },
      { id: randomUUID(), priority: 'urgent', createdAt: '2026-09-02T00:00:00Z' },
      { id: randomUUID(), priority: 'evergreen', createdAt: '2026-09-03T00:00:00Z' },
      { id: randomUUID(), priority: 'normal', createdAt: '2026-09-04T00:00:00Z' },
    ];
    for (const entry of seeded) {
      await db.query(
        `insert into app.reels (id, original_input, created_by, priority, created_at)
         values ($1, '{"images":[]}'::jsonb, $2, $3, $4)`,
        [entry.id, NOXAVA.id, entry.priority, entry.createdAt],
      );
    }

    const all = await repo.listReels({ limit: 10 });
    assert.deepEqual(all.items.map((r) => r.priority), ['urgent', 'normal', 'normal', 'evergreen']);
    // Within a priority, newest first.
    assert.equal(all.items[1].createdAt, '2026-09-04T00:00:00.000Z');
    assert.equal(all.nextCursor, null);

    // Keyset paging walks the same order without repeats or gaps.
    const firstPage = await repo.listReels({ limit: 2 });
    assert.equal(firstPage.items.length, 2);
    assert.ok(firstPage.nextCursor);
    const secondPage = await repo.listReels({ limit: 2, cursor: firstPage.nextCursor as string });
    const walked = [...firstPage.items, ...secondPage.items].map((r) => r.id);
    assert.deepEqual(walked, all.items.map((r) => r.id));
    assert.equal(new Set(walked).size, 4, 'no row appears twice');

    // Status filter.
    await db.query(`update app.reels set status = 'editing' where id = $1`, [seeded[0].id]);
    const editing = await repo.listReels({ status: 'editing' });
    assert.deepEqual(editing.items.map((r) => r.id), [seeded[0].id]);

    // A malformed cursor is a validation error, not a silent full scan.
    await expectCode(() => repo.listReels({ cursor: 'not-a-cursor' }), 'VALIDATION_ERROR', 422);
  } finally {
    await db.close();
  }
});

test('the overdue flag counts only Reels currently in editing past the first threshold', async () => {
  const { db, repo } = await fixture();
  try {
    const stale = randomUUID();
    const fresh = randomUUID();
    const readyButOld = randomUUID();
    await db.query(
      `insert into app.reels (id, original_input, created_by, status, editing_started_at) values
        ($1, '{"images":[]}'::jsonb, $4, 'editing', now() - interval '30 hours'),
        ($2, '{"images":[]}'::jsonb, $4, 'editing', now() - interval '2 hours'),
        ($3, '{"images":[]}'::jsonb, $4, 'ready',   now() - interval '300 hours')`,
      [stale, fresh, readyButOld, NOXAVA.id],
    );
    const overdue = await repo.listReels({ overdue: true });
    assert.deepEqual(overdue.items.map((r) => r.id), [stale], 'only current editing items count');
  } finally {
    await db.close();
  }
});

// ══════════════════════════ HTTP surface ════════════════════════════════════
//
// `registerCoreRoutes` is exercised on a bare Fastify instance, not through
// app.ts: T05 does not own API composition, so these tests must not depend on it.

async function server() {
  const { default: Fastify } = await import('fastify');
  const { registerCoreRoutes } = await import('./core/routes.js');
  const { db, storage } = await fixture();
  const harness = sessionHarness(db);
  const app = Fastify({ logger: false });
  harness.register(app);
  registerCoreRoutes(app, {
    db,
    storage,
    authenticate: harness.authenticate,
    allowlist: [{ ...NOXAVA, avatarUrl: null }, { ...SZRON, avatarUrl: null }],
  });
  await app.ready();

  // One real session per provisioned user, issued through the same store the login
  // route uses. `as` now selects a session rather than minting a token, so a value
  // that is not one of the two users simply has no session to select.
  const issued = new Map<string, Awaited<ReturnType<typeof harness.issue>>>();
  for (const user of [NOXAVA, SZRON]) issued.set(user.id, await harness.issue(user.id));

  return {
    app, db, storage, harness,
    async call(method: string, url: string, options: { as?: string; body?: unknown } = {}) {
      const session = options.as === undefined ? undefined : issued.get(options.as);
      const headers = options.as === undefined
        ? {}
        // An unknown `as` presents a cookie value with no matching session row,
        // which is what a forged cookie looks like to the server.
        : session
          ? harness.headers(session, method)
          : harness.headers({ secret: `forged-${options.as}`, csrfToken: 'forged', expiresAt: new Date() }, method);
      return app.inject({
        method: method as never,
        url,
        headers,
        ...(options.body === undefined ? {} : { payload: options.body as never }),
      });
    },
  };
}

test('every core route refuses an unauthenticated caller with the shared envelope', async () => {
  const ctx = await server();
  try {
    const routes: Array<[string, string]> = [
      ['GET', '/api/v1/me'],
      ['GET', '/api/v1/reels'],
      ['GET', `/api/v1/reels/${randomUUID()}`],
      ['POST', '/api/v1/reels'],
      ['PATCH', `/api/v1/reels/${randomUUID()}`],
      ['POST', `/api/v1/reels/${randomUUID()}/delete`],
      ['POST', `/api/v1/reels/${randomUUID()}/restore`],
      ['POST', `/api/v1/reels/${randomUUID()}/hooks`],
      ['PATCH', `/api/v1/reels/${randomUUID()}/hooks/${randomUUID()}`],
      ['DELETE', `/api/v1/reels/${randomUUID()}/hooks/${randomUUID()}`],
      ['POST', `/api/v1/reels/${randomUUID()}/current-export`],
      ['POST', `/api/v1/reels/${randomUUID()}/verification`],
      ['POST', `/api/v1/reels/${randomUUID()}/attachments/initiate`],
      ['POST', `/api/v1/reels/${randomUUID()}/attachments/${randomUUID()}/complete`],
    ];
    for (const [method, url] of routes) {
      const response = await ctx.call(method, url, { body: {} });
      assert.equal(response.statusCode, 401, `${method} ${url}`);
      assert.deepEqual(response.json(), {
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required', retryable: false },
      });
    }
  } finally {
    await ctx.app.close();
    await ctx.db.close();
  }
});

test('a cookie that matches no session row is refused, including for a plausible user id', async () => {
  const ctx = await server();
  try {
    const response = await ctx.call('GET', '/api/v1/me', { as: randomUUID() });
    assert.equal(response.statusCode, 401);
  } finally {
    await ctx.app.close();
    await ctx.db.close();
  }
});

test('/me reports the signed-in user and the peer identity', async () => {
  const ctx = await server();
  try {
    const response = await ctx.call('GET', '/api/v1/me', { as: NOXAVA.id });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      user: { id: NOXAVA.id, name: 'NOXAVA', avatarUrl: null },
      peer: { id: SZRON.id, name: 'SZRON', avatarUrl: null },
      expiresAt: response.json().expiresAt,
      csrfToken: response.json().csrfToken,
    });
  } finally {
    await ctx.app.close();
    await ctx.db.close();
  }
});

test('the capture, edit and publish path works over HTTP with contract status codes', async () => {
  const ctx = await server();
  try {
    const reelId = randomUUID();
    const created = await ctx.call('POST', '/api/v1/reels', {
      as: NOXAVA.id,
      body: {
        operationId: randomUUID(), reelId,
        input: { text: 'Pomysł', images: [image('a.png')] },
        initialHook: 'Hook',
      },
    });
    assert.equal(created.statusCode, 201);
    const reel = created.json();
    assert.equal(reel.attachments.length, 1);
    assert.equal(reel.hooks.length, 1);

    // A malformed body is a validation error, not a 500.
    const bad = await ctx.call('PATCH', `/api/v1/reels/${reelId}`, {
      as: NOXAVA.id, body: { operationId: 'not-a-uuid', expectedVersion: 1, changes: { title: 'x' } },
    });
    assert.equal(bad.statusCode, 422);
    assert.equal(bad.json().error.code, 'VALIDATION_ERROR');

    // The publish gate surfaces as 422 FEED_COVER_REQUIRED over HTTP.
    const blocked = await ctx.call('PATCH', `/api/v1/reels/${reelId}`, {
      as: NOXAVA.id,
      body: { operationId: randomUUID(), expectedVersion: reel.version, changes: { status: 'published' } },
    });
    assert.equal(blocked.statusCode, 422);
    assert.equal(blocked.json().error.code, 'FEED_COVER_REQUIRED');

    const published = await ctx.call('PATCH', `/api/v1/reels/${reelId}`, {
      as: NOXAVA.id,
      body: {
        operationId: randomUUID(), expectedVersion: reel.version,
        changes: { status: 'published', feedCoverDone: true, publicationDescription: 'Opis' },
      },
    });
    assert.equal(published.statusCode, 200);
    assert.equal(published.json().status, 'published');

    // A stale write conflicts and carries the current version.
    const stale = await ctx.call('PATCH', `/api/v1/reels/${reelId}`, {
      as: NOXAVA.id,
      body: { operationId: randomUUID(), expectedVersion: reel.version, changes: { title: 'Za późno' } },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'EDIT_CONFLICT');
    assert.equal(stale.json().error.currentVersion, published.json().version);

    // Detail and list are readable by the peer: Reels are shared.
    assert.equal((await ctx.call('GET', `/api/v1/reels/${reelId}`, { as: SZRON.id })).statusCode, 200);
    const list = await ctx.call('GET', '/api/v1/reels?status=published', { as: SZRON.id });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().items.map((r: { id: string }) => r.id), [reelId]);

    // A missing Reel is a contract 404, not a Fastify default.
    const missing = await ctx.call('GET', `/api/v1/reels/${randomUUID()}`, { as: NOXAVA.id });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'NOT_FOUND');
  } finally {
    await ctx.app.close();
    await ctx.db.close();
  }
});

test('an unexpected internal failure is reduced to a generic envelope', async () => {
  // No SQL text, driver message or stack may reach the client.
  const ctx = await server();
  try {
    await ctx.db.close();
    const response = await ctx.call('GET', '/api/v1/reels', { as: NOXAVA.id });
    assert.equal(response.statusCode, 500);
    const body = response.json();
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.retryable, true);
    assert.ok(!/select|app\.reels|pglite/i.test(JSON.stringify(body)), 'no internals may leak');
  } finally {
    await ctx.app.close();
  }
});

// ══════════════════════ T08 blockers: deleted visibility ════════════════════

test('visibility=deleted returns only soft-deleted Reels, and active excludes them', async () => {
  // T08 reported that a correct client request could not retrieve deleted records
  // at all, because the list unconditionally filtered them out.
  const { db, repo } = await fixture();
  try {
    const kept = capture();
    const removed = capture();
    const keptReel = await repo.createReel(NOXAVA, kept as never);
    const removedReel = await repo.createReel(NOXAVA, removed as never);
    await repo.setDeleted(NOXAVA, removed.reelId, {
      operationId: randomUUID(), expectedVersion: removedReel.version,
    }, true);

    const active = await repo.listReels({});
    assert.deepEqual(active.items.map((r) => r.id), [keptReel.id]);

    const deleted = await repo.listReels({ visibility: 'deleted' });
    assert.deepEqual(deleted.items.map((r) => r.id), [removed.reelId]);
    assert.ok(deleted.items[0].deletedAt, 'a deleted Reel carries its deletedAt');

    // Explicit active is the same as the default.
    assert.deepEqual(
      (await repo.listReels({ visibility: 'active' })).items.map((r) => r.id),
      [keptReel.id],
    );
  } finally {
    await db.close();
  }
});

test('a deleted Reel is readable only with an explicit opt-in', async () => {
  const { db, repo } = await fixture();
  try {
    const request = capture();
    const created = await repo.createReel(NOXAVA, request as never);
    await repo.setDeleted(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: created.version,
    }, true);

    // The ordinary detail path still treats it as gone.
    await expectCode(() => repo.getReel(request.reelId), 'NOT_FOUND', 404);
    // The restore surface can fetch it deliberately.
    const forRestore = await repo.getReel(request.reelId, { includeDeleted: true });
    assert.equal(forRestore.id, request.reelId);
    assert.ok(forRestore.deletedAt);
  } finally {
    await db.close();
  }
});

test('the deleted list and restore round-trip over HTTP', async () => {
  const ctx = await server();
  try {
    const reelId = randomUUID();
    const created = await ctx.call('POST', '/api/v1/reels', {
      as: NOXAVA.id,
      body: { operationId: randomUUID(), reelId, input: { text: 'Do usunięcia', images: [] } },
    });
    const version = created.json().version;
    const deleted = await ctx.call('POST', `/api/v1/reels/${reelId}/delete`, {
      as: NOXAVA.id, body: { operationId: randomUUID(), expectedVersion: version },
    });
    assert.equal(deleted.statusCode, 200);

    // Absent from the active list, present in the deleted one.
    assert.deepEqual((await ctx.call('GET', '/api/v1/reels', { as: NOXAVA.id })).json().items, []);
    const deletedList = await ctx.call('GET', '/api/v1/reels?visibility=deleted', { as: NOXAVA.id });
    assert.equal(deletedList.statusCode, 200);
    assert.deepEqual(deletedList.json().items.map((r: { id: string }) => r.id), [reelId]);

    // Restorable from there.
    const restored = await ctx.call('POST', `/api/v1/reels/${reelId}/restore`, {
      as: NOXAVA.id, body: { operationId: randomUUID(), expectedVersion: deleted.json().version },
    });
    assert.equal(restored.statusCode, 200);
    assert.equal(restored.json().deletedAt, null);
    assert.deepEqual(
      (await ctx.call('GET', '/api/v1/reels', { as: NOXAVA.id })).json().items.map((r: { id: string }) => r.id),
      [reelId],
    );

    // An unknown visibility is refused rather than silently treated as active.
    const bogus = await ctx.call('GET', '/api/v1/reels?visibility=everything', { as: NOXAVA.id });
    assert.equal(bogus.statusCode, 422);
    assert.equal(bogus.json().error.code, 'VALIDATION_ERROR');
  } finally {
    await ctx.app.close();
    await ctx.db.close();
  }
});

// ══════════════════════ T08 blockers: signed upload ═════════════════════════

test('attachment initiation returns a signed upload the browser can use', async () => {
  const { db, repo, storage } = await fixture();
  try {
    const request = capture();
    await repo.createReel(NOXAVA, request as never);
    const initiated = await repo.initiateAttachment(NOXAVA, request.reelId, {
      operationId: randomUUID(), attachmentId: randomUUID(),
      fileName: 'obraz.png', mimeType: 'image/png', byteSize: 2048,
    }, DEFAULT_ATTACHMENT_LIMITS, storage);

    // T08's blocker: initiate previously returned only a storage key.
    assert.ok(initiated.upload.uploadUrl, 'a browser needs somewhere to PUT the bytes');
    assert.equal(initiated.upload.method, 'PUT');
    assert.ok(initiated.upload.expiresAt > Math.floor(Date.now() / 1000), 'the URL must be short-lived');
    assert.deepEqual(storage.uploads(), [initiated.storageKey], 'signed for exactly this object');
    assert.equal(initiated.attachment.state, 'pending');
  } finally {
    await db.close();
  }
});

test('a replayed initiate returns the original signed upload rather than minting another', async () => {
  const { db, repo, storage } = await fixture();
  try {
    const request = capture();
    await repo.createReel(NOXAVA, request as never);
    const body = {
      operationId: randomUUID(), attachmentId: randomUUID(),
      fileName: 'obraz.png', mimeType: 'image/png', byteSize: 2048,
    };
    const first = await repo.initiateAttachment(NOXAVA, request.reelId, body, DEFAULT_ATTACHMENT_LIMITS, storage);
    const replay = await repo.initiateAttachment(NOXAVA, request.reelId, body, DEFAULT_ATTACHMENT_LIMITS, storage);
    assert.deepEqual(replay, first);
    assert.equal(storage.uploads().length, 1, 'a retry must not issue a second URL');
  } finally {
    await db.close();
  }
});

test('the signed upload is exposed over HTTP without leaking a service key', async () => {
  const ctx = await server();
  try {
    const reelId = randomUUID();
    await ctx.call('POST', '/api/v1/reels', {
      as: NOXAVA.id,
      body: { operationId: randomUUID(), reelId, input: { text: 'Z obrazem', images: [] } },
    });
    const response = await ctx.call('POST', `/api/v1/reels/${reelId}/attachments/initiate`, {
      as: NOXAVA.id,
      body: {
        operationId: randomUUID(), attachmentId: randomUUID(),
        fileName: 'a.png', mimeType: 'image/png', byteSize: 1024,
      },
    });
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.ok(body.upload.uploadUrl);
    assert.equal(body.upload.method, 'PUT');
    // No server credential may ride out with the signed URL.
    assert.ok(!JSON.stringify(body).includes('service_role'));
    assert.ok(!/apikey|authorization/i.test(JSON.stringify(body.upload.headers ?? {})));
  } finally {
    await ctx.app.close();
    await ctx.db.close();
  }
});

test('the Supabase storage adapter reports a missing object and refuses a sizeless response', async () => {
  // The provider call itself is UNVERIFIED — no project exists. What is asserted
  // here is that this adapter handles the documented shapes without inventing a
  // size, because a silent zero would make a mismatch check pass by accident.
  const missing = supabaseStorageAdapter({
    url: 'https://project.supabase.co', serviceRoleKey: 'fake-service-key', bucket: 'attachments',
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) as never,
  });
  assert.deepEqual(await missing.statObject('reels/a/b'), { exists: false, byteSize: 0 });

  const sizeless = supabaseStorageAdapter({
    url: 'https://project.supabase.co', serviceRoleKey: 'fake-service-key', bucket: 'attachments',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ name: 'b' }) }) as never,
  });
  await assert.rejects(sizeless.statObject('reels/a/b'), StorageError);

  const signing = supabaseStorageAdapter({
    url: 'https://project.supabase.co/', serviceRoleKey: 'fake-service-key', bucket: 'attachments',
    now: () => 1_800_000_000_000,
    fetchImpl: async (url, init) => {
      // The service-role key authenticates the signing request, server-side only.
      assert.match(String(url), /\/storage\/v1\/object\/upload\/sign\/attachments\/reels\/a\/b$/);
      assert.equal((init as { method?: string }).method, 'POST');
      return { ok: true, status: 200, json: async () => ({ url: '/object/upload/sign/attachments/reels/a/b?token=x' }) } as never;
    },
  });
  const upload = await signing.createSignedUpload('reels/a/b', { mimeType: 'image/png', byteSize: 10 });
  assert.equal(upload.uploadUrl, 'https://project.supabase.co/storage/v1/object/upload/sign/attachments/reels/a/b?token=x');
  assert.equal(upload.expiresAt, 1_800_000_000 + 300);
  assert.ok(!JSON.stringify(upload.headers).includes('fake-service-key'), 'the signed URL carries the authority, not the key');
});

// ══════════════════ removed: asymmetric JWKS verification ══════════════════
//
// VPS-01 removed RS256/ES256 JWKS verification with the rest of the JWT path.
// Sessions are opaque and application-owned, so there is no external key set to
// fetch, cache or rotate. The tests that generated keypairs and served a JWKS
// document were deleted with the module they exercised rather than left asserting
// behaviour nothing implements.

// ══════════════════════ T08 blocker: app.ts registration ════════════════════

test('buildApp registers the core routes when dependencies are supplied', async () => {
  const { buildApp } = await import('./app.js');
  const { db, storage } = await fixture();
  const harness = sessionHarness(db);
  const app = buildApp({
    auth: { service: harness.service },
    core: {
      db, storage,
      authenticate: harness.authenticate,
      allowlist: [{ ...NOXAVA, avatarUrl: null }, { ...SZRON, avatarUrl: null }],
    },
  });
  try {
    await app.ready();
    const session = await harness.issue(NOXAVA.id);
    const me = await app.inject({
      method: 'GET', url: '/api/v1/me', headers: harness.headers(session, 'GET'),
    });
    assert.equal(me.statusCode, 200, 'core routes must be reachable through app.ts');
    assert.equal(me.json().user.name, 'NOXAVA');

    // The pre-existing surface still behaves: health, the shared 404 envelope and
    // the SPA fallback are unaffected by registration.
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode, 200);
    const unknown = await app.inject({ method: 'POST', url: '/api/v1/nope' });
    assert.equal(unknown.statusCode, 404);
    assert.equal(unknown.json().error.code, 'NOT_FOUND');

    // A core route must be matched by its own handler, not swallowed by the SPA
    // fallback, and must answer 401 rather than 200 HTML when unauthenticated.
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/reels' });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.json().error.code, 'UNAUTHENTICATED');
  } finally {
    await app.close();
    await db.close();
  }
});

test('buildApp without core dependencies serves the static app only', async () => {
  const { buildApp } = await import('./app.js');
  const app = buildApp();
  try {
    await app.ready();
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode, 200);
    // Core routes are absent rather than half-registered against no database.
    const reels = await app.inject({ method: 'GET', url: '/api/v1/reels' });
    assert.equal(reels.statusCode, 404);
    assert.equal(reels.json().error.code, 'NOT_FOUND');
  } finally {
    await app.close();
  }
});

// ══════════════════════ T08 blocker: storage configuration ══════════════════

test('configuration requires private filesystem settings without a memory fallback', async () => {
  const { buildStorage, parseAllowlist, describeConfig, ConfigError } =
    await import('./core/config.js');
  assert.throws(() => buildStorage({ APP_ORIGIN: 'https://szronox.test' }), ConfigError);
  assert.throws(() => buildStorage({}), /APP_STORAGE_ROOT is required/);
  assert.ok(buildStorage({ STORAGE_DRIVER: 'memory' }));
  assert.ok(buildStorage({ APP_STORAGE_ROOT: '/var/lib/szronox/storage', APP_ORIGIN: 'https://szronox.test' }));

  // The allowlist is exactly two distinct product users.
  assert.deepEqual(
    parseAllowlist(`NOXAVA:${NOXAVA.id},SZRON:${SZRON.id}`),
    [{ id: NOXAVA.id, name: 'NOXAVA' }, { id: SZRON.id, name: 'SZRON' }],
  );
  assert.throws(() => parseAllowlist(`NOXAVA:${NOXAVA.id}`), /exactly two/);
  assert.throws(() => parseAllowlist(`NOXAVA:${NOXAVA.id},NOXAVA:${SZRON.id}`), /NOXAVA and SZRON/);
  assert.throws(() => parseAllowlist(`NOXAVA:${NOXAVA.id},SZRON:${NOXAVA.id}`), /distinct ids/);
  assert.throws(() => parseAllowlist(`ADMIN:${NOXAVA.id},SZRON:${SZRON.id}`), /unknown user name/);
  assert.throws(() => parseAllowlist(undefined), /required/);

  // The startup summary names what is configured without exposing any value.
  const described = describeConfig({
    ...TEST_AUTH_ENV,
    APP_STORAGE_ROOT: '/var/lib/szronox/storage', APP_ALLOWLIST: `NOXAVA:${NOXAVA.id},SZRON:${SZRON.id}`,
  });
  assert.equal(described.authentication.mechanism, 'opaque_session_cookie');
  assert.equal(described.authentication.csrfSecretConfigured, true);
  assert.equal(described.storage, 'filesystem');
  const serialised = JSON.stringify(described);
  assert.ok(
    !serialised.includes(TEST_CSRF_SECRET) && !serialised.includes('super-secret-key'),
    'no secret may appear',
  );
});

test('buildCoreDependencies composes a working dependency set from environment', async () => {
  const { buildCoreDependencies } = await import('./core/config.js');
  const { buildApp } = await import('./app.js');
  const { db } = await fixture();
  const core = buildCoreDependencies(db, {
    ...TEST_AUTH_ENV,
    STORAGE_DRIVER: 'memory', APP_ALLOWLIST: `NOXAVA:${NOXAVA.id},SZRON:${SZRON.id}`,
  });
  const app = buildApp({ core, auth: core.auth });
  try {
    await app.ready();
    assert.equal(typeof core.authenticate, 'function', 'the composed set must carry the session seam');
    // The session is issued into the same database under the same configuration, so
    // /me here is resolved by the authenticator `buildCoreDependencies` composed.
    const harness = sessionHarness(db);
    const response = await app.inject({
      method: 'GET', url: '/api/v1/me',
      headers: harness.headers(await harness.issue(NOXAVA.id), 'GET'),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().peer.name, 'SZRON');
  } finally {
    await app.close();
    await db.close();
  }
});

// ══════════════════════ scriptRevision (pinned contract) ════════════════════

test('scriptRevision advances only for script changes, not for metadata edits', async () => {
  // The contract defines it as a "monotonic script-only change counter; unrelated
  // metadata edits do not increment it" — `version` cannot answer that question,
  // because it bumps on every accepted mutation.
  const { db, repo } = await fixture();
  try {
    const request = capture();
    let reel = await repo.createReel(NOXAVA, request as never);
    assert.equal(reel.scriptRevision, 0, 'a fresh capture starts at zero');

    reel = await repo.patchReel(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: reel.version, changes: { script: 'Pierwsza wersja' },
    });
    assert.equal(reel.scriptRevision, 1);

    // Metadata edits bump version but must leave the counter alone.
    for (const changes of [{ priority: 'urgent' as const }, { title: 'Nowy tytuł' }, { editorId: SZRON.id }]) {
      const before: number = reel.scriptRevision;
      reel = await repo.patchReel(NOXAVA, request.reelId, {
        operationId: randomUUID(), expectedVersion: reel.version, changes,
      });
      assert.equal(reel.scriptRevision, before, `${JSON.stringify(changes)} must not advance scriptRevision`);
    }

    reel = await repo.patchReel(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: reel.version, changes: { script: 'Druga wersja' },
    });
    assert.equal(reel.scriptRevision, 2);

    // Writing the SAME script text is not a script change.
    const unchanged = await repo.patchReel(NOXAVA, request.reelId, {
      operationId: randomUUID(), expectedVersion: reel.version, changes: { script: 'Druga wersja' },
    });
    assert.equal(unchanged.scriptRevision, 2, 'an identical script must not advance the counter');
  } finally {
    await db.close();
  }
});

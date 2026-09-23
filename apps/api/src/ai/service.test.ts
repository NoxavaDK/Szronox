import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgliteDatabase } from '../db/client.js';
import { mkdtemp, readdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { payloadHash } from '../core/repository.js';
import { defaultMigrationsDir, migrate } from '../db/migrate.js';
import { AiService } from './service.js';

const user = '11111111-1111-4111-8111-111111111111';
const reelId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const imageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const actor = { id: user, name: 'NOXAVA' as const };
const input = { text: 'Źródło', images: [{ attachmentId: imageId, fileName: 'test.png', mimeType: 'image/png', byteSize: 100 }] };

async function setup() {
  const instance = new PGlite();
  const db = pgliteDatabase(instance);
  // Every committed migration, in order, rather than a hand-kept list that silently
  // stops covering the schema the code under test actually queries.
  await migrate(db);
  await db.query("insert into app.users(id,name) values($1,'NOXAVA')", [user]);
  await db.query('insert into app.reels(id,original_input,created_by,script) values($1,$2,$3,$4)', [reelId, JSON.stringify(input), user, 'Stary skrypt.']);
  await db.query(`insert into app.attachments(id,reel_id,purpose,kind,state,file_name,mime_type,byte_size)
    values($1,$2,'input','image','pending','test.png','image/png',100)`, [imageId, reelId]);
  return { db, service: new AiService(db) };
}

async function readyInput(db: Awaited<ReturnType<typeof setup>>['db']) {
  await db.query(`update app.attachments set state='ready',storage_key='reels/test/image',
    stored_byte_size=100,validated_mime_type='image/png',validated_width=2,validated_height=2,
    validated_pixel_count=4,validated_at=now() where id=$1`, [imageId]);
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * The smallest active corpus release `find_programme` will accept.
 *
 * Written out in full because the release-membership trigger refuses a document version
 * without validated provenance — which is the point of that trigger, and a fixture that
 * dodged it would be testing a schema the deployment does not have.
 */
async function activeRelease(db: Awaited<ReturnType<typeof setup>>['db']): Promise<void> {
  const documentId = '03000000-0000-4000-8000-000000000011';
  const versionId = '03000000-0000-4000-8000-000000000001';
  const releaseId = '03000000-0000-4000-8000-000000000012';
  await db.query(`insert into app.programme_documents
      (id, document_slug, title, document_type, issuing_body, admission_rationale)
    values($1,'doc-programme','Program','programme','Partia Zieloni','Przyjęty przez Kongres.')`, [documentId]);
  await db.query(`insert into app.programme_versions
      (id, title, source_url, document_sha256, document_id, version_slug, source_title, edition, adopted_at,
       language, source_file_name, source_format, source_byte_size, retrieved_at, page_count,
       printed_page_labels, structure_coverage, archive_key, normalized_text_sha256, normalized_length,
       ingestion, state)
    values($1,'Program','https://example.org/programme.pdf',$2,$3,'dv-programme-01','Program (2026)',
       'Kongres 2026','2026-01-17','pl','Program.pdf','pdf',1024,now(),4,
       array['','','3','4']::text[],'full','dv-programme-01/Program.pdf',$4,100,'{}'::jsonb,'approved')`,
  [versionId, 'a'.repeat(64), documentId, 'b'.repeat(64)]);
  await db.query(`insert into app.programme_releases
      (id, corpus_id, release_slug, label, state, category_vocabulary_id, imported_by,
       validation_report, coverage_ledger, approved_by, approved_at, activated_at)
    values($1,'zieloni-programme','release-01','Wydanie testowe','active','cat-vocab-01','NOXAVA',
       '{}'::jsonb,'{}'::jsonb,'NOXAVA',now(),now())`, [releaseId]);
  await db.query('insert into app.programme_release_versions(release_id,document_version_id,position) values($1,$2,0)',
    [releaseId, versionId]);
}

function claim(id: string, script: string, original: string, correction: string, inputHash: string) {
  const start = script.indexOf(original);
  assert.ok(start >= 0);
  return {
    id, location: { field: 'script' },
    origin: { reelVersion: 1, inputHash, sourceTextHash: sha256(script),
      span: { start, end: start + original.length, text: original, offsetUnit: 'utf16_code_units' } },
    text: original, status: 'contradicted', explanation: 'Test evidence', sourceIds: [], evidence: [],
    correction, isStale: false, applied: null,
  };
}

async function successfulRun(
  db: Awaited<ReturnType<typeof setup>>['db'], service: AiService,
  action: 'fact_check' | 'language_check' | 'find_programme', result: unknown, operationId: string,
) {
  const run = await service.enqueue(actor, reelId, { operationId, expectedVersion: 1, action });
  await db.query("update app.ai_runs set state='succeeded',result=$2,completed_at=now() where id=$1", [run.id, JSON.stringify(result)]);
  return service.get(actor, run.id);
}

test('enqueue snapshots every validated input image and refuses pending ones', async () => {
  const { db, service } = await setup();
  try {
    await assert.rejects(service.enqueue(actor, reelId, {
      operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expectedVersion: 1, action: 'develop',
    }), (error: { code?: string }) => error.code === 'UPLOAD_INCOMPLETE');
    await readyInput(db);
    const request = { operationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', expectedVersion: 1, action: 'develop' as const };
    const first = await service.enqueue(actor, reelId, request);
    const replay = await service.enqueue(actor, reelId, request);
    assert.equal(replay.id, first.id);
    const run = await service.get(actor, first.id);
    assert.equal(run.input.originalInput.text, 'Źródło');
    assert.equal(run.input.attachments.length, 1);
    assert.equal(run.input.attachments[0].storageKey, undefined);
    assert.equal(run.promptStage, 'development_provisional');
    assert.equal(run.promptId, 'gemini-02-development-provisional-v3');
  } finally { await db.close(); }
});

const publicationProposal = { publicationDescriptionSuggestion: 'Opis AI', publicationHashtagsSuggestion: '#AI' };
const legacyDevelop = { titleSuggestion: 'Tytuł', eventSummary: 'Podsumowanie', verificationIssues: [], hookAdditions: [],
  scriptSuggestion: 'Nowy skrypt.', publicationDescriptionSuggestion: 'Opis z Opracuj', publicationHashtagsSuggestion: '#stare',
  possibleProgrammeConnection: null, prioritySuggestion: null, memeSuggestion: null };
const reelRow = async (db: Awaited<ReturnType<typeof setup>>['db']) => (await db.query<{
  version: number; script: string; script_revision: number; publication_description: string; publication_hashtags: string; title: string;
}>('select version,script,script_revision,publication_description,publication_hashtags,title from app.reels where id=$1', [reelId])).rows[0];
const code = (expected: string) => (error: { code?: string }) => error.code === expected;

async function publicationRun(db: Awaited<ReturnType<typeof setup>>['db'], service: AiService, operationId: string, expectedVersion = 1) {
  const run = await service.enqueue(actor, reelId, { operationId, expectedVersion, action: 'generate_publication' });
  await db.query("update app.ai_runs set state='succeeded',result=$2,completed_at=now() where id=$1", [run.id, JSON.stringify(publicationProposal)]);
  return run.id;
}

test('publication application requires explicit current-value confirmation after a changed saved field', async () => {
  const { db, service } = await setup();
  try {
    const runId = await publicationRun(db, service, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    await db.query("update app.reels set publication_description='Opis użytkownika',version=2 where id=$1", [reelId]);
    await assert.rejects(service.apply(actor, runId, {
      operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', expectedVersion: 2,
      selection: 'publication_description', text: 'Opis AI', replaceCurrentValue: '', confirmReplacement: true,
    }), code('EDIT_CONFLICT'));
    assert.equal((await reelRow(db)).publication_description, 'Opis użytkownika');
    const saved = await service.apply(actor, runId, {
      operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', expectedVersion: 2,
      selection: 'publication_description', text: 'Opis AI', replaceCurrentValue: 'Opis użytkownika', confirmReplacement: true,
    });
    assert.equal(saved.publicationDescription, 'Opis AI');
    assert.equal(saved.version, 3);
  } finally { await db.close(); }
});

test('generate_publication snapshots the saved script only and ignores incomplete uploads', async () => {
  const { db, service } = await setup();
  try {
    // The input image is still pending: irrelevant to a script-based action.
    const queued = await service.enqueue(actor, reelId, {
      operationId: '05000000-0000-4000-8000-000000000001', expectedVersion: 1, action: 'generate_publication',
    });
    const stored = await db.query<{ action: string; input_snapshot: { script: string; scriptRevision: number; imageObjects: unknown[] } }>(
      'select action,input_snapshot from app.ai_runs where id=$1', [queued.id]);
    assert.equal(stored.rows[0].action, 'generate_publication');
    assert.equal(stored.rows[0].input_snapshot.script, 'Stary skrypt.');
    assert.equal(stored.rows[0].input_snapshot.scriptRevision, 0);
    assert.deepEqual(stored.rows[0].input_snapshot.imageObjects, []);
    // Other actions keep their upload gate.
    await assert.rejects(service.enqueue(actor, reelId, {
      operationId: '05000000-0000-4000-8000-000000000002', expectedVersion: 1, action: 'develop',
    }), code('UPLOAD_INCOMPLETE'));
    const latest = await service.latest(actor, reelId, 'generate_publication');
    assert.equal(latest?.id, queued.id);
    assert.equal((await service.latest(actor, reelId, 'develop')), null);
  } finally { await db.close(); }
});

test('an empty or whitespace-only saved script is refused before any run exists', async () => {
  const { db, service } = await setup();
  try {
    for (const [index, script] of ['', '  \n\t '].entries()) {
      await db.query('update app.reels set script=$2 where id=$1', [reelId, script]);
      await assert.rejects(service.enqueue(actor, reelId, {
        operationId: `05000000-0000-4000-8000-00000000001${index}`, expectedVersion: 1, action: 'generate_publication',
      }), (error: { code?: string; details?: { reason?: string } }) => error.code === 'VALIDATION_ERROR' && error.details?.reason === 'script_required');
    }
    const runs = await db.query('select id from app.ai_runs');
    assert.equal(runs.rows.length, 0);
  } finally { await db.close(); }
});

test('completion writes nothing; each field applies separately and the second survives the first version bump', async () => {
  const { db, service } = await setup();
  try {
    const runId = await publicationRun(db, service, '06000000-0000-4000-8000-000000000001');
    const before = await reelRow(db);
    assert.equal(before.publication_description, '');
    assert.equal(before.publication_hashtags, '');
    assert.equal(before.version, 1);
    const run = await service.get(actor, runId);
    assert.equal(run.isStale, false);
    assert.deepEqual(Object.keys(run.result ?? {}).sort(), ['publicationDescriptionSuggestion', 'publicationHashtagsSuggestion']);
    // Empty target, edited output, explicit application of one field only.
    const description = await service.apply(actor, runId, {
      operationId: '06000000-0000-4000-8000-000000000002', expectedVersion: 1,
      selection: 'publication_description', text: 'Opis AI (poprawiony)', replaceCurrentValue: '', confirmReplacement: true,
    });
    assert.equal(description.publicationDescription, 'Opis AI (poprawiony)');
    assert.equal(description.publicationHashtags, '');
    // The browser's old version is refused; refreshed authoritative state succeeds.
    await assert.rejects(service.apply(actor, runId, {
      operationId: '06000000-0000-4000-8000-000000000003', expectedVersion: 1,
      selection: 'publication_hashtags', text: '#AI', replaceCurrentValue: '', confirmReplacement: true,
    }), code('EDIT_CONFLICT'));
    const hashtags = await service.apply(actor, runId, {
      operationId: '06000000-0000-4000-8000-000000000004', expectedVersion: description.version,
      selection: 'publication_hashtags', text: '#AI', replaceCurrentValue: '', confirmReplacement: true,
    });
    assert.equal(hashtags.publicationDescription, 'Opis AI (poprawiony)');
    assert.equal(hashtags.publicationHashtags, '#AI');
    const after = await reelRow(db);
    assert.equal(after.script, 'Stary skrypt.');
    assert.equal(after.script_revision, 0);
    assert.equal(after.title, before.title);
    // Unconfirmed replacement is refused.
    await assert.rejects(service.apply(actor, runId, {
      operationId: '06000000-0000-4000-8000-000000000005', expectedVersion: hashtags.version,
      selection: 'publication_hashtags', text: '#Inne', replaceCurrentValue: '#AI',
    } as never), code('VALIDATION_ERROR'));
    // A publication run cannot apply script, title or priority.
    await assert.rejects(service.apply(actor, runId, {
      operationId: '06000000-0000-4000-8000-000000000006', expectedVersion: hashtags.version,
      selection: 'script', text: 'Obcy skrypt.',
    }), code('STALE_FACT_CLAIM'));
    await assert.rejects(service.apply(actor, runId, {
      operationId: '06000000-0000-4000-8000-000000000007', expectedVersion: hashtags.version,
      selection: 'title', text: 'Obcy tytuł',
    }), code('STALE_FACT_CLAIM'));
    assert.equal((await reelRow(db)).script, 'Stary skrypt.');
  } finally { await db.close(); }
});

test('an intervening target edit is protected and the proposal stays applicable after refresh', async () => {
  const { db, service } = await setup();
  try {
    const runId = await publicationRun(db, service, '07000000-0000-4000-8000-000000000001');
    // Another device writes hashtags between generation and application.
    await db.query("update app.reels set publication_hashtags='#ręczne',version=version+1 where id=$1", [reelId]);
    await assert.rejects(service.apply(actor, runId, {
      operationId: '07000000-0000-4000-8000-000000000002', expectedVersion: 2,
      selection: 'publication_hashtags', text: '#AI', replaceCurrentValue: '', confirmReplacement: true,
    }), code('EDIT_CONFLICT'));
    assert.equal((await reelRow(db)).publication_hashtags, '#ręczne');
    const replaced = await service.apply(actor, runId, {
      operationId: '07000000-0000-4000-8000-000000000003', expectedVersion: 2,
      selection: 'publication_hashtags', text: '#AI', replaceCurrentValue: '#ręczne', confirmReplacement: true,
    });
    assert.equal(replaced.publicationHashtags, '#AI');
  } finally { await db.close(); }
});

test('a script change, including edit-and-revert, invalidates publication application', async () => {
  const { db, service } = await setup();
  try {
    const runId = await publicationRun(db, service, '08000000-0000-4000-8000-000000000001');
    await db.query("update app.reels set script='Inny.',script_revision=script_revision+1,version=version+1 where id=$1", [reelId]);
    assert.equal((await service.get(actor, runId)).isStale, true);
    await assert.rejects(service.apply(actor, runId, {
      operationId: '08000000-0000-4000-8000-000000000002', expectedVersion: 2,
      selection: 'publication_description', text: 'Opis AI', replaceCurrentValue: '', confirmReplacement: true,
    }), code('STALE_PUBLICATION_RESULT'));
    await db.query("update app.reels set script='Stary skrypt.',script_revision=script_revision+1,version=version+1 where id=$1", [reelId]);
    assert.equal((await service.get(actor, runId)).isStale, true, 'revision detects edit-and-revert');
    await assert.rejects(service.apply(actor, runId, {
      operationId: '08000000-0000-4000-8000-000000000003', expectedVersion: 3,
      selection: 'publication_hashtags', text: '#AI', replaceCurrentValue: '', confirmReplacement: true,
    }), code('STALE_PUBLICATION_RESULT'));
    const row = await reelRow(db);
    assert.equal(row.publication_description, '');
    assert.equal(row.publication_hashtags, '');
    // An unrelated metadata change is ordinary version handling, not staleness.
    const fresh = await publicationRun(db, service, '08000000-0000-4000-8000-000000000004', 3);
    await db.query("update app.reels set priority='urgent',version=version+1 where id=$1", [reelId]);
    assert.equal((await service.get(actor, fresh)).isStale, false);
    const applied = await service.apply(actor, fresh, {
      operationId: '08000000-0000-4000-8000-000000000005', expectedVersion: 4,
      selection: 'publication_description', text: 'Opis AI', replaceCurrentValue: '', confirmReplacement: true,
    });
    assert.equal(applied.publicationDescription, 'Opis AI');
  } finally { await db.close(); }
});

test('publication apply replays a duplicate operation and refuses a changed payload', async () => {
  const { db, service } = await setup();
  try {
    const runId = await publicationRun(db, service, '09000000-0000-4000-8000-000000000001');
    const request = { operationId: '09000000-0000-4000-8000-000000000002', expectedVersion: 1,
      selection: 'publication_description' as const, text: 'Opis AI', replaceCurrentValue: '', confirmReplacement: true as const };
    const first = await service.apply(actor, runId, request);
    const replay = await service.apply(actor, runId, request);
    assert.equal(replay.version, first.version);
    assert.equal((await reelRow(db)).version, 2, 'a replay writes nothing');
    await assert.rejects(service.apply(actor, runId, { ...request, text: 'Inny opis' }), code('IDEMPOTENCY_CONFLICT'));
    const enqueue = { operationId: '09000000-0000-4000-8000-000000000003', expectedVersion: 2, action: 'generate_publication' as const };
    const queued = await service.enqueue(actor, reelId, enqueue);
    assert.equal((await service.enqueue(actor, reelId, enqueue)).id, queued.id);
    await assert.rejects(service.enqueue(actor, reelId, { ...enqueue, action: 'language_check' }), code('IDEMPOTENCY_CONFLICT'));
  } finally { await db.close(); }
});

test('legacy develop publication drafts stay readable, cannot be newly applied, and keep recorded replays', async () => {
  const { db, service } = await setup();
  try {
    await readyInput(db);
    const legacy = await service.enqueue(actor, reelId, {
      operationId: '0a000000-0000-4000-8000-000000000001', expectedVersion: 1, action: 'develop',
    });
    await db.query("update app.ai_runs set state='succeeded',result=$2,completed_at=now() where id=$1", [legacy.id, JSON.stringify(legacyDevelop)]);
    const read = await service.get(actor, legacy.id);
    assert.equal(read.action, 'develop');
    assert.equal((read.result as unknown as Record<string, unknown>).publicationDescriptionSuggestion, 'Opis z Opracuj', 'stored result is not rewritten');
    await assert.rejects(service.apply(actor, legacy.id, {
      operationId: '0a000000-0000-4000-8000-000000000002', expectedVersion: 1,
      selection: 'publication_description', text: 'Opis z Opracuj', replaceCurrentValue: '', confirmReplacement: true,
    }), (error: { code?: string; details?: { reason?: string } }) => error.code === 'VALIDATION_ERROR' && error.details?.reason === 'wrong_action');
    assert.equal((await reelRow(db)).publication_description, '');
    // An application recorded by the previous release still replays its outcome.
    const recorded = { operationId: '0a000000-0000-4000-8000-000000000003', expectedVersion: 1,
      selection: 'publication_hashtags' as const, text: '#stare', replaceCurrentValue: '', confirmReplacement: true as const };
    const outcome = { id: reelId, publicationHashtags: '#stare', version: 2 };
    await db.query('insert into app.operations(operation_id,actor_id,route,payload_hash,result) values($1,$2,$3,$4,$5)',
      [recorded.operationId, user, 'POST /ai-runs/:id/apply', payloadHash({ runId: legacy.id, ...recorded }), JSON.stringify(outcome)]);
    assert.deepEqual(await service.apply(actor, legacy.id, recorded), outcome);
    // Script application from Opracuj is unchanged and explicit.
    const applied = await service.apply(actor, legacy.id, {
      operationId: '0a000000-0000-4000-8000-000000000004', expectedVersion: 1, selection: 'script', text: 'Nowy skrypt.',
    });
    assert.equal(applied.script, 'Nowy skrypt.');
    assert.equal(applied.publicationDescription, '');
    assert.equal(applied.publicationHashtags, '');
  } finally { await db.close(); }
});

test('migration 0009 adds the action without touching historical runs', async () => {
  const staged = await mkdtemp(path.join(tmpdir(), 'szronox-migrations-'));
  const instance = new PGlite();
  const db = pgliteDatabase(instance);
  try {
    const all = (await readdir(defaultMigrationsDir())).filter((name) => name.endsWith('.sql')).sort();
    assert.ok(all.includes('0009_generate_publication_action.sql'));
    for (const name of all.filter((name) => name < '0009')) await copyFile(path.join(defaultMigrationsDir(), name), path.join(staged, name));
    await migrate(db, staged);
    await db.query("insert into app.users(id,name) values($1,'NOXAVA')", [user]);
    await db.query('insert into app.reels(id,original_input,created_by) values($1,$2,$3)', [reelId, JSON.stringify({ text: 'x', images: [] }), user]);
    const insert = (id: string, action: string, state = 'queued', result: unknown = null) => db.query(
      `insert into app.ai_runs(id,reel_id,requested_by,action,state,input_snapshot,input_hash,model,prompt_id,prompt_stage,result,completed_at)
       values($1,$2,$3,$4,$5,'{}'::jsonb,$6,'m','p','development_provisional',$7,case when $5='succeeded' then now() end)`,
      [id, reelId, user, action, state, 'a'.repeat(64), result === null ? null : JSON.stringify(result)]);
    await assert.rejects(insert('0b000000-0000-4000-8000-000000000001', 'generate_publication'), 'the previous schema refuses the action');
    await insert('0b000000-0000-4000-8000-000000000002', 'develop', 'succeeded', legacyDevelop);
    const before = await db.query('select * from app.ai_runs order by id');
    // Staged up to 0009 only, so later migrations do not change what this test is about.
    await copyFile(path.join(defaultMigrationsDir(), '0009_generate_publication_action.sql'), path.join(staged, '0009_generate_publication_action.sql'));
    const applied = await migrate(db, staged);
    assert.deepEqual(applied.filter((item) => !item.alreadyApplied).map((item) => item.name), ['0009_generate_publication_action.sql']);
    assert.deepEqual((await db.query('select * from app.ai_runs order by id')).rows, before.rows, 'historical rows unchanged');
    await insert('0b000000-0000-4000-8000-000000000003', 'generate_publication');
    await assert.rejects(insert('0b000000-0000-4000-8000-000000000004', 'invented_action'));
    // Every action the previous release writes is still accepted.
    for (const [index, action] of ['develop', 'generate_hooks', 'fact_check', 'language_check', 'find_programme'].entries()) {
      await insert(`0b000000-0000-4000-8000-00000000001${index}`, action);
    }
    const constraints = await db.query<{ conname: string }>(
      "select conname from pg_constraint where conrelid='app.ai_runs'::regclass and contype='c' and pg_get_constraintdef(oid) like '%action%'");
    assert.deepEqual(constraints.rows.map((row) => row.conname), ['ai_runs_action_check'], 'exactly one action constraint');
    assert.equal((await migrate(db, staged)).every((item) => item.alreadyApplied), true);
  } finally { await db.close(); await rm(staged, { recursive: true, force: true }); }
});

test('fact corrections remap separate claims and reject a second claim in the edited sentence', async () => {
  const { db, service } = await setup();
  try {
    await readyInput(db);
    const script = 'Pierwsza liczba 10. Druga liczba 20.';
    await db.query('update app.reels set script=$2 where id=$1', [reelId, script]);
    const start = await service.enqueue(actor, reelId, {
      operationId: '01000000-0000-4000-8000-000000000001', expectedVersion: 1, action: 'fact_check',
    });
    const snapshot = await service.get(actor, start.id);
    const first = claim('01000000-0000-4000-8000-000000000011', script, '10', '11', snapshot.inputHash);
    const second = claim('01000000-0000-4000-8000-000000000012', script, '20', '21', snapshot.inputHash);
    const overlapping = claim('01000000-0000-4000-8000-000000000013', script, 'liczba 10', 'liczba 12', snapshot.inputHash);
    await db.query("update app.ai_runs set state='succeeded',result=$2,completed_at=now() where id=$1", [start.id,
      JSON.stringify({ coverage: 'complete', claims: [first, second, overlapping], sources: [], warnings: [] })]);
    const afterFirst = await service.apply(actor, start.id, {
      operationId: '01000000-0000-4000-8000-000000000021', expectedVersion: 1,
      selection: 'fact_correction', claimId: first.id,
    });
    assert.equal(afterFirst.script, 'Pierwsza liczba 11. Druga liczba 20.');
    const checked = await service.get(actor, start.id);
    if (checked.action !== 'fact_check' || !checked.result) throw new Error('Expected fact result');
    assert.deepEqual(checked.result.claims.map((item) => item.isStale), [true, false, true]);
    await assert.rejects(service.apply(actor, start.id, {
      operationId: '01000000-0000-4000-8000-000000000022', expectedVersion: 2,
      selection: 'fact_correction', claimId: overlapping.id,
    }), (error: { code?: string }) => error.code === 'STALE_FACT_CLAIM');
    const afterSecond = await service.apply(actor, start.id, {
      operationId: '01000000-0000-4000-8000-000000000023', expectedVersion: 2,
      selection: 'fact_correction', claimId: second.id,
    });
    assert.equal(afterSecond.script, 'Pierwsza liczba 11. Druga liczba 21.');
    assert.equal(afterSecond.scriptRevision, 2);
  } finally { await db.close(); }
});

test('language result rejects edit-and-revert and a no-op apply leaves script revision unchanged', async () => {
  const { db, service } = await setup();
  try {
    await readyInput(db);
    const run = await successfulRun(db, service, 'language_check', { scriptSuggestion: 'Lepszy skrypt.', notes: [] },
      '02000000-0000-4000-8000-000000000001');
    const unchanged = await service.apply(actor, run.id, {
      operationId: '02000000-0000-4000-8000-000000000002', expectedVersion: 1,
      selection: 'language_version', version: 'A', text: 'Stary skrypt.',
    });
    assert.equal(unchanged.scriptRevision, 0);
    await db.query("update app.reels set script='Edited.',script_revision=script_revision+1,version=version+1 where id=$1", [reelId]);
    await db.query("update app.reels set script='Stary skrypt.',script_revision=script_revision+1,version=version+1 where id=$1", [reelId]);
    await assert.rejects(service.apply(actor, run.id, {
      operationId: '02000000-0000-4000-8000-000000000003', expectedVersion: 4,
      selection: 'language_version', version: 'B', text: 'Lepszy skrypt.',
    }), (error: { code?: string }) => error.code === 'STALE_LANGUAGE_RESULT');
  } finally { await db.close(); }
});

test('no-match result retains an existing programme attachment', async () => {
  const { db, service } = await setup();
  try {
    await readyInput(db);
    await activeRelease(db);
    const run = await successfulRun(db, service, 'find_programme', { candidates: [] },
      '03000000-0000-4000-8000-000000000002');
    const attachment = { candidateId: '03000000-0000-4000-8000-000000000003', proposal: 'Saved proposition' };
    await db.query("update app.reels set programme_state='matched',programme_attachment=$2 where id=$1", [reelId, JSON.stringify(attachment)]);
    await assert.rejects(service.apply(actor, run.id, {
      operationId: '03000000-0000-4000-8000-000000000004', expectedVersion: 1,
      selection: 'programme_no_match',
    }), (error: { code?: string }) => error.code === 'VALIDATION_ERROR');
    const saved = await db.query<{ programme_attachment: unknown }>('select programme_attachment from app.reels where id=$1', [reelId]);
    assert.deepEqual(saved.rows[0].programme_attachment, attachment);
    await db.query("update app.reels set programme_state='unchecked',programme_attachment=null where id=$1", [reelId]);
    const noMatch = await service.apply(actor, run.id, {
      operationId: '03000000-0000-4000-8000-000000000005', expectedVersion: 1,
      selection: 'programme_no_match',
    });
    assert.equal(noMatch.programmeState, 'no_match');
    assert.equal(noMatch.programmeDocumentVersionId, null);
  } finally { await db.close(); }
});

test('operation replay is scoped to actor and route', async () => {
  const { db, service } = await setup();
  try {
    await readyInput(db);
    const operationId = '04000000-0000-4000-8000-000000000001';
    const body = { operationId, expectedVersion: 1, action: 'develop' as const };
    await service.enqueue(actor, reelId, body);
    await assert.rejects(service.enqueue({ id: '04000000-0000-4000-8000-000000000002', name: 'NOXAVA' }, reelId, body),
      (error: { code?: string }) => error.code === 'IDEMPOTENCY_CONFLICT');
    await assert.rejects(service.apply(actor, operationId, {
      operationId, expectedVersion: 1, selection: 'title', text: 'A',
    }), (error: { code?: string }) => error.code === 'IDEMPOTENCY_CONFLICT');
  } finally { await db.close(); }
});

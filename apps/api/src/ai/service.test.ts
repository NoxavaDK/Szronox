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

/** VOICE-01: a minimal extra Reel, for style-example selection tests. */
async function insertReel(db: Awaited<ReturnType<typeof setup>>['db'], id: string, overrides: {
  status?: string; script?: string; format?: string; absorbedInto?: string | null;
  publicationDescription?: string; deletedAt?: string | null; updatedAt?: string;
} = {}): Promise<void> {
  const opts = {
    status: 'to_record', script: 'Przykładowy skrypt.', format: 'reel', absorbedInto: null,
    publicationDescription: '', deletedAt: null, updatedAt: new Date().toISOString(), ...overrides,
  };
  await db.query(
    `insert into app.reels (id, status, script, original_input, created_by, format, absorbed_into,
                             publication_description, deleted_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, opts.status, opts.script, JSON.stringify({ text: 'x', images: [] }), user, opts.format,
      opts.absorbedInto, opts.publicationDescription, opts.deletedAt, opts.updatedAt],
  );
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
    assert.equal(run.promptId, 'gemini-02-development-provisional-v4');
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

test('new generate_publication snapshots versioned grounded context and ignores incomplete uploads', async () => {
  const { db, service } = await setup();
  try {
    // The input image is still pending: irrelevant to a script-based action.
    const queued = await service.enqueue(actor, reelId, {
      operationId: '05000000-0000-4000-8000-000000000001', expectedVersion: 1, action: 'generate_publication',
    });
    const stored = await db.query<{ action: string; prompt_id: string; input_snapshot: { script: string; scriptRevision: number; publicationContextVersion?: number; imageObjects: unknown[] } }>(
      'select action,input_snapshot,prompt_id from app.ai_runs where id=$1', [queued.id]);
    assert.equal(stored.rows[0].action, 'generate_publication');
    assert.equal(stored.rows[0].input_snapshot.script, 'Stary skrypt.');
    assert.equal(stored.rows[0].input_snapshot.scriptRevision, 0);
    assert.equal(stored.rows[0].input_snapshot.publicationContextVersion, 3);
    assert.equal(stored.rows[0].prompt_id, 'gemini-02-publication-provisional-v4');
    // v3 may read completed capture images; a pending one is neither snapshotted nor a blocker.
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

test('PUBLICATION-02 freshness follows selected hook and eligible saved text, not unrelated metadata', async () => {
  const { db, service } = await setup();
  const hookId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc';
  try {
    await db.query('insert into app.reel_hooks(id,reel_id,text,source,position) values($1,$2,$3,$4,0)',
      [hookId, reelId, 'Wybrany hook', 'user']);
    await db.query('update app.reels set selected_hook_id=$2,original_input=$3,input_note=$4 where id=$1', [reelId,
      hookId, JSON.stringify({ text: 'Przechwycony tekst', additionalText: 'Dodatkowy tekst', url: 'https://example.invalid', images: [],
        originalShare: { fields: [{ name: 'title', value: 'Tytuł' }, { name: 'text', value: 'Tekst z udostępnienia' }], files: [] } }), 'Notatka']);
    const runId = await publicationRun(db, service, '05100000-0000-4000-8000-000000000001');
    const stored = await db.query<{ input_snapshot: { publicationContextVersion: number; inputNote: string; selectedHookId: string; hooks: Array<{ id: string; text: string }>; originalInput: { url?: string } } }>(
      'select input_snapshot from app.ai_runs where id=$1', [runId]);
    const snapshot = stored.rows[0].input_snapshot;
    assert.equal(snapshot.publicationContextVersion, 3);
    assert.equal(snapshot.selectedHookId, hookId);
    assert.ok(snapshot.hooks.some((hook) => hook.id === hookId && hook.text === 'Wybrany hook'));
    assert.deepEqual(snapshot.originalInput, {
      text: 'Przechwycony tekst', additionalText: 'Dodatkowy tekst', url: 'https://example.invalid', images: [],
      originalShare: { fields: [{ name: 'title', value: 'Tytuł' }, { name: 'text', value: 'Tekst z udostępnienia' }], files: [] },
    });
    assert.equal(stored.rows[0].input_snapshot.inputNote, 'Notatka');
    assert.equal((await service.get(actor, runId)).isStale, false);

    await db.query("update app.reels set priority='urgent',version=version+1 where id=$1", [reelId]);
    assert.equal((await service.get(actor, runId)).isStale, false);
    // Unrelated metadata: title, editing notes, planning and cover never stale publication copy.
    await db.query("update app.reels set title='Nowy tytuł',editing_notes='Uwagi',feed_cover_done=true,version=version+1 where id=$1", [reelId]);
    assert.equal((await service.get(actor, runId)).isStale, false);
    await db.query("update app.reels set input_note='Zmiana notatki',version=version+1 where id=$1", [reelId]);
    assert.equal((await service.get(actor, runId)).isStale, true);
    await assert.rejects(service.apply(actor, runId, {
      operationId: '05100000-0000-4000-8000-000000000002', expectedVersion: 4,
      selection: 'publication_description', text: 'Opis AI', replaceCurrentValue: '', confirmReplacement: true,
    }), code('STALE_PUBLICATION_RESULT'));
  } finally { await db.close(); }
});

test('PUBLICATION-02 selected-hook identity, text edits and deletion stale a proposal', async () => {
  const { db, service } = await setup();
  const firstHook = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
  const nextHook = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  try {
    await db.query('insert into app.reel_hooks(id,reel_id,text,source,position) values($1,$3,$4,$5,0),($2,$3,$6,$5,1)',
      [firstHook, nextHook, reelId, 'Hook pierwszy', 'user', 'Hook następny']);
    await db.query('update app.reels set selected_hook_id=$2 where id=$1', [reelId, firstHook]);

    const selectionRun = await publicationRun(db, service, '05200000-0000-4000-8000-000000000001');
    await db.query('update app.reels set selected_hook_id=$2,version=version+1 where id=$1', [reelId, nextHook]);
    assert.equal((await service.get(actor, selectionRun)).isStale, true, 'changing to another valid hook ID stales');
    await assert.rejects(service.apply(actor, selectionRun, {
      operationId: '05200000-0000-4000-8000-000000000002', expectedVersion: 2,
      selection: 'publication_description', text: 'Opis AI', replaceCurrentValue: '', confirmReplacement: true,
    }), code('STALE_PUBLICATION_RESULT'));

    const editRun = await publicationRun(db, service, '05200000-0000-4000-8000-000000000003', 2);
    await db.query("update app.reel_hooks set text='Hook zmieniony' where id=$1", [nextHook]);
    await db.query('update app.reels set version=version+1 where id=$1', [reelId]);
    assert.equal((await service.get(actor, editRun)).isStale, true, 'selected hook text is exact freshness input');
    await assert.rejects(service.apply(actor, editRun, {
      operationId: '05200000-0000-4000-8000-000000000004', expectedVersion: 3,
      selection: 'publication_hashtags', text: '#AI', replaceCurrentValue: '', confirmReplacement: true,
    }), code('STALE_PUBLICATION_RESULT'));

    const deleteRun = await publicationRun(db, service, '05200000-0000-4000-8000-000000000005', 3);
    await db.query('delete from app.reel_hooks where id=$1', [nextHook]);
    assert.equal((await service.get(actor, deleteRun)).isStale, true, 'deleting the selected hook clears selection and stales');
    await assert.rejects(service.apply(actor, deleteRun, {
      operationId: '05200000-0000-4000-8000-000000000006', expectedVersion: 3,
      selection: 'publication_description', text: 'Opis AI', replaceCurrentValue: '', confirmReplacement: true,
    }), code('STALE_PUBLICATION_RESULT'));

    const newHookRun = await publicationRun(db, service, '05200000-0000-4000-8000-000000000007', 3);
    const addedHook = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3';
    await db.query('insert into app.reel_hooks(id,reel_id,text,source,position) values($1,$2,$3,$4,2)',
      [addedHook, reelId, 'Nowy hook po wygenerowaniu', 'user']);
    await db.query('update app.reels set selected_hook_id=$2,version=version+1 where id=$1', [reelId, addedHook]);
    assert.equal((await service.get(actor, newHookRun)).isStale, true, 'selecting a newly added hook stales even though it was absent from the run snapshot');
    await assert.rejects(service.apply(actor, newHookRun, {
      operationId: '05200000-0000-4000-8000-000000000008', expectedVersion: 4,
      selection: 'publication_description', text: 'Opis AI', replaceCurrentValue: '', confirmReplacement: true,
    }), code('STALE_PUBLICATION_RESULT'));
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

// ── VOICE-01: style-example selection, exactly per T00 ──────────────────────────────────────

test('VOICE-01 style examples exclude idea/deleted/absorbed/stream/empty-script Reels, the run\'s own Reel, and are selected only for develop/generate_hooks/generate_publication', async () => {
  const { db, service } = await setup();
  try {
    await readyInput(db);
    // Otherwise-eligible, to prove the run's own Reel never becomes its own example.
    await db.query("update app.reels set status='ready', script=$2 where id=$1", [reelId, 'Własny skrypt.']);
    const ids = {
      idea: '10000000-0000-4000-8000-000000000001', deleted: '10000000-0000-4000-8000-000000000002',
      absorbed: '10000000-0000-4000-8000-000000000003', stream: '10000000-0000-4000-8000-000000000004',
      emptyScript: '10000000-0000-4000-8000-000000000005', eligible: '10000000-0000-4000-8000-000000000006',
    };
    await insertReel(db, ids.idea, { status: 'idea', script: 'Pomysł.' });
    await insertReel(db, ids.deleted, { status: 'ready', script: 'Usunięty.', deletedAt: new Date().toISOString() });
    await insertReel(db, ids.absorbed, { status: 'to_record', script: 'Wchłonięty.', absorbedInto: reelId });
    await insertReel(db, ids.stream, { status: 'to_record', script: 'Stream.', format: 'stream' });
    await insertReel(db, ids.emptyScript, { status: 'ready', script: '   ' });
    await insertReel(db, ids.eligible, { status: 'published', script: 'Opublikowany materiał.' });

    const develop = await service.enqueue(actor, reelId, {
      operationId: '10000000-0000-4000-8000-00000000000a', expectedVersion: 1, action: 'develop',
    });
    const snapshotOf = async (runId: string) => (await db.query<{ input_snapshot: { styleExamples?: Array<{ reelId: string }> } }>(
      'select input_snapshot from app.ai_runs where id=$1', [runId])).rows[0].input_snapshot;
    assert.deepEqual((await snapshotOf(develop.id)).styleExamples?.map((example) => example.reelId), [ids.eligible]);

    // fact_check, language_check and find_programme are not among the three style-example actions.
    const factCheck = await service.enqueue(actor, reelId, {
      operationId: '10000000-0000-4000-8000-00000000000b', expectedVersion: 1, action: 'fact_check',
    });
    assert.equal((await snapshotOf(factCheck.id)).styleExamples, undefined);
  } finally { await db.close(); }
});

test('VOICE-01 hook fallback: selected hook wins, else the single user hook, else null when ambiguous or absent', async () => {
  const { db, service } = await setup();
  try {
    await readyInput(db);
    const ids = {
      noHook: '11000000-0000-4000-8000-000000000001', selectedAi: '11000000-0000-4000-8000-000000000002',
      singleUser: '11000000-0000-4000-8000-000000000003', multiUser: '11000000-0000-4000-8000-000000000004',
    };
    await insertReel(db, ids.noHook, { status: 'to_record', script: 'Bez hooka.' });
    await insertReel(db, ids.selectedAi, { status: 'editing', script: 'Z wybranym hookiem AI.' });
    await insertReel(db, ids.singleUser, { status: 'ready', script: 'Jeden hook zespołu.' });
    await insertReel(db, ids.multiUser, { status: 'ready', script: 'Dwa hooki zespołu.' });

    const aiHookId = '11000000-0000-4000-8000-000000000012';
    await db.query('insert into app.reel_hooks(id,reel_id,text,source,position) values($1,$2,$3,$4,0)',
      [aiHookId, ids.selectedAi, 'Hook AI wybrany', 'ai']);
    await db.query('update app.reels set selected_hook_id=$2 where id=$1', [ids.selectedAi, aiHookId]);

    await db.query('insert into app.reel_hooks(id,reel_id,text,source,position) values($1,$2,$3,$4,0)',
      ['11000000-0000-4000-8000-000000000013', ids.singleUser, 'Jedyny hook zespołu', 'user']);

    await db.query('insert into app.reel_hooks(id,reel_id,text,source,position) values($1,$3,$4,$5,0),($2,$3,$6,$5,1)',
      ['11000000-0000-4000-8000-000000000014', '11000000-0000-4000-8000-000000000015', ids.multiUser,
        'Pierwszy hook zespołu', 'user', 'Drugi hook zespołu']);

    const run = await service.enqueue(actor, reelId, {
      operationId: '11000000-0000-4000-8000-00000000000a', expectedVersion: 1, action: 'develop',
    });
    const stored = await db.query<{ input_snapshot: { styleExamples?: Array<{ reelId: string; hook: string | null }> } }>(
      'select input_snapshot from app.ai_runs where id=$1', [run.id]);
    const byId = new Map((stored.rows[0].input_snapshot.styleExamples ?? []).map((example) => [example.reelId, example.hook]));
    assert.equal(byId.get(ids.noHook), null, 'no hooks at all');
    assert.equal(byId.get(ids.selectedAi), 'Hook AI wybrany', 'selected hook wins even when AI-sourced');
    assert.equal(byId.get(ids.singleUser), 'Jedyny hook zespołu', 'falls back to the only team-written hook');
    assert.equal(byId.get(ids.multiUser), null, 'two team-written hooks with no selection is ambiguous');
  } finally { await db.close(); }
});

test('VOICE-01 scriptExcerpt and description are cut at exactly 600 characters', async () => {
  const { db, service } = await setup();
  try {
    await readyInput(db);
    const longScript = 'A'.repeat(700);
    const longDescription = 'B'.repeat(700);
    await insertReel(db, '12000000-0000-4000-8000-000000000001', {
      status: 'ready', script: longScript, publicationDescription: longDescription,
    });
    const run = await service.enqueue(actor, reelId, {
      operationId: '12000000-0000-4000-8000-00000000000a', expectedVersion: 1, action: 'develop',
    });
    const stored = await db.query<{ input_snapshot: { styleExamples?: Array<{ scriptExcerpt: string; description: string }> } }>(
      'select input_snapshot from app.ai_runs where id=$1', [run.id]);
    const example = stored.rows[0].input_snapshot.styleExamples?.[0];
    assert.equal(example?.scriptExcerpt.length, 600);
    assert.equal(example?.description.length, 600);
    assert.equal(example?.scriptExcerpt, 'A'.repeat(600));
    assert.equal(example?.description, 'B'.repeat(600));
  } finally { await db.close(); }
});

test('VOICE-01 selects at most 8 examples, newest updated_at first', async () => {
  const { db, service } = await setup();
  try {
    await readyInput(db);
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    const ids: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const id = `13000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      ids.push(id);
      await insertReel(db, id, {
        status: 'to_record', script: `Skrypt numer ${index}.`,
        updatedAt: new Date(base + index * 60_000).toISOString(),
      });
    }
    const run = await service.enqueue(actor, reelId, {
      operationId: '13000000-0000-4000-8000-00000000000a', expectedVersion: 1, action: 'develop',
    });
    const stored = await db.query<{ input_snapshot: { styleExamples?: Array<{ reelId: string }> } }>(
      'select input_snapshot from app.ai_runs where id=$1', [run.id]);
    const selected = stored.rows[0].input_snapshot.styleExamples ?? [];
    assert.equal(selected.length, 8);
    // Newest updated_at first: the 8 most recently inserted (highest index), descending.
    assert.deepEqual(selected.map((example) => example.reelId), [...ids].reverse().slice(0, 8));
  } finally { await db.close(); }
});

test('VOICE-01: styleExamples never enters inputHash or isStale; editing another Reel does not stale an existing run or change a new run\'s hash for the same Reel input', async () => {
  const { db, service } = await setup();
  try {
    await readyInput(db);
    const exampleId = '14000000-0000-4000-8000-000000000001';
    await insertReel(db, exampleId, { status: 'ready', script: 'Pierwotny skrypt przykładu.' });

    const first = await service.enqueue(actor, reelId, {
      operationId: '14000000-0000-4000-8000-00000000000a', expectedVersion: 1, action: 'develop',
    });
    const firstRow = (await db.query<{ input_hash: string }>('select input_hash from app.ai_runs where id=$1', [first.id])).rows[0];
    const firstSnapshot = (await db.query<{ input_snapshot: { styleExamples?: Array<{ reelId: string; scriptExcerpt: string }> } }>(
      'select input_snapshot from app.ai_runs where id=$1', [first.id])).rows[0].input_snapshot;
    assert.equal(firstSnapshot.styleExamples?.[0]?.scriptExcerpt, 'Pierwotny skrypt przykładu.');
    assert.equal((await service.get(actor, first.id)).isStale, false);

    // Edit the OTHER Reel: its example content changes, but nothing about the main Reel's own
    // relevant input (script, hooks, etc.) changes.
    await db.query('update app.reels set script=$2, version=version+1, updated_at=now() where id=$1',
      [exampleId, 'Zupełnie inny skrypt przykładu.']);

    assert.equal((await service.get(actor, first.id)).isStale, false, 'editing another Reel never stales this run');

    const second = await service.enqueue(actor, reelId, {
      operationId: '14000000-0000-4000-8000-00000000000b', expectedVersion: 1, action: 'develop',
    });
    const secondRow = (await db.query<{ input_hash: string }>('select input_hash from app.ai_runs where id=$1', [second.id])).rows[0];
    const secondSnapshot = (await db.query<{ input_snapshot: { styleExamples?: Array<{ reelId: string; scriptExcerpt: string }> } }>(
      'select input_snapshot from app.ai_runs where id=$1', [second.id])).rows[0].input_snapshot;
    // The example content really did change in the new snapshot...
    assert.equal(secondSnapshot.styleExamples?.[0]?.scriptExcerpt, 'Zupełnie inny skrypt przykładu.');
    // ...yet the hash for the same main-Reel input is identical, because styleExamples never
    // enters the canonical relevant-input representation.
    assert.equal(secondRow.input_hash, firstRow.input_hash);
  } finally { await db.close(); }
});

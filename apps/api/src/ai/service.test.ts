import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgliteDatabase } from '../db/client.js';
import { migrate } from '../db/migrate.js';
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
  } finally { await db.close(); }
});

test('publication application requires explicit current-value confirmation after a changed saved field', async () => {
  const { db, service } = await setup();
  try {
    await readyInput(db);
    const run = await service.enqueue(actor, reelId, {
      operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', expectedVersion: 1, action: 'develop',
    });
    await db.query(`update app.ai_runs set state='succeeded',result=$2,completed_at=now() where id=$1`, [run.id,
      JSON.stringify({ titleSuggestion: 'Tytuł', eventSummary: 'Podsumowanie', verificationIssues: [], hookAdditions: [],
        scriptSuggestion: 'Nowy skrypt.', publicationDescriptionSuggestion: 'Opis AI', publicationHashtagsSuggestion: '#AI',
        possibleProgrammeConnection: null, prioritySuggestion: null, memeSuggestion: null })]);
    await db.query("update app.reels set publication_description='Opis użytkownika',version=2 where id=$1", [reelId]);
    await assert.rejects(service.apply(actor, run.id, {
      operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', expectedVersion: 2,
      selection: 'publication_description', text: 'Opis AI', replaceCurrentValue: '', confirmReplacement: true,
    }), (error: { code?: string }) => error.code === 'EDIT_CONFLICT');
    const value = await db.query<{ publication_description: string }>('select publication_description from app.reels where id=$1', [reelId]);
    assert.equal(value.rows[0].publication_description, 'Opis użytkownika');
    const saved = await service.apply(actor, run.id, {
      operationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', expectedVersion: 2,
      selection: 'publication_description', text: 'Opis AI', replaceCurrentValue: 'Opis użytkownika', confirmReplacement: true,
    });
    assert.equal(saved.publicationDescription, 'Opis AI');
    assert.equal(saved.version, 3);
  } finally { await db.close(); }
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

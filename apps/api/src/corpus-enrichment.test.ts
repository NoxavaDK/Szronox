/**
 * CORPUS-02: narrowly-scoped enrichment revisions (migration 0007).
 *
 * Two properties are under test, both at the database level and not only through the
 * application code that happens to respect them:
 *
 *   - `reviseProposalEnrichment` can change primary_tag/secondary_tags/keywords, validates
 *     the new tags against the release's *pinned* vocabulary snapshot, and writes an
 *     append-only revision row — while every other column (identity, text, pages, category,
 *     section) stays byte-for-byte unchanged.
 *   - The database itself refuses a raw UPDATE that touches any column outside that narrow
 *     set, even one issued directly against `app.programme_proposals` and not through the
 *     repository function — proving the guard lives in the trigger, not in application
 *     discipline alone.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { PGlite } from '@electric-sql/pglite';

import { loadBundle } from './ai/corpus/bundle.js';
import {
  activateRelease, approveRelease, CorpusError, importRelease, resolveActiveRelease, reviseProposalEnrichment,
} from './ai/corpus/repository.js';
import { findEvidence } from './ai/corpus/retrieval.js';
import { validateBundle } from './ai/corpus/validate.js';
import { pgliteDatabase, type Database } from './db/client.js';
import { migrate } from './db/migrate.js';

/* ── A minimal, real, ASCII-only PDF (one page, one proposal) ──────────────────── */

function buildPdf(pages: readonly string[][]): Buffer {
  const objects: string[] = [];
  const add = (body: string): number => { objects.push(body); return objects.length; };
  const catalogNumber = 1;
  const pagesNumber = 2;
  const fontNumber = 3;
  objects.push('', '', '');
  const escape = (line: string): string => line.replace(/[\\()]/g, (character) => `\\${character}`);
  const pageNumbers: number[] = [];
  for (const lines of pages) {
    const content = [
      'BT', '/F1 12 Tf', '14 TL', '1 0 0 1 50 760 Tm',
      ...lines.map((line) => `(${escape(line)}) Tj T*`),
      'ET',
    ].join('\n');
    const contentNumber = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    pageNumbers.push(add(`<< /Type /Page /Parent ${pagesNumber} 0 R /MediaBox [0 0 595 842] `
      + `/Resources << /Font << /F1 ${fontNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>`));
  }
  objects[catalogNumber - 1] = `<< /Type /Catalog /Pages ${pagesNumber} 0 R >>`;
  objects[pagesNumber - 1] = `<< /Type /Pages /Count ${pageNumbers.length} `
    + `/Kids [ ${pageNumbers.map((number) => `${number} 0 R`).join(' ')} ] >>`;
  objects[fontNumber - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNumber} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

const PROPOSAL_TEXT = 'Postulat: tani bilet kolejowy. Chcemy wprowadzic wspolny bilet aglomeracyjny.';
const PAGES = [
  ['TRANSPORT', 'Wprowadzenie do transportu.'],
  ['KOLEJ', PROPOSAL_TEXT],
];

const VOCABULARY = {
  vocabulary_id: 'cat-vocab-enrichment-test',
  entries: [
    { id: 'transport', label: 'Transport', definition: 'Kolej, transport zbiorowy i mobilnosc.' },
    { id: 'kolej', label: 'Kolej', definition: 'Transport kolejowy.' },
    { id: 'samorzad', label: 'Samorzad', definition: 'Wladze lokalne.' },
    { id: 'nieznany', label: 'Nieznany', definition: 'Nieuzywany w tym wydaniu.' },
  ],
};

interface AdmissionOverride {
  adoptedAt: string | null;
  admissionAmendment: Record<string, unknown> | null;
}

async function writeBundle(admission?: AdmissionOverride): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'szronox-enrichment-'));
  const pdf = buildPdf(PAGES);
  const manifest = {
    corpus_id: 'zieloni-programme-enrichment-test',
    release_id: 'zieloni-programme-enrichment-test-r1',
    release_label: 'Program Zielonych — fixture wzbogacania',
    category_vocabulary_id: 'cat-vocab-enrichment-test',
    imported_by: 'NOXAVA',
    expected_proposal_count: 1,
    document: {
      document_id: 'doc-program-zielonych-enrichment-test',
      title: 'Program Partii Zieloni',
      document_type: 'programme',
      issuing_body: 'Partia Zieloni',
      admission_rationale: 'Program przyjety przez Kongres partii.',
      admission_amendment: admission?.admissionAmendment ?? null,
    },
    version: {
      document_version_id: 'dv-program-zielonych-enrichment-test-r1',
      source_title: 'Program Partii Zieloni (fixture)',
      edition: 'wydanie testowe',
      adopted_at: admission ? admission.adoptedAt : '2026-01-17',
      language: 'pl',
      source_file_name: 'EnrichmentTest.pdf',
      structure_file_name: 'EnrichmentTest.docx',
      dataset_file_name: 'proposals.json',
      source_url: 'https://example.org/enrichment-fixture.pdf',
      source_sha256: createHash('sha256').update(pdf).digest('hex'),
      retrieved_at: '2026-09-20T00:00:00.000Z',
      page_count: 2,
      printed_page_labels: ['', '3'],
      structure_coverage: 'full',
    },
    ingestion: {
      ingested_by: 'NOXAVA',
      normalization_profile_id: 'szronox-normalization-1',
      punctuation_map: {},
      chunking: { target_chars: 200, max_chars: 900, min_chars: 50, overlap: 'none' },
      structure_source: 'operator_declared',
      excluded_ranges: [],
      header_footer: { drop_exact_lines: [], drop_printed_page_label_lines: false },
      category_from_primary_tag: true,
      notes: 'Fixture bundle.',
    },
  };
  const record = {
    proposal_id: 'prop-kolej-01', section_id: 'sec-kolej', chapter: 'TRANSPORT', subchapter: null,
    order_index: 0, title: 'Postulat: tani bilet kolejowy.', text: PROPOSAL_TEXT,
    primary_tag: 'transport', secondary_tags: ['kolej'], keywords: ['bilet aglomeracyjny'], pdf_page: 2,
  };
  const ledger = {
    pages: [
      { pdf_page: 1, status: 'excluded', reason: 'wprowadzenie' },
      { pdf_page: 2, status: 'indexed', proposal_ids: ['prop-kolej-01'] },
    ],
    sections: [{ section_id: 'sec-kolej', status: 'indexed' }],
  };
  await writeFile(path.join(directory, 'EnrichmentTest.pdf'), pdf);
  await writeFile(path.join(directory, 'EnrichmentTest.docx'), Buffer.from('opaque', 'latin1'));
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await writeFile(path.join(directory, 'vocabulary.json'), JSON.stringify(VOCABULARY, null, 2), 'utf8');
  await writeFile(path.join(directory, 'proposals.json'), JSON.stringify({ records: [record] }, null, 2), 'utf8');
  await writeFile(path.join(directory, 'coverage.json'), JSON.stringify(ledger, null, 2), 'utf8');
  return directory;
}

async function database(): Promise<{ db: Database; close(): Promise<void> }> {
  const instance = new PGlite();
  const db = pgliteDatabase(instance);
  await migrate(db);
  return { db, close: () => instance.close() };
}

/** Import, approve and activate the fixture bundle; returns the release slug and db. */
async function activatedFixture() {
  const directory = await writeBundle();
  const { db, close } = await database();
  const bundle = await loadBundle(directory);
  const sourceBytes = await readFile(bundle.source.absolutePath);
  const structureBytes = await readFile(bundle.structure.absolutePath);
  const datasetBytes = await readFile(bundle.dataset.absolutePath);
  const validation = validateBundle(bundle, sourceBytes);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues));
  const archiveRoot = await mkdtemp(path.join(tmpdir(), 'szronox-enrichment-archive-'));
  await importRelease(db, bundle, validation, { archiveRoot, sourceBytes, structureBytes, datasetBytes });
  await approveRelease(db, bundle.manifest.releaseId, 'Operator Testowy');
  await activateRelease(db, bundle.manifest.releaseId, { archiveRoot });
  return {
    db, close, directory, archiveRoot, releaseSlug: bundle.manifest.releaseId,
    externalId: 'prop-kolej-01',
  };
}

test('reviseProposalEnrichment changes only enrichment fields, and writes an audit revision', async () => {
  const fixture = await activatedFixture();
  try {
    const before = await fixture.db.query<{
      id: string; category: string; exact_text: string; pdf_pages: number[]; section_id: string; title: string;
    }>('select id, category, exact_text, pdf_pages, section_id, title from app.programme_proposals where external_id=$1',
      [fixture.externalId]);

    const outcome = await reviseProposalEnrichment(fixture.db, {
      releaseSlug: fixture.releaseSlug,
      externalId: fixture.externalId,
      primaryTag: 'kolej',
      secondaryTags: ['transport', 'samorzad'],
      keywords: ['bilet metropolitalny', 'rozklad jazdy'],
      operator: 'Operator Rewizyjny',
    });
    assert.equal(outcome.revisionNumber, 1);

    const after = await fixture.db.query<{
      id: string; category: string; exact_text: string; pdf_pages: number[]; section_id: string; title: string;
      primary_tag: string; secondary_tags: string[]; keywords: string[];
    }>(`select id, category, exact_text, pdf_pages, section_id, title, primary_tag, secondary_tags, keywords
          from app.programme_proposals where external_id=$1`, [fixture.externalId]);

    assert.equal(after.rows[0].id, before.rows[0].id);
    assert.equal(after.rows[0].category, before.rows[0].category);
    assert.equal(after.rows[0].exact_text, before.rows[0].exact_text);
    assert.deepEqual(after.rows[0].pdf_pages, before.rows[0].pdf_pages);
    assert.equal(after.rows[0].section_id, before.rows[0].section_id);
    assert.equal(after.rows[0].title, before.rows[0].title);
    assert.equal(after.rows[0].primary_tag, 'kolej');
    assert.deepEqual([...after.rows[0].secondary_tags].sort(), ['samorzad', 'transport']);
    assert.deepEqual(after.rows[0].keywords, ['bilet metropolitalny', 'rozklad jazdy']);

    const revisions = await fixture.db.query<{
      revision_number: number; operator: string; previous_primary_tag: string; new_primary_tag: string; checksum: string;
    }>('select revision_number, operator, previous_primary_tag, new_primary_tag, checksum '
      + 'from app.programme_proposal_enrichment_revisions where proposal_id=$1', [before.rows[0].id]);
    assert.equal(revisions.rows.length, 1);
    assert.equal(revisions.rows[0].revision_number, 1);
    assert.equal(revisions.rows[0].operator, 'Operator Rewizyjny');
    assert.equal(revisions.rows[0].previous_primary_tag, 'transport');
    assert.equal(revisions.rows[0].new_primary_tag, 'kolej');
    assert.match(revisions.rows[0].checksum, /^[0-9a-f]{64}$/);

    // The new keyword is now genuinely searchable — the enrichment_vector generated column
    // recomputed itself from the update.
    const active = (await resolveActiveRelease(fixture.db))!;
    const hits = await findEvidence(fixture.db, active.releaseId, ['metropolitalny']);
    assert.ok(hits.some((hit) => hit.proposalId === before.rows[0].id));

    // A second revision increments the number and still preserves the first row unedited.
    const second = await reviseProposalEnrichment(fixture.db, {
      releaseSlug: fixture.releaseSlug, externalId: fixture.externalId,
      primaryTag: 'transport', secondaryTags: [], keywords: ['bilet metropolitalny'], operator: 'Operator Rewizyjny',
    });
    assert.equal(second.revisionNumber, 2);
    const revisionsAgain = await fixture.db.query<{ revision_number: number }>(
      'select revision_number from app.programme_proposal_enrichment_revisions where proposal_id=$1 order by revision_number',
      [before.rows[0].id]);
    assert.deepEqual(revisionsAgain.rows.map((row) => row.revision_number), [1, 2]);
  } finally {
    await fixture.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(fixture.archiveRoot, { recursive: true, force: true });
  }
});

test('reviseProposalEnrichment rejects a tag outside the release\'s pinned vocabulary', async () => {
  const fixture = await activatedFixture();
  try {
    await assert.rejects(reviseProposalEnrichment(fixture.db, {
      releaseSlug: fixture.releaseSlug, externalId: fixture.externalId,
      primaryTag: 'nieistniejacy-tag', secondaryTags: [], keywords: [], operator: 'Operator Rewizyjny',
    }), (error: unknown) => {
      assert.ok(error instanceof CorpusError);
      assert.equal(error.reason, 'tag_unknown');
      return true;
    });
  } finally {
    await fixture.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(fixture.archiveRoot, { recursive: true, force: true });
  }
});

test('reviseProposalEnrichment rejects an unnamed operator and an unknown proposal', async () => {
  const fixture = await activatedFixture();
  try {
    await assert.rejects(reviseProposalEnrichment(fixture.db, {
      releaseSlug: fixture.releaseSlug, externalId: fixture.externalId,
      primaryTag: 'kolej', secondaryTags: [], keywords: [], operator: '   ',
    }), (error: unknown) => error instanceof CorpusError && error.reason === 'operator_invalid');

    await assert.rejects(reviseProposalEnrichment(fixture.db, {
      releaseSlug: fixture.releaseSlug, externalId: 'prop-does-not-exist',
      primaryTag: 'kolej', secondaryTags: [], keywords: [], operator: 'Operator Rewizyjny',
    }), (error: unknown) => error instanceof CorpusError && error.reason === 'proposal_not_found');
  } finally {
    await fixture.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(fixture.archiveRoot, { recursive: true, force: true });
  }
});

test('the database itself refuses a raw UPDATE outside the six enrichment columns', async () => {
  const fixture = await activatedFixture();
  try {
    const row = await fixture.db.query<{ id: string }>(
      'select id from app.programme_proposals where external_id=$1', [fixture.externalId]);
    const proposalId = row.rows[0].id;

    // Allowed: a raw UPDATE touching only the six enrichment columns succeeds even without
    // going through the repository function — the guard is a property of the schema.
    await fixture.db.query(
      "update app.programme_proposals set primary_tag='samorzad' where id=$1", [proposalId]);

    // Refused: any other column, even alongside an otherwise-legal enrichment change.
    await assert.rejects(
      fixture.db.query("update app.programme_proposals set category='Something else' where id=$1", [proposalId]),
      /immutable/, 'category must stay immutable even via a direct UPDATE');
    await assert.rejects(
      fixture.db.query('update app.programme_proposals set order_index=99 where id=$1', [proposalId]),
      /immutable/, 'order_index must stay immutable even via a direct UPDATE');
    await assert.rejects(
      fixture.db.query('delete from app.programme_proposals where id=$1', [proposalId]),
      /immutable/, 'DELETE must remain fully blocked');
  } finally {
    await fixture.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(fixture.archiveRoot, { recursive: true, force: true });
  }
});

/**
 * Migration 0008 regression: an unadopted draft with a recorded admission_amendment must
 * import, approve and activate successfully — not just pass `validate`.
 *
 * Discovered live (CORPUS-05): migration 0006's `assert_programme_version_complete()`
 * trigger required `adopted_at IS NOT NULL` unconditionally, with no exception for a
 * document whose `admission_amendment` waives adoption. Every fixture before this one used a
 * real `adopted_at` date, and `validate` never reaches this trigger (it only runs against a
 * database during `import`), so the gap survived until the first real `import` run against a
 * real unadopted-draft bundle. This test exercises exactly that path end to end.
 */
test('an unadopted draft with a recorded admission_amendment imports, approves and activates', async () => {
  const directory = await writeBundle({
    adoptedAt: null,
    admissionAmendment: {
      approved_by: 'Operator Testowy',
      approved_at: '2026-09-21',
      statement: 'Szkic dopuszczony do testów wewnetrznych.',
      unpublished_source: false,
    },
  });
  const { db, close } = await database();
  const archiveRoot = await mkdtemp(path.join(tmpdir(), 'szronox-enrichment-draft-archive-'));
  try {
    const bundle = await loadBundle(directory);
    const sourceBytes = await readFile(bundle.source.absolutePath);
    const structureBytes = await readFile(bundle.structure.absolutePath);
    const datasetBytes = await readFile(bundle.dataset.absolutePath);
    const validation = validateBundle(bundle, sourceBytes);
    assert.equal(validation.ok, true, JSON.stringify(validation.issues));
    assert.equal(validation.report.admission.adoptedAt, null);
    assert.equal(validation.report.admission.amendment?.approvedBy, 'Operator Testowy');

    // The exact call that failed live before migration 0008: inserting into
    // programme_release_versions fires assert_programme_version_complete(), which must now
    // accept a null adopted_at when admission_amendment is present.
    await importRelease(db, bundle, validation, { archiveRoot, sourceBytes, structureBytes, datasetBytes });
    await approveRelease(db, bundle.manifest.releaseId, 'Operator Testowy');
    const activation = await activateRelease(db, bundle.manifest.releaseId, { archiveRoot });
    assert.equal(activation.releaseSlug, bundle.manifest.releaseId);

    const active = await db.query<{ id: string }>(
      "select id from app.programme_releases where release_slug=$1 and state='active'", [bundle.manifest.releaseId]);
    assert.equal(active.rows.length, 1);
  } finally {
    await close();
    await rm(directory, { recursive: true, force: true });
    await rm(archiveRoot, { recursive: true, force: true });
  }
});

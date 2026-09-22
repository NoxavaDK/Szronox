/**
 * CORPUS-02 (ETAP 3B): the adapter, empty-section retention and the retrieval changes,
 * exercised end to end against genuine PostgreSQL (PGlite) with the committed migrations.
 *
 * The fixture is deliberately ETAP-3B-shaped rather than bundle-shaped: raw
 * `Finalszronox_programme_proposals.json` / `..._metadata(2).json` / `..._coverage.json` plus
 * a companion `etap3b.manifest.json`, all written under the exact file names
 * `etap3b-adapter.ts` reads. Every bundle file used by `validate`/`import`/`approve`/
 * `activate` below is produced by `adaptEtap3bBundle` itself — nothing here hand-authors the
 * bundle format directly, so this proves the real adapter code, not a simulation of it.
 *
 * ASCII-only text: Polish diacritic decoding through the PDF extractor is already proven by
 * `corpus.test.ts`; this file is about the adapter, empty sections and short controlled
 * search terms, none of which depend on diacritics.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { PGlite } from '@electric-sql/pglite';

import { adaptEtap3bBundle, buildVocabulary, deriveTitle, Etap3bAdapterError, slugify } from './ai/corpus/etap3b-adapter.js';
import { loadBundle } from './ai/corpus/bundle.js';
import { readArchivedFile } from './ai/corpus/archive.js';
import { activateRelease, approveRelease, importRelease, resolveActiveRelease } from './ai/corpus/repository.js';
import { findEvidence, MAX_EVIDENCE_CANDIDATES, searchTerms } from './ai/corpus/retrieval.js';
import { joinHyphenatedLines, normalizePassage } from './ai/corpus/normalize.js';
import { extractPdfText } from './ai/corpus/pdf-text.js';
import { validateBundle } from './ai/corpus/validate.js';
import { pgliteDatabase, type Database } from './db/client.js';
import { migrate } from './db/migrate.js';

/* ── A minimal, real PDF (ASCII only — no /Differences needed) ─────────────────── */

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

/**
 * A one-page PDF from a raw content stream, for tests that need to control inter-glyph
 * positioning directly (the gap-threshold regression below) rather than relying on the font's
 * own natural character advances, which `buildPdf` above uses.
 */
function buildPdfWithContent(content: string): Buffer {
  const objects: string[] = ['', '', '', ''];
  const catalogNumber = 1;
  const pagesNumber = 2;
  const pageNumber = 3;
  const fontNumber = 4;
  const contentBody = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
  objects.push(contentBody);
  const contentNumber = objects.length;

  objects[catalogNumber - 1] = `<< /Type /Catalog /Pages ${pagesNumber} 0 R >>`;
  objects[pagesNumber - 1] = `<< /Type /Pages /Count 1 /Kids [ ${pageNumber} 0 R ] >>`;
  objects[pageNumber - 1] = `<< /Type /Page /Parent ${pagesNumber} 0 R /MediaBox [0 0 595 842] `
    + `/Resources << /Font << /F1 ${fontNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>`;
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

/* ── Fixture content ─────────────────────────────────────────────────────────── */

const WATER = 'Postulat: ochrona malej retencji wodnej. Bedziemy wspierac odbudowe mokradel '
  + 'i starorzeczy w calym kraju.';
const AI_PROP = 'Postulat: rozwoj sztucznej inteligencji w administracji. Wdrozymy AI oraz '
  + 'standardy UE dotyczace przejrzystosci systemow.';

const FILLER_COUNT = 10;
function fillerText(index: number): string {
  return `Postulat filtrowy numer ${index} dotyczacy wspolnytermin w wybranym obszarze kraju.`;
}

const CHAPTER_ENV = 'OCHRONA SRODOWISKA';
const CHAPTER_DIG = 'EDUKACJA NAUKA I NOWE TECHNOLOGIE';
const CHAPTER_FILTER = 'ROZDZIAL FILTROWY';

const SECTION_INTRO = 'Wprowadzenie';
const SECTION_RIVERS = 'RZEKI I ZBIORNIKI WODNE';
const SECTION_DIGITAL = 'CYFRYZACJA I SZTUCZNA INTELIGENCJA';

/** Physical pages, in order: 1 intro (empty), 2 water, 3 AI, 4–5 filler (5 each). */
function buildPages(): string[][] {
  const pages: string[][] = [
    [CHAPTER_ENV, SECTION_INTRO, 'Strona wprowadzajaca bez samodzielnego postulatu.'],
    [CHAPTER_ENV, SECTION_RIVERS, WATER],
    [CHAPTER_DIG, SECTION_DIGITAL, AI_PROP],
  ];
  const fillerPageOne = Array.from({ length: 5 }, (_unused, index) => fillerText(index + 1));
  const fillerPageTwo = Array.from({ length: 5 }, (_unused, index) => fillerText(index + 6));
  pages.push([CHAPTER_FILTER, 'strona filtrowa 1', ...fillerPageOne]);
  pages.push([CHAPTER_FILTER, 'strona filtrowa 2', ...fillerPageTwo]);
  return pages;
}

interface Etap3bProposalFixture {
  proposal_id: string; chapter: string; section: string; proposal_text: string;
  pdf_page: number; primary_tag: string; secondary_tags: string[]; keywords: string[];
}

function buildProposals(): Etap3bProposalFixture[] {
  const records: Etap3bProposalFixture[] = [
    {
      proposal_id: 'SZR-ENV-WATER-001', chapter: CHAPTER_ENV, section: SECTION_RIVERS,
      proposal_text: WATER, pdf_page: 2, primary_tag: 'woda', secondary_tags: [], keywords: ['melioracja'],
    },
    {
      proposal_id: 'SZR-DIG-AI-001', chapter: CHAPTER_DIG, section: SECTION_DIGITAL,
      proposal_text: AI_PROP, pdf_page: 3, primary_tag: 'cyfryzacja', secondary_tags: ['ai'], keywords: ['algorytmy'],
    },
  ];
  for (let index = 1; index <= FILLER_COUNT; index += 1) {
    records.push({
      proposal_id: `SZR-FLT-F-${String(index).padStart(3, '0')}`,
      chapter: CHAPTER_FILTER,
      section: `SEKCJA F${index}`,
      proposal_text: fillerText(index),
      pdf_page: index <= 5 ? 4 : 5,
      primary_tag: 'transport',
      secondary_tags: [],
      keywords: [],
    });
  }
  return records;
}

interface CoverageEntry {
  chapter: string; section: string; first_pdf_page: number; last_pdf_page: number;
  extracted_proposals_count: number; status: 'COMPLETE';
}

function buildCoverage(): CoverageEntry[] {
  const coverage: CoverageEntry[] = [
    { chapter: CHAPTER_ENV, section: SECTION_INTRO, first_pdf_page: 1, last_pdf_page: 1, extracted_proposals_count: 0, status: 'COMPLETE' },
    { chapter: CHAPTER_ENV, section: SECTION_RIVERS, first_pdf_page: 2, last_pdf_page: 2, extracted_proposals_count: 1, status: 'COMPLETE' },
    { chapter: CHAPTER_DIG, section: SECTION_DIGITAL, first_pdf_page: 3, last_pdf_page: 3, extracted_proposals_count: 1, status: 'COMPLETE' },
  ];
  for (let index = 1; index <= FILLER_COUNT; index += 1) {
    const page = index <= 5 ? 4 : 5;
    coverage.push({
      chapter: CHAPTER_FILTER, section: `SEKCJA F${index}`,
      first_pdf_page: page, last_pdf_page: page, extracted_proposals_count: 1, status: 'COMPLETE',
    });
  }
  return coverage;
}

/**
 * Section codes are deliberately incomplete: the empty intro section and one non-empty
 * filler section (`SEKCJA F2`) are left uncoded, so the adapter's fallback-slug path is
 * exercised for both an empty and a non-empty section, not only the real dataset's pattern
 * (where every uncoded section happens to be empty).
 */
function buildSectionCodeMap(): Array<{ chapter: string; section: string; chapter_code: string; section_code: string }> {
  const map = [
    { chapter: CHAPTER_ENV, section: SECTION_RIVERS, chapter_code: 'ENV', section_code: 'RZWP' },
    { chapter: CHAPTER_DIG, section: SECTION_DIGITAL, chapter_code: 'DIG', section_code: 'CSI' },
    { chapter: CHAPTER_FILTER, section: 'SEKCJA F1', chapter_code: 'FLT', section_code: 'F01' },
  ];
  for (let index = 3; index <= FILLER_COUNT; index += 1) {
    map.push({ chapter: CHAPTER_FILTER, section: `SEKCJA F${index}`, chapter_code: 'FLT', section_code: `F${String(index).padStart(2, '0')}` });
  }
  return map;
}

async function writeEtap3bRawInputs(directory: string): Promise<{ pdf: Buffer; sha256: string }> {
  const pdf = buildPdf(buildPages());
  const sha256 = createHash('sha256').update(pdf).digest('hex');
  await writeFile(path.join(directory, 'EtapTest.pdf'), pdf);
  await writeFile(path.join(directory, 'EtapTest.docx'), Buffer.from('opaque structural aid', 'latin1'));

  await writeFile(path.join(directory, 'Finalszronox_programme_proposals.json'),
    JSON.stringify(buildProposals(), null, 2), 'utf8');
  await writeFile(path.join(directory, 'Finalszronox_programme_metadata(2).json'), JSON.stringify({
    approved_controlled_tags: ['woda', 'cyfryzacja', 'AI', 'UE', 'transport'],
    tagging_rules: {
      cyfryzacja_vs_AI_vs_technologie: 'AI for AI-specific governance/models/algorithms; cyfryzacja for digital public services.',
    },
    section_code_map: buildSectionCodeMap(),
    authoritative_pdf_page_count: 5,
    source_sha256: sha256,
  }, null, 2), 'utf8');
  await writeFile(path.join(directory, 'Finalszronox_programme_coverage.json'),
    JSON.stringify(buildCoverage(), null, 2), 'utf8');

  await writeFile(path.join(directory, 'etap3b.manifest.json'), JSON.stringify({
    corpus_id: 'zieloni-programme-test',
    release_id: 'zieloni-programme-test-etap3b-r1',
    release_label: 'Program Zielonych — fixture ETAP 3B',
    category_vocabulary_id: 'cat-vocab-test-etap3b',
    imported_by: 'NOXAVA',
    notes: 'Fixture bundle.',
    document: {
      document_id: 'doc-program-zielonych-test',
      title: 'Program Partii Zieloni',
      document_type: 'programme',
      issuing_body: 'Partia Zieloni',
      admission_rationale: 'Program przyjety przez Kongres partii.',
      admission_amendment: null,
    },
    version: {
      document_version_id: 'dv-program-zielonych-test-etap3b-r1',
      source_title: 'Program Partii Zieloni (fixture)',
      edition: 'wydanie testowe',
      adopted_at: '2026-01-17',
      language: 'pl',
      source_file_name: 'EtapTest.pdf',
      structure_file_name: 'EtapTest.docx',
      source_url: 'https://example.org/etap3b-fixture.pdf',
      retrieved_at: '2026-09-20T00:00:00.000Z',
      structure_coverage: 'full',
      // Genuinely missing from the real ETAP 3B dataset (decision 5); this fixture, being
      // fully controlled, supplies its own so the lifecycle test below can reach a clean pass.
      printed_page_labels: ['', '3', '4', '5', '6'],
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
  }, null, 2), 'utf8');

  return { pdf, sha256 };
}

async function database(): Promise<{ db: Database; close(): Promise<void> }> {
  const instance = new PGlite();
  const db = pgliteDatabase(instance);
  await migrate(db);
  return { db, close: () => instance.close() };
}

/* ── Adapter ──────────────────────────────────────────────────────────────────── */

/**
 * `joinHyphenatedLines` (normalize.ts): the PDF page-assembly join.
 *
 * Discovered while validating the real ETAP 3B/PDF pair (CORPUS-02): a blind space-join of
 * per-line text left a stray space where a word wrapped across a line break at a hyphen,
 * which broke grounding for real proposals whose dataset text has the word unwrapped. These
 * cases are taken directly from that run, both the ones it must fix and the one it must not
 * (a standalone dash used as punctuation, not a word-wrap).
 *
 * CORPUS-03: the hyphen is always retained, never dropped, for an attached hyphen — confirmed
 * against the real PDF (rendered and read by eye) that every attached-hyphen wrap in this
 * document is a real compound word or acronym (`MIR-PIB`, `doradczo-rozwojowych`), never an
 * inserted word-wrap artefact, and confirmed against all 1,423 canonical proposals that
 * "always retain" produces zero regressions versus the earlier drop-for-letter rule.
 */
test('joinHyphenatedLines joins an attached hyphen and keeps it, confirmed against the real PDF', () => {
  assert.equal(joinHyphenatedLines(['agencj-', 'ach wykonawczych']), 'agencj-ach wykonawczych');
  assert.equal(joinHyphenatedLines(['MIR-', 'PIB, IBW PAN']), 'MIR-PIB, IBW PAN');
  assert.equal(joinHyphenatedLines(['doradczo-', 'rozwojowych alternatywami']), 'doradczo-rozwojowych alternatywami');
});

test('joinHyphenatedLines keeps a digit-preceded hyphen, since it is part of the token', () => {
  assert.equal(joinHyphenatedLines(['wysokości 35-', 'krotności rocznej']), 'wysokości 35-krotności rocznej');
});

test('joinHyphenatedLines does not touch a standalone dash used as punctuation', () => {
  assert.equal(
    joinHyphenatedLines(['organizacji pozarządowych -', 'oraz ich wykonawców']),
    'organizacji pozarządowych - oraz ich wykonawców',
  );
});

test('joinHyphenatedLines leaves two ordinary lines exactly as a single-space join would', () => {
  assert.equal(joinHyphenatedLines(['Pierwsze zdanie.', 'Drugie zdanie.']), 'Pierwsze zdanie. Drugie zdanie.');
  assert.equal(joinHyphenatedLines(['Jedna linia']), 'Jedna linia');
  assert.equal(joinHyphenatedLines([]), '');
});

/**
 * `normalizePassage`'s subscript-digit expansion (CORPUS-03): the real PDF renders "CO₂"
 * with a genuine Unicode subscript 2 (confirmed by rendering page 57 and reading it by eye),
 * while the ETAP 3B dataset's canonical text has plain "CO2". Expanded the same way ligatures
 * are — typography, not spelling.
 */
test('normalizePassage expands a subscript digit to its plain form', () => {
  assert.equal(normalizePassage('trwałego wiązania CO₂ wyłącznie'), 'trwałego wiązania CO2 wyłącznie');
  assert.equal(normalizePassage('H₂O i CO₂'), 'H2O i CO2');
});

/**
 * `pdf-text.ts`'s `assembleLines` glyph-gap threshold (CORPUS-03).
 *
 * The content stream places "agencj" then "ach" on one line with an explicit TJ-array
 * kerning adjustment between them, at font size 12 — the same mechanism (and the same
 * font size) that produced every false positive found in the real document. A gap ratio of
 * 0.3 (between the old 0.22 multiplier, which wrongly split this into two words, and the new
 * 0.4, which must not) reproduces the exact defect class this fix closes. A second case with
 * ratio 0.6 — comfortably past 0.4 — proves the threshold still recognizes a genuine wide gap.
 */
function contentWithGap(tjAdjustment: number): string {
  return ['BT', '/F1 12 Tf', '1 0 0 1 50 760 Tm', `[(agencj) ${tjAdjustment} (ach)] TJ`, 'ET'].join('\n');
}

test('assembleLines does not split a word at a justified-text kerning gap that used to false-positive', () => {
  // ratio 0.3: ((-adjustment/1000) * 12) / 12 = 0.3  =>  adjustment = -300
  const extracted = extractPdfText(buildPdfWithContent(contentWithGap(-300)));
  assert.equal(extracted.pages[0].text, 'agencjach');
});

test('assembleLines still inserts a space at a genuine wide gap', () => {
  // ratio 0.6: adjustment = -600
  const extracted = extractPdfText(buildPdfWithContent(contentWithGap(-600)));
  assert.equal(extracted.pages[0].text, 'agencj ach');
});

test('slugify transliterates Polish diacritics explicitly', () => {
  assert.equal(slugify('środowisko'), 'srodowisko');
  assert.equal(slugify('gospodarka obiegu zamkniętego'), 'gospodarka-obiegu-zamknietego');
  assert.equal(slugify('AI'), 'ai');
});

test('deriveTitle is always a verbatim prefix of the passage, and never mid-word past the bound', () => {
  assert.equal(deriveTitle(WATER), 'Postulat: ochrona malej retencji wodnej.');
  const longSentence = `Postulat ${'x'.repeat(600)} zakonczenie.`;
  const title = deriveTitle(longSentence);
  assert.ok(title.length <= 500);
  assert.ok(longSentence.startsWith(title));
  assert.ok(!title.endsWith(' '));
});

test('buildVocabulary uses the tagging-rule note when a tag participates in one, else an explicit placeholder', () => {
  const vocabulary = buildVocabulary({
    approved_controlled_tags: ['AI', 'cyfryzacja', 'transport'],
    tagging_rules: { cyfryzacja_vs_AI_vs_technologie: 'AI for AI-specific governance.' },
    section_code_map: [],
    authoritative_pdf_page_count: 1,
    source_sha256: 'x'.repeat(64),
  }, 'cat-vocab-test');
  const byId = new Map(vocabulary.entries.map((entry) => [entry.id, entry]));
  assert.equal(byId.get('ai')?.definition, 'AI for AI-specific governance.');
  assert.equal(byId.get('transport')?.definition, 'Kontrolowany tag ETAP 3B; zobacz metadata.approved_controlled_tags.');
});

test('a record with more than four secondary tags is rejected by the adapter, not silently truncated', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'szronox-etap3b-'));
  try {
    await writeEtap3bRawInputs(directory);
    const proposals = JSON.parse(await readFile(path.join(directory, 'Finalszronox_programme_proposals.json'), 'utf8'));
    proposals[0].secondary_tags = ['a', 'b', 'c', 'd', 'e'];
    await writeFile(path.join(directory, 'Finalszronox_programme_proposals.json'), JSON.stringify(proposals), 'utf8');
    await assert.rejects(adaptEtap3bBundle({ programDir: directory }), (error: unknown) => {
      assert.ok(error instanceof Etap3bAdapterError);
      assert.ok(error.issues.some((issue) => issue.code === 'secondary_tags_too_many'));
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/* ── End to end: adapt → validate → import → approve → activate → retrieve ─────── */

test('ETAP 3B fixture: adapt, validate, import inactive, approve, activate; empty section retained', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'szronox-etap3b-'));
  const { db, close } = await database();
  try {
    const { pdf } = await writeEtap3bRawInputs(directory);
    const adapted = await adaptEtap3bBundle({ programDir: directory });
    assert.equal(adapted.proposalCount, 2 + FILLER_COUNT);
    assert.equal(adapted.rejectedCount, 0);
    assert.equal(adapted.sectionCount, 3 + FILLER_COUNT);
    assert.equal(adapted.emptySectionCount, 1);

    const bundle = await loadBundle(directory);
    const sourceBytes = await readFile(bundle.source.absolutePath);
    assert.deepEqual(sourceBytes, pdf);
    const validation = validateBundle(bundle, sourceBytes);
    assert.deepEqual(validation.issues, []);
    assert.equal(validation.ok, true);
    // All 13 sections retained, including the zero-proposal intro section (#11).
    assert.equal(validation.sections.length, 3 + FILLER_COUNT);
    assert.equal(validation.proposals.length, 2 + FILLER_COUNT);

    const structureBytes = await readFile(bundle.structure.absolutePath);
    const datasetBytes = await readFile(bundle.dataset.absolutePath);
    const archiveRoot = await mkdtemp(path.join(tmpdir(), 'szronox-etap3b-archive-'));

    // #1 — inactive import.
    const outcome = await importRelease(db, bundle, validation, { archiveRoot, sourceBytes, structureBytes, datasetBytes });
    assert.equal(outcome.state, 'draft');
    assert.equal(await resolveActiveRelease(db), null);

    const introSection = await db.query<{ id: string }>(
      "select id from app.programme_sections where subchapter='Wprowadzenie'");
    assert.equal(introSection.rows.length, 1, 'the empty intro section must exist after import (#11)');
    const introProposals = await db.query<{ count: string }>(
      'select count(*) as count from app.programme_proposals where section_id=$1', [introSection.rows[0].id]);
    assert.equal(Number(introProposals.rows[0].count), 0);

    // #2 — explicit activation, refused before approval.
    await assert.rejects(activateRelease(db, bundle.manifest.releaseId, { archiveRoot }));
    await approveRelease(db, bundle.manifest.releaseId, 'Operator Testowy');
    const activation = await activateRelease(db, bundle.manifest.releaseId, { archiveRoot });
    assert.equal(activation.supersededSlug, null);
    const active = await resolveActiveRelease(db);
    assert.equal(active?.releaseSlug, bundle.manifest.releaseId);

    /* ── Retrieval ────────────────────────────────────────────────────────────── */

    // #3 — exact retrieval: the proposal's own text finds itself.
    const exactTerms = searchTerms([WATER]);
    const exactHits = await findEvidence(db, active!.releaseId, exactTerms);
    assert.ok(exactHits.some((hit) => hit.proposal.startsWith('Postulat: ochrona malej retencji')));

    // #4 — cross-cutting retrieval: a term present only in keywords, never in body text.
    assert.ok(!WATER.includes('melioracja'));
    const crossCuttingHits = await findEvidence(db, active!.releaseId, ['melioracja']);
    assert.equal(crossCuttingHits.length, 1);
    assert.ok(crossCuttingHits[0].proposal.startsWith('Postulat: ochrona malej retencji'));
    // #5 — the very same proposal has zero secondary tags and still retrieves normally.

    // #12 — short controlled terms survive tokenization and reach the database layer.
    const shortTerms = searchTerms(['W programie znajduje sie fragment o UE oraz o AI.']);
    assert.ok(shortTerms.includes('ai'));
    assert.ok(shortTerms.includes('ue'));
    const aiHits = await findEvidence(db, active!.releaseId, shortTerms);
    assert.ok(aiHits.some((hit) => hit.proposal.startsWith('Postulat: rozwoj sztucznej inteligencji')));
    const ueOnlyHits = await findEvidence(db, active!.releaseId, ['ue']);
    assert.equal(ueOnlyHits.length, 1);
    assert.ok(ueOnlyHits[0].excerpt.includes('UE'));

    // #6 — bounded candidate input: ten proposals share one rare term; at most eight return.
    const boundedHits = await findEvidence(db, active!.releaseId, ['wspolnytermin']);
    assert.equal(boundedHits.length, MAX_EVIDENCE_CANDIDATES);
    assert.equal(new Set(boundedHits.map((hit) => hit.proposalId)).size, MAX_EVIDENCE_CANDIDATES);
    const boundedHitsAgain = await findEvidence(db, active!.releaseId, ['wspolnytermin']);
    assert.deepEqual(boundedHitsAgain.map((hit) => hit.chunkId), boundedHits.map((hit) => hit.chunkId));

    // #8 — unrelated content: no term overlaps any fixture text, so no candidate returns.
    const unrelatedTerms = searchTerms(['Recenzja filmowej superprodukcji kinowej.']);
    const unrelatedHits = await findEvidence(db, active!.releaseId, unrelatedTerms);
    assert.deepEqual(unrelatedHits, []);

    // #9 — PDF citation integrity: the archived bytes read back byte-for-byte.
    const versionRow = await db.query<{ archive_key: string; document_sha256: string; source_byte_size: string }>(
      'select archive_key, document_sha256, source_byte_size from app.programme_versions where version_slug=$1',
      [bundle.manifest.version.documentVersionId]);
    const archived = await readArchivedFile(archiveRoot, versionRow.rows[0].archive_key, {
      sha256: versionRow.rows[0].document_sha256,
      byteSize: Number(versionRow.rows[0].source_byte_size),
    });
    assert.deepEqual(archived, pdf);

    await rm(archiveRoot, { recursive: true, force: true });
  } finally {
    await close();
    await rm(directory, { recursive: true, force: true });
  }
});

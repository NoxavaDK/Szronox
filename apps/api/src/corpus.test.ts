/**
 * The approved programme corpus, end to end.
 *
 * The fixture is a real PDF built here byte by byte — catalog, page tree, cross-reference
 * table, a Type1 font with a `/Differences` encoding for the Polish letters WinAnsi does
 * not carry. That matters: the property under test is that the server can re-derive a
 * citation's text and pages from archived bytes, and a stubbed extractor would prove
 * nothing about it. Everything downstream runs against genuine PostgreSQL (PGlite) with
 * the committed migrations applied.
 *
 * What is deliberately NOT stubbed: extraction, normalization, chunking, offsets, page
 * mapping, the database constraints and the three lifecycle acts. What is: the DOCX, which
 * the corpus treats as opaque archived bytes and never parses.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import Fastify from 'fastify';
import { PGlite } from '@electric-sql/pglite';

import { registerAiRoutes } from './ai/routes.js';
import { memoryStorageAdapter } from './core/storage.js';
import { unauthenticated } from './core/errors.js';

import { AiService } from './ai/service.js';
import { loadBundle } from './ai/corpus/bundle.js';
import { readArchivedFile } from './ai/corpus/archive.js';
import {
  activateRelease, approveRelease, importRelease, resolveActiveRelease,
} from './ai/corpus/repository.js';
import { findEvidence, resolveArchivedSource, searchTerms } from './ai/corpus/retrieval.js';
import { validateBundle } from './ai/corpus/validate.js';
import { extractPdfText } from './ai/corpus/pdf-text.js';
import { pgliteDatabase, type Database } from './db/client.js';
import { migrate } from './db/migrate.js';

/* ── A real PDF ───────────────────────────────────────────────────────────────── */

/** Polish letters that WinAnsiEncoding lacks, mapped through /Differences. */
const DIFFERENCES: Array<[string, string]> = [
  ['ą', 'aogonek'], ['ę', 'eogonek'], ['ł', 'lslash'], ['ś', 'sacute'], ['ż', 'zdotaccent'],
  ['ź', 'zacute'], ['ć', 'cacute'], ['ń', 'nacute'], ['Ś', 'Sacute'], ['Ł', 'Lslash'],
  ['Ż', 'Zdotaccent'], ['Ą', 'Aogonek'],
];
const CODE_FOR = new Map(DIFFERENCES.map(([character], index) => [character, 200 + index]));

function encodeLine(line: string): string {
  let out = '';
  for (const character of line) {
    const code = CODE_FOR.get(character);
    if (code !== undefined) { out += `\\${code.toString(8).padStart(3, '0')}`; continue; }
    if (character === '(' || character === ')' || character === '\\') { out += `\\${character}`; continue; }
    const point = character.codePointAt(0) ?? 32;
    // Everything else in the fixture is Latin-1, which WinAnsi agrees with above U+00A0.
    out += point < 256 ? String.fromCharCode(point) : '?';
  }
  return out;
}

/** Build a multi-page PDF whose pages hold the given lines, in order. */
export function buildPdf(pages: readonly string[][]): Buffer {
  const objects: string[] = [];
  const add = (body: string): number => { objects.push(body); return objects.length; };

  const catalogNumber = 1;
  const pagesNumber = 2;
  const fontNumber = 3;
  const encodingNumber = 4;
  objects.push('', '', '', ''); // reserved slots for the four fixed objects

  const pageNumbers: number[] = [];
  for (const lines of pages) {
    const content = [
      'BT', '/F1 12 Tf', '14 TL', '1 0 0 1 50 760 Tm',
      ...lines.map((line) => `(${encodeLine(line)}) Tj T*`),
      'ET',
    ].join('\n');
    const contentNumber = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    pageNumbers.push(add(`<< /Type /Page /Parent ${pagesNumber} 0 R /MediaBox [0 0 595 842] `
      + `/Resources << /Font << /F1 ${fontNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>`));
  }

  objects[catalogNumber - 1] = `<< /Type /Catalog /Pages ${pagesNumber} 0 R >>`;
  objects[pagesNumber - 1] = `<< /Type /Pages /Count ${pageNumbers.length} `
    + `/Kids [ ${pageNumbers.map((number) => `${number} 0 R`).join(' ')} ] >>`;
  objects[fontNumber - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica '
    + `/Encoding ${encodingNumber} 0 R >>`;
  objects[encodingNumber - 1] = '<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [ 200 '
    + `${DIFFERENCES.map(([, name]) => `/${name}`).join(' ')} ] >>`;

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

/* ── Fixture content ──────────────────────────────────────────────────────────── */

const WATER = 'Postulat: Ochrona małej retencji. Będziemy wspierać zatrzymywanie wody w krajobrazie '
  + 'oraz odbudowę mokradeł i starorzeczy.';
const TRANSPORT = 'Postulat: Tani bilet kolejowy. Chcemy wprowadzić wspólny bilet aglomeracyjny '
  + 'i rozwijać połączenia regionalne poza dużymi miastami.';
const ENERGY_FIRST = 'Postulat: Spółdzielnie energetyczne. Mieszkańcy powinni móc zakładać lokalne '
  + 'spółdzielnie wytwarzające prąd z dachowych instalacji fotowoltaicznych. Taka spółdzielnia '
  + 'rozlicza się wspólnie, a nadwyżka trafia do sąsiadów zamiast do pośrednika. Samorząd '
  + 'udostępnia dachy szkół i świetlic, co obniża rachunki instytucji publicznych.';
const ENERGY_SECOND = 'Przyłączenie takiej instalacji powinno być rozpatrywane w terminie '
  + 'trzydziestu dni, a odmowa wymagać pisemnego uzasadnienia technicznego od operatora sieci.';
const ENERGY = `${ENERGY_FIRST} ${ENERGY_SECOND}`;

const PAGES: string[][] = [
  ['OCHRONA ŚRODOWISKA', 'Zieloni chronią rzeki i mokradła przed osuszaniem.', WATER],
  ['TRANSPORT', 'Dostępna kolej jest warunkiem sprawiedliwej transformacji.', TRANSPORT],
  ['ENERGETYKA', ENERGY_FIRST],
  [ENERGY_SECOND, 'Koniec rozdziału.'],
];

const VOCABULARY = {
  vocabulary_id: 'cat-vocab-test-01',
  entries: [
    { id: 'srodowisko', label: 'Środowisko', definition: 'Ochrona przyrody, wód i klimatu.' },
    { id: 'transport', label: 'Transport', definition: 'Kolej, transport zbiorowy i mobilność.' },
    { id: 'energetyka', label: 'Energetyka', definition: 'Wytwarzanie i dystrybucja energii.' },
  ],
};

interface RecordOverrides { [key: string]: unknown }

function records(overrides: RecordOverrides[] = []): RecordOverrides[] {
  const base: RecordOverrides[] = [
    {
      proposal_id: 'prop-srodowisko-01', section_id: 'sec-srodowisko', chapter: 'OCHRONA ŚRODOWISKA',
      subchapter: null, order_index: 0, title: 'Postulat: Ochrona małej retencji.', text: WATER,
      primary_tag: 'srodowisko', secondary_tags: [], keywords: ['retencja', 'mokradła'], pdf_page: 1,
    },
    {
      proposal_id: 'prop-transport-01', section_id: 'sec-transport', chapter: 'TRANSPORT',
      subchapter: null, order_index: 0, title: 'Postulat: Tani bilet kolejowy.', text: TRANSPORT,
      primary_tag: 'transport', secondary_tags: ['srodowisko'],
      keywords: ['bilet aglomeracyjny', 'kolej regionalna'], pdf_page: 2,
    },
    {
      proposal_id: 'prop-energetyka-01', section_id: 'sec-energetyka', chapter: 'ENERGETYKA',
      subchapter: 'Energetyka obywatelska', order_index: 0,
      title: 'Postulat: Spółdzielnie energetyczne.', text: ENERGY,
      primary_tag: 'energetyka', secondary_tags: ['srodowisko'],
      keywords: ['fotowoltaika', 'prosument', 'rachunki za prąd'], pdf_pages: [3, 4],
    },
  ];
  return base.map((record, index) => ({ ...record, ...(overrides[index] ?? {}) }));
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const pdf = buildPdf(PAGES);
  return {
    corpus_id: 'zieloni-programme',
    release_id: 'zieloni-programme-test-r1',
    release_label: 'Program Zielonych — wydanie testowe',
    category_vocabulary_id: 'cat-vocab-test-01',
    imported_by: 'NOXAVA',
    expected_proposal_count: 3,
    document: {
      document_id: 'doc-program-zielonych',
      title: 'Program Partii Zieloni',
      document_type: 'programme',
      issuing_body: 'Partia Zieloni',
      admission_rationale: 'Program przyjęty przez Kongres partii.',
      admission_amendment: null,
    },
    version: {
      document_version_id: 'dv-program-zielonych-test-r1',
      source_title: 'Program Partii Zieloni (2026)',
      edition: 'przyjęty przez Kongres, 01.2026',
      adopted_at: '2026-01-17',
      language: 'pl',
      source_file_name: 'ProgramTest.pdf',
      structure_file_name: 'ProgramTest.docx',
      dataset_file_name: 'proposals.json',
      source_url: 'https://example.org/program.pdf',
      source_sha256: createHash('sha256').update(pdf).digest('hex'),
      retrieved_at: '2026-09-19T08:00:00.000Z',
      page_count: 4,
      printed_page_labels: ['', '', '3', '4'],
      structure_coverage: 'full',
    },
    ingestion: {
      ingested_by: 'NOXAVA',
      normalization_profile_id: 'szronox-normalization-1',
      punctuation_map: {},
      chunking: { target_chars: 200, max_chars: 900, min_chars: 100, overlap: 'none' },
      structure_source: 'operator_declared',
      excluded_ranges: [],
      header_footer: { drop_exact_lines: [], drop_printed_page_label_lines: false },
      category_from_primary_tag: true,
      notes: 'Fixture bundle.',
    },
    ...overrides,
  };
}

function ledger(): Record<string, unknown> {
  return {
    pages: [
      { pdf_page: 1, status: 'indexed', proposal_ids: ['prop-srodowisko-01'] },
      { pdf_page: 2, status: 'indexed', proposal_ids: ['prop-transport-01'] },
      { pdf_page: 3, status: 'indexed', proposal_ids: ['prop-energetyka-01'] },
      { pdf_page: 4, status: 'indexed', proposal_ids: ['prop-energetyka-01'] },
    ],
    sections: [
      { section_id: 'sec-srodowisko', status: 'indexed' },
      { section_id: 'sec-transport', status: 'indexed' },
      { section_id: 'sec-energetyka', status: 'indexed' },
    ],
  };
}

interface BundleOptions {
  manifestOverrides?: Record<string, unknown>;
  recordOverrides?: RecordOverrides[];
  ledgerOverride?: Record<string, unknown>;
  datasetCsv?: boolean;
  pages?: string[][];
}

async function writeBundle(options: BundleOptions = {}): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'szronox-corpus-'));
  const pdf = buildPdf(options.pages ?? PAGES);
  const declared = manifest(options.manifestOverrides);
  const version = declared.version as Record<string, unknown>;
  if (options.pages) version.source_sha256 = createHash('sha256').update(pdf).digest('hex');
  const rows = records(options.recordOverrides ?? []);

  await writeFile(path.join(directory, String(version.source_file_name)), pdf);
  await writeFile(path.join(directory, String(version.structure_file_name)),
    Buffer.from('PK opaque structural aid', 'latin1'));
  if (options.datasetCsv) {
    version.dataset_file_name = 'proposals.csv';
    const columns = ['proposal_id', 'section_id', 'chapter', 'subchapter', 'order_index', 'title',
      'text', 'primary_tag', 'secondary_tags', 'keywords', 'pdf_pages'];
    const cell = (value: unknown): string => {
      if (value === null) return 'null';
      const text = Array.isArray(value) ? JSON.stringify(value) : String(value);
      return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    const lines = [columns.join(',')];
    for (const row of rows) {
      lines.push(columns.map((column) => cell(
        column === 'pdf_pages' ? (row.pdf_pages ?? [row.pdf_page]) : row[column],
      )).join(','));
    }
    await writeFile(path.join(directory, 'proposals.csv'), `${lines.join('\n')}\n`, 'utf8');
  } else {
    await writeFile(path.join(directory, 'proposals.json'),
      JSON.stringify({ records: rows }, null, 2), 'utf8');
  }
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(declared, null, 2), 'utf8');
  await writeFile(path.join(directory, 'vocabulary.json'), JSON.stringify(VOCABULARY, null, 2), 'utf8');
  await writeFile(path.join(directory, 'coverage.json'),
    JSON.stringify(options.ledgerOverride ?? ledger(), null, 2), 'utf8');
  return directory;
}

async function prepare(options: BundleOptions = {}) {
  const directory = await writeBundle(options);
  const bundle = await loadBundle(directory);
  const sourceBytes = await readFile(bundle.source.absolutePath);
  const structureBytes = await readFile(bundle.structure.absolutePath);
  const datasetBytes = await readFile(bundle.dataset.absolutePath);
  return {
    directory, bundle, sourceBytes, structureBytes, datasetBytes,
    validation: validateBundle(bundle, sourceBytes),
  };
}

async function database(): Promise<{ db: Database; close(): Promise<void> }> {
  const instance = new PGlite();
  const db = pgliteDatabase(instance);
  await migrate(db);
  return { db, close: () => instance.close() };
}

const codes = (issues: readonly { code: string }[]): string[] => [...new Set(issues.map((issue) => issue.code))].sort();

/* ── Extraction ───────────────────────────────────────────────────────────────── */

test('extraction recovers Polish text, page order and page boundaries from archived bytes', () => {
  const extracted = extractPdfText(buildPdf(PAGES));
  assert.equal(extracted.pageCount, 4);
  assert.equal(extracted.pages.reduce((total, page) => total + page.undecodedCount, 0), 0);
  assert.deepEqual(extracted.warnings, []);
  assert.equal(extracted.pages[0].text.split('\n')[0], 'OCHRONA ŚRODOWISKA');
  assert.ok(extracted.pages[0].text.includes('mokradeł i starorzeczy.'));
  assert.ok(extracted.pages[2].text.includes('fotowoltaicznych'));
  assert.ok(extracted.pages[3].text.startsWith('Przyłączenie'));
});

/* ── Validation ───────────────────────────────────────────────────────────────── */

test('a well-formed bundle validates, and every chunk matches its own offsets and pages', async () => {
  const { directory, validation } = await prepare();
  try {
    assert.deepEqual(validation.issues, [], 'a clean bundle must produce no findings');
    assert.equal(validation.proposals.length, 3);
    assert.equal(validation.sections.length, 3);

    const energy = validation.proposals.find((proposal) => proposal.externalId === 'prop-energetyka-01')!;
    assert.deepEqual(energy.pdfPages, [3, 4], 'a passage across a page break carries both pages');
    assert.deepEqual(energy.printedPages, ['3', '4']);
    assert.ok(energy.chunks.length >= 2, 'a long proposal is chunked');
    assert.equal(energy.category, 'Energetyka', 'the category is the vocabulary label, not the tag id');

    for (const proposal of validation.proposals) {
      for (const chunk of proposal.chunks) {
        assert.equal(validation.document.text.slice(chunk.charStart, chunk.charEnd), chunk.text);
        assert.equal(chunk.pdfPages.length, chunk.printedPages.length);
        assert.ok(chunk.charStart >= proposal.charStart && chunk.charEnd <= proposal.charEnd,
          'a chunk never crosses its proposal boundary');
      }
      const reassembled = proposal.chunks.map((chunk) => chunk.text).join(' ');
      assert.equal(reassembled.replace(/\s+/g, ' '), proposal.text.replace(/\s+/g, ' '),
        'chunks cover the whole proposal without inventing or dropping text');
    }

    const spanning = validation.report.manualChecks.pageSpanningChunk;
    assert.ok(spanning && spanning.pdfPages.length > 1, 'the report offers a page-spanning chunk to check by eye');
    assert.deepEqual(validation.report.manualChecks.frontMatterPage, { pdfPage: 1, printedPage: '' });
    assert.deepEqual(validation.report.manualChecks.bodyPage, { pdfPage: 3, printedPage: '3' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the CSV adapter and the JSON dataset produce the same index', async () => {
  const json = await prepare();
  const csv = await prepare({ datasetCsv: true });
  try {
    assert.deepEqual(csv.validation.issues, []);
    const strip = (result: typeof json.validation) => result.proposals.map((proposal) => ({
      ...proposal, chunks: proposal.chunks.map((chunk) => ({ ...chunk })),
    }));
    assert.deepEqual(strip(csv.validation), strip(json.validation));
  } finally {
    await rm(json.directory, { recursive: true, force: true });
    await rm(csv.directory, { recursive: true, force: true });
  }
});

test('malformed, duplicated and ungrounded records are rejected with indexed reasons', async () => {
  const cases: Array<{ name: string; options: BundleOptions; expected: string[] }> = [
    {
      name: 'both page forms',
      options: { recordOverrides: [{ pdf_pages: [1] }] },
      expected: ['pages_ambiguous'],
    },
    {
      name: 'page range endpoints instead of every page',
      options: { recordOverrides: [{}, {}, { pdf_pages: [1, 4] }] },
      expected: ['pages_invalid'],
    },
    {
      name: 'duplicate proposal id',
      options: { recordOverrides: [{}, { proposal_id: 'prop-srodowisko-01' }] },
      expected: ['proposal_id_duplicate'],
    },
    {
      name: 'passage not in the archived PDF',
      options: { recordOverrides: [{ text: 'Postulat: Zapis, którego nie ma w dokumencie źródłowym.' }] },
      expected: ['passage_not_found'],
    },
    {
      name: 'passage on a different page',
      options: { recordOverrides: [{ pdf_page: 2 }] },
      expected: ['pages_mismatch'],
    },
    {
      name: 'absent subchapter left out instead of declared null',
      options: { recordOverrides: [{ subchapter: undefined }] },
      expected: ['field_missing'],
    },
    {
      name: 'tag outside the pinned vocabulary',
      options: { recordOverrides: [{ primary_tag: 'gospodarka' }] },
      expected: ['tag_unknown'],
    },
    {
      name: 'one section declared with two headings',
      options: { recordOverrides: [{}, { section_id: 'sec-srodowisko' }] },
      expected: ['structure_ambiguous'],
    },
    {
      name: 'declared record count disagrees with the dataset',
      options: { manifestOverrides: { expected_proposal_count: 4 } },
      expected: ['record_count_mismatch'],
    },
    {
      name: 'unadopted draft without an admission amendment',
      options: { manifestOverrides: { version: { ...(manifest().version as object), adopted_at: null } } },
      expected: ['admission_refused'],
    },
  ];

  for (const testCase of cases) {
    const { directory, validation } = await prepare(testCase.options);
    try {
      assert.equal(validation.ok, false, `${testCase.name} must be rejected`);
      for (const code of testCase.expected) {
        assert.ok(codes(validation.issues).includes(code),
          `${testCase.name}: expected ${code}, got ${codes(validation.issues).join(', ')}`);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('a coverage ledger that misses a page, a section or a proposal blocks the release', async () => {
  const pages = () => ledger().pages as Array<Record<string, unknown>>;
  const sections = () => ledger().sections as Array<Record<string, unknown>>;
  const missingPage = { ...ledger(), pages: pages().slice(0, 3) };
  const orphanProposal = {
    ...ledger(),
    pages: [...pages().slice(0, 3), { pdf_page: 4, status: 'indexed', proposal_ids: ['prop-nieistniejacy'] }],
  };
  const reviewedOnly = {
    ...ledger(),
    pages: [{ pdf_page: 1, status: 'reviewed' }, ...pages().slice(1)],
  };
  const excludedButIndexed = {
    ...ledger(),
    pages: [{ pdf_page: 1, status: 'excluded', reason: 'strona tytułowa' }, ...pages().slice(1)],
  };
  const missingSection = { ...ledger(), sections: sections().slice(0, 2) };

  const expectations: Array<[Record<string, unknown>, string]> = [
    [missingPage, 'ledger_pages_missing'],
    [orphanProposal, 'ledger_proposal_orphan'],
    [reviewedOnly, 'ledger_status_invalid'],
    [excludedButIndexed, 'ledger_page_conflict'],
    [missingSection, 'ledger_section_missing'],
  ];
  for (const [ledgerOverride, code] of expectations) {
    const { directory, validation } = await prepare({ ledgerOverride });
    try {
      assert.equal(validation.ok, false);
      assert.ok(codes(validation.issues).includes(code),
        `expected ${code}, got ${codes(validation.issues).join(', ')}`);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

/* ── Import, approval, activation ─────────────────────────────────────────────── */

async function importFixture(
  db: Database,
  archiveRoot: string,
  options: BundleOptions = {},
) {
  const prepared = await prepare(options);
  assert.deepEqual(prepared.validation.issues, []);
  const outcome = await importRelease(db, prepared.bundle, prepared.validation, {
    archiveRoot,
    sourceBytes: prepared.sourceBytes,
    structureBytes: prepared.structureBytes,
    datasetBytes: prepared.datasetBytes,
  });
  await rm(prepared.directory, { recursive: true, force: true });
  return outcome;
}

test('import commits an inactive release; only explicit activation makes it searchable', async () => {
  const context = await database();
  const archiveRoot = await mkdtemp(path.join(tmpdir(), 'szronox-archive-'));
  try {
    const outcome = await importFixture(context.db, archiveRoot);
    assert.equal(outcome.state, 'draft');
    assert.equal(outcome.proposals, 3);
    assert.ok(outcome.chunks >= 4);
    assert.equal(await resolveActiveRelease(context.db), null, 'import must not make anything searchable');

    // Activation before approval is refused: the report has to be accepted by a human.
    await assert.rejects(activateRelease(context.db, outcome.releaseSlug, { archiveRoot }),
      (error: { reason?: string }) => error.reason === 'release_state');

    const approved = await approveRelease(context.db, outcome.releaseSlug, 'NOXAVA');
    assert.equal(approved.approved_by, 'NOXAVA');
    assert.equal(await resolveActiveRelease(context.db), null, 'approval alone is not activation');
    await assert.rejects(approveRelease(context.db, outcome.releaseSlug, ''),
      (error: { reason?: string }) => error.reason === 'approver_invalid');

    const activation = await activateRelease(context.db, outcome.releaseSlug, { archiveRoot });
    assert.equal(activation.supersededSlug, null);
    const active = await resolveActiveRelease(context.db);
    assert.equal(active?.releaseSlug, outcome.releaseSlug);
    assert.deepEqual(active?.documentVersionIds, [outcome.documentVersionId]);

    // The enrichment text columns the ranking index reads must agree with the arrays.
    const rows = await context.db.query<{ keywords: string[]; keywords_text: string; tags_text: string;
      primary_tag: string; secondary_tags: string[] }>(
      'select keywords, keywords_text, tags_text, primary_tag, secondary_tags from app.programme_proposals');
    for (const row of rows.rows) {
      assert.equal(row.keywords_text, row.keywords.join(' '));
      assert.equal(row.tags_text, [row.primary_tag, ...row.secondary_tags].join(' '));
    }
  } finally {
    await context.close();
    await rm(archiveRoot, { recursive: true, force: true });
  }
});

test('a second release supersedes the first, and the first stays resolvable', async () => {
  const context = await database();
  const archiveRoot = await mkdtemp(path.join(tmpdir(), 'szronox-archive-'));
  try {
    const first = await importFixture(context.db, archiveRoot);
    await approveRelease(context.db, first.releaseSlug, 'NOXAVA');
    await activateRelease(context.db, first.releaseSlug, { archiveRoot });

    // A corrected edition: new release slug, new version slug, same document.
    const second = await importFixture(context.db, archiveRoot, {
      manifestOverrides: {
        release_id: 'zieloni-programme-test-r2',
        version: { ...(manifest().version as object), document_version_id: 'dv-program-zielonych-test-r2' },
      },
    });
    await approveRelease(context.db, second.releaseSlug, 'SZRON');
    const activation = await activateRelease(context.db, second.releaseSlug, { archiveRoot });
    assert.equal(activation.supersededSlug, first.releaseSlug);

    const states = await context.db.query<{ release_slug: string; state: string }>(
      'select release_slug, state from app.programme_releases order by release_slug');
    assert.deepEqual(states.rows, [
      { release_slug: 'zieloni-programme-test-r1', state: 'superseded' },
      { release_slug: 'zieloni-programme-test-r2', state: 'active' },
    ]);
    const active = await context.db.query<{ count: number }>(
      "select count(*)::int as count from app.programme_releases where state='active'");
    assert.equal(active.rows[0].count, 1, 'exactly one release per corpus is active');

    // The pinned older version still resolves its archived source. This is the property a
    // Reel attachment depends on: publishing a newer release never breaks an old citation.
    const source = await resolveArchivedSource(context.db, first.documentVersionId);
    assert.ok(source?.resolvable);
    const bytes = await readArchivedFile(archiveRoot, source!.archiveKey,
      { sha256: source!.sha256, byteSize: source!.byteSize });
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  } finally {
    await context.close();
    await rm(archiveRoot, { recursive: true, force: true });
  }
});

test('activation refuses a release whose archived bytes changed underneath it', async () => {
  const context = await database();
  const archiveRoot = await mkdtemp(path.join(tmpdir(), 'szronox-archive-'));
  try {
    const outcome = await importFixture(context.db, archiveRoot);
    await approveRelease(context.db, outcome.releaseSlug, 'NOXAVA');
    const key = (await resolveArchivedSource(context.db, outcome.documentVersionId))!.archiveKey;
    // Archived files are written read-only; a tamper has to defeat that first, which is
    // exactly what this test simulates.
    await chmod(path.join(archiveRoot, key), 0o600);
    await writeFile(path.join(archiveRoot, key), Buffer.from('%PDF-1.4 podmienione'));
    await assert.rejects(activateRelease(context.db, outcome.releaseSlug, { archiveRoot }), /archive|size|hash/i);
    assert.equal(await resolveActiveRelease(context.db), null);
  } finally {
    await context.close();
    await rm(archiveRoot, { recursive: true, force: true });
  }
});

test('a release slug and a document version slug are never reused', async () => {
  const context = await database();
  const archiveRoot = await mkdtemp(path.join(tmpdir(), 'szronox-archive-'));
  try {
    await importFixture(context.db, archiveRoot);
    const prepared = await prepare();
    try {
      await assert.rejects(importRelease(context.db, prepared.bundle, prepared.validation, {
        archiveRoot,
        sourceBytes: prepared.sourceBytes,
        structureBytes: prepared.structureBytes,
        datasetBytes: prepared.datasetBytes,
      }), (error: { reason?: string }) => error.reason === 'release_exists');
    } finally { await rm(prepared.directory, { recursive: true, force: true }); }
  } finally {
    await context.close();
    await rm(archiveRoot, { recursive: true, force: true });
  }
});

/* ── Retrieval ────────────────────────────────────────────────────────────────── */

async function activeFixture() {
  const context = await database();
  const archiveRoot = await mkdtemp(path.join(tmpdir(), 'szronox-archive-'));
  const outcome = await importFixture(context.db, archiveRoot);
  await approveRelease(context.db, outcome.releaseSlug, 'NOXAVA');
  await activateRelease(context.db, outcome.releaseSlug, { archiveRoot });
  const release = (await resolveActiveRelease(context.db))!;
  return {
    db: context.db, archiveRoot, release, outcome,
    async close() {
      await context.close();
      await rm(archiveRoot, { recursive: true, force: true });
    },
  };
}

test('retrieval finds the exact proposal, ranks cross-cutting keywords and returns nothing unrelated', async () => {
  const fixture = await activeFixture();
  try {
    const exact = await findEvidence(fixture.db, fixture.release.releaseId,
      searchTerms(['Chcemy zatrzymywać wodę w krajobrazie i odbudowywać mokradła.']));
    assert.ok(exact.length >= 1);
    assert.equal(exact[0].proposal, 'Postulat: Ochrona małej retencji.');
    assert.equal(exact[0].chapter, 'OCHRONA ŚRODOWISKA');
    assert.equal(exact[0].subchapter, null);
    assert.equal(exact[0].category, 'Środowisko');
    assert.deepEqual(exact[0].pdfPages, [1]);
    assert.deepEqual(exact[0].printedPages, ['']);
    assert.equal(exact[0].sourceUrl,
      `/api/v1/programme/versions/${fixture.outcome.documentVersionId}/source#page=1`);
    assert.ok(exact[0].excerpt.includes('retencji'));

    // Cross-cutting: "fotowoltaika" and "prosument" are operator keywords, not words of the
    // passage. Enrichment is what makes the proposal reachable from how a Reel talks.
    const crossCutting = await findEvidence(fixture.db, fixture.release.releaseId,
      searchTerms(['Sąsiedzi chcą razem rozliczać fotowoltaika i zostać prosument.']));
    assert.equal(crossCutting[0].proposal, 'Postulat: Spółdzielnie energetyczne.');
    assert.equal(crossCutting[0].subchapter, 'Energetyka obywatelska');

    const unrelated = await findEvidence(fixture.db, fixture.release.releaseId,
      searchTerms(['Recenzja nowego filmu science fiction oraz ścieżki dźwiękowej.']));
    assert.deepEqual(unrelated, [], 'unrelated content is an empty result, never a weak match');

    // One chunk per proposal, deterministically ordered and bounded.
    const broad = await findEvidence(fixture.db, fixture.release.releaseId,
      searchTerms(['bilet kolejowy mokradła spółdzielnie retencja prosument']));
    assert.equal(new Set(broad.map((item) => item.proposalId)).size, broad.length);
    assert.ok(broad.length <= 8);
    const again = await findEvidence(fixture.db, fixture.release.releaseId,
      searchTerms(['bilet kolejowy mokradła spółdzielnie retencja prosument']));
    assert.deepEqual(again.map((item) => item.chunkId), broad.map((item) => item.chunkId),
      'the same Reel against the same release retrieves the same evidence in the same order');
  } finally { await fixture.close(); }
});

test('every retrieved excerpt is exactly the indexed chunk it cites', async () => {
  const fixture = await activeFixture();
  try {
    const evidence = await findEvidence(fixture.db, fixture.release.releaseId,
      searchTerms(['mokradła kolej spółdzielnie energetyczne retencja']));
    assert.ok(evidence.length > 0);
    for (const candidate of evidence) {
      const stored = await fixture.db.query<{ excerpt: string; pdf_pages: number[]; printed_pages: string[] }>(
        'select excerpt, pdf_pages, printed_pages from app.programme_chunks where id=$1', [candidate.chunkId]);
      assert.equal(candidate.excerpt, stored.rows[0].excerpt);
      assert.deepEqual(candidate.pdfPages, stored.rows[0].pdf_pages);
      assert.deepEqual(candidate.printedPages, stored.rows[0].printed_pages);
    }
  } finally { await fixture.close(); }
});

/* ── Fail-closed behaviour of the run that uses it ────────────────────────────── */

const user = '11111111-1111-4111-8111-111111111111';
const reelId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actor = { id: user, name: 'NOXAVA' as const };

async function reelFixture(db: Database): Promise<void> {
  await db.query("insert into app.users(id,name) values($1,'NOXAVA')", [user]);
  await db.query('insert into app.reels(id,original_input,created_by,script) values($1,$2,$3,$4)',
    [reelId, JSON.stringify({ text: 'Woda' }), user,
      'Mokradła znikają, a woda spływa do morza. Potrzebujemy retencji.']);
}

test('find_programme fails closed without an active release and uses it once activated', async () => {
  const fixture = await activeFixture();
  try {
    await reelFixture(fixture.db);
    const service = new AiService(fixture.db);

    // Withdraw the only active release: the check must report an operator-input error rather
    // than an empty candidate list or a no_match.
    await fixture.db.query(
      "update app.programme_releases set state='withdrawn', withdrawn_at=now(), activated_at=null where state='active'");
    await assert.rejects(service.enqueue(actor, reelId, {
      operationId: '06000000-0000-4000-8000-000000000001', expectedVersion: 1, action: 'find_programme',
    }), (error: { code?: string }) => error.code === 'INSUFFICIENT_EVIDENCE');

    await fixture.db.query(
      "update app.programme_releases set state='active', activated_at=now(), withdrawn_at=null where state='withdrawn'");
    const run = await service.enqueue(actor, reelId, {
      operationId: '06000000-0000-4000-8000-000000000002', expectedVersion: 1, action: 'find_programme',
    });
    const snapshot = await fixture.db.query<{ input_snapshot: {
      programmeEvidence: Array<{ proposal: string; pdfPages: number[] }>;
      programmeReleaseId: string | null; programmeDocumentVersionId: string | null;
    } }>('select input_snapshot from app.ai_runs where id=$1', [run.id]);
    const input = snapshot.rows[0].input_snapshot;
    assert.equal(input.programmeReleaseId, fixture.release.releaseId);
    assert.equal(input.programmeDocumentVersionId, fixture.outcome.documentVersionId);
    assert.ok(input.programmeEvidence.length >= 1);
    assert.equal(input.programmeEvidence[0].proposal, 'Postulat: Ochrona małej retencji.');

    // The snapshot is internal: the wire response never carries the evidence or the release.
    const visible = await service.get(actor, run.id);
    assert.equal((visible.input as unknown as Record<string, unknown>).programmeEvidence, undefined);
    assert.equal((visible.input as unknown as Record<string, unknown>).programmeReleaseId, undefined);
    assert.equal(visible.input.programmeDocumentVersionId, fixture.outcome.documentVersionId);
  } finally { await fixture.close(); }
});

/* ── The archived source route ────────────────────────────────────────────────── */

test('the archived PDF is served version-specifically, authenticated, and verified first', async () => {
  const fixture = await activeFixture();
  const app = Fastify({ logger: false });
  try {
    registerAiRoutes(app, {
      db: fixture.db,
      storage: memoryStorageAdapter(),
      allowlist: [{ id: user, name: 'NOXAVA' }],
      aiEnabled: true,
      programmeArchiveRoot: fixture.archiveRoot,
      async authenticate(request) {
        if (request.headers['x-test-actor'] !== user) throw unauthenticated();
        return actor;
      },
    });
    await app.ready();
    const url = `/api/v1/programme/versions/${fixture.outcome.documentVersionId}/source`;

    const anonymous = await app.inject({ method: 'GET', url });
    assert.equal(anonymous.statusCode, 401, 'the archive is behind the same session as everything else');

    const served = await app.inject({ method: 'GET', url, headers: { 'x-test-actor': user } });
    assert.equal(served.statusCode, 200);
    assert.equal(served.headers['content-type'], 'application/pdf');
    assert.equal(served.headers['cache-control'], 'private, no-store');
    assert.equal(served.headers['x-content-type-options'], 'nosniff');
    assert.match(String(served.headers['content-disposition']), /ProgramTest\.pdf/);
    assert.equal(served.rawPayload.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.equal(Number(served.headers['content-length']), served.rawPayload.byteLength);

    // A version that was never released is not an archive anyone may read.
    const stranger = await app.inject({
      method: 'GET', headers: { 'x-test-actor': user },
      url: '/api/v1/programme/versions/07000000-0000-4000-8000-000000000001/source',
    });
    assert.equal(stranger.statusCode, 404);

    // Capability reporting follows the release, not the presence of rows.
    const capabilities = await app.inject({
      method: 'GET', url: '/api/v1/ai/capabilities', headers: { 'x-test-actor': user },
    });
    assert.deepEqual(capabilities.json(), { enabled: true, programmeIndexed: true });

    // A replaced file is reported, never served as if it were the cited document.
    const key = (await resolveArchivedSource(fixture.db, fixture.outcome.documentVersionId))!.archiveKey;
    await chmod(path.join(fixture.archiveRoot, key), 0o600);
    await writeFile(path.join(fixture.archiveRoot, key), Buffer.from('%PDF-1.4 podmienione'));
    const tampered = await app.inject({ method: 'GET', url, headers: { 'x-test-actor': user } });
    assert.equal(tampered.statusCode, 503);
    assert.equal(tampered.json().error.code, 'PROVIDER_UNAVAILABLE');
  } finally {
    await app.close();
    await fixture.close();
  }
});

test('with no archive root configured the source route says so instead of guessing', async () => {
  const fixture = await activeFixture();
  const app = Fastify({ logger: false });
  try {
    registerAiRoutes(app, {
      db: fixture.db,
      storage: memoryStorageAdapter(),
      allowlist: [{ id: user, name: 'NOXAVA' }],
      aiEnabled: true,
      async authenticate() { return actor; },
    });
    await app.ready();
    const response = await app.inject({
      method: 'GET', url: `/api/v1/programme/versions/${fixture.outcome.documentVersionId}/source`,
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'PROVIDER_UNAVAILABLE');
  } finally {
    await app.close();
    await fixture.close();
  }
});

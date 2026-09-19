/**
 * The operator handover bundle: reading it, and refusing it when it is wrong.
 *
 * One directory is the whole input boundary (specification §8). It holds the archived PDF,
 * the DOCX that shares its basename, the manifest, the semantic dataset, the pinned
 * category vocabulary and the coverage ledger. Nothing else is consulted — no network, no
 * model, no defaulting of a field the operator left out.
 *
 * Canonical input is UTF-8 JSON. CSV is an adapter over the same columns with JSON-encoded
 * array cells, and both formats are checked by the code below rather than by two validators
 * that could drift apart.
 *
 * Every rejection is collected with a machine code and the record it came from, because an
 * operator fixing 800 records needs the list, not the first failure. Nothing here repairs a
 * record: a malformed passage is an operator correction, never an automatic one.
 */

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const SLUG = /^[a-z0-9][a-z0-9._-]{2,119}$/;
const ENTRY_ID = /^[a-z0-9][a-z0-9._-]{1,119}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface Issue {
  code: string;
  message: string;
  /** Which record raised it, when it came from one. */
  at?: string;
}

export class IssueList {
  readonly issues: Issue[] = [];
  add(code: string, message: string, at?: string): void {
    if (this.issues.length < 2000) this.issues.push(at === undefined ? { code, message } : { code, message, at });
  }
  get ok(): boolean { return this.issues.length === 0; }
}

export class BundleError extends Error {
  readonly issues: readonly Issue[];
  constructor(message: string, issues: readonly Issue[]) {
    super(message);
    this.name = 'BundleError';
    this.issues = issues;
  }
}

/* ── Field readers ────────────────────────────────────────────────────────────── */

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function text(source: Raw, key: string, issues: IssueList, at: string, max: number, min = 1): string {
  const value = source[key];
  if (typeof value !== 'string' || value.length < min || value.length > max || value.trim() === '') {
    issues.add('field_invalid', `${key} must be text of 1..${max} characters`, at);
    return '';
  }
  return value;
}

function optionalText(source: Raw, key: string, issues: IssueList, at: string, max: number): string | null {
  const value = source[key];
  if (value === null) return null;
  if (value === undefined) {
    issues.add('field_missing', `${key} must be present, and explicitly null when the source has none`, at);
    return null;
  }
  return text(source, key, issues, at, max);
}

function integer(source: Raw, key: string, issues: IssueList, at: string, min: number, max: number): number {
  const value = source[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    issues.add('field_invalid', `${key} must be an integer from ${min} to ${max}`, at);
    return min;
  }
  return value;
}

function slug(source: Raw, key: string, issues: IssueList, at: string, pattern = SLUG): string {
  const value = source[key];
  if (typeof value !== 'string' || !pattern.test(value)) {
    issues.add('field_invalid', `${key} must be a stable lower-case slug`, at);
    return '';
  }
  return value;
}

function stringArray(source: Raw, key: string, issues: IssueList, at: string, maxCount: number, maxLength: number): string[] {
  const value = source[key];
  if (!Array.isArray(value) || value.length > maxCount) {
    issues.add('field_invalid', `${key} must be an array of at most ${maxCount} strings`, at);
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > maxLength) {
      issues.add('field_invalid', `${key} contains an invalid entry`, at);
      continue;
    }
    out.push(entry);
  }
  return out;
}

function object(source: Raw, key: string, issues: IssueList, at: string): Raw {
  const value = source[key];
  if (!isObject(value)) {
    issues.add('field_invalid', `${key} must be an object`, at);
    return {};
  }
  return value;
}

/* ── Manifest ─────────────────────────────────────────────────────────────────── */

export interface AdmissionAmendment {
  approvedBy: string;
  approvedAt: string;
  statement: string;
  /** Set when the source has no public URL and the operator accepted the archived copy. */
  unpublishedSource: boolean;
}

export interface BundleManifest {
  corpusId: string;
  releaseId: string;
  releaseLabel: string;
  categoryVocabularyId: string;
  importedBy: string;
  expectedProposalCount: number;
  notes: string | null;
  document: {
    documentId: string;
    title: string;
    documentType: 'programme' | 'resolution' | 'programme_annex';
    issuingBody: string;
    admissionRationale: string;
    admissionAmendment: AdmissionAmendment | null;
  };
  version: {
    documentVersionId: string;
    sourceTitle: string;
    edition: string;
    adoptedAt: string | null;
    language: 'pl';
    sourceFileName: string;
    structureFileName: string;
    datasetFileName: string;
    sourceUrl: string | null;
    sourceSha256: string;
    retrievedAt: string;
    pageCount: number;
    printedPageLabels: string[];
    structureCoverage: 'full' | 'partial';
  };
  ingestion: {
    ingestedBy: string;
    normalizationProfileId: string;
    punctuationMap: Record<string, string>;
    chunking: { targetChars: number; maxChars: number; minChars: number; overlap: 'none' | 'one_sentence' };
    structureSource: 'document_headings' | 'operator_declared' | 'mixed';
    excludedRanges: Array<{ pages: number[]; reason: string }>;
    headerFooter: { dropExactLines: string[]; dropPrintedPageLabelLines: boolean };
    categoryFromPrimaryTag: boolean;
    notes: string | null;
  };
}

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,120}$/;

function fileName(source: Raw, key: string, issues: IssueList, at: string, extension: string): string {
  const value = text(source, key, issues, at, 128);
  if (value === '') return '';
  if (!FILE_NAME.test(value) || value.includes('..') || !value.toLowerCase().endsWith(extension)) {
    issues.add('field_invalid', `${key} must be a plain ${extension} file name in the bundle directory`, at);
    return '';
  }
  return value;
}

function parseManifest(raw: unknown, issues: IssueList): BundleManifest {
  const source = isObject(raw) ? raw : {};
  if (!isObject(raw)) issues.add('manifest_invalid', 'manifest.json must contain one JSON object', 'manifest');

  const documentRaw = object(source, 'document', issues, 'manifest.document');
  const versionRaw = object(source, 'version', issues, 'manifest.version');
  const ingestionRaw = object(source, 'ingestion', issues, 'manifest.ingestion');
  const chunkingRaw = object(ingestionRaw, 'chunking', issues, 'manifest.ingestion.chunking');
  const headerFooterRaw = object(ingestionRaw, 'header_footer', issues, 'manifest.ingestion.header_footer');

  const documentType = documentRaw.document_type;
  if (documentType !== 'programme' && documentType !== 'resolution' && documentType !== 'programme_annex') {
    issues.add('field_invalid', 'document_type must be programme, resolution or programme_annex', 'manifest.document');
  }
  const structureCoverage = versionRaw.structure_coverage;
  if (structureCoverage !== 'full' && structureCoverage !== 'partial') {
    issues.add('field_invalid', 'structure_coverage must be full or partial', 'manifest.version');
  }
  const structureSource = ingestionRaw.structure_source;
  if (structureSource !== 'document_headings' && structureSource !== 'operator_declared' && structureSource !== 'mixed') {
    issues.add('field_invalid', 'structure_source must be document_headings, operator_declared or mixed', 'manifest.ingestion');
  }
  const overlap = chunkingRaw.overlap;
  if (overlap !== 'none' && overlap !== 'one_sentence') {
    issues.add('field_invalid', 'chunking.overlap must be none or one_sentence', 'manifest.ingestion.chunking');
  }
  if (versionRaw.language !== 'pl') {
    issues.add('language_not_admitted', 'Only a Polish source is admissible without separate operator approval', 'manifest.version');
  }

  const adoptedAtRaw = versionRaw.adopted_at;
  let adoptedAt: string | null = null;
  if (typeof adoptedAtRaw === 'string' && ISO_DATE.test(adoptedAtRaw)) adoptedAt = adoptedAtRaw;
  else if (adoptedAtRaw !== null) {
    issues.add('field_invalid', 'adopted_at must be an ISO date, or explicitly null for an unadopted source', 'manifest.version');
  }

  let amendment: AdmissionAmendment | null = null;
  const amendmentRaw = documentRaw.admission_amendment;
  if (isObject(amendmentRaw)) {
    const approvedAt = amendmentRaw.approved_at;
    if (typeof approvedAt !== 'string' || !ISO_DATE.test(approvedAt)) {
      issues.add('field_invalid', 'admission_amendment.approved_at must be an ISO date', 'manifest.document');
    }
    amendment = {
      approvedBy: text(amendmentRaw, 'approved_by', issues, 'manifest.document.admission_amendment', 200),
      approvedAt: typeof approvedAt === 'string' ? approvedAt : '',
      statement: text(amendmentRaw, 'statement', issues, 'manifest.document.admission_amendment', 2000),
      unpublishedSource: amendmentRaw.unpublished_source === true,
    };
  } else if (amendmentRaw !== null && amendmentRaw !== undefined) {
    issues.add('field_invalid', 'admission_amendment must be an object or null', 'manifest.document');
  }

  const sourceUrlRaw = versionRaw.source_url;
  let sourceUrl: string | null = null;
  if (typeof sourceUrlRaw === 'string') {
    try {
      const url = new URL(sourceUrlRaw);
      if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') throw new Error('not https');
      sourceUrl = url.toString();
    } catch {
      issues.add('field_invalid', 'source_url must be an HTTPS URL without credentials', 'manifest.version');
    }
  } else if (sourceUrlRaw !== null && sourceUrlRaw !== undefined) {
    issues.add('field_invalid', 'source_url must be a string or null', 'manifest.version');
  }

  const pageCount = integer(versionRaw, 'page_count', issues, 'manifest.version', 1, 5000);
  const labelsRaw = versionRaw.printed_page_labels;
  let printedPageLabels: string[] = [];
  if (!Array.isArray(labelsRaw) || labelsRaw.length !== pageCount
    || labelsRaw.some((entry) => typeof entry !== 'string' || entry.length > 32)) {
    issues.add('printed_labels_invalid',
      'printed_page_labels must list one label per physical page; an unlabelled page is an empty string',
      'manifest.version');
  } else {
    printedPageLabels = labelsRaw as string[];
  }

  const excludedRanges: Array<{ pages: number[]; reason: string }> = [];
  const excludedRaw = ingestionRaw.excluded_ranges;
  if (!Array.isArray(excludedRaw)) {
    issues.add('field_invalid', 'excluded_ranges must be an array, empty when nothing was excluded', 'manifest.ingestion');
  } else {
    excludedRaw.forEach((entry, index) => {
      const at = `manifest.ingestion.excluded_ranges[${index}]`;
      if (!isObject(entry)) { issues.add('field_invalid', 'excluded range must be an object', at); return; }
      const pages = Array.isArray(entry.pages)
        ? entry.pages.filter((page): page is number => Number.isInteger(page) && (page as number) >= 1)
        : [];
      if (!Array.isArray(entry.pages) || pages.length !== entry.pages.length || pages.length === 0) {
        issues.add('field_invalid', 'excluded range pages must be physical page numbers', at);
      }
      excludedRanges.push({ pages, reason: text(entry, 'reason', issues, at, 500) });
    });
  }

  const punctuationMap: Record<string, string> = {};
  const punctuationRaw = ingestionRaw.punctuation_map;
  if (isObject(punctuationRaw)) {
    for (const [from, to] of Object.entries(punctuationRaw)) {
      if ([...from].length !== 1 || typeof to !== 'string' || to.length > 4) {
        issues.add('field_invalid', 'punctuation_map maps one source character to its replacement', 'manifest.ingestion');
        continue;
      }
      punctuationMap[from] = to;
    }
  } else if (punctuationRaw !== undefined) {
    issues.add('field_invalid', 'punctuation_map must be an object', 'manifest.ingestion');
  }

  const notes = typeof source.notes === 'string' ? source.notes.slice(0, 4000) : null;
  const ingestionNotes = typeof ingestionRaw.notes === 'string' ? ingestionRaw.notes.slice(0, 4000) : null;

  return {
    corpusId: slug(source, 'corpus_id', issues, 'manifest'),
    releaseId: slug(source, 'release_id', issues, 'manifest'),
    releaseLabel: text(source, 'release_label', issues, 'manifest', 300),
    categoryVocabularyId: slug(source, 'category_vocabulary_id', issues, 'manifest'),
    importedBy: text(source, 'imported_by', issues, 'manifest', 200),
    expectedProposalCount: integer(source, 'expected_proposal_count', issues, 'manifest', 1, 20000),
    notes,
    document: {
      documentId: slug(documentRaw, 'document_id', issues, 'manifest.document'),
      title: text(documentRaw, 'title', issues, 'manifest.document', 300),
      documentType: (documentType === 'resolution' || documentType === 'programme_annex' ? documentType : 'programme'),
      issuingBody: text(documentRaw, 'issuing_body', issues, 'manifest.document', 300),
      admissionRationale: text(documentRaw, 'admission_rationale', issues, 'manifest.document', 2000),
      admissionAmendment: amendment,
    },
    version: {
      documentVersionId: slug(versionRaw, 'document_version_id', issues, 'manifest.version'),
      sourceTitle: text(versionRaw, 'source_title', issues, 'manifest.version', 300),
      edition: text(versionRaw, 'edition', issues, 'manifest.version', 300),
      adoptedAt,
      language: 'pl',
      sourceFileName: fileName(versionRaw, 'source_file_name', issues, 'manifest.version', '.pdf'),
      structureFileName: fileName(versionRaw, 'structure_file_name', issues, 'manifest.version', '.docx'),
      datasetFileName: text(versionRaw, 'dataset_file_name', issues, 'manifest.version', 128),
      sourceUrl,
      sourceSha256: (() => {
        const value = versionRaw.source_sha256;
        if (typeof value !== 'string' || !SHA256.test(value)) {
          issues.add('field_invalid', 'source_sha256 must be a lower-case SHA-256 digest', 'manifest.version');
          return '';
        }
        return value;
      })(),
      retrievedAt: (() => {
        const value = versionRaw.retrieved_at;
        if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
          issues.add('field_invalid', 'retrieved_at must be an ISO timestamp', 'manifest.version');
          return new Date(0).toISOString();
        }
        return new Date(value).toISOString();
      })(),
      pageCount,
      printedPageLabels,
      structureCoverage: structureCoverage === 'partial' ? 'partial' : 'full',
    },
    ingestion: {
      ingestedBy: text(ingestionRaw, 'ingested_by', issues, 'manifest.ingestion', 200),
      normalizationProfileId: slug(ingestionRaw, 'normalization_profile_id', issues, 'manifest.ingestion'),
      punctuationMap,
      chunking: {
        targetChars: integer(chunkingRaw, 'target_chars', issues, 'manifest.ingestion.chunking', 200, 2000),
        maxChars: integer(chunkingRaw, 'max_chars', issues, 'manifest.ingestion.chunking', 200, 4000),
        minChars: integer(chunkingRaw, 'min_chars', issues, 'manifest.ingestion.chunking', 50, 2000),
        overlap: overlap === 'one_sentence' ? 'one_sentence' : 'none',
      },
      structureSource: (structureSource === 'document_headings' || structureSource === 'mixed'
        ? structureSource : 'operator_declared'),
      excludedRanges,
      headerFooter: {
        dropExactLines: stringArray(headerFooterRaw, 'drop_exact_lines', issues, 'manifest.ingestion.header_footer', 64, 300),
        dropPrintedPageLabelLines: headerFooterRaw.drop_printed_page_label_lines === true,
      },
      categoryFromPrimaryTag: ingestionRaw.category_from_primary_tag === true,
      notes: ingestionNotes,
    },
  };
}

/* ── Vocabulary ───────────────────────────────────────────────────────────────── */

export interface VocabularyEntry { id: string; label: string; definition: string }
export interface Vocabulary { vocabularyId: string; entries: VocabularyEntry[] }

function parseVocabulary(raw: unknown, issues: IssueList): Vocabulary {
  const source = isObject(raw) ? raw : {};
  if (!isObject(raw)) issues.add('vocabulary_invalid', 'vocabulary.json must contain one JSON object', 'vocabulary');
  const entries: VocabularyEntry[] = [];
  const list = source.entries;
  if (!Array.isArray(list) || list.length === 0 || list.length > 500) {
    issues.add('vocabulary_invalid', 'vocabulary entries must be a non-empty array of at most 500 entries', 'vocabulary');
  } else {
    const seen = new Set<string>();
    list.forEach((entry, index) => {
      const at = `vocabulary.entries[${index}]`;
      if (!isObject(entry)) { issues.add('vocabulary_invalid', 'entry must be an object', at); return; }
      const id = slug(entry, 'id', issues, at, ENTRY_ID);
      if (id !== '' && seen.has(id)) { issues.add('vocabulary_duplicate', `duplicate vocabulary id ${id}`, at); return; }
      if (id !== '') seen.add(id);
      entries.push({
        id,
        label: text(entry, 'label', issues, at, 200),
        definition: text(entry, 'definition', issues, at, 1000),
      });
    });
  }
  return { vocabularyId: slug(source, 'vocabulary_id', issues, 'vocabulary'), entries };
}

/* ── Proposal records ─────────────────────────────────────────────────────────── */

export interface ProposalRecord {
  proposalId: string;
  sectionId: string;
  chapter: string;
  subchapter: string | null;
  orderIndex: number;
  title: string;
  text: string;
  category: string;
  primaryTag: string;
  secondaryTags: string[];
  keywords: string[];
  pdfPages: number[];
}

/**
 * One record reader for both formats.
 *
 * `pdf_page` and `pdf_pages` are alternatives, never both, and an array enumerates every
 * physical page the passage touches rather than a start/end pair — a two-element array is
 * two pages, not a range, and a passage that spans three pages must list three.
 */
function parseRecord(raw: unknown, index: number, issues: IssueList, manifest: BundleManifest): ProposalRecord | null {
  const at = `record[${index}]`;
  if (!isObject(raw)) { issues.add('record_invalid', 'record must be an object', at); return null; }

  const hasSingle = raw.pdf_page !== undefined && raw.pdf_page !== null;
  const hasMany = raw.pdf_pages !== undefined && raw.pdf_pages !== null;
  if (hasSingle && hasMany) {
    issues.add('pages_ambiguous', 'a record declares pdf_page and pdf_pages; exactly one is allowed', at);
  }
  let pdfPages: number[] = [];
  if (hasSingle && !hasMany) {
    const page = raw.pdf_page;
    if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > manifest.version.pageCount) {
      issues.add('pages_invalid', 'pdf_page must be a physical page of the archived file', at);
    } else pdfPages = [page as number];
  } else if (hasMany && !hasSingle) {
    const pages = raw.pdf_pages;
    if (!Array.isArray(pages) || pages.length === 0 || pages.length > 200) {
      issues.add('pages_invalid', 'pdf_pages must enumerate one to 200 physical pages', at);
    } else {
      const parsed = pages.filter((page): page is number =>
        Number.isInteger(page) && (page as number) >= 1 && (page as number) <= manifest.version.pageCount);
      if (parsed.length !== pages.length) {
        issues.add('pages_invalid', 'pdf_pages contains a page outside the archived file', at);
      } else if (parsed.some((page, position) => position > 0 && page <= parsed[position - 1])) {
        issues.add('pages_invalid', 'pdf_pages must be ascending and free of duplicates', at);
      } else if (parsed.length > 1 && parsed[parsed.length - 1] - parsed[0] !== parsed.length - 1) {
        issues.add('pages_invalid', 'pdf_pages must enumerate every page in the span, not its endpoints', at);
      } else pdfPages = parsed;
    }
  } else if (!hasSingle && !hasMany) {
    issues.add('pages_missing', 'a record must declare pdf_page or pdf_pages', at);
  }

  const secondaryTags = stringArray(raw, 'secondary_tags', issues, at, 12, 120);
  const keywords = stringArray(raw, 'keywords', issues, at, 40, 120);
  const categoryRaw = raw.category;
  let category = '';
  if (typeof categoryRaw === 'string') category = categoryRaw;
  else if (categoryRaw === undefined || categoryRaw === null) {
    if (!manifest.ingestion.categoryFromPrimaryTag) {
      issues.add('category_missing',
        'a record has no category and the manifest did not map primary tags onto the vocabulary', at);
    }
  } else issues.add('field_invalid', 'category must be a string or absent', at);

  const record: ProposalRecord = {
    proposalId: text(raw, 'proposal_id', issues, at, 200),
    sectionId: text(raw, 'section_id', issues, at, 200),
    chapter: text(raw, 'chapter', issues, at, 500),
    subchapter: optionalText(raw, 'subchapter', issues, at, 500),
    orderIndex: integer(raw, 'order_index', issues, at, 0, 100000),
    title: text(raw, 'title', issues, at, 500),
    text: text(raw, 'text', issues, at, 200000),
    category,
    primaryTag: text(raw, 'primary_tag', issues, at, 120),
    secondaryTags,
    keywords,
    pdfPages,
  };
  return record;
}

const CSV_COLUMNS = [
  'proposal_id', 'section_id', 'chapter', 'subchapter', 'order_index', 'title', 'text',
  'category', 'primary_tag', 'secondary_tags', 'keywords', 'pdf_pages', 'pdf_page',
] as const;

/** RFC 4180 rows: quoted fields, doubled quotes, embedded newlines. */
export function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1; continue; }
        quoted = false;
        continue;
      }
      field += character;
      continue;
    }
    if (character === '"' && field === '') { quoted = true; started = true; continue; }
    if (character === ',') { row.push(field); field = ''; started = true; continue; }
    if (character === '\r') continue;
    if (character === '\n') {
      row.push(field);
      if (row.length > 1 || row[0] !== '' || started) rows.push(row);
      row = [];
      field = '';
      started = false;
      continue;
    }
    field += character;
    started = true;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Turn CSV rows into the same shape the JSON reader produces.
 *
 * Array cells hold JSON (`["a","b"]`), so one validator decides what an array means in
 * either format. An empty cell means the field is absent; the literal `null` means the
 * operator is declaring it absent in the source, which is what `subchapter` requires.
 */
function csvToRecords(source: string, issues: IssueList): unknown[] {
  const rows = parseCsv(source);
  if (rows.length === 0) { issues.add('dataset_invalid', 'CSV dataset is empty', 'dataset'); return []; }
  const header = rows[0].map((column) => column.trim());
  const unknown = header.filter((column) => !(CSV_COLUMNS as readonly string[]).includes(column));
  if (unknown.length > 0) {
    issues.add('dataset_invalid', `CSV dataset has unknown columns: ${unknown.join(', ')}`, 'dataset');
  }
  const jsonColumns = new Set(['secondary_tags', 'keywords', 'pdf_pages']);
  const records: unknown[] = [];
  rows.slice(1).forEach((row, index) => {
    if (row.length === 1 && row[0].trim() === '') return;
    const at = `record[${index}]`;
    if (row.length !== header.length) {
      issues.add('record_invalid', `CSV row has ${row.length} cells, header has ${header.length}`, at);
      return;
    }
    const record: Raw = {};
    header.forEach((column, position) => {
      const cell = row[position];
      if (cell === '') return;
      if (jsonColumns.has(column)) {
        try { record[column] = JSON.parse(cell); }
        catch { issues.add('record_invalid', `${column} must hold a JSON array`, at); }
        return;
      }
      if (column === 'order_index' || column === 'pdf_page') {
        const value = Number(cell);
        if (!Number.isInteger(value)) { issues.add('record_invalid', `${column} must be an integer`, at); return; }
        record[column] = value;
        return;
      }
      if (column === 'subchapter' && cell === 'null') { record[column] = null; return; }
      record[column] = cell;
    });
    if (!header.includes('subchapter')) record.subchapter = undefined;
    records.push(record);
  });
  return records;
}

/* ── Coverage ledger ──────────────────────────────────────────────────────────── */

export interface LedgerPage {
  pdfPage: number;
  status: 'indexed' | 'excluded';
  reason: string | null;
  proposalIds: string[];
}
export interface LedgerSection {
  sectionId: string;
  status: 'indexed' | 'excluded';
  reason: string | null;
}
export interface CoverageLedger { pages: LedgerPage[]; sections: LedgerSection[] }

function parseLedger(raw: unknown, issues: IssueList): CoverageLedger {
  const source = isObject(raw) ? raw : {};
  if (!isObject(raw)) issues.add('ledger_invalid', 'coverage.json must contain one JSON object', 'ledger');
  const pages: LedgerPage[] = [];
  const sections: LedgerSection[] = [];

  const pagesRaw = source.pages;
  if (!Array.isArray(pagesRaw)) issues.add('ledger_invalid', 'coverage pages must be an array', 'ledger');
  else {
    pagesRaw.forEach((entry, index) => {
      const at = `ledger.pages[${index}]`;
      if (!isObject(entry)) { issues.add('ledger_invalid', 'coverage page must be an object', at); return; }
      const status = entry.status;
      if (status !== 'indexed' && status !== 'excluded') {
        // "Reviewed" is not an outcome: a page is either indexed or excluded with a reason.
        issues.add('ledger_status_invalid', 'coverage status must be indexed or excluded', at);
        return;
      }
      const reason = status === 'excluded' ? text(entry, 'reason', issues, at, 500) : null;
      pages.push({
        pdfPage: integer(entry, 'pdf_page', issues, at, 1, 5000),
        status,
        reason,
        proposalIds: status === 'indexed' ? stringArray(entry, 'proposal_ids', issues, at, 2000, 200) : [],
      });
    });
  }

  const sectionsRaw = source.sections;
  if (!Array.isArray(sectionsRaw)) issues.add('ledger_invalid', 'coverage sections must be an array', 'ledger');
  else {
    sectionsRaw.forEach((entry, index) => {
      const at = `ledger.sections[${index}]`;
      if (!isObject(entry)) { issues.add('ledger_invalid', 'coverage section must be an object', at); return; }
      const status = entry.status;
      if (status !== 'indexed' && status !== 'excluded') {
        issues.add('ledger_status_invalid', 'coverage status must be indexed or excluded', at);
        return;
      }
      sections.push({
        sectionId: text(entry, 'section_id', issues, at, 200),
        status,
        reason: status === 'excluded' ? text(entry, 'reason', issues, at, 500) : null,
      });
    });
  }
  return { pages, sections };
}

/* ── Bundle ───────────────────────────────────────────────────────────────────── */

export interface ArchivedFile {
  fileName: string;
  absolutePath: string;
  byteSize: number;
  sha256: string;
}

export interface LoadedBundle {
  directory: string;
  manifest: BundleManifest;
  vocabulary: Vocabulary;
  records: ProposalRecord[];
  ledger: CoverageLedger;
  source: ArchivedFile;
  structure: ArchivedFile;
  dataset: ArchivedFile;
  issues: readonly Issue[];
}

const MAX_SOURCE_BYTES = 60_000_000;
const MAX_DATASET_BYTES = 80_000_000;

async function readArchived(directory: string, name: string, maxBytes: number): Promise<ArchivedFile> {
  const absolute = path.resolve(directory, name);
  if (path.dirname(absolute) !== path.resolve(directory)) {
    throw new BundleError('Bundle file names must not contain a path', [
      { code: 'path_invalid', message: `${name} is not a plain file name in the bundle directory` },
    ]);
  }
  const info = await stat(absolute);
  if (!info.isFile() || info.size === 0 || info.size > maxBytes) {
    throw new BundleError('Bundle file is missing or out of bounds', [
      { code: 'file_invalid', message: `${name} must be a file of 1..${maxBytes} bytes` },
    ]);
  }
  const bytes = await readFile(absolute);
  return {
    fileName: name,
    absolutePath: absolute,
    byteSize: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

async function readJson(directory: string, name: string, issues: IssueList): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.resolve(directory, name), 'utf8'));
  } catch (error) {
    issues.add('file_unreadable', `${name} is missing or is not valid UTF-8 JSON: ${(error as Error).message}`, name);
    return null;
  }
}

/**
 * Read and structurally validate a bundle directory.
 *
 * Structural only: this says the input is well formed and internally consistent. Whether
 * each passage really appears on the pages it claims is decided against the archived PDF
 * in `validate.ts`, because that check needs the extracted document text.
 */
export async function loadBundle(directory: string): Promise<LoadedBundle> {
  const issues = new IssueList();
  const manifestRaw = await readJson(directory, 'manifest.json', issues);
  const manifest = parseManifest(manifestRaw, issues);
  const vocabulary = parseVocabulary(await readJson(directory, 'vocabulary.json', issues), issues);
  const ledger = parseLedger(await readJson(directory, 'coverage.json', issues), issues);

  if (manifest.version.sourceFileName === '' || manifest.version.structureFileName === '') {
    throw new BundleError('Bundle manifest does not name its archived files', issues.issues);
  }
  // The DOCX is a structural aid for the operator, and sharing the PDF's basename is how a
  // bundle states that the two describe the same document rather than two different ones.
  const sourceBase = manifest.version.sourceFileName.replace(/\.pdf$/i, '');
  const structureBase = manifest.version.structureFileName.replace(/\.docx$/i, '');
  if (sourceBase !== structureBase) {
    issues.add('basename_mismatch', 'The PDF and DOCX must share one basename', 'manifest.version');
  }

  const source = await readArchived(directory, manifest.version.sourceFileName, MAX_SOURCE_BYTES);
  const structure = await readArchived(directory, manifest.version.structureFileName, MAX_SOURCE_BYTES);
  const dataset = await readArchived(directory, manifest.version.datasetFileName, MAX_DATASET_BYTES);

  const datasetText = await readFile(dataset.absolutePath, 'utf8');
  let rawRecords: unknown[] = [];
  if (manifest.version.datasetFileName.toLowerCase().endsWith('.csv')) {
    rawRecords = csvToRecords(datasetText, issues);
  } else {
    try {
      const parsed = JSON.parse(datasetText) as unknown;
      const list = isObject(parsed) ? (parsed as Raw).records : null;
      if (!Array.isArray(list)) issues.add('dataset_invalid', 'dataset must hold a records array', 'dataset');
      else rawRecords = list;
    } catch (error) {
      issues.add('dataset_invalid', `dataset is not valid JSON: ${(error as Error).message}`, 'dataset');
    }
  }
  if (rawRecords.length > 20000) {
    issues.add('dataset_invalid', 'dataset exceeds 20000 records', 'dataset');
    rawRecords = rawRecords.slice(0, 20000);
  }

  const records: ProposalRecord[] = [];
  rawRecords.forEach((raw, index) => {
    const record = parseRecord(raw, index, issues, manifest);
    if (record) records.push(record);
  });

  return { directory, manifest, vocabulary, records, ledger, source, structure, dataset, issues: issues.issues };
}

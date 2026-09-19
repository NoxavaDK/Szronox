/**
 * Source grounding, coverage and the validation report.
 *
 * `bundle.ts` decides whether the operator's input is well formed. This module decides
 * whether it is *true of the archived PDF*: every passage is located in the text extracted
 * from those exact bytes, its physical pages are derived from that location, and the
 * derived pages must equal the pages the operator declared. A passage that cannot be found,
 * or is found twice, or is found somewhere else, is an operator correction — never an
 * automatic repair and never something a model is asked about.
 *
 * Chunks, offsets, page arrays and printed labels are all produced here, from the located
 * span. That is what makes `ProgrammeCitation` reconstructable: every field it carries
 * traces back to a character range in a hashed document text derived from a hashed file.
 *
 * The result of a failed validation is a list, not an exception. An operator repairing a
 * bundle needs every rejection at once, indexed by the record that caused it.
 */

import { createHash } from 'node:crypto';

import {
  type CoverageLedger,
  type Issue,
  IssueList,
  type LoadedBundle,
  type ProposalRecord,
  type VocabularyEntry,
} from './bundle.js';
import { chunkProposal, estimateTokens, type GeneratedChunk } from './chunking.js';
import {
  assembleDocument,
  type NormalizedDocument,
  normalizeKeywords,
  normalizePassage,
  pagesForRange,
  printedLabelsFor,
} from './normalize.js';
import { EXTRACTION_TOOL, extractPdfText } from './pdf-text.js';

export interface ResolvedSection {
  sectionSlug: string;
  chapter: string;
  subchapter: string | null;
  orderIndex: number;
  startPdfPage: number;
  endPdfPage: number;
}

export interface ResolvedChunk {
  externalId: string;
  orderIndex: number;
  text: string;
  charStart: number;
  charEnd: number;
  pdfPages: number[];
  printedPages: string[];
  tokenEstimate: number;
}

export interface ResolvedProposal {
  externalId: string;
  sectionSlug: string;
  orderIndex: number;
  title: string;
  text: string;
  category: string;
  primaryTag: string;
  secondaryTags: string[];
  keywords: string[];
  keywordsRaw: string[];
  charStart: number;
  charEnd: number;
  pdfPages: number[];
  printedPages: string[];
  chunks: ResolvedChunk[];
}

export interface ValidationReport {
  releaseId: string;
  documentVersionId: string;
  generatedAt: string;
  extraction: {
    tool: string;
    pageCount: number;
    normalizedLength: number;
    normalizedSha256: string;
    undecodedCharacters: number;
    warnings: string[];
    droppedLines: Array<{ pdfPage: number; line: string; rule: string }>;
  };
  hashes: { source: string; structure: string; dataset: string };
  counts: {
    sections: number;
    proposals: number;
    chunks: number;
    perChapter: Array<{ chapter: string; sections: number; proposals: number }>;
    perTag: Array<{ tag: string; primary: number; secondary: number }>;
  };
  pageCoverage: {
    pageCount: number;
    indexedPages: number[];
    excludedPages: Array<{ pdfPage: number; reason: string }>;
    unaccountedPages: number[];
  };
  /** The §7 checks a human still has to do by eye, with the exact samples to look at. */
  manualChecks: {
    sampleChunks: Array<{ chunkId: string; pdfPages: number[]; printedPages: string[]; text: string }>;
    pageSpanningChunk: { chunkId: string; pdfPages: number[] } | null;
    listChunk: { chunkId: string; text: string } | null;
    frontMatterPage: { pdfPage: number; printedPage: string } | null;
    bodyPage: { pdfPage: number; printedPage: string } | null;
  };
  admission: {
    documentType: string;
    adoptedAt: string | null;
    amendment: { approvedBy: string; approvedAt: string; statement: string } | null;
    publicSourceUrl: string | null;
  };
  issues: Issue[];
}

export interface ValidationResult {
  ok: boolean;
  issues: readonly Issue[];
  report: ValidationReport;
  document: NormalizedDocument;
  sections: ResolvedSection[];
  proposals: ResolvedProposal[];
  vocabulary: VocabularyEntry[];
  ledger: CoverageLedger;
}

const countOccurrences = (haystack: string, needle: string): { count: number; first: number } => {
  if (needle === '') return { count: 0, first: -1 };
  let count = 0;
  let first = -1;
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) {
    if (first < 0) first = index;
    count += 1;
    if (count > 8) break;
  }
  return { count, first };
};

/** Locate one passage inside the pages the operator declared for it. */
function locate(
  document: NormalizedDocument,
  record: ProposalRecord,
  needle: string,
  issues: IssueList,
  at: string,
): { start: number; end: number } | null {
  if (record.pdfPages.length === 0 || needle === '') return null;
  const first = document.pages[record.pdfPages[0] - 1];
  const last = document.pages[record.pdfPages[record.pdfPages.length - 1] - 1];
  if (!first || !last) {
    issues.add('pages_invalid', 'declared pages are outside the archived file', at);
    return null;
  }
  const windowStart = first.start;
  const windowEnd = last.end;
  const inWindow = countOccurrences(document.text.slice(windowStart, windowEnd), needle);
  if (inWindow.count === 1) return { start: windowStart + inWindow.first, end: windowStart + inWindow.first + needle.length };
  if (inWindow.count > 1) {
    issues.add('passage_ambiguous',
      'the passage occurs more than once on its declared pages; the operator must disambiguate it', at);
    return null;
  }
  const anywhere = countOccurrences(document.text, needle);
  if (anywhere.count === 0) {
    issues.add('passage_not_found',
      'the passage does not appear in the text extracted from the archived PDF', at);
    return null;
  }
  const foundPages = pagesForRange(document.pages, anywhere.first, anywhere.first + needle.length);
  issues.add('pages_mismatch',
    `the passage was found on pages ${foundPages.join(', ')}, not on the declared pages ${record.pdfPages.join(', ')}`, at);
  return null;
}

const sameNumbers = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * Validate a loaded bundle against its archived PDF and produce the importable index.
 *
 * Structural issues from `loadBundle` are carried through, so one report answers "may this
 * be imported" completely.
 */
export function validateBundle(bundle: LoadedBundle, sourceBytes: Buffer): ValidationResult {
  const issues = new IssueList();
  for (const issue of bundle.issues) issues.issues.push(issue);
  const { manifest } = bundle;

  /* ── Archived bytes ─────────────────────────────────────────────────────────── */
  if (bundle.source.sha256 !== manifest.version.sourceSha256) {
    issues.add('source_hash_mismatch',
      `the archived PDF hashes to ${bundle.source.sha256}, the manifest declares ${manifest.version.sourceSha256}`,
      'manifest.version');
  }
  if (sourceBytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    issues.add('source_not_pdf', 'the archived source file is not a PDF', 'manifest.version');
  }
  if (manifest.version.sourceUrl === null && manifest.document.admissionAmendment?.unpublishedSource !== true) {
    issues.add('source_url_missing',
      'a version without a public source URL requires an admission amendment declaring an unpublished source',
      'manifest.version');
  }
  // Admission: only a formally adopted, published document qualifies by default (§2.2).
  if (manifest.version.adoptedAt === null && manifest.document.admissionAmendment === null) {
    issues.add('admission_refused',
      'the corpus excludes unadopted drafts; admitting this source requires an explicit admission amendment',
      'manifest.document');
  }

  /* ── Extraction ─────────────────────────────────────────────────────────────── */
  const extraction = extractPdfText(sourceBytes);
  if (extraction.pageCount !== manifest.version.pageCount) {
    issues.add('page_count_mismatch',
      `the archived PDF has ${extraction.pageCount} pages, the manifest declares ${manifest.version.pageCount}`,
      'manifest.version');
  }
  const profile = { id: manifest.ingestion.normalizationProfileId, punctuationMap: manifest.ingestion.punctuationMap };
  const document = assembleDocument(extraction.pages, {
    profile,
    headerFooter: manifest.ingestion.headerFooter,
    printedPageLabels: manifest.version.printedPageLabels,
  });
  for (const declared of manifest.ingestion.headerFooter.dropExactLines) {
    if (!document.droppedLines.some((entry) => entry.line === declared)) {
      issues.add('header_footer_stale',
        `the declared header/footer line "${declared}" never appears in the archived PDF`,
        'manifest.ingestion.header_footer');
    }
  }

  /* ── Vocabulary and tags ────────────────────────────────────────────────────── */
  if (bundle.vocabulary.vocabularyId !== manifest.categoryVocabularyId) {
    issues.add('vocabulary_mismatch',
      'vocabulary.json does not carry the category_vocabulary_id the manifest pins', 'vocabulary');
  }
  const vocabulary = new Map(bundle.vocabulary.entries.map((entry) => [entry.id, entry]));

  /* ── Sections ───────────────────────────────────────────────────────────────── */
  const sectionOrder: string[] = [];
  const sectionShape = new Map<string, { chapter: string; subchapter: string | null }>();
  const sectionPages = new Map<string, number[]>();
  const seenProposalIds = new Set<string>();
  const sectionOrderIndexes = new Map<string, Set<number>>();

  bundle.records.forEach((record, index) => {
    const at = `record[${index}]`;
    if (record.proposalId === '' || record.sectionId === '') return;
    if (seenProposalIds.has(record.proposalId)) {
      issues.add('proposal_id_duplicate', `proposal id ${record.proposalId} is used more than once`, at);
      return;
    }
    seenProposalIds.add(record.proposalId);
    const shape = sectionShape.get(record.sectionId);
    if (!shape) {
      sectionShape.set(record.sectionId, { chapter: record.chapter, subchapter: record.subchapter });
      sectionOrder.push(record.sectionId);
    } else if (shape.chapter !== record.chapter || shape.subchapter !== record.subchapter) {
      issues.add('structure_ambiguous',
        `section ${record.sectionId} is declared with two different chapter/subchapter headings`, at);
    }
    const orders = sectionOrderIndexes.get(record.sectionId) ?? new Set<number>();
    if (orders.has(record.orderIndex)) {
      issues.add('order_index_duplicate',
        `order_index ${record.orderIndex} is used twice inside section ${record.sectionId}`, at);
    }
    orders.add(record.orderIndex);
    sectionOrderIndexes.set(record.sectionId, orders);
    sectionPages.set(record.sectionId, [...(sectionPages.get(record.sectionId) ?? []), ...record.pdfPages]);
  });

  if (bundle.records.length !== manifest.expectedProposalCount) {
    issues.add('record_count_mismatch',
      `the dataset holds ${bundle.records.length} records, the manifest expects ${manifest.expectedProposalCount}`,
      'manifest');
  }

  /* ── Grounding ──────────────────────────────────────────────────────────────── */
  const proposals: ResolvedProposal[] = [];
  const occupied: Array<{ start: number; end: number; id: string }> = [];
  let chunkOrder = 0;

  bundle.records.forEach((record, index) => {
    const at = `record[${index}]`;
    const normalizedText = normalizePassage(record.text, profile);
    const normalizedTitle = normalizePassage(record.title, profile);
    if (normalizedText === '') { issues.add('text_empty', 'the proposal text is empty after normalization', at); return; }
    if (normalizedText.includes('�')) {
      issues.add('text_undecodable',
        'the proposal text contains a character the PDF extraction could not decode', at);
      return;
    }

    const span = locate(document, record, normalizedText, issues, at);
    if (!span) return;

    const derivedPages = pagesForRange(document.pages, span.start, span.end);
    if (!sameNumbers(derivedPages, record.pdfPages)) {
      issues.add('pages_mismatch',
        `the passage occupies pages ${derivedPages.join(', ')}, the record declares ${record.pdfPages.join(', ')}`, at);
      return;
    }
    if (!normalizedText.includes(normalizedTitle) && normalizedTitle !== '') {
      issues.add('title_not_verbatim',
        'the proposal title does not appear verbatim inside the proposal passage', at);
      return;
    }
    const overlapping = occupied.find((entry) => entry.start < span.end && span.start < entry.end);
    if (overlapping) {
      issues.add('passage_overlap',
        `this passage overlaps the passage of ${overlapping.id}; two proposals cannot own the same characters`, at);
      return;
    }
    occupied.push({ start: span.start, end: span.end, id: record.proposalId });

    if (record.primaryTag !== '' && !vocabulary.has(record.primaryTag)) {
      issues.add('tag_unknown', `primary_tag ${record.primaryTag} is not in the pinned vocabulary`, at);
      return;
    }
    const unknownSecondary = record.secondaryTags.filter((tag) => !vocabulary.has(tag));
    if (unknownSecondary.length > 0) {
      issues.add('tag_unknown', `secondary_tags not in the pinned vocabulary: ${unknownSecondary.join(', ')}`, at);
      return;
    }
    const categoryId = record.category !== '' ? record.category
      : manifest.ingestion.categoryFromPrimaryTag ? record.primaryTag : '';
    const categoryEntry = vocabulary.get(categoryId);
    if (!categoryEntry) {
      issues.add('category_unknown', `category ${categoryId || '(none)'} is not in the pinned vocabulary`, at);
      return;
    }

    const keywords = normalizeKeywords(record.keywords);
    const generated: GeneratedChunk[] = chunkProposal(document.text, span.start, span.end, {
      targetChars: manifest.ingestion.chunking.targetChars,
      maxChars: manifest.ingestion.chunking.maxChars,
      minChars: manifest.ingestion.chunking.minChars,
      overlap: manifest.ingestion.chunking.overlap,
    });
    if (generated.length === 0) { issues.add('chunking_empty', 'no chunk could be produced for this proposal', at); return; }

    const chunks: ResolvedChunk[] = generated.map((chunk, position) => {
      const pages = pagesForRange(document.pages, chunk.charStart, chunk.charEnd);
      return {
        externalId: `${record.proposalId}#${String(position).padStart(3, '0')}`,
        orderIndex: chunkOrder + position,
        text: chunk.text,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        pdfPages: pages,
        printedPages: printedLabelsFor(pages, manifest.version.printedPageLabels),
        tokenEstimate: estimateTokens(chunk.text),
      };
    });
    for (const chunk of chunks) {
      if (document.text.slice(chunk.charStart, chunk.charEnd) !== chunk.text) {
        issues.add('chunk_offset_invalid', `chunk ${chunk.externalId} does not match its own offsets`, at);
        return;
      }
      if (chunk.pdfPages.length === 0 || chunk.pdfPages.length !== chunk.printedPages.length) {
        issues.add('chunk_pages_invalid', `chunk ${chunk.externalId} has no usable page mapping`, at);
        return;
      }
    }
    chunkOrder += chunks.length;

    proposals.push({
      externalId: record.proposalId,
      sectionSlug: record.sectionId,
      orderIndex: record.orderIndex,
      title: normalizedTitle,
      text: normalizedText,
      category: categoryEntry.label,
      primaryTag: record.primaryTag,
      secondaryTags: record.secondaryTags,
      keywords: keywords.normalized,
      keywordsRaw: keywords.raw,
      charStart: span.start,
      charEnd: span.end,
      pdfPages: derivedPages,
      printedPages: printedLabelsFor(derivedPages, manifest.version.printedPageLabels),
      chunks,
    });
  });

  /* ── Sections, in reading order ─────────────────────────────────────────────── */
  const sections: ResolvedSection[] = sectionOrder.map((sectionId, order) => {
    const shape = sectionShape.get(sectionId)!;
    const pages = (sectionPages.get(sectionId) ?? []).filter((page) => Number.isInteger(page));
    return {
      sectionSlug: sectionId,
      chapter: shape.chapter,
      subchapter: shape.subchapter,
      orderIndex: order,
      startPdfPage: pages.length > 0 ? Math.min(...pages) : 1,
      endPdfPage: pages.length > 0 ? Math.max(...pages) : 1,
    };
  });

  /* ── Coverage ledger ────────────────────────────────────────────────────────── */
  const indexedPages = new Set<number>();
  for (const proposal of proposals) for (const page of proposal.pdfPages) indexedPages.add(page);
  const ledgerPages = new Map<number, (typeof bundle.ledger.pages)[number]>();
  for (const entry of bundle.ledger.pages) {
    if (ledgerPages.has(entry.pdfPage)) {
      issues.add('ledger_duplicate', `the ledger lists page ${entry.pdfPage} more than once`, 'ledger');
      continue;
    }
    ledgerPages.set(entry.pdfPage, entry);
  }
  const unaccounted: number[] = [];
  for (let page = 1; page <= manifest.version.pageCount; page += 1) {
    const entry = ledgerPages.get(page);
    if (!entry) { unaccounted.push(page); continue; }
    if (entry.status === 'indexed' && !indexedPages.has(page)) {
      issues.add('ledger_page_unindexed',
        `the ledger calls page ${page} indexed, but no validated proposal occupies it`, 'ledger');
    }
    if (entry.status === 'excluded' && indexedPages.has(page)) {
      issues.add('ledger_page_conflict',
        `the ledger excludes page ${page}, but a validated proposal occupies it`, 'ledger');
    }
  }
  if (unaccounted.length > 0) {
    issues.add('ledger_pages_missing',
      `the ledger accounts for neither indexing nor exclusion of pages: ${unaccounted.slice(0, 40).join(', ')}`,
      'ledger');
  }
  for (const page of ledgerPages.keys()) {
    if (page > manifest.version.pageCount) {
      issues.add('ledger_page_orphan', `the ledger lists page ${page}, which the archived file does not have`, 'ledger');
    }
  }

  const validatedIds = new Set(proposals.map((proposal) => proposal.externalId));
  const referenced = new Set<string>();
  for (const entry of bundle.ledger.pages) {
    for (const id of entry.proposalIds) {
      if (!validatedIds.has(id)) {
        issues.add('ledger_proposal_orphan',
          `the ledger references proposal ${id} on page ${entry.pdfPage}, which is not a validated proposal`, 'ledger');
        continue;
      }
      referenced.add(id);
    }
  }
  for (const id of validatedIds) {
    if (!referenced.has(id)) {
      issues.add('ledger_proposal_missing', `the ledger never references validated proposal ${id}`, 'ledger');
    }
  }

  const ledgerSections = new Map(bundle.ledger.sections.map((entry) => [entry.sectionId, entry]));
  for (const section of sections) {
    const entry = ledgerSections.get(section.sectionSlug);
    if (!entry) {
      issues.add('ledger_section_missing', `the ledger does not account for section ${section.sectionSlug}`, 'ledger');
      continue;
    }
    if (entry.status === 'excluded') {
      issues.add('ledger_section_conflict',
        `the ledger excludes section ${section.sectionSlug}, which nonetheless carries indexed proposals`, 'ledger');
    }
  }
  for (const entry of bundle.ledger.sections) {
    if (entry.status === 'indexed' && !sections.some((section) => section.sectionSlug === entry.sectionId)) {
      issues.add('ledger_section_orphan',
        `the ledger calls section ${entry.sectionId} indexed, but the dataset has no such section`, 'ledger');
    }
  }

  /* ── Report ─────────────────────────────────────────────────────────────────── */
  const allChunks = proposals.flatMap((proposal) => proposal.chunks);
  const chapters = new Map<string, { sections: number; proposals: number }>();
  for (const section of sections) {
    const entry = chapters.get(section.chapter) ?? { sections: 0, proposals: 0 };
    entry.sections += 1;
    chapters.set(section.chapter, entry);
  }
  for (const proposal of proposals) {
    const section = sections.find((entry) => entry.sectionSlug === proposal.sectionSlug);
    if (!section) continue;
    const entry = chapters.get(section.chapter) ?? { sections: 0, proposals: 0 };
    entry.proposals += 1;
    chapters.set(section.chapter, entry);
  }
  const tags = new Map<string, { primary: number; secondary: number }>();
  for (const proposal of proposals) {
    const primary = tags.get(proposal.primaryTag) ?? { primary: 0, secondary: 0 };
    primary.primary += 1;
    tags.set(proposal.primaryTag, primary);
    for (const tag of proposal.secondaryTags) {
      const entry = tags.get(tag) ?? { primary: 0, secondary: 0 };
      entry.secondary += 1;
      tags.set(tag, entry);
    }
  }

  const stride = Math.max(1, Math.floor(allChunks.length / 10));
  const sampleChunks = allChunks.filter((_chunk, index) => index % stride === 0).slice(0, 10);
  const pageSpanning = allChunks.find((chunk) => chunk.pdfPages.length > 1) ?? null;
  const listChunk = allChunks.find((chunk) => /[•●◦]|\s\d+\)\s|\s\d+\.\s\p{Lu}/u.test(chunk.text)) ?? null;
  const frontMatter = manifest.version.printedPageLabels
    .map((label, index) => ({ pdfPage: index + 1, printedPage: label }))
    .find((entry) => entry.printedPage === '') ?? null;
  const body = manifest.version.printedPageLabels
    .map((label, index) => ({ pdfPage: index + 1, printedPage: label }))
    .find((entry) => entry.printedPage !== '') ?? null;

  const report: ValidationReport = {
    releaseId: manifest.releaseId,
    documentVersionId: manifest.version.documentVersionId,
    generatedAt: new Date().toISOString(),
    extraction: {
      tool: EXTRACTION_TOOL,
      pageCount: extraction.pageCount,
      normalizedLength: document.text.length,
      normalizedSha256: document.sha256,
      undecodedCharacters: extraction.pages.reduce((total, page) => total + page.undecodedCount, 0),
      warnings: extraction.warnings,
      droppedLines: document.droppedLines.slice(0, 500),
    },
    hashes: { source: bundle.source.sha256, structure: bundle.structure.sha256, dataset: bundle.dataset.sha256 },
    counts: {
      sections: sections.length,
      proposals: proposals.length,
      chunks: allChunks.length,
      perChapter: [...chapters.entries()].map(([chapter, entry]) => ({ chapter, ...entry })),
      perTag: [...tags.entries()].map(([tag, entry]) => ({ tag, ...entry })).sort((left, right) => left.tag.localeCompare(right.tag)),
    },
    pageCoverage: {
      pageCount: manifest.version.pageCount,
      indexedPages: [...indexedPages].sort((left, right) => left - right),
      excludedPages: bundle.ledger.pages
        .filter((entry) => entry.status === 'excluded')
        .map((entry) => ({ pdfPage: entry.pdfPage, reason: entry.reason ?? '' })),
      unaccountedPages: unaccounted,
    },
    manualChecks: {
      sampleChunks: sampleChunks.map((chunk) => ({
        chunkId: chunk.externalId, pdfPages: chunk.pdfPages, printedPages: chunk.printedPages,
        text: chunk.text.slice(0, 400),
      })),
      pageSpanningChunk: pageSpanning ? { chunkId: pageSpanning.externalId, pdfPages: pageSpanning.pdfPages } : null,
      listChunk: listChunk ? { chunkId: listChunk.externalId, text: listChunk.text.slice(0, 400) } : null,
      frontMatterPage: frontMatter,
      bodyPage: body,
    },
    admission: {
      documentType: manifest.document.documentType,
      adoptedAt: manifest.version.adoptedAt,
      amendment: manifest.document.admissionAmendment
        ? {
          approvedBy: manifest.document.admissionAmendment.approvedBy,
          approvedAt: manifest.document.admissionAmendment.approvedAt,
          statement: manifest.document.admissionAmendment.statement,
        }
        : null,
      publicSourceUrl: manifest.version.sourceUrl,
    },
    issues: issues.issues.slice(0, 500),
  };

  if (proposals.length === 0) issues.add('index_empty', 'no proposal survived validation', 'dataset');

  return {
    ok: issues.issues.length === 0,
    issues: issues.issues,
    report,
    document,
    sections,
    proposals,
    vocabulary: bundle.vocabulary.entries,
    ledger: bundle.ledger,
  };
}

/** Stable digest of a validated index, recorded so activation can prove nothing moved. */
export function indexDigest(result: ValidationResult): string {
  const hash = createHash('sha256');
  hash.update(result.document.sha256);
  for (const proposal of result.proposals) {
    hash.update(`\n${proposal.externalId}|${proposal.charStart}|${proposal.charEnd}|${proposal.pdfPages.join(',')}`);
    for (const chunk of proposal.chunks) hash.update(`\n  ${chunk.externalId}|${chunk.charStart}|${chunk.charEnd}`);
  }
  return hash.digest('hex');
}

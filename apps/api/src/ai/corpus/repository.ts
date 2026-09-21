/**
 * Corpus persistence: import, approve, activate, and resolve what is searchable.
 *
 * The three lifecycle acts are deliberately three separate calls, because collapsing them
 * is exactly the defect this task exists to correct. Import writes a complete but inactive
 * release, so a reviewer can read the report against real rows. Approval records a named
 * human. Activation re-proves the archived bytes and the completeness of the index, then
 * atomically supersedes whatever was active before.
 *
 * Nothing here edits indexed content. The database refuses that anyway (migration 0006),
 * and the shape of this module matches: rows are inserted once, and a correction is a new
 * document version with new internal identifiers and the operator's external ones preserved.
 */

import { createHash, randomUUID } from 'node:crypto';

import type { Database, Queryable } from '../../db/client.js';
import { archivedDigest, archiveKey, stageArchiveFile, verifyArchivedFile } from './archive.js';
import type { LoadedBundle } from './bundle.js';
import { normalizeKeywords } from './normalize.js';
import type { ValidationResult } from './validate.js';

export class CorpusError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'CorpusError';
    this.reason = reason;
  }
}

/** A release with no public source URL still needs a stable, non-web provenance string. */
const archiveUrn = (versionSlug: string) => `urn:szronox:programme-archive:${versionSlug}`;

export interface ImportOutcome {
  releaseId: string;
  releaseSlug: string;
  documentVersionId: string;
  versionSlug: string;
  sections: number;
  proposals: number;
  chunks: number;
  state: 'draft';
}

/**
 * Stage the archived files, then commit the whole index as one inactive release.
 *
 * Files first, and verified as they are written: a database row that points at bytes which
 * were never archived would be a citation that cannot open its own source.
 */
export async function importRelease(
  db: Database,
  bundle: LoadedBundle,
  validation: ValidationResult,
  options: { archiveRoot: string; sourceBytes: Buffer; structureBytes: Buffer; datasetBytes: Buffer },
): Promise<ImportOutcome> {
  if (!validation.ok) throw new CorpusError('validation_failed', 'Refusing to import a bundle that failed validation');
  const { manifest } = bundle;
  const versionSlug = manifest.version.documentVersionId;

  const sourceKey = archiveKey(versionSlug, manifest.version.sourceFileName);
  const structureKey = archiveKey(versionSlug, manifest.version.structureFileName);
  const datasetKey = archiveKey(versionSlug, manifest.version.datasetFileName);
  await stageArchiveFile(options.archiveRoot, sourceKey, options.sourceBytes, bundle.source.sha256);
  await stageArchiveFile(options.archiveRoot, structureKey, options.structureBytes, bundle.structure.sha256);
  await stageArchiveFile(options.archiveRoot, datasetKey, options.datasetBytes, bundle.dataset.sha256);

  return db.transaction(async (tx) => {
    const existingRelease = await tx.query<{ id: string }>(
      'select id from app.programme_releases where release_slug=$1', [manifest.releaseId]);
    if (existingRelease.rows[0]) {
      throw new CorpusError('release_exists', `Release ${manifest.releaseId} already exists and is never reused`);
    }
    const existingVersion = await tx.query<{ id: string }>(
      'select id from app.programme_versions where version_slug=$1', [versionSlug]);
    if (existingVersion.rows[0]) {
      throw new CorpusError('version_exists', `Document version ${versionSlug} already exists and is never reused`);
    }

    // A document is a stable work across editions: reuse it, and refuse a redefinition.
    const documentRows = await tx.query<{ id: string; title: string; document_type: string; issuing_body: string }>(
      'select id, title, document_type, issuing_body from app.programme_documents where document_slug=$1',
      [manifest.document.documentId]);
    let documentId = documentRows.rows[0]?.id ?? null;
    if (documentRows.rows[0]) {
      const current = documentRows.rows[0];
      if (current.title !== manifest.document.title
        || current.document_type !== manifest.document.documentType
        || current.issuing_body !== manifest.document.issuingBody) {
        throw new CorpusError('document_conflict',
          `Document ${manifest.document.documentId} is already recorded with a different identity`);
      }
    } else {
      documentId = randomUUID();
      await tx.query(
        `insert into app.programme_documents
           (id, document_slug, title, document_type, issuing_body, admission_rationale, admission_amendment)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [documentId, manifest.document.documentId, manifest.document.title, manifest.document.documentType,
          manifest.document.issuingBody, manifest.document.admissionRationale,
          manifest.document.admissionAmendment ? JSON.stringify(manifest.document.admissionAmendment) : null]);
    }

    const versionId = randomUUID();
    await tx.query(
      `insert into app.programme_versions
         (id, title, source_url, document_sha256, document_id, version_slug, source_title, edition, adopted_at,
          language, source_file_name, source_format, source_byte_size, retrieved_at, page_count,
          printed_page_labels, structure_coverage, archive_key, structure_file_name, structure_sha256,
          structure_archive_key, dataset_file_name, dataset_sha256, dataset_archive_key,
          normalized_text_sha256, normalized_length, ingestion, state)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pl',$10,'pdf',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,'draft')`,
      [versionId, manifest.document.title, manifest.version.sourceUrl ?? archiveUrn(versionSlug),
        bundle.source.sha256, documentId, versionSlug, manifest.version.sourceTitle, manifest.version.edition,
        manifest.version.adoptedAt, manifest.version.sourceFileName, bundle.source.byteSize,
        manifest.version.retrievedAt, manifest.version.pageCount, manifest.version.printedPageLabels,
        manifest.version.structureCoverage, sourceKey, manifest.version.structureFileName, bundle.structure.sha256,
        structureKey, manifest.version.datasetFileName, bundle.dataset.sha256, datasetKey,
        validation.document.sha256, validation.document.text.length,
        JSON.stringify({
          ingestedAt: new Date().toISOString(),
          ingestedBy: manifest.ingestion.ingestedBy,
          extractionTool: validation.report.extraction.tool,
          normalizationProfileId: manifest.ingestion.normalizationProfileId,
          punctuationMap: manifest.ingestion.punctuationMap,
          chunkingParameters: manifest.ingestion.chunking,
          structureSource: manifest.ingestion.structureSource,
          excludedRanges: manifest.ingestion.excludedRanges,
          headerFooter: manifest.ingestion.headerFooter,
          extractionWarnings: validation.report.extraction.warnings,
          droppedLines: validation.report.extraction.droppedLines.slice(0, 200),
          notes: manifest.ingestion.notes,
        })]);

    const sectionIds = new Map<string, string>();
    for (const section of validation.sections) {
      const id = randomUUID();
      sectionIds.set(section.sectionSlug, id);
      await tx.query(
        `insert into app.programme_sections
           (id, document_version_id, section_slug, chapter, subchapter, order_index, start_pdf_page, end_pdf_page)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, versionId, section.sectionSlug, section.chapter, section.subchapter,
          section.orderIndex, section.startPdfPage, section.endPdfPage]);
    }

    let chunkCount = 0;
    for (const proposal of validation.proposals) {
      const sectionId = sectionIds.get(proposal.sectionSlug);
      if (!sectionId) throw new CorpusError('section_missing', `Proposal ${proposal.externalId} has no section`);
      const proposalId = randomUUID();
      await tx.query(
        `insert into app.programme_proposals
           (id, document_version_id, category, title, chapter, subchapter, search_text, section_id, external_id,
            order_index, exact_text, primary_tag, secondary_tags, keywords, keywords_raw, keywords_text, tags_text,
            pdf_pages, printed_pages, char_start, char_end)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [proposalId, versionId, proposal.category, proposal.title,
          validation.sections.find((entry) => entry.sectionSlug === proposal.sectionSlug)!.chapter,
          validation.sections.find((entry) => entry.sectionSlug === proposal.sectionSlug)!.subchapter,
          proposal.text, sectionId, proposal.externalId, proposal.orderIndex, proposal.text,
          proposal.primaryTag, proposal.secondaryTags, proposal.keywords, proposal.keywordsRaw,
          proposal.keywords.join(' '), [proposal.primaryTag, ...proposal.secondaryTags].join(' '),
          proposal.pdfPages, proposal.printedPages, proposal.charStart, proposal.charEnd]);

      for (const chunk of proposal.chunks) {
        await tx.query(
          `insert into app.programme_chunks
             (id, proposal_id, excerpt, pdf_page, printed_page, document_version_id, section_id, external_id,
              order_index, char_start, char_end, pdf_pages, printed_pages, token_estimate)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [randomUUID(), proposalId, chunk.text, chunk.pdfPages[0], chunk.printedPages[0], versionId, sectionId,
            chunk.externalId, chunk.orderIndex, chunk.charStart, chunk.charEnd,
            chunk.pdfPages, chunk.printedPages, chunk.tokenEstimate]);
        chunkCount += 1;
      }
    }

    const releaseId = randomUUID();
    await tx.query(
      `insert into app.programme_releases
         (id, corpus_id, release_slug, label, state, category_vocabulary_id, imported_by,
          validation_report, coverage_ledger, notes)
       values ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9)`,
      [releaseId, manifest.corpusId, manifest.releaseId, manifest.releaseLabel, manifest.categoryVocabularyId,
        manifest.importedBy, JSON.stringify(validation.report), JSON.stringify(validation.ledger), manifest.notes]);
    await tx.query(
      'insert into app.programme_release_versions (release_id, document_version_id, position) values ($1,$2,0)',
      [releaseId, versionId]);
    for (const [position, entry] of validation.vocabulary.entries()) {
      await tx.query(
        `insert into app.programme_vocabulary_entries (release_id, entry_id, label, definition, position)
         values ($1,$2,$3,$4,$5)`,
        [releaseId, entry.id, entry.label, entry.definition, position]);
    }

    return {
      releaseId,
      releaseSlug: manifest.releaseId,
      documentVersionId: versionId,
      versionSlug,
      sections: validation.sections.length,
      proposals: validation.proposals.length,
      chunks: chunkCount,
      state: 'draft' as const,
    };
  });
}

export interface ReleaseRow {
  id: string;
  corpus_id: string;
  release_slug: string;
  label: string;
  state: 'draft' | 'approved' | 'active' | 'superseded' | 'withdrawn';
  approved_by: string | null;
  approved_at: string | null;
  activated_at: string | null;
  validation_report: { issues?: unknown[]; counts?: { proposals: number; chunks: number } };
}

async function loadRelease(tx: Queryable, releaseSlug: string): Promise<ReleaseRow> {
  const rows = await tx.query<ReleaseRow>(
    `select id, corpus_id, release_slug, label, state, approved_by, approved_at, activated_at, validation_report
       from app.programme_releases where release_slug=$1 for update`, [releaseSlug]);
  const release = rows.rows[0];
  if (!release) throw new CorpusError('release_not_found', `No release ${releaseSlug}`);
  return release;
}

/** Record the named human who accepted the report. Still not searchable afterwards. */
export async function approveRelease(db: Database, releaseSlug: string, approvedBy: string): Promise<ReleaseRow> {
  if (approvedBy.trim() === '' || approvedBy.length > 200) {
    throw new CorpusError('approver_invalid', 'Approval requires a named human operator');
  }
  return db.transaction(async (tx) => {
    const release = await loadRelease(tx, releaseSlug);
    if (release.state !== 'draft') {
      throw new CorpusError('release_state', `Release ${releaseSlug} is ${release.state}, not draft`);
    }
    const issues = Array.isArray(release.validation_report.issues) ? release.validation_report.issues : [];
    if (issues.length > 0) {
      throw new CorpusError('validation_failed', `Release ${releaseSlug} carries ${issues.length} unresolved findings`);
    }
    await tx.query(
      "update app.programme_releases set state='approved', approved_by=$2, approved_at=now() where id=$1",
      [release.id, approvedBy.trim()]);
    return { ...release, state: 'approved' as const, approved_by: approvedBy.trim() };
  });
}

export interface ActivationOutcome {
  releaseId: string;
  releaseSlug: string;
  corpusId: string;
  supersededSlug: string | null;
}

/**
 * Make an approved release the one the app searches.
 *
 * Hashes and completeness are re-checked here rather than trusted from import time,
 * because activation is the moment the index starts answering users — and because an
 * archived file can be replaced on disk between the two acts.
 */
export async function activateRelease(
  db: Database,
  releaseSlug: string,
  options: { archiveRoot: string },
): Promise<ActivationOutcome> {
  const versions = await db.query<{
    id: string; version_slug: string; archive_key: string; document_sha256: string; source_byte_size: string;
    dataset_archive_key: string | null; dataset_sha256: string | null;
    structure_archive_key: string | null; structure_sha256: string | null;
    proposals: string; chunks: string; orphan_proposals: string;
  }>(
    `select v.id, v.version_slug, v.archive_key, v.document_sha256, v.source_byte_size,
            v.dataset_archive_key, v.dataset_sha256, v.structure_archive_key, v.structure_sha256,
            (select count(*) from app.programme_proposals p where p.document_version_id=v.id) as proposals,
            (select count(*) from app.programme_chunks c where c.document_version_id=v.id) as chunks,
            (select count(*) from app.programme_proposals p
              where p.document_version_id=v.id
                and not exists (select 1 from app.programme_chunks c where c.proposal_id=p.id)) as orphan_proposals
       from app.programme_release_versions rv
       join app.programme_versions v on v.id=rv.document_version_id
       join app.programme_releases r on r.id=rv.release_id
      where r.release_slug=$1
      order by rv.position`, [releaseSlug]);
  if (versions.rows.length === 0) {
    throw new CorpusError('release_empty', `Release ${releaseSlug} has no document versions`);
  }
  for (const version of versions.rows) {
    await verifyArchivedFile(options.archiveRoot, version.archive_key,
      { sha256: version.document_sha256, byteSize: Number(version.source_byte_size) });
    for (const [key, expected] of [
      [version.dataset_archive_key, version.dataset_sha256],
      [version.structure_archive_key, version.structure_sha256],
    ] as Array<[string | null, string | null]>) {
      if (!key || !expected) continue;
      const digest = await archivedDigest(options.archiveRoot, key);
      if (digest !== expected) {
        throw new CorpusError('archive_changed', `Archived file ${key} no longer matches its recorded hash`);
      }
    }
    if (Number(version.proposals) === 0) {
      throw new CorpusError('version_empty', `Document version ${version.version_slug} has no proposals`);
    }
    if (Number(version.chunks) === 0) {
      throw new CorpusError('version_empty', `Document version ${version.version_slug} has no chunks`);
    }
    if (Number(version.orphan_proposals) > 0) {
      throw new CorpusError('version_incomplete',
        `Document version ${version.version_slug} has ${version.orphan_proposals} proposals with no chunk`);
    }
  }

  return db.transaction(async (tx) => {
    const release = await loadRelease(tx, releaseSlug);
    if (release.state !== 'approved') {
      throw new CorpusError('release_state', `Release ${releaseSlug} is ${release.state}, not approved`);
    }
    const counts = await tx.query<{ proposals: string; chunks: string }>(
      `select (select count(*) from app.programme_proposals p
                 join app.programme_release_versions rv on rv.document_version_id=p.document_version_id
                where rv.release_id=$1) as proposals,
              (select count(*) from app.programme_chunks c
                 join app.programme_release_versions rv on rv.document_version_id=c.document_version_id
                where rv.release_id=$1) as chunks`, [release.id]);
    const expected = release.validation_report.counts;
    if (expected && (Number(counts.rows[0].proposals) !== expected.proposals
      || Number(counts.rows[0].chunks) !== expected.chunks)) {
      throw new CorpusError('index_changed',
        'The persisted index no longer matches the counts recorded in the validation report');
    }

    const current = await tx.query<{ id: string; release_slug: string }>(
      "select id, release_slug from app.programme_releases where corpus_id=$1 and state='active' for update",
      [release.corpus_id]);
    const previous = current.rows[0] ?? null;
    if (previous) {
      await tx.query(
        "update app.programme_releases set state='superseded', superseded_by=$2, superseded_at=now() where id=$1",
        [previous.id, release.id]);
      await tx.query(
        `update app.programme_versions set state='superseded', approved_at=null
           where id in (select document_version_id from app.programme_release_versions where release_id=$1)
             and id not in (select document_version_id from app.programme_release_versions where release_id=$2)`,
        [previous.id, release.id]);
    }
    await tx.query("update app.programme_releases set state='active', activated_at=now() where id=$1", [release.id]);
    await tx.query(
      `update app.programme_versions set state='approved', approved_at=now()
         where id in (select document_version_id from app.programme_release_versions where release_id=$1)`,
      [release.id]);
    return {
      releaseId: release.id,
      releaseSlug: release.release_slug,
      corpusId: release.corpus_id,
      supersededSlug: previous?.release_slug ?? null,
    };
  });
}

export interface ActiveRelease {
  releaseId: string;
  corpusId: string;
  releaseSlug: string;
  label: string;
  activatedAt: string;
  documentVersionIds: string[];
}

/**
 * The one release the app searches, resolved once per request and then held constant.
 *
 * Resolving it again mid-request would let an activation between two queries mix evidence
 * from two releases into one citation.
 */
export async function resolveActiveRelease(tx: Queryable): Promise<ActiveRelease | null> {
  const rows = await tx.query<{
    id: string; corpus_id: string; release_slug: string; label: string; activated_at: string;
  }>(`select id, corpus_id, release_slug, label, activated_at
        from app.programme_releases where state='active' order by activated_at desc, id limit 1`);
  const release = rows.rows[0];
  if (!release) return null;
  const versions = await tx.query<{ document_version_id: string }>(
    'select document_version_id from app.programme_release_versions where release_id=$1 order by position',
    [release.id]);
  return {
    releaseId: release.id,
    corpusId: release.corpus_id,
    releaseSlug: release.release_slug,
    label: release.label,
    activatedAt: new Date(release.activated_at).toISOString(),
    documentVersionIds: versions.rows.map((row) => row.document_version_id),
  };
}

export interface EnrichmentRevisionInput {
  releaseSlug: string;
  externalId: string;
  primaryTag: string;
  secondaryTags: readonly string[];
  keywords: readonly string[];
  operator: string;
  notes?: string | null;
}

export interface EnrichmentRevisionOutcome {
  proposalId: string;
  revisionNumber: number;
  checksum: string;
}

/**
 * Revise a proposal's tagging and keywords, keyed by its frozen external id.
 *
 * Everything else about the proposal — text, pages, category, section, identity — is
 * enforced immutable at the database level (migration 0007's
 * `guard_programme_proposal_enrichment`), so this function only ever needs to write the six
 * enrichment columns and one audit row, in one transaction. Tags are checked against the
 * *release's* pinned vocabulary snapshot, not the live vocabulary file, because that snapshot
 * is what the release was approved against.
 */
export async function reviseProposalEnrichment(
  db: Database,
  input: EnrichmentRevisionInput,
): Promise<EnrichmentRevisionOutcome> {
  const operator = input.operator.trim();
  if (operator === '' || operator.length > 200) {
    throw new CorpusError('operator_invalid', 'Revising enrichment requires a named human operator');
  }
  const primaryTag = input.primaryTag.trim();
  if (primaryTag === '') throw new CorpusError('primary_tag_invalid', 'primary_tag is required');
  const secondaryTags = [...new Set(input.secondaryTags.map((tag) => tag.trim()).filter((tag) => tag !== ''))];
  const keywords = normalizeKeywords(input.keywords);

  return db.transaction(async (tx) => {
    const releaseRows = await tx.query<{ id: string }>(
      'select id from app.programme_releases where release_slug=$1', [input.releaseSlug]);
    const release = releaseRows.rows[0];
    if (!release) throw new CorpusError('release_not_found', `No release ${input.releaseSlug}`);

    const vocabRows = await tx.query<{ entry_id: string }>(
      'select entry_id from app.programme_vocabulary_entries where release_id=$1', [release.id]);
    const vocabulary = new Set(vocabRows.rows.map((row) => row.entry_id));
    if (!vocabulary.has(primaryTag)) {
      throw new CorpusError('tag_unknown',
        `primary_tag ${primaryTag} is not in release ${input.releaseSlug}'s pinned vocabulary`);
    }
    const unknownSecondary = secondaryTags.filter((tag) => !vocabulary.has(tag));
    if (unknownSecondary.length > 0) {
      throw new CorpusError('tag_unknown', `secondary_tags not in the pinned vocabulary: ${unknownSecondary.join(', ')}`);
    }

    const proposalRows = await tx.query<{
      id: string; primary_tag: string | null; secondary_tags: string[]; keywords: string[]; keywords_raw: string[];
    }>(
      `select p.id, p.primary_tag, p.secondary_tags, p.keywords, p.keywords_raw
         from app.programme_proposals p
         join app.programme_release_versions rv on rv.document_version_id = p.document_version_id
        where rv.release_id = $1 and p.external_id = $2
        for update of p`,
      [release.id, input.externalId]);
    const proposal = proposalRows.rows[0];
    if (!proposal) {
      throw new CorpusError('proposal_not_found', `No proposal ${input.externalId} in release ${input.releaseSlug}`);
    }

    const keywordsText = keywords.normalized.join(' ');
    const tagsText = [primaryTag, ...secondaryTags].join(' ');
    const checksum = createHash('sha256')
      .update(`${primaryTag}\n${secondaryTags.join(',')}\n${keywords.normalized.join(',')}`)
      .digest('hex');

    const revisionRows = await tx.query<{ revision_number: number }>(
      `select coalesce(max(revision_number), 0) + 1 as revision_number
         from app.programme_proposal_enrichment_revisions where proposal_id=$1`,
      [proposal.id]);
    const revisionNumber = revisionRows.rows[0].revision_number;

    await tx.query(
      `insert into app.programme_proposal_enrichment_revisions
         (id, proposal_id, revision_number, operator, previous_primary_tag, previous_secondary_tags,
          previous_keywords, previous_keywords_raw, new_primary_tag, new_secondary_tags, new_keywords,
          new_keywords_raw, checksum, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [randomUUID(), proposal.id, revisionNumber, operator, proposal.primary_tag, proposal.secondary_tags,
        proposal.keywords, proposal.keywords_raw, primaryTag, secondaryTags, keywords.normalized,
        keywords.raw, checksum, input.notes ?? null]);

    await tx.query(
      `update app.programme_proposals
          set primary_tag=$2, secondary_tags=$3, keywords=$4, keywords_raw=$5, keywords_text=$6, tags_text=$7
        where id=$1`,
      [proposal.id, primaryTag, secondaryTags, keywords.normalized, keywords.raw, keywordsText, tagsText]);

    return { proposalId: proposal.id, revisionNumber, checksum };
  });
}

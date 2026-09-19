/**
 * Candidate retrieval over the active release.
 *
 * The model ranks; the server cites. So this module decides which indexed chunks the model
 * is allowed to see, and every field a later citation carries is read here from persisted
 * rows — not reconstructed later from anything the model said.
 *
 * Ranking combines the operator's enrichment (title, keywords, tags, headings) with the
 * chunk's own text, weighted so a deliberate keyword outranks an incidental body match. It
 * is deterministic end to end: the same Reel against the same release produces the same
 * candidates in the same order, because every tie is broken by reading order and then by
 * identifier.
 *
 * Candidates are deduplicated to one chunk per proposal and capped, because the user
 * chooses between propositions rather than between fragments of one proposition.
 */

import type { Queryable } from '../../db/client.js';

/** Upper bound on evidence handed to the model, before it selects at most three. */
export const MAX_EVIDENCE_CANDIDATES = 8;

export interface ProgrammeEvidence {
  releaseId: string;
  documentVersionId: string;
  proposalId: string;
  chunkId: string;
  category: string;
  proposal: string;
  excerpt: string;
  sourceTitle: string;
  /** The authenticated archive route for this version, opened at the first cited page. */
  sourceUrl: string;
  chapter: string;
  subchapter: string | null;
  pdfPages: number[];
  printedPages: string[];
}

/**
 * Polish function words that carry no topical signal.
 *
 * Without this list a Reel about a film matches a programme passage because both contain
 * "oraz". The list is short, fixed and made only of grammatical words: it removes noise,
 * never subject matter. Words of three letters or fewer are already excluded by the length
 * rule below, so they do not appear here.
 */
const STOPWORDS = new Set([
  'oraz', 'także', 'również', 'jest', 'jako', 'przez', 'które', 'która', 'który', 'którzy',
  'których', 'tego', 'temu', 'tym', 'tych', 'tylko', 'jeszcze', 'bardzo', 'gdzie', 'kiedy',
  'ponieważ', 'dlatego', 'jednak', 'między', 'wobec', 'około', 'podczas', 'przed', 'poza',
  'nawet', 'więcej', 'mniej', 'może', 'można', 'będzie', 'będą', 'była', 'było', 'były',
  'mamy', 'mają', 'nasze', 'nasza', 'naszych', 'swoje', 'siebie', 'sobie', 'wszystko',
  'wszystkie', 'wszystkich', 'każdy', 'każda', 'każde', 'inne', 'inny', 'inna', 'taki',
  'taka', 'takie', 'tutaj', 'jeśli', 'żeby', 'czyli', 'lecz', 'albo', 'żadnych', 'temu',
  'teraz', 'właśnie', 'chodzi', 'trzeba', 'powinien', 'powinno', 'powinny',
]);

/**
 * Search terms from Reel content.
 *
 * Only runs of four or more letters survive, which keeps the generated `tsquery` free of
 * anything that could be read as an operator — the query is built from user content, so it
 * must not be able to carry syntax.
 */
export function searchTerms(sources: readonly string[], limit = 24): string[] {
  const words = sources.join(' ').toLowerCase().match(/\p{L}{4,}/gu) ?? [];
  return [...new Set(words)].filter((word) => !STOPWORDS.has(word)).slice(0, limit);
}

interface EvidenceRow {
  releaseId: string;
  documentVersionId: string;
  proposalId: string;
  chunkId: string;
  category: string;
  proposal: string;
  excerpt: string;
  sourceTitle: string;
  chapter: string;
  subchapter: string | null;
  pdfPages: number[];
  printedPages: string[];
}

/** The version-specific, session-authenticated route a citation opens. */
export function programmeSourceUrl(documentVersionId: string, pdfPages: readonly number[]): string {
  const first = pdfPages[0];
  const base = `/api/v1/programme/versions/${documentVersionId}/source`;
  return Number.isInteger(first) && first > 0 ? `${base}#page=${first}` : base;
}

export async function findEvidence(
  tx: Queryable,
  releaseId: string,
  terms: readonly string[],
  limit = MAX_EVIDENCE_CANDIDATES,
): Promise<ProgrammeEvidence[]> {
  if (terms.length === 0) return [];
  const query = terms.join(' | ');
  const rows = await tx.query<EvidenceRow>(
    `with q as (select to_tsquery('simple', $2) as query),
     scored as (
       select r.id as "releaseId", v.id as "documentVersionId", p.id as "proposalId", c.id as "chunkId",
              p.category, p.title as proposal, c.excerpt, v.source_title as "sourceTitle",
              s.chapter, s.subchapter, c.pdf_pages as "pdfPages", c.printed_pages as "printedPages",
              s.order_index as section_order, p.order_index as proposal_order, c.order_index as chunk_order,
              ts_rank(p.enrichment_vector, q.query) * 2 + ts_rank(c.search_vector, q.query) as rank
         from app.programme_chunks c
         join app.programme_proposals p on p.id = c.proposal_id
         join app.programme_sections s on s.id = p.section_id
         join app.programme_versions v on v.id = p.document_version_id
         join app.programme_release_versions rv on rv.document_version_id = v.id
         join app.programme_releases r on r.id = rv.release_id
         cross join q
        where r.id = $1
          and (c.search_vector @@ q.query or p.enrichment_vector @@ q.query)
     ),
     best as (
       select distinct on ("proposalId") *
         from scored
        order by "proposalId", rank desc, chunk_order asc, "chunkId" asc
     )
     select "releaseId", "documentVersionId", "proposalId", "chunkId", category, proposal, excerpt,
            "sourceTitle", chapter, subchapter, "pdfPages", "printedPages"
       from best
      order by rank desc, section_order asc, proposal_order asc, chunk_order asc, "chunkId" asc
      limit $3`,
    [releaseId, query, limit]);

  return rows.rows.map((row) => ({
    releaseId: row.releaseId,
    documentVersionId: row.documentVersionId,
    proposalId: row.proposalId,
    chunkId: row.chunkId,
    category: row.category,
    proposal: row.proposal,
    excerpt: row.excerpt,
    sourceTitle: row.sourceTitle,
    sourceUrl: programmeSourceUrl(row.documentVersionId, row.pdfPages),
    chapter: row.chapter,
    subchapter: row.subchapter,
    pdfPages: row.pdfPages,
    printedPages: row.printedPages,
  }));
}

export interface ArchivedSource {
  documentVersionId: string;
  fileName: string;
  archiveKey: string;
  sha256: string;
  byteSize: number;
  /** Whether the version belongs to a release that is or once was searchable. */
  resolvable: boolean;
}

/**
 * Resolve an archived source for reading.
 *
 * Any version that ever belonged to a released corpus stays resolvable, including a
 * superseded one: a Reel attachment pins its `documentVersionId`, and publishing a newer
 * release must never make an existing citation unopenable.
 */
export async function resolveArchivedSource(
  tx: Queryable,
  documentVersionId: string,
): Promise<ArchivedSource | null> {
  const rows = await tx.query<{
    id: string; source_file_name: string | null; archive_key: string | null;
    document_sha256: string; source_byte_size: string | null; releases: string;
  }>(
    `select v.id, v.source_file_name, v.archive_key, v.document_sha256, v.source_byte_size,
            (select count(*) from app.programme_release_versions rv where rv.document_version_id = v.id) as releases
       from app.programme_versions v where v.id = $1`, [documentVersionId]);
  const row = rows.rows[0];
  if (!row || !row.archive_key || !row.source_file_name || row.source_byte_size === null) return null;
  return {
    documentVersionId: row.id,
    fileName: row.source_file_name,
    archiveKey: row.archive_key,
    sha256: row.document_sha256,
    byteSize: Number(row.source_byte_size),
    resolvable: Number(row.releases) > 0,
  };
}

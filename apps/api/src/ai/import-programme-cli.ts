/** Operator-only importer. No programme document is bundled with the app. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { openDatabase } from '../runtime/database.js';

interface ImportChunk { id: string; excerpt: string; pdfPage: number; printedPage?: string }
interface ImportProposal { id: string; category: string; title: string; chapter: string; subchapter?: string; searchText: string; chunks: ImportChunk[] }
interface ImportFile { document: { id: string; title: string; sourceUrl: string }; approve: true; proposals: ImportProposal[] }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const valid = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

function check(data: ImportFile): void {
  if (data.approve !== true || !data.document || !uuid.test(data.document.id) ||
      !valid(data.document.title, 300) || !valid(data.document.sourceUrl, 2000) ||
      !Array.isArray(data.proposals) || data.proposals.length === 0 || data.proposals.length > 5000) {
    throw new Error('Invalid approved programme import manifest');
  }
  const url = new URL(data.document.sourceUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Programme source must be an HTTPS URL');
  const ids = new Set<string>([data.document.id]);
  for (const proposal of data.proposals) {
    if (!uuid.test(proposal.id) || ids.has(proposal.id) || !valid(proposal.title, 500) ||
        !valid(proposal.category, 300) || !valid(proposal.chapter, 300) ||
        !valid(proposal.searchText, 10000) || !Array.isArray(proposal.chunks) ||
        proposal.chunks.length === 0 || proposal.chunks.length > 100) throw new Error('Invalid programme proposal');
    ids.add(proposal.id);
    for (const chunk of proposal.chunks) {
      if (!uuid.test(chunk.id) || ids.has(chunk.id) || !valid(chunk.excerpt, 4000) ||
          !Number.isInteger(chunk.pdfPage) || chunk.pdfPage < 1) throw new Error('Invalid programme evidence chunk');
      ids.add(chunk.id);
    }
  }
}

const manifestPath = process.env.PROGRAMME_IMPORT_JSON;
const pdfPath = process.env.PROGRAMME_SOURCE_PDF;
if (!manifestPath || !pdfPath) throw new Error('PROGRAMME_IMPORT_JSON and PROGRAMME_SOURCE_PDF are required');
const data = JSON.parse(await readFile(manifestPath, 'utf8')) as ImportFile;
check(data);
const pdf = await readFile(pdfPath);
if (pdf.subarray(0, 5).toString() !== '%PDF-' || pdf.length > 30_000_000) throw new Error('Source is not a bounded PDF');
const digest = createHash('sha256').update(pdf).digest('hex');
const database = await openDatabase(process.env, { poolMax: 2, applicationName: 'szronox-programme-import' });
try {
  const role = await database.db.query<{ role: string }>('select current_user as role');
  if (role.rows[0].role !== 'szronox_dev') throw new Error('Programme import requires the owner role');
  await database.db.transaction(async (tx) => {
    const prior = await tx.query<{ document_sha256: string }>('select document_sha256 from app.programme_versions where id=$1', [data.document.id]);
    if (prior.rows[0]) throw new Error('Programme version ID already exists');
    await tx.query('update app.programme_versions set approved_at=null where approved_at is not null');
    await tx.query('insert into app.programme_versions(id,title,source_url,document_sha256) values($1,$2,$3,$4)',
      [data.document.id, data.document.title, data.document.sourceUrl, digest]);
    for (const proposal of data.proposals) {
      await tx.query(`insert into app.programme_proposals(id,document_version_id,category,title,chapter,subchapter,search_text)
        values($1,$2,$3,$4,$5,$6,$7)`,
      [proposal.id, data.document.id, proposal.category, proposal.title, proposal.chapter, proposal.subchapter ?? null, proposal.searchText]);
      for (const chunk of proposal.chunks) {
        await tx.query('insert into app.programme_chunks(id,proposal_id,excerpt,pdf_page,printed_page) values($1,$2,$3,$4,$5)',
          [chunk.id, proposal.id, chunk.excerpt, chunk.pdfPage, chunk.printedPage ?? null]);
      }
    }
    await tx.query('update app.programme_versions set approved_at=now() where id=$1', [data.document.id]);
  });
  process.stdout.write(`Approved programme version ${data.document.id} with ${data.proposals.length} proposals; PDF SHA-256 ${digest}.\n`);
} finally { await database.close(); }

/**
 * Operator command for the approved programme corpus.
 *
 *   validate  <bundle-dir>                 read and prove a bundle; touches no database
 *   import    <bundle-dir>                 archive the files and commit an INACTIVE release
 *   approve   <release-slug> --by "<name>" record the named human who accepted the report
 *   activate  <release-slug>               re-prove, then make it the searchable release
 *
 * Four commands rather than one, because approving what you have not read and activating
 * what you have not re-proved are exactly the failures this separation prevents. Import
 * never makes anything searchable; activation is the only act that does, and it supersedes
 * the previous release atomically.
 *
 * No programme document is bundled with the application. The operator's directory is the
 * whole input, and nothing here reaches the network or a model.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { programmeArchiveRoot, type CoreEnv } from '../core/config.js';
import { openDatabase } from '../runtime/database.js';
import { BundleError, loadBundle } from './corpus/bundle.js';
import { adaptEtap3bBundle, Etap3bAdapterError } from './corpus/etap3b-adapter.js';
import {
  activateRelease, approveRelease, CorpusError, importRelease, reviseProposalEnrichment,
} from './corpus/repository.js';
import { validateBundle, type ValidationResult } from './corpus/validate.js';

const out = (line: string): void => { process.stdout.write(`${line}\n`); };

function usage(): never {
  out('Usage:');
  out('  import-programme-cli validate         <bundle-dir> [--report <file>]');
  out('  import-programme-cli import           <bundle-dir>');
  out('  import-programme-cli approve          <release-slug> --by "<named operator>"');
  out('  import-programme-cli activate         <release-slug>');
  out('  import-programme-cli etap3b-adapt     <program-dir>');
  out('  import-programme-cli revise-enrichment <release-slug> <external-id> --by "<named operator>"');
  out('                         [--primary-tag <slug>] [--secondary-tags a,b] [--keywords a,b,c]');
  process.exit(2);
}

function flag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) usage();
  return value;
}

function archiveRoot(): string {
  const root = programmeArchiveRoot(process.env as CoreEnv);
  if (!root) throw new Error('PROGRAMME_ARCHIVE_ROOT or APP_STORAGE_ROOT is required');
  return root;
}

/** Everything a reviewer needs on one screen; the full report goes to `--report`. */
function printReport(result: ValidationResult): void {
  const { report } = result;
  out(`release            ${report.releaseId}`);
  out(`document version   ${report.documentVersionId}`);
  out(`extraction         ${report.extraction.tool}, ${report.extraction.pageCount} pages, `
    + `${report.extraction.normalizedLength} normalized characters`);
  out(`normalized sha256  ${report.extraction.normalizedSha256}`);
  out(`source sha256      ${report.hashes.source}`);
  out(`docx sha256        ${report.hashes.structure}`);
  out(`dataset sha256     ${report.hashes.dataset}`);
  out(`undecoded glyphs   ${report.extraction.undecodedCharacters}`);
  out(`index              ${report.counts.sections} sections, ${report.counts.proposals} proposals, `
    + `${report.counts.chunks} chunks`);
  out(`pages indexed      ${report.pageCoverage.indexedPages.length} of ${report.pageCoverage.pageCount}`);
  out(`pages excluded     ${report.pageCoverage.excludedPages.length}`);
  out(`admission          type=${report.admission.documentType} adopted=${report.admission.adoptedAt ?? 'none'} `
    + `amendment=${report.admission.amendment ? report.admission.amendment.approvedBy : 'none'}`);
  out(`public source url  ${report.admission.publicSourceUrl ?? 'waived by amendment (archived copy is authoritative)'}`);
  for (const warning of report.extraction.warnings) out(`extraction warning ${warning}`);

  out('');
  out('MANUAL CHECKS STILL OWED BY A HUMAN (specification §7):');
  out(`  page-spanning chunk  ${report.manualChecks.pageSpanningChunk
    ? `${report.manualChecks.pageSpanningChunk.chunkId} on pages ${report.manualChecks.pageSpanningChunk.pdfPages.join(', ')}`
    : 'NONE FOUND — confirm no proposal crosses a page break'}`);
  out(`  list/table chunk     ${report.manualChecks.listChunk?.chunkId ?? 'NONE FOUND'}`);
  out(`  front-matter page    ${report.manualChecks.frontMatterPage
    ? `pdf ${report.manualChecks.frontMatterPage.pdfPage} prints ""` : 'NONE — every page carries a printed label'}`);
  out(`  body page            ${report.manualChecks.bodyPage
    ? `pdf ${report.manualChecks.bodyPage.pdfPage} prints "${report.manualChecks.bodyPage.printedPage}"` : 'NONE'}`);
  out(`  sample chunks        ${report.manualChecks.sampleChunks.map((chunk) => chunk.chunkId).join(', ') || 'none'}`);

  if (result.issues.length > 0) {
    out('');
    out(`REJECTED — ${result.issues.length} findings:`);
    for (const issue of result.issues.slice(0, 200)) {
      out(`  [${issue.code}] ${issue.at ?? '-'}: ${issue.message}`);
    }
    if (result.issues.length > 200) out(`  ... ${result.issues.length - 200} more`);
  }
}

async function readBundle(directory: string) {
  const bundle = await loadBundle(path.resolve(directory));
  const sourceBytes = await readFile(bundle.source.absolutePath);
  const structureBytes = await readFile(bundle.structure.absolutePath);
  const datasetBytes = await readFile(bundle.dataset.absolutePath);
  return { bundle, sourceBytes, structureBytes, datasetBytes, validation: validateBundle(bundle, sourceBytes) };
}

/** Every write command runs as the schema owner; runtime roles cannot publish evidence. */
async function withOwnerDatabase<T>(body: (db: Awaited<ReturnType<typeof openDatabase>>['db']) => Promise<T>): Promise<T> {
  const database = await openDatabase(process.env, { poolMax: 2, applicationName: 'szronox-programme-corpus' });
  try {
    const role = await database.db.query<{ role: string }>('select current_user as role');
    if (role.rows[0].role !== 'szronox_dev') throw new Error('Programme corpus commands require the owner role');
    return await body(database.db);
  } finally {
    await database.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const target = argv[1];
  if (!command || !target) usage();

  if (command === 'validate') {
    const { validation } = await readBundle(target);
    printReport(validation);
    const reportPath = flag(argv, 'report');
    if (reportPath) {
      await writeFile(path.resolve(reportPath), `${JSON.stringify(validation.report, null, 2)}\n`, 'utf8');
      out(`\nfull report written to ${path.resolve(reportPath)}`);
    }
    return validation.ok ? 0 : 1;
  }

  if (command === 'import') {
    const { bundle, validation, sourceBytes, structureBytes, datasetBytes } = await readBundle(target);
    printReport(validation);
    if (!validation.ok) {
      out('\nNothing was imported. Correct the bundle and validate again.');
      return 1;
    }
    const root = archiveRoot();
    const outcome = await withOwnerDatabase((db) =>
      importRelease(db, bundle, validation, {
        archiveRoot: root, sourceBytes, structureBytes, datasetBytes,
      }));
    out('');
    out(`Imported release ${outcome.releaseSlug} as ${outcome.state}: ${outcome.sections} sections, `
      + `${outcome.proposals} proposals, ${outcome.chunks} chunks.`);
    out(`Archive root ${root}`);
    out('It is NOT searchable. Review the report, then approve and activate it.');
    return 0;
  }

  if (command === 'approve') {
    const approver = flag(argv, 'by');
    if (!approver) usage();
    const release = await withOwnerDatabase((db) => approveRelease(db, target, approver));
    out(`Release ${release.release_slug} approved by ${release.approved_by}. It is still not searchable.`);
    return 0;
  }

  if (command === 'activate') {
    const root = archiveRoot();
    const outcome = await withOwnerDatabase((db) => activateRelease(db, target, { archiveRoot: root }));
    out(`Release ${outcome.releaseSlug} is now the active release of corpus ${outcome.corpusId}.`);
    out(outcome.supersededSlug
      ? `Superseded ${outcome.supersededSlug}; its versions, files and existing attachments stay resolvable.`
      : 'No previous release existed for this corpus.');
    return 0;
  }

  if (command === 'etap3b-adapt') {
    const result = await adaptEtap3bBundle({ programDir: path.resolve(target) });
    out(`Wrote ${result.manifestPath}`);
    out(`Wrote ${result.vocabularyPath}`);
    out(`Wrote ${result.datasetPath}`);
    out(`Wrote ${result.coveragePath}`);
    out(`${result.proposalCount} proposals adapted, ${result.rejectedCount} rejected, `
      + `${result.sectionCount} sections retained (${result.emptySectionCount} empty).`);
    out('Run "validate" against this directory next.');
    return 0;
  }

  if (command === 'revise-enrichment') {
    const externalId = argv[2];
    if (!externalId) usage();
    const operator = flag(argv, 'by');
    if (!operator) usage();
    const primaryTagFlag = flag(argv, 'primary-tag');
    const secondaryTagsFlag = flag(argv, 'secondary-tags');
    const keywordsFlag = flag(argv, 'keywords');
    if (!primaryTagFlag) {
      out('--primary-tag is required');
      return 2;
    }
    const outcome = await withOwnerDatabase((db) => reviseProposalEnrichment(db, {
      releaseSlug: target,
      externalId,
      primaryTag: primaryTagFlag,
      secondaryTags: secondaryTagsFlag ? secondaryTagsFlag.split(',').map((tag) => tag.trim()).filter(Boolean) : [],
      keywords: keywordsFlag ? keywordsFlag.split(',').map((keyword) => keyword.trim()).filter(Boolean) : [],
      operator,
    }));
    out(`Proposal ${externalId} revised: revision ${outcome.revisionNumber}, checksum ${outcome.checksum}.`);
    out('Identity, text, pages, category and section are unchanged; only enrichment fields were updated.');
    return 0;
  }

  return usage();
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof BundleError || error instanceof Etap3bAdapterError) {
    process.stderr.write(`${error.message}\n`);
    for (const issue of error.issues) process.stderr.write(`  [${issue.code}] ${issue.at ?? '-'}: ${issue.message}\n`);
  } else if (error instanceof CorpusError) {
    process.stderr.write(`${error.reason}: ${error.message}\n`);
  } else {
    process.stderr.write(`${(error as Error).message}\n`);
  }
  process.exitCode = 1;
}

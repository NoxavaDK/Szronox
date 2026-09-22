/**
 * The private programme archive.
 *
 * A citation points at a physical page of a specific file. Serving that file from the
 * operator's public URL would make the citation depend on a third party's web server
 * continuing to host the same bytes, so the bytes are archived here at import and served
 * from here afterwards — behind the same session authentication as everything else.
 *
 * Files are staged before any database row is written and are never rewritten: a changed
 * source produces a new document version with its own directory. The read path re-hashes
 * what it is about to serve, because "the archived copy is authoritative" is only true if
 * something checks.
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

const KEY = /^[a-z0-9][a-z0-9._-]{2,119}\/[A-Za-z0-9][A-Za-z0-9 ._-]{0,120}$/;

/** `<versionSlug>/<fileName>`; both halves are validated before they touch the filesystem. */
export function archiveKey(versionSlug: string, fileName: string): string {
  const key = `${versionSlug}/${fileName}`;
  if (!KEY.test(key) || key.includes('..')) throw new ArchiveError('Invalid programme archive key');
  return key;
}

function resolveKey(root: string, key: string): string {
  if (!KEY.test(key) || key.includes('..')) throw new ArchiveError('Invalid programme archive key');
  const base = path.resolve(root);
  const absolute = path.resolve(base, key);
  if (absolute !== path.join(base, key)) throw new ArchiveError('Programme archive key escapes its root');
  return absolute;
}

/**
 * Write one archived file and prove it afterwards.
 *
 * The write goes to a temporary name in the same directory and is renamed into place, so a
 * partially written file is never visible under the key a database row will point at.
 */
export async function stageArchiveFile(
  root: string,
  key: string,
  bytes: Buffer,
  expectedSha256: string,
): Promise<{ absolutePath: string; byteSize: number; sha256: string }> {
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== expectedSha256) {
    throw new ArchiveError(`Refusing to archive ${key}: content hashes to ${digest}, expected ${expectedSha256}`);
  }
  const absolute = resolveKey(root, key);
  await mkdir(path.dirname(absolute), { recursive: true, mode: 0o750 });
  const existing = await stat(absolute).catch(() => null);
  if (existing) {
    const current = createHash('sha256').update(await readFile(absolute)).digest('hex');
    if (current !== digest) throw new ArchiveError(`Archived file ${key} already exists with different content`);
    return { absolutePath: absolute, byteSize: bytes.byteLength, sha256: digest };
  }
  const temporary = `${absolute}.staging`;
  await writeFile(temporary, bytes, { mode: 0o440 });
  await rename(temporary, absolute);
  await chmod(absolute, 0o440);
  return { absolutePath: absolute, byteSize: bytes.byteLength, sha256: digest };
}

/**
 * Read an archived file and verify it against the hash recorded at import.
 *
 * Read whole rather than streamed: the bound is the recorded byte size, the corpus is a
 * handful of documents, and verifying a hash while streaming would mean discovering the
 * mismatch after the first bytes had already been sent to the browser.
 */
export async function readArchivedFile(
  root: string,
  key: string,
  expected: { sha256: string; byteSize: number },
  maxBytes = 60_000_000,
): Promise<Buffer> {
  if (expected.byteSize > maxBytes) throw new ArchiveError('Archived file exceeds the readable bound');
  const absolute = resolveKey(root, key);
  const info = await stat(absolute).catch(() => null);
  if (!info || !info.isFile()) throw new ArchiveError('Archived programme file is missing');
  if (info.size !== expected.byteSize) throw new ArchiveError('Archived programme file changed size');
  const bytes = await readFile(absolute);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== expected.sha256) throw new ArchiveError('Archived programme file no longer matches its recorded hash');
  return bytes;
}

/** Hash an archived file without loading it into a response. Used by activation. */
export async function verifyArchivedFile(
  root: string,
  key: string,
  expected: { sha256: string; byteSize: number },
): Promise<void> {
  await readArchivedFile(root, key, expected);
}

/** The current digest of an archived file whose recorded size is not tracked separately. */
export async function archivedDigest(root: string, key: string, maxBytes = 80_000_000): Promise<string> {
  const absolute = resolveKey(root, key);
  const info = await stat(absolute).catch(() => null);
  if (!info || !info.isFile()) throw new ArchiveError('Archived programme file is missing');
  if (info.size > maxBytes) throw new ArchiveError('Archived file exceeds the readable bound');
  return createHash('sha256').update(await readFile(absolute)).digest('hex');
}

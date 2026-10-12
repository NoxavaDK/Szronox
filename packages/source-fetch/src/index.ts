import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { parseHTML } from 'linkedom';

export const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 2;

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const p = address.split('.').map(Number);
    return !(p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 192 && p[1] === 0) || (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
      (p[0] === 255));
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    return lower.startsWith('2') || lower.startsWith('3')
      ? !lower.startsWith('2001:db8') && !lower.startsWith('2001:0:')
      : false;
  }
  return false;
}

export function canonicalPublicUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new SourceError('SOURCE_UNSUPPORTED'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !hostname || hostname.length > 253 ||
      /(^|\.)(localhost|local|internal|invalid|test)$/.test(hostname.toLowerCase())) {
    throw new SourceError('SOURCE_UNSUPPORTED');
  }
  if (isIP(hostname) && !publicAddress(hostname)) throw new SourceError('SOURCE_UNSUPPORTED');
  url.hash = '';
  return url;
}

export class SourceError extends Error {
  /** `status`: the HTTP status behind an access/availability refusal, when there was one. */
  constructor(readonly code: 'SOURCE_UNSUPPORTED' | 'SOURCE_UNAVAILABLE' | 'SOURCE_ACCESS_DENIED' | 'SOURCE_TOO_LARGE' | 'SOURCE_TEXT_TOO_LONG' | 'SOURCE_TEXT_UNAVAILABLE', readonly status?: number) {
    super(code);
    this.name = 'SourceError';
  }
}


async function checkedAddress(hostname: string): Promise<{ address: string; family: number }> {
  hostname = hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return { address: hostname, family: isIP(hostname) };
  const answers = await lookup(hostname, { all: true, verbatim: true });
  if (answers.length === 0 || answers.some(({ address }) => !publicAddress(address))) {
    throw new SourceError('SOURCE_UNSUPPORTED');
  }
  return answers[0];
}

async function oneFetch(url: URL): Promise<{ status: number; location?: string; contentType: string; bytes: Buffer }> {
  const pinned = await checkedAddress(url.hostname);
  return new Promise((resolve, reject) => {
    const driver = url.protocol === 'https:' ? https : http;
    const request = driver.request(url, {
      method: 'GET', timeout: 6_000,
      headers: { accept: 'text/html, text/plain', 'accept-encoding': 'identity', 'user-agent': 'SzroNoxSourceReader/1.0' },
      // Node calls this with `all: true` whenever it is choosing between address
      // families, and then expects an array. Answering with the scalar form there
      // leaves the socket with `addresses === undefined`, which surfaces as
      // ERR_INVALID_IP_ADDRESS before any request is sent — so both shapes are
      // honoured rather than assuming the scalar one.
      lookup: (_hostname, options, callback) => (options as { all?: boolean } | undefined)?.all
        ? (callback as unknown as (error: null, addresses: Array<{ address: string; family: number }>) => void)(
          null, [{ address: pinned.address, family: pinned.family }])
        : callback(null, pinned.address, pinned.family),
      maxHeaderSize: 16_384,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const contentType = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      const contentEncoding = String(response.headers['content-encoding'] ?? 'identity').toLowerCase();
      const location = response.headers.location;
      if (status >= 300 && status < 400) {
        response.resume();
        resolve({ status, location, contentType, bytes: Buffer.alloc(0) });
        return;
      }
      if (status !== 200) {
        response.destroy(); reject(new SourceError(status === 401 || status === 403 || status === 429 ? 'SOURCE_ACCESS_DENIED' : 'SOURCE_UNAVAILABLE', status)); return;
      }
      if (contentEncoding !== 'identity' || !['text/html', 'text/plain'].includes(contentType)) {
        response.destroy(); reject(new SourceError('SOURCE_UNSUPPORTED')); return;
      }
      void readSourceBody(response, response.headers['content-length']).then(
        (bytes) => resolve({ status, contentType, bytes }), reject);
    });
    request.on('timeout', () => request.destroy(new SourceError('SOURCE_UNAVAILABLE')));
    const deadline = setTimeout(() => request.destroy(new SourceError('SOURCE_UNAVAILABLE')), 6000);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', reject);
    request.end();
  });
}

/** Count actual streamed bytes; Content-Length is only an early rejection, never trusted. */
export async function readSourceBody(stream: Readable, contentLength?: string): Promise<Buffer> {
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BYTES) {
    stream.destroy();
    throw new SourceError('SOURCE_TOO_LARGE');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BYTES) {
      stream.destroy();
      throw new SourceError('SOURCE_TOO_LARGE');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

/** Fetch only guarded HTML; callers decide how to parse the bytes. */
export async function fetchPublicHtml(raw: string, fetchHop: typeof oneFetch = oneFetch): Promise<{ finalUrl: string; contentType: string; bytes: Buffer }> {
  let url = canonicalPublicUrl(raw);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetchHop(url).catch((error: unknown) => {
      throw error instanceof SourceError ? error : new SourceError('SOURCE_UNAVAILABLE');
    });
    if (response.location) {
      if (redirect === MAX_REDIRECTS) throw new SourceError('SOURCE_UNSUPPORTED');
      url = resolvePublicRedirect(response.location, url);
      continue;
    }
    if (!['text/html', 'text/plain'].includes(response.contentType)) throw new SourceError('SOURCE_UNSUPPORTED');
    return { finalUrl: url.toString(), contentType: response.contentType, bytes: response.bytes };
  }
  throw new SourceError('SOURCE_UNSUPPORTED');
}

/** Resolve each Location against the current hop and reapply the public URL guard. */
export function resolvePublicRedirect(location: string, current: URL): URL {
  return canonicalPublicUrl(new URL(location, current).toString());
}

export interface ExtractedSourceMetadata {
  author: string | null;
  siteName: string | null;
  publishedDate: string | null;
  line: string;
  state: 'found' | 'partial';
  /**
   * CAPTURE-DRAFT-01: og:title, else <title>, with a trailing ` | site` / ` - site` /
   * ` – site` suffix stripped when it equals `siteName` (case-insensitive). Null when neither
   * tag is present or the collapsed text is empty.
   */
  headline: string | null;
}

const collapse = (value: unknown, cap: number): string | null => {
  if (typeof value !== 'string') return null;
  const result = value.replace(/\s+/g, ' ').trim().slice(0, cap).trim();
  return result || null;
};
const meta = (doc: Document, key: string, attr = 'name'): string | null =>
  doc.querySelector(`meta[${attr}="${key}"]`)?.getAttribute('content') ?? null;

function objects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(objects);
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  return [object, ...(Array.isArray(object['@graph']) ? objects(object['@graph']) : [])];
}
function schemaNodes(doc: Document): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const block of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try { out.push(...objects(JSON.parse(block.textContent ?? ''))); } catch { /* ignore one bad block */ }
  }
  return out;
}
function typeHas(node: Record<string, unknown>, ...types: string[]): boolean {
  const values = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  return values.some((value) => typeof value === 'string' && types.includes(value.split('/').pop()!.split('#').pop()!));
}
function names(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return entries.flatMap((entry) => {
    if (typeof entry === 'string') return [entry];
    if (entry && typeof entry === 'object') return [String((entry as Record<string, unknown>).name ?? '')];
    return [];
  }).map((name) => name.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
function localDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const iso = `${get('year')}-${get('month')}-${get('day')}`;
  if (iso <= '1990-01-01') return null;
  const todayParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const today = `${todayParts.find((p) => p.type === 'year')?.value}-${todayParts.find((p) => p.type === 'month')?.value}-${todayParts.find((p) => p.type === 'day')?.value}`;
  return iso > today ? null : iso;
}
function displayDate(iso: string | null): string | null {
  if (!iso) return null;
  const [year, month, day] = iso.split('-');
  return `${day}.${month}.${year}`;
}

/**
 * CAPTURE-DRAFT-01 headline: og:title, else <title>; a trailing ` | site`, ` - site` or
 * ` – site` suffix is removed when the text after the separator equals `site`
 * (case-insensitive). Collapsed and capped at 300 characters.
 */
function extractHeadline(document: Document, site: string): string | null {
  const raw = collapse(meta(document, 'og:title', 'property'), 600)
    ?? collapse(document.querySelector('title')?.textContent, 600);
  if (!raw) return null;
  let headline = raw;
  for (const separator of [' | ', ' - ', ' – ']) {
    const index = headline.lastIndexOf(separator);
    if (index <= 0) continue;
    const suffix = headline.slice(index + separator.length).trim();
    if (suffix.toLocaleLowerCase() === site.trim().toLocaleLowerCase()) {
      headline = headline.slice(0, index).trim();
      break;
    }
  }
  return collapse(headline, 300);
}

/** Deterministic, metadata-only extraction. No page body text or linked resources are read. */
export function extractSourceMetadata(html: string | Buffer, finalUrl: string): ExtractedSourceMetadata {
  const { document } = parseHTML(typeof html === 'string' ? html : html.toString('utf8'));
  const host = new URL(finalUrl).hostname.replace(/^www\./i, '').toLowerCase();
  const nodes = schemaNodes(document);
  const article = nodes.find((node) => typeHas(node, 'NewsArticle', 'Article', 'BlogPosting'));
  const rawAuthor = names(article?.author);
  const authorCandidates = [rawAuthor.length === 2 ? rawAuthor.join(' i ') : rawAuthor.length > 2 ? `${rawAuthor[0]} i in.` : rawAuthor[0],
    meta(document, 'author'), meta(document, 'article:author', 'property'), meta(document, 'parsely-author')];
  let author: string | null = null;
  for (const candidate of authorCandidates) {
    const value = collapse(candidate, 120);
    if (value && !/^https?:\/\//i.test(value) && !/^@[\w.]+$/.test(value)) { author = value; break; }
  }
  const publisherNode = nodes.find((node) => node.publisher !== undefined);
  const publisher = publisherNode?.publisher;
  let publisherName: unknown = typeof publisher === 'string' ? publisher : publisher && typeof publisher === 'object' ? (publisher as Record<string, unknown>).name : null;
  if (publisher && typeof publisher === 'object' && typeof (publisher as Record<string, unknown>)['@id'] === 'string') {
    const linked = nodes.find((node) => node['@id'] === (publisher as Record<string, unknown>)['@id']);
    if (linked?.name) publisherName = linked.name;
  }
  const site = collapse(publisherName, 80) ?? collapse(meta(document, 'og:site_name', 'property'), 80) ?? collapse(meta(document, 'application-name'), 80) ?? host;
  if (author && author.toLocaleLowerCase() === site.toLocaleLowerCase()) author = null;
  const dateCandidates = [article?.datePublished, meta(document, 'article:published_time', 'property'), meta(document, 'date'), meta(document, 'pubdate'), document.querySelector('article time[datetime]')?.getAttribute('datetime')];
  const publishedDate = dateCandidates.map(localDate).find((date) => date !== null) ?? null;
  const parts = [author, site, displayDate(publishedDate)].filter((part): part is string => Boolean(part));
  return {
    author, siteName: site, publishedDate, line: `Źródło: ${parts.join(', ')}`,
    state: author || publisherName || meta(document, 'og:site_name', 'property') || meta(document, 'application-name') || publishedDate ? 'found' : 'partial',
    headline: extractHeadline(document, site),
  };
}

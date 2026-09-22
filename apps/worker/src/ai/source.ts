import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_ARTICLE_CHARS = 20_000;
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
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !url.hostname || url.hostname.length > 253 ||
      /(^|\.)(localhost|local|internal|invalid|test)$/.test(url.hostname.toLowerCase())) {
    throw new SourceError('SOURCE_UNSUPPORTED');
  }
  if (isIP(url.hostname) && !publicAddress(url.hostname)) throw new SourceError('SOURCE_UNSUPPORTED');
  url.hash = '';
  return url;
}

export class SourceError extends Error {
  constructor(readonly code: 'SOURCE_UNSUPPORTED' | 'SOURCE_UNAVAILABLE' | 'SOURCE_ACCESS_DENIED' | 'SOURCE_TOO_LARGE' | 'SOURCE_TEXT_TOO_LONG' | 'SOURCE_TEXT_UNAVAILABLE') {
    super(code);
    this.name = 'SourceError';
  }
}

export interface RetrievedSource {
  url: string; retrievedAt: string; status: number; contentType: string;
  excerpt: string; sha256: string;
}

async function checkedAddress(hostname: string): Promise<{ address: string; family: number }> {
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
        response.destroy(); reject(new SourceError(status === 401 || status === 403 || status === 429 ? 'SOURCE_ACCESS_DENIED' : 'SOURCE_UNAVAILABLE')); return;
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

/** Inert parsing only: no scripts execute and no linked resources are requested. */
export function textFrom(bytes: Buffer, contentType: string): string {
  let text = bytes.toString('utf8');
  if (contentType === 'text/html') {
    const { document } = parseHTML(text);
    for (const node of document.querySelectorAll('script,style,noscript,nav,footer,aside,form,dialog,button,iframe,svg,[hidden],[aria-hidden="true"],[role="navigation"],[role="dialog"]')) node.remove();
    for (const node of document.querySelectorAll('[class],[id]')) {
      if (/(?:^|[\s_-])(cookie|consent|newsletter|related|recommendations|advertisement|advert|social-share)(?:$|[\s_-])/i.test(`${node.id} ${node.className}`)) node.remove();
    }
    // Onet keeps its introduction in a separate semantic article from the body.
    // Retain only explicit lead paragraphs, never a metadata description or script.
    const heading = document.querySelector('h1')?.textContent?.trim() ?? '';
    const leads = [...document.querySelectorAll('p')].filter((node) =>
      /(?:^|[\s_-])(lead|standfirst)(?:$|[\s_-])/i.test(node.className)).map((node) => node.textContent.trim());
    // Publisher-specific follow widget; it is not part of the reported article.
    for (const node of document.querySelectorAll('.ods-m-google-article,.ods-o-google-buttons-bottom')) node.remove();
    for (const node of document.querySelectorAll('p,li,h1,h2,h3,h4,blockquote')) node.appendChild(document.createTextNode('\n'));
    try {
      const article = new Readability(document, { charThreshold: 80, maxElemsToParse: 30_000, disableJSONLD: true }).parse();
      text = article?.textContent ?? '';
      if (!text.trim()) throw new SourceError('SOURCE_TEXT_UNAVAILABLE');
      const prefix = [heading, ...leads].filter((value, index, all) => value && all.indexOf(value) === index && !text.includes(value));
      text = [...prefix, text].join('\n');
    } catch { throw new SourceError('SOURCE_TEXT_UNAVAILABLE'); }
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || (contentType === 'text/html' && text.length < 80)) throw new SourceError('SOURCE_TEXT_UNAVAILABLE');
  if (text.length > MAX_ARTICLE_CHARS) throw new SourceError('SOURCE_TEXT_TOO_LONG');
  return text;
}

/** Every redirect is resolved and checked independently, and DNS is pinned per hop. */
export async function retrievePublicSource(raw: string): Promise<RetrievedSource> {
  let url = canonicalPublicUrl(raw);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await oneFetch(url).catch((error: unknown) => {
      throw error instanceof SourceError ? error : new SourceError('SOURCE_UNAVAILABLE');
    });
    if (response.location) {
      if (redirect === MAX_REDIRECTS) throw new SourceError('SOURCE_UNSUPPORTED');
      url = canonicalPublicUrl(new URL(response.location, url).toString());
      continue;
    }
    const excerpt = textFrom(response.bytes, response.contentType);
    if (!excerpt) throw new SourceError('SOURCE_UNSUPPORTED');
    return {
      url: url.toString(), retrievedAt: new Date().toISOString(), status: response.status,
      contentType: response.contentType, excerpt,
      sha256: createHash('sha256').update(response.bytes).digest('hex'),
    };
  }
  throw new SourceError('SOURCE_UNSUPPORTED');
}

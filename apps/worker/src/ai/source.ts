import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const MAX_BYTES = 256_000;
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
  try { url = new URL(raw); } catch { throw new SourceError('UNSUPPORTED_INPUT'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !url.hostname || url.hostname.length > 253 ||
      /(^|\.)(localhost|local|internal|invalid|test)$/.test(url.hostname.toLowerCase())) {
    throw new SourceError('UNSUPPORTED_INPUT');
  }
  if (isIP(url.hostname) && !publicAddress(url.hostname)) throw new SourceError('UNSUPPORTED_INPUT');
  url.hash = '';
  return url;
}

export class SourceError extends Error {
  constructor(readonly code: 'UNSUPPORTED_INPUT' | 'PROVIDER_UNAVAILABLE') {
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
    throw new SourceError('UNSUPPORTED_INPUT');
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
      if (status !== 200 || contentEncoding !== 'identity' || !['text/html', 'text/plain'].includes(contentType)) {
        response.resume(); reject(new SourceError('UNSUPPORTED_INPUT')); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { response.destroy(new SourceError('UNSUPPORTED_INPUT')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status, contentType, bytes: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new SourceError('PROVIDER_UNAVAILABLE')));
    request.on('error', reject);
    request.end();
  });
}

function textFrom(bytes: Buffer, contentType: string): string {
  let text = bytes.toString('utf8');
  if (contentType === 'text/html') {
    text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, 20_000);
}

/** Every redirect is resolved and checked independently, and DNS is pinned per hop. */
export async function retrievePublicSource(raw: string): Promise<RetrievedSource> {
  let url = canonicalPublicUrl(raw);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await oneFetch(url);
    if (response.location) {
      if (redirect === MAX_REDIRECTS) throw new SourceError('UNSUPPORTED_INPUT');
      url = canonicalPublicUrl(new URL(response.location, url).toString());
      continue;
    }
    const excerpt = textFrom(response.bytes, response.contentType);
    if (!excerpt) throw new SourceError('UNSUPPORTED_INPUT');
    return {
      url: url.toString(), retrievedAt: new Date().toISOString(), status: response.status,
      contentType: response.contentType, excerpt,
      sha256: createHash('sha256').update(response.bytes).digest('hex'),
    };
  }
  throw new SourceError('UNSUPPORTED_INPUT');
}

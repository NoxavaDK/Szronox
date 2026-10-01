import { createHash } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { canonicalPublicUrl, fetchPublicHtml, readSourceBody, SourceError, MAX_BYTES } from '@szronox/source-fetch';
export { canonicalPublicUrl, readSourceBody, SourceError, MAX_BYTES } from '@szronox/source-fetch';
export const MAX_ARTICLE_CHARS = 20_000;
export interface RetrievedSource { url: string; retrievedAt: string; status: number; contentType: string; excerpt: string; sha256: string }
export function textFrom(bytes: Buffer, contentType: string): string {
  let text = bytes.toString('utf8');
  if (contentType === 'text/html') {
    const { document } = parseHTML(text);
    for (const node of document.querySelectorAll('script,style,noscript,nav,footer,aside,form,dialog,button,iframe,svg,[hidden],[aria-hidden="true"],[role="navigation"],[role="dialog"]')) node.remove();
    for (const node of document.querySelectorAll('[class],[id]')) if (/(?:^|[\s_-])(cookie|consent|newsletter|related|recommendations|advertisement|advert|social-share)(?:$|[\s_-])/i.test(`${node.id} ${node.className}`)) node.remove();
    const heading = document.querySelector('h1')?.textContent?.trim() ?? '';
    const leads = [...document.querySelectorAll('p')].filter((node) => /(?:^|[\s_-])(lead|standfirst)(?:$|[\s_-])/i.test(node.className)).map((node) => node.textContent.trim());
    for (const node of document.querySelectorAll('.ods-m-google-article,.ods-o-google-buttons-bottom')) node.remove();
    for (const node of document.querySelectorAll('p,li,h1,h2,h3,h4,blockquote')) node.appendChild(document.createTextNode('\n'));
    try { const article = new Readability(document, { charThreshold: 80, maxElemsToParse: 30_000, disableJSONLD: true }).parse(); text = article?.textContent ?? ''; if (!text.trim()) throw new SourceError('SOURCE_TEXT_UNAVAILABLE'); const prefix = [heading, ...leads].filter((value, index, all) => value && all.indexOf(value) === index && !text.includes(value)); text = [...prefix, text].join('\n'); }
    catch { throw new SourceError('SOURCE_TEXT_UNAVAILABLE'); }
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text || (contentType === 'text/html' && text.length < 80)) throw new SourceError('SOURCE_TEXT_UNAVAILABLE');
  if (text.length > MAX_ARTICLE_CHARS) throw new SourceError('SOURCE_TEXT_TOO_LONG');
  return text;
}
export async function retrievePublicSource(raw: string): Promise<RetrievedSource> {
  const result = await fetchPublicHtml(raw);
  const excerpt = textFrom(result.bytes, result.contentType);
  return { url: result.finalUrl, retrievedAt: new Date().toISOString(), status: 200, contentType: result.contentType, excerpt, sha256: createHash('sha256').update(result.bytes).digest('hex') };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { canonicalPublicUrl, extractSourceMetadata, fetchPublicHtml, MAX_BYTES, readSourceBody, resolvePublicRedirect, SourceError } from './index.js';
const finalUrl = 'https://www.example.com/story';
const line = (html: string) => extractSourceMetadata(html, finalUrl).line;

test('JSON-LD NewsArticle author and date format exactly', () => {
  const html = `<head><script type="application/ld+json">{"@type":"NewsArticle","author":{"name":"  Jan   Kowalski "},"datePublished":"2024-05-06T10:00:00+02:00","publisher":{"name":"Przykład"}}</script></head>`;
  assert.equal(line(html), 'Źródło: Jan Kowalski, Przykład, 06.05.2024');
});
test('@graph publisher is resolved through its identifier', () => {
  const html = `<script type="application/ld+json">{"@graph":[{"@type":"NewsArticle","publisher":{"@id":"#publisher"}},{"@id":"#publisher","@type":"Organization","name":"Gazeta Testowa"}]}</script>`;
  assert.equal(line(html), 'Źródło: Gazeta Testowa');
});
test('Open Graph and application metadata provide site name', () => {
  assert.equal(line('<meta property="og:site_name" content="  Portal   Testowy ">'), 'Źródło: Portal Testowy');
  assert.equal(line('<meta name="application-name" content="Aplikacja">'), 'Źródło: Aplikacja');
});
test('meta author priority, two authors and three-author abbreviation are deterministic', () => {
  assert.equal(line('<meta name="author" content="Anna Nowak">'), 'Źródło: Anna Nowak, example.com');
  assert.equal(line('<script type="application/ld+json">{"@type":"Article","author":[{"name":"A"},{"name":"B"}]}</script>'), 'Źródło: A i B, example.com');
  assert.equal(line('<script type="application/ld+json">{"@type":"Article","author":[{"name":"A"},{"name":"B"},{"name":"C"}]}</script>'), 'Źródło: A i in., example.com');
});
test('site-valued author is removed and URL-valued article:author falls through', () => {
  assert.equal(line('<meta name="author" content="EXAMPLE.COM">'), 'Źródło: example.com');
  assert.equal(line('<meta property="article:author" content="https://example.com/author"><meta name="parsely-author" content="Ewa">'), 'Źródło: Ewa, example.com');
});
test('invalid and future dates are dropped; malformed JSON-LD is ignored', () => {
  const future = new Date(Date.now() + 86400_000).toISOString();
  assert.equal(line(`<meta name="date" content="not a date"><meta name="pubdate" content="${future}">`), 'Źródło: example.com');
  assert.equal(line('<script type="application/ld+json">{not json</script><meta property="og:site_name" content="Social">'), 'Źródło: Social');
});
test('metadata-free social pages return partial host fallback', () => {
  const result = extractSourceMetadata('<html><head></head><body>post</body></html>', 'https://www.instagram.com/p/123');
  assert.equal(result.state, 'partial'); assert.equal(result.line, 'Źródło: instagram.com');
});
test('public URL guard rejects private and loopback addresses and redirect targets', async () => {
  for (const url of ['http://127.0.0.1', 'http://10.0.0.2', 'http://192.168.1.1', 'http://[::1]']) assert.throws(() => canonicalPublicUrl(url), { code: 'SOURCE_UNSUPPORTED' });
  assert.throws(() => resolvePublicRedirect('http://127.0.0.1/private', new URL('https://example.com/a')), { code: 'SOURCE_UNSUPPORTED' });
  let hops = 0;
  await assert.rejects(fetchPublicHtml('https://example.com', async () => {
    hops += 1; return { status: 302, location: 'http://127.0.0.1/private', contentType: '', bytes: Buffer.alloc(0) };
  }), { code: 'SOURCE_UNSUPPORTED' });
  assert.equal(hops, 1);
});
test('source body refuses oversize streams and source fetch reports bounded timeout failures', async () => {
  await assert.rejects(readSourceBody(Readable.from([Buffer.alloc(MAX_BYTES + 1)])), { code: 'SOURCE_TOO_LARGE' });
  await assert.rejects(fetchPublicHtml('https://example.com', async () => { throw new SourceError('SOURCE_UNAVAILABLE'); }), { code: 'SOURCE_UNAVAILABLE' });
});

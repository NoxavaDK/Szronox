import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { MAX_BYTES, MAX_ARTICLE_CHARS, readSourceBody, textFrom, canonicalPublicUrl } from './source.js';
const paragraph = 'Woda jest cennym zasobem. Artykuł opisuje konkretne sposoby ochrony rzek, czystości wody oraz zapobiegania suszy. ';
test('large HTML yields article text, not scripts, navigation or recommendations', () => {
 const html = `<html><head><title>Ochrona rzek</title><script>${'x'.repeat(440_000)}</script></head><body><nav>MENU_SENTINEL</nav><article><h1>Ochrona rzek</h1><p>${paragraph.repeat(4)} &amp; &#322;ąki.</p><div class="related">RELATED_SENTINEL</div><img src="https://invalid.invalid/image"></article><footer>FOOTER_SENTINEL</footer></body></html>`;
 const result = textFrom(Buffer.from(html), 'text/html');
 assert.match(result,/Ochrona|Woda/);assert.match(result,/& łąki/);
 assert.doesNotMatch(result,/SENTINEL|xxxx|https:/);
 assert.ok(result.length < 1000);
});
test('no article and oversized extracted text fail explicitly rather than truncate', () => {
 assert.throws(()=>textFrom(Buffer.from('<html><body><nav>Menu</nav></body></html>'),'text/html'),{code:'SOURCE_TEXT_UNAVAILABLE'});
 assert.throws(()=>textFrom(Buffer.from('x'.repeat(MAX_ARTICLE_CHARS+1)),'text/plain'),{code:'SOURCE_TEXT_TOO_LONG'});
 assert.equal(textFrom(Buffer.from('x'.repeat(MAX_ARTICLE_CHARS)),'text/plain').length,MAX_ARTICLE_CHARS);
});
test('body limit checks actual bytes even with understated length', async () => {
 let produced=0;
 const stream=Readable.from((async function*(){while(true){produced++;yield Buffer.alloc(65536);}})(),{highWaterMark:1});
 await assert.rejects(readSourceBody(stream,'1'),{code:'SOURCE_TOO_LARGE'});
 assert.ok(produced<=MAX_BYTES/65536+2);assert.ok(stream.destroyed);
});
test('overstated body length is rejected before reading; exact bound is accepted',async()=>{
 let read=false;const stream=new Readable({read(){read=true;this.push(null);}});
 await assert.rejects(readSourceBody(stream,String(MAX_BYTES+1)),{code:'SOURCE_TOO_LARGE'});
 assert.equal(read,false);
 assert.equal((await readSourceBody(Readable.from([Buffer.alloc(MAX_BYTES)]))).length,MAX_BYTES);
});
test('private and unsupported URLs remain rejected',()=>{
 for(const url of ['http://127.0.0.1','file:///etc/passwd','https://x.local','https://a:b@example.com'])assert.throws(()=>canonicalPublicUrl(url),{code:'SOURCE_UNSUPPORTED'});
});

test('separate publisher introduction survives and follow widget does not', () => {
 const html=`<html><head><title>News</title></head><body><article><h1>Headline</h1><p class="ods-a-lead-text">LEAD_SENTINEL ${paragraph}</p></article><article><p>${paragraph.repeat(8)}</p><div class="ods-m-google-article">FOLLOW_SENTINEL</div><p>Second paragraph ends here.</p></article></body></html>`;
 const result=textFrom(Buffer.from(html),'text/html');
 assert.match(result,/LEAD_SENTINEL/);assert.match(result,/Headline/);assert.doesNotMatch(result,/FOLLOW_SENTINEL/);
 assert.match(result,/suszy\. Second/);
});

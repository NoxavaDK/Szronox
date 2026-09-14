// Run inside the application container after starting a release.
import assert from 'node:assert/strict';

const base = 'http://127.0.0.1:3000';
const health = await fetch(`${base}/api/v1/health`);
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), { status: 'ok' });
const page = await fetch(base);
assert.equal(page.status, 200);
const html = await page.text();
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g)].map(m => m[1]);
assert.ok(assets.length >= 2, 'Expected JavaScript and CSS assets');
for (const asset of assets) {
  const response = await fetch(base + asset);
  assert.equal(response.status, 200, asset);
  assert.ok((await response.text()).length > 0, asset);
}
assert.equal((await fetch(`${base}/api/v1/not-a-route`)).status, 404);
assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404);
console.log(`PASS: health, page, ${assets.length} assets, API and asset 404s`);

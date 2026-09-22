import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from './app.js';

/**
 * How the origin root serves the two resources a PWA cannot do without.
 *
 * VPS-07 finding 4 recorded that `/sw.js`, `/service-worker.js`, `/manifest.webmanifest` and
 * `/manifest.json` all returned `200 text/html`, because the SPA fallback answered them. That
 * is harmless only while nothing registers a worker. Once something does, the browser reports
 * a MIME-type error that names neither the missing file nor the fallback, and installability
 * degrades with no usable diagnosis.
 *
 * These tests run against the real build output, so they assert what is actually served rather
 * than what a double would say. They require `npm run build -w @szronox/web` to have run —
 * which the deployment image does before the API is packaged.
 */

test('the service worker and manifest are served as themselves, not as the SPA document', async () => {
  const app = buildApp();
  for (const [url, expected] of [
    ['/sw.js', /javascript/],
    ['/manifest.webmanifest', /manifest\+json|json/],
    ['/icon-192.png', /image\/png/],
    ['/icon-512.png', /image\/png/],
    ['/icon-maskable-512.png', /image\/png/],
  ] as const) {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, `${url} should be served`);
    assert.match(response.headers['content-type'] ?? '', expected, `${url} content type`);
    assert.doesNotMatch(response.headers['content-type'] ?? '', /text\/html/, `${url} must not be HTML`);

    // A HEAD probe is how a deployment gets checked, and it must agree with the GET.
    const head = await app.inject({ method: 'HEAD', url });
    assert.equal(head.statusCode, 200, `HEAD ${url} should be served`);
    assert.doesNotMatch(head.headers['content-type'] ?? '', /text\/html/, `HEAD ${url} must not be HTML`);
  }
  await app.close();
});

test('the worker payload is a classic script with a generated precache list', async () => {
  const app = buildApp();
  const response = await app.inject({ method: 'GET', url: '/sw.js' });
  const body = response.body;

  // A classic worker cannot contain module syntax. Comments are stripped first so that this
  // prose, or the worker's own, cannot satisfy or break the check.
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /(^|[;}\s])import\s*[({*'"]/, 'classic worker must not import');
  assert.doesNotMatch(code, /(^|[;}\s])export\s*[({*]/, 'classic worker must not export');

  // The precache list names the hashed bundle this build actually emitted. A stale or
  // hand-written list would not match the file on disk.
  const asset = /["'](\/assets\/index-[A-Za-z0-9_-]+\.js)["']/.exec(code);
  assert.ok(asset, 'the worker should name a hashed entry bundle');
  const served = await app.inject({ method: 'GET', url: asset[1] });
  assert.equal(served.statusCode, 200, `${asset[1]} named by the worker should exist`);
  await app.close();
});

test('the served manifest is installable and every resource it names is actually served', async () => {
  const app = buildApp();
  const response = await app.inject({ method: 'GET', url: '/manifest.webmanifest' });
  const manifest = JSON.parse(response.body) as {
    name: string; start_url: string; scope: string; display: string;
    icons: Array<{ src: string; sizes: string; purpose?: string }>;
    share_target: { action: string; method: string; enctype: string };
  };

  // The installability basics: a name, a scope the start URL lives in, a standalone display,
  // and raster icons at both sizes Chrome's installability checks look for.
  assert.equal(manifest.name, 'SzroNox');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.scope, '/');
  assert.ok(manifest.start_url.startsWith(manifest.scope));
  const sizes = manifest.icons.map((icon) => icon.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'), 'an Android home screen needs a maskable icon');

  // Every icon it names must exist. A manifest referencing a missing icon is the classic
  // silent installability failure.
  for (const icon of manifest.icons) {
    const served = await app.inject({ method: 'GET', url: icon.src });
    assert.equal(served.statusCode, 200, `${icon.src} named by the manifest should exist`);
    assert.match(served.headers['content-type'] ?? '', /image\/png/, `${icon.src} should be a PNG`);
  }

  // And the share target must point at the path this server actually answers, or a share
  // would 404 on any device where the worker is not running.
  assert.equal(manifest.share_target.method, 'POST');
  assert.equal(manifest.share_target.enctype, 'multipart/form-data');
  const fallback = await app.inject({
    method: 'POST',
    url: manifest.share_target.action,
    headers: { 'content-type': 'multipart/form-data; boundary=----szronox' },
    payload: '------szronox--\r\n',
  });
  assert.equal(fallback.statusCode, 303, `${manifest.share_target.action} should be routed`);
  await app.close();
});

test('missing root resources fail as missing files, never as SPA HTML (F1)', async () => {
  const app = buildApp();
  // Real absent paths: neither name is ever emitted by the build, so this exercises the
  // not-found path rather than a simulated one.
  for (const url of ['/service-worker.js', '/manifest.json'] as const) {
    for (const method of ['GET', 'HEAD'] as const) {
      const response = await app.inject({ method, url });
      assert.equal(response.statusCode, 404, `${method} ${url} should 404`);
      assert.doesNotMatch(
        response.headers['content-type'] ?? '',
        /text\/html/,
        `${method} ${url} must not return the SPA document`,
      );
      assert.equal(response.body, '', `${method} ${url} should have no body`);
    }
  }

  // The ordinary deep-link fallback is untouched: a navigation still gets the app.
  const navigation = await app.inject({ method: 'GET', url: '/reels/example' });
  assert.equal(navigation.statusCode, 200);
  assert.match(navigation.headers['content-type'] ?? '', /text\/html/);
  await app.close();
});

test('the share target POST is answered honestly when no worker took it', async () => {
  const app = buildApp();
  const response = await app.inject({
    method: 'POST',
    url: '/share-target',
    headers: { 'content-type': 'multipart/form-data; boundary=----szronox' },
    payload: [
      '------szronox',
      'Content-Disposition: form-data; name="text"',
      '',
      'https://example.test/a',
      '------szronox--',
      '',
    ].join('\r\n'),
  });

  // 303 turns the POST into a GET of the app, which then explains the failure in Polish.
  assert.equal(response.statusCode, 303);
  assert.equal(response.headers.location, '/?shareError=worker_unavailable');
  assert.equal(response.headers['cache-control'], 'no-store');
  // Nothing was stored and nothing was echoed back: the shared URL must not appear anywhere.
  assert.doesNotMatch(String(response.headers.location), /example\.test/);
  assert.equal(response.body, '');
  await app.close();
});

test('the share target parser does not change how other routes read bodies', async () => {
  const app = buildApp();
  // The multipart parser is registered in an encapsulated scope. Outside it, a multipart body
  // is still unsupported, which is what every JSON route depends on.
  const elsewhere = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'content-type': 'multipart/form-data; boundary=----szronox' },
    payload: '------szronox--\r\n',
  });
  assert.notEqual(elsewhere.statusCode, 303);
  await app.close();
});

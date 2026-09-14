import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from './app.js';

test('health endpoint is under API namespace', async () => {
  const app = buildApp();
  const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
  await app.close();
});

test('unknown API paths are not swallowed by SPA fallback', async () => {
  const app = buildApp();
  const response = await app.inject({ method: 'GET', url: '/api/v1/missing' });
  assert.equal(response.statusCode, 404);
  await app.close();
});

test('the production fallback serves the built SPA only for non-API paths', async () => {
  const app = buildApp();
  const response = await app.inject({ method: 'GET', url: '/reels/example' });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'] ?? '', /text\/html/);
  const apiRoot = await app.inject({ method: 'GET', url: '/api' });
  assert.equal(apiRoot.statusCode, 404);
  const apiRootWithQuery = await app.inject({ method: 'GET', url: '/api?probe=1' });
  assert.equal(apiRootWithQuery.statusCode, 404);
  await app.close();
});

test('unknown API paths return the shared error envelope for every method (F2)', async () => {
  const app = buildApp();
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] as const) {
    const response = await app.inject({ method, url: '/api/v1/does-not-exist' });
    assert.equal(response.statusCode, 404, `${method} should 404`);
    assert.deepEqual(response.json(), {
      error: { code: 'NOT_FOUND', message: 'Route not found', retryable: false },
    });
  }
  const head = await app.inject({ method: 'HEAD', url: '/api/v1/does-not-exist' });
  assert.equal(head.statusCode, 404);
  assert.equal(head.body, '');
  await app.close();
});

test('missing hashed build assets 404 while real assets serve with correct MIME (F3)', async () => {
  const app = buildApp();
  const missing = await app.inject({ method: 'GET', url: '/assets/missing.js' });
  assert.equal(missing.statusCode, 404);
  assert.doesNotMatch(missing.headers['content-type'] ?? '', /text\/html/);

  const [realAsset] = (await import('node:fs/promises').then((fs) =>
    fs.readdir(new URL('../../web/dist/assets', import.meta.url)),
  )).filter((name) => name.endsWith('.js'));
  const real = await app.inject({ method: 'GET', url: `/assets/${realAsset}` });
  assert.equal(real.statusCode, 200);
  assert.match(real.headers['content-type'] ?? '', /javascript/);
  await app.close();
});

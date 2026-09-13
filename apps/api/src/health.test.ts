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

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';

const here = path.dirname(fileURLToPath(import.meta.url));

export function buildApp() {
  const app = Fastify({ logger: false });
  app.get('/api/v1/health', async () => ({ status: 'ok' as const }));

  const webRoot = path.resolve(here, '../../web/dist');
  app.register(fastifyStatic, { root: webRoot, wildcard: false });
  app.get('/*', async (request, reply) => {
    const pathname = request.url.split('?', 1)[0];
    if (pathname === '/api' || pathname.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', retryable: false } });
    return reply.sendFile('index.html');
  });
  return app;
}

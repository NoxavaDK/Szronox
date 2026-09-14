import type { FastifyInstance } from 'fastify';

/**
 * Test-only seam for shutdown behaviour. NOT a product feature.
 *
 * Registered only when `API_TEST_SEAM` is set, which `index.ts` reads and which
 * nothing in production sets. Without that variable none of this exists: no route
 * is added and no hook is installed.
 *
 * C04 (C01 follow-up). The previous shutdown test equated "the client's TCP write
 * returned" with "the server entered a handler", which it does not: the bytes may
 * sit in a socket buffer while the signal arrives first. It also had no way to
 * reach the close-error and deadline branches without inventing a real slow
 * endpoint. Both problems need a seam the test controls, so the seam exists here
 * rather than being smuggled into the application surface.
 *
 * `HANDLER_ENTERED` is written to stdout from inside the handler, so a test can
 * wait for proof of handler entry before signalling.
 */

export const HANDLER_ENTERED_MARKER = 'TEST_SEAM_HANDLER_ENTERED';

export type TestSeamMode = 'hold' | 'close-error';

export function isTestSeamMode(value: string | undefined): value is TestSeamMode {
  return value === 'hold' || value === 'close-error';
}

export function registerTestSeam(app: FastifyInstance, mode: TestSeamMode): void {
  // A request that announces it is genuinely inside the handler, then stays there.
  app.get('/__test/hold', async (request) => {
    const requested = Number((request.query as { ms?: string } | undefined)?.ms ?? 250);
    const holdMs = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), 30_000) : 250;
    process.stdout.write(`${HANDLER_ENTERED_MARKER}\n`);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    return { held: holdMs };
  });

  if (mode === 'close-error') {
    // Drives the shutdown catch branch: app.close() rejects.
    app.addHook('onClose', async () => {
      throw new Error('test seam: close failed deliberately');
    });
  }
}

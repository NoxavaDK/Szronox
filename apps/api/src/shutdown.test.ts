import assert from 'node:assert/strict';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { connect, createServer } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HANDLER_ENTERED_MARKER } from './test-seam.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, 'index.js');

/**
 * C04 rewrite of the shutdown suite (C01 follow-up).
 *
 * Three problems in the previous version are addressed here:
 *
 *  1. It treated a client TCP connect + write as proof that a request was in
 *     flight. It is not: the bytes can sit in a socket buffer while the signal
 *     arrives first. Handler entry is now proven by a marker the handler itself
 *     writes, via the env-gated test seam.
 *  2. Its refusal check waited for process exit first, so it only showed that an
 *     exited process refuses connections. Refusal is now asserted *while shutdown
 *     is still in progress*, with an in-flight request deliberately held open.
 *  3. Exit observation was attached after signalling and could miss the event, and
 *     waits were unbounded so a regression could hang the suite. Every wait is now
 *     bounded, and exit is observed before any signal is sent.
 *
 * The close-error and deadline branches are driven through the test seam rather
 * than through a real application endpoint.
 */

const DEFAULT_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, label: string, ms = DEFAULT_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function freePort(): Promise<number> {
  return withTimeout(new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address && typeof address === 'object') probe.close(() => resolve(address.port));
      else probe.close(() => reject(new Error('could not allocate a free port')));
    });
  }), 'allocating a free port', 2_000);
}

/** stdio is ['ignore','pipe','pipe']: no stdin, both output streams readable. */
type ServerChild = ChildProcessByStdio<null, Readable, Readable>;

interface Server {
  child: ServerChild;
  port: number;
  stdout: () => string;
  stderr: () => string;
  waitForStdout: (needle: string, label: string) => Promise<void>;
  waitForExit: () => Promise<number | NodeJS.Signals>;
}

async function start(options: { seam?: string; shutdownTimeoutMs?: number } = {}): Promise<Server> {
  const port = await freePort();
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SHUTDOWN_TIMEOUT_MS: String(options.shutdownTimeoutMs ?? 10_000),
      ...(options.seam ? { API_TEST_SEAM: options.seam } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { err += String(chunk); });

  // Exit is captured from the start, so nothing depends on attaching a listener
  // before or after a signal, and an already-exited child resolves immediately.
  let exited: number | NodeJS.Signals | null = null;
  const exitWaiters: Array<(value: number | NodeJS.Signals) => void> = [];
  child.once('exit', (code, signal) => {
    exited = code ?? signal ?? 0;
    for (const resolve of exitWaiters) resolve(exited);
  });

  const server: Server = {
    child,
    port,
    stdout: () => out,
    stderr: () => err,
    waitForStdout: (needle, label) => withTimeout(new Promise<void>((resolve, reject) => {
      const check = () => {
        if (out.includes(needle)) return resolve();
        if (exited !== null) return reject(new Error(`process exited before ${label}; stderr: ${err}`));
        setTimeout(check, 10);
      };
      check();
    }), label),
    waitForExit: () => withTimeout(new Promise<number | NodeJS.Signals>((resolve) => {
      if (exited !== null) resolve(exited);
      else exitWaiters.push(resolve);
    }), 'process exit'),
  };

  // Readiness, bounded.
  const deadline = Date.now() + 5_000;
  for (;;) {
    if (exited !== null) throw new Error(`server exited during startup; stderr: ${err}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      await response.arrayBuffer();
      if (response.status === 200) return server;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not become healthy; stderr: ${err}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Always reap the child, whatever the assertions did. */
async function stop(server: Server): Promise<void> {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGKILL');
    await server.waitForExit().catch(() => undefined);
  }
}

/** Can a brand-new TCP connection be established right now? */
function canConnect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    setTimeout(() => finish(false), 1_000);
  });
}

test('SIGTERM drains a request proven to be inside a handler, and refuses new work while shutting down', async () => {
  const server = await start({ seam: 'hold', shutdownTimeoutMs: 10_000 });
  try {
    // Held long enough that the shutdown is observably still in progress.
    // `connection: close` keeps this test about draining: a keep-alive socket
    // interacts with Fastify's close in a separate, documented way asserted by the
    // next test, and mixing the two would make this one non-deterministic.
    const inFlight = fetch(`http://127.0.0.1:${server.port}/__test/hold?ms=700`, {
      headers: { connection: 'close' },
    });
    // Proof of handler entry, written by the handler itself.
    await server.waitForStdout(HANDLER_ENTERED_MARKER, 'handler entry before signalling');

    server.child.kill('SIGTERM');
    server.child.kill('SIGTERM');
    server.child.kill('SIGTERM');

    // While the held request keeps shutdown open, new connections must already be
    // refused. The process has not exited yet, so this is refusal *during*
    // shutdown rather than after it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(server.child.exitCode, null, 'the server should still be draining');
    assert.equal(await canConnect(server.port), false, 'the listener must stop accepting during shutdown');

    // The already-accepted request still completes.
    const response = await withTimeout(inFlight, 'in-flight response');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { held: 700 });

    assert.equal(await server.waitForExit(), 0, `expected a clean exit; stderr: ${server.stderr()}`);
  } finally {
    await stop(server);
  }
});

test('a keep-alive client in flight at SIGTERM drains, but close waits for the deadline', async () => {
  // C04 finding, pinned rather than silently changed. Node's fetch keeps the
  // connection alive by default. When the request is still in flight as the signal
  // arrives, the socket returns to the keep-alive pool *after* close() has begun
  // and is not reclaimed, so shutdown waits out the deadline and exits non-zero.
  //
  // The request itself is NOT cut off, which is the safe side of the trade-off:
  // Fastify's `forceCloseConnections: true` closes in ~5ms but aborts the in-flight
  // response, and neither the default nor `'idle'` reclaims a socket that becomes
  // idle later. Choosing a drain-then-reclaim strategy is a design decision for the
  // lead, not something this follow-up changes unasked.
  const server = await start({ seam: 'hold', shutdownTimeoutMs: 600 });
  try {
    const inFlight = fetch(`http://127.0.0.1:${server.port}/__test/hold?ms=200`);
    await server.waitForStdout(HANDLER_ENTERED_MARKER, 'handler entry before signalling');
    server.child.kill('SIGTERM');

    // The in-flight request still completes: draining works.
    const response = await withTimeout(inFlight, 'in-flight response');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { held: 200 });

    // But the process leaves via the deadline, not a clean close.
    assert.equal(await server.waitForExit(), 1, 'currently exits via the deadline');
    assert.match(server.stderr(), /shutdown deadline exceeded after SIGTERM/);
  } finally {
    await stop(server);
  }
});

test('SIGINT follows the same repeat-safe path', async () => {
  const server = await start();
  try {
    server.child.kill('SIGINT');
    server.child.kill('SIGINT');
    assert.equal(await server.waitForExit(), 0, `stderr: ${server.stderr()}`);
  } finally {
    await stop(server);
  }
});

test('a request that outlives the deadline forces a reported non-zero exit', async () => {
  // The branch C01 shipped untested. Driven through the seam, not a real endpoint.
  const server = await start({ seam: 'hold', shutdownTimeoutMs: 300 });
  try {
    const inFlight = fetch(`http://127.0.0.1:${server.port}/__test/hold?ms=9000`).catch(() => 'aborted');
    await server.waitForStdout(HANDLER_ENTERED_MARKER, 'handler entry before signalling');

    const started = Date.now();
    server.child.kill('SIGTERM');
    assert.equal(await server.waitForExit(), 1, 'the deadline must force a non-zero exit');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 300, `exited after ${elapsed}ms, before the 300ms deadline`);
    assert.ok(elapsed < 5_000, `exit took ${elapsed}ms, far beyond the deadline`);
    // C04: the deadline is now reported, so exit 1 is diagnosable.
    assert.match(server.stderr(), /shutdown deadline exceeded after SIGTERM/);
    await inFlight;
  } finally {
    await stop(server);
  }
});

test('a failing close is reported and exits non-zero without waiting for the deadline', async () => {
  const server = await start({ seam: 'close-error', shutdownTimeoutMs: 9_000 });
  try {
    const started = Date.now();
    server.child.kill('SIGTERM');
    assert.equal(await server.waitForExit(), 1, 'a close error must exit non-zero');
    const elapsed = Date.now() - started;
    // Distinguishes the catch branch from the deadline branch: it must not wait.
    assert.ok(elapsed < 5_000, `close error took ${elapsed}ms, suggesting it fell through to the deadline`);
    assert.match(server.stderr(), /shutdown close failed after SIGTERM/);
    assert.doesNotMatch(server.stderr(), /deadline exceeded/);
  } finally {
    await stop(server);
  }
});

test('the test seam does not exist unless it is explicitly enabled', async () => {
  const server = await start();
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/__test/hold`);
    // Not a 404: `/__test/hold` is a non-API GET, so with no seam registered it
    // falls through to the SPA fallback like any other navigation path. What
    // proves the seam is absent is that no handler ran and no JSON came back.
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(server.stdout().includes(HANDLER_ENTERED_MARKER), false, 'no seam handler may run');

    // Under /api the shared envelope still applies, seam or not.
    const apiResponse = await fetch(`http://127.0.0.1:${server.port}/api/__test/hold`);
    assert.equal(apiResponse.status, 404);
    assert.deepEqual(await apiResponse.json(), {
      error: { code: 'NOT_FOUND', message: 'Route not found', retryable: false },
    });

    server.child.kill('SIGTERM');
    assert.equal(await server.waitForExit(), 0);
  } finally {
    await stop(server);
  }
});

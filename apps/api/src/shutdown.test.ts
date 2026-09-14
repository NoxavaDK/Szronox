import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect, createServer, type Socket } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, 'index.js');

function spawnServer(port: number, shutdownTimeoutMs: number) {
  return spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

type ShutdownTestChild = ReturnType<typeof spawnServer>;

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('could not allocate a free port')));
      }
    });
  });
}

async function waitForHealth(port: number, deadlineMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      await response.arrayBuffer();
      if (response.status === 200) return;
    } catch {
      // server socket not accepting connections yet
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('server did not become healthy before the deadline');
}

// Opens a real TCP connection and writes the request line before returning, so the caller can
// prove the request was already accepted by the server *before* sending a shutdown signal --
// unlike a bare fetch() call, whose connection establishment races the signal nondeterministically.
async function sendRawRequest(port: number): Promise<{ socket: Socket; response: Promise<string> }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const response = new Promise<string>((resolveResponse, rejectResponse) => {
        let data = '';
        socket.on('data', (chunk) => { data += chunk.toString('utf8'); });
        socket.on('end', () => resolveResponse(data));
        socket.on('error', rejectResponse);
      });
      socket.write('GET /api/v1/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
      resolve({ socket, response });
    });
    socket.on('error', reject);
  });
}

function waitForExit(child: ShutdownTestChild): Promise<number | null> {
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
}

function killIfAlive(child: ShutdownTestChild): void {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

test('SIGTERM finishes an already-accepted in-flight request, tolerates repeated signals, and exits within the bounded deadline (F4)', async () => {
  const port = await getFreePort();
  const shutdownTimeoutMs = 3000;
  const child = spawnServer(port, shutdownTimeoutMs);

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  try {
    await waitForHealth(port);

    // The socket is connected and the request line written before we return, so it is
    // provably in-flight (already accepted by the server) at the moment the signal is sent.
    const { response } = await sendRawRequest(port);

    const start = Date.now();
    child.kill('SIGTERM');
    child.kill('SIGTERM');
    child.kill('SIGTERM'); // repeated signals must not crash the process or double-exit

    const raw = await response;
    assert.match(raw, /^HTTP\/1\.1 200/);

    const exitCode = await waitForExit(child);
    const elapsed = Date.now() - start;

    assert.equal(exitCode, 0, `expected a clean exit, stderr: ${stderr}`);
    assert.ok(elapsed < shutdownTimeoutMs, `shutdown took ${elapsed}ms, exceeding its ${shutdownTimeoutMs}ms deadline`);
  } finally {
    killIfAlive(child);
  }
});

test('a connection attempt after shutdown has begun is refused, not silently accepted', async () => {
  const port = await getFreePort();
  const child = spawnServer(port, 3000);

  try {
    await waitForHealth(port);
    child.kill('SIGTERM');
    const exitCode = await waitForExit(child);
    assert.equal(exitCode, 0);

    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/v1/health`));
  } finally {
    killIfAlive(child);
  }
});

test('SIGINT triggers the same bounded, repeat-safe shutdown path', async () => {
  const port = await getFreePort();
  const shutdownTimeoutMs = 3000;
  const child = spawnServer(port, shutdownTimeoutMs);

  try {
    await waitForHealth(port);
    child.kill('SIGINT');
    child.kill('SIGINT');
    const exitCode = await waitForExit(child);
    assert.equal(exitCode, 0);
  } finally {
    killIfAlive(child);
  }
});

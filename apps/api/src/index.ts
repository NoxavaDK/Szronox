import { buildApp } from './app.js';
import { isTestSeamMode, registerTestSeam } from './test-seam.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000);
const app = buildApp();

// Test-only seam for the shutdown suite. Nothing in production sets API_TEST_SEAM,
// and an unrecognised value registers nothing.
const seamMode = process.env.API_TEST_SEAM;
if (isTestSeamMode(seamMode)) registerTestSeam(app, seamMode);

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.stderr.write(`listen failed: ${String(error)}\n`);
  process.exit(1);
}

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  // Repeat-safe: later signals during an in-progress shutdown are ignored rather
  // than starting a second close or a second deadline.
  if (shuttingDown) return;
  shuttingDown = true;

  const forceExit = setTimeout(() => {
    // C04: written to stderr as well as the logger. The app is built with
    // `logger: false`, so `app.log.error` is a no-op and both failure branches were
    // previously silent -- leaving exit code 1 as the only signal, ambiguous
    // between a hung close and a close error.
    app.log.error(`shutdown deadline exceeded after ${signal}`);
    process.stderr.write(`shutdown deadline exceeded after ${signal} (${shutdownTimeoutMs}ms)\n`);
    process.exit(1);
  }, shutdownTimeoutMs);
  forceExit.unref();

  try {
    await app.close();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExit);
    app.log.error(error);
    process.stderr.write(`shutdown close failed after ${signal}: ${String(error)}\n`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

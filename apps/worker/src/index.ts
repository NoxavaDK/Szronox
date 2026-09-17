/**
 * Worker process entry point.
 *
 * Same two-mode rule as the API: configured means every dependency must be reachable
 * and the role's grants must be narrow enough, or the process exits 1; unconfigured
 * outside production means the previous idle scaffold, announced as such.
 *
 * Each tick probes the database, then processes at most one durable AI run when
 * AI_ENABLED is set. Job ownership and finalization are fenced in the AI module.
 *
 * Shutdown mirrors the API: repeat-safe, one bounded deadline, exit 0 on a clean
 * drain and exit 1 when the deadline passes or draining fails.
 */

import { composeWorkerRuntime, databaseConfigured, type WorkerEnv, type WorkerRuntime } from './runtime.js';

const env = process.env as WorkerEnv & { NODE_ENV?: string; SHUTDOWN_TIMEOUT_MS?: string };
const shutdownTimeoutMs = Number(env.SHUTDOWN_TIMEOUT_MS ?? 10_000);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

let runtime: WorkerRuntime | null = null;

if (databaseConfigured(env)) {
  try {
    runtime = await composeWorkerRuntime(env);
  } catch (error) {
    fail(`worker runtime composition failed: ${error instanceof Error ? error.message : String(error)}`);
  }
} else if (env.NODE_ENV === 'production') {
  fail('worker runtime is not configured: DATABASE_* is required when NODE_ENV=production');
} else {
  process.stderr.write('worker runtime is not configured: idling without a database connection.\n');
}

const pollMs = runtime?.pollMs ?? Number(env.WORKER_POLL_MS ?? 30_000);
process.stdout.write(
  runtime
    ? `worker ready ${JSON.stringify(runtime.describe())}\n`
    : `SzroNox worker started unconfigured (poll ${pollMs}ms)\n`,
);
for (const violation of runtime?.privilegeViolations ?? []) {
  // Reached only when enforcement was explicitly disabled, so a single-role local run
  // cannot be mistaken for verified separation.
  process.stderr.write(`WARNING: worker database role ${runtime?.role} ${violation}\n`);
}

let shuttingDown = false;
let ticking = false;
const timer = setInterval(() => {
  // Overlap-safe: a slow probe must not stack ticks on a two-connection pool.
  if (ticking || runtime === null || shuttingDown) return;
  ticking = true;
  void runtime.tick()
    .catch((error: unknown) => {
      // A failed tick is reported and retried on the next interval. A claimed
      // run recovers through its bounded lease after a process/database failure.
      process.stderr.write(`worker probe failed: ${error instanceof Error ? error.message : String(error)}\n`);
    })
    .finally(() => { ticking = false; });
}, pollMs);

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);

  const forceExit = setTimeout(() => {
    process.stderr.write(`worker shutdown deadline exceeded after ${signal} (${shutdownTimeoutMs}ms)\n`);
    process.exit(1);
  }, shutdownTimeoutMs);
  forceExit.unref();

  try {
    await runtime?.close();
    clearTimeout(forceExit);
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExit);
    process.stderr.write(`worker shutdown failed after ${signal}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

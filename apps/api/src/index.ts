/**
 * API process entry point.
 *
 * Two modes, chosen by configuration rather than by a flag somebody can forget:
 *
 *   - **application**: any `DATABASE_*` variable is set, so the full runtime is
 *     composed. Every dependency must be reachable, writable and consistent before
 *     the process listens. Anything missing is a hard failure with a truthful
 *     message and exit code 1 — never a degraded process that answers liveness.
 *   - **scaffold**: no database configuration at all. The static/health-only app
 *     starts, announces itself on stderr, and `/api/v1/ready` reports
 *     `runtime_not_configured`. This is the pre-VPS-04 behaviour the existing
 *     shutdown suite drives, kept so that accepted evidence still applies.
 *
 * `NODE_ENV=production` removes the second mode: a production image with no database
 * configuration is a deployment mistake, and starting anyway would present a healthy
 * process with no application behind it.
 *
 * The C01/C04 shutdown contract is unchanged: repeat-safe, one deadline written to
 * both the logger and stderr, exit 0 on a clean close, exit 1 on a close error or a
 * missed deadline. VPS-04 only adds dependency draining inside the existing `try`,
 * so a hung pool is reported through the same deadline branch rather than a new one.
 */

import { buildApp } from './app.js';
import { composeApiRuntime, type ApiRuntime, type ApiRuntimeEnv } from './runtime/api.js';
import { databaseConfigured } from './runtime/database.js';
import { buildLoggerOptions, parseLogLevel } from './runtime/logging.js';
import { describeTrustedProxies, parseTrustedProxies, type TrustProxySetting } from './runtime/proxy.js';
import { isTestSeamMode, registerTestSeam } from './test-seam.js';

const env = process.env as ApiRuntimeEnv & { NODE_ENV?: string; LOG_LEVEL?: string };
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000);

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

let runtime: ApiRuntime | null = null;

if (databaseConfigured(env)) {
  try {
    runtime = await composeApiRuntime(env);
  } catch (error) {
    // The message is the configuration problem, not a stack: the operator needs to
    // know which variable or grant is wrong, and a stack would bury it.
    fail(`API runtime composition failed: ${error instanceof Error ? error.message : String(error)}`);
  }
} else if (env.NODE_ENV === 'production') {
  fail('API runtime is not configured: DATABASE_* is required when NODE_ENV=production');
} else {
  process.stderr.write(
    'API runtime is not configured: starting scaffold only. '
    + 'No database, storage or authenticated route is available; /api/v1/ready reports runtime_not_configured.\n',
  );
}

let logLevel;
try {
  // Default silent: the historical app logged nothing, and a process that suddenly
  // writes request lines to a container log is a change nobody asked for. The real
  // deployment opts in with LOG_LEVEL, and the options it gets are redacting.
  logLevel = parseLogLevel(process.env.LOG_LEVEL, 'silent');
} catch (error) {
  fail(`invalid logging configuration: ${error instanceof Error ? error.message : String(error)}`);
}

let trustProxy: TrustProxySetting = false;
try {
  trustProxy = parseTrustedProxies(env);
} catch (error) {
  // A malformed proxy list is refused rather than silently downgraded to trusting
  // nothing: the operator asked for proxy awareness and must be told it was not applied.
  fail(`invalid proxy configuration: ${error instanceof Error ? error.message : String(error)}`);
}

const app = buildApp({
  ...(runtime?.options ?? {}),
  logger: buildLoggerOptions(logLevel),
  trustProxy,
});

// Test-only seam for the shutdown suite. Nothing in production sets API_TEST_SEAM,
// and an unrecognised value registers nothing.
const seamMode = process.env.API_TEST_SEAM;
if (isTestSeamMode(seamMode)) registerTestSeam(app, seamMode);

try {
  await app.listen({ port, host });
  // Marked only after listen succeeded: a process that cannot bind its port is not
  // ready, whatever its dependencies say.
  runtime?.readiness.markReady();
  if (runtime) {
    process.stdout.write(`API ready ${JSON.stringify({
      ...runtime.describe(),
      ...describeTrustedProxies(trustProxy),
    })}\n`);
    for (const violation of runtime.privileges.violations) {
      // Reached only when enforcement was explicitly disabled. Said out loud, so a
      // single-role local run cannot be mistaken for verified role separation.
      process.stderr.write(`WARNING: database role ${runtime.privileges.role} ${violation}\n`);
    }
  }
} catch (error) {
  app.log.error(error);
  process.stderr.write(`listen failed: ${String(error)}\n`);
  await runtime?.close().catch(() => undefined);
  process.exit(1);
}

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  // Repeat-safe: later signals during an in-progress shutdown are ignored rather
  // than starting a second close or a second deadline.
  if (shuttingDown) return;
  shuttingDown = true;
  runtime?.readiness.markStopping();

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
    // HTTP first, then dependencies: closing the pool while a handler still holds a
    // connection would turn a draining request into an error response.
    await app.close();
    await runtime?.close();
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

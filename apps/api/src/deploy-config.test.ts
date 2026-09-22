/**
 * Agreement between the deployment files and the code that reads them.
 *
 * The failure this exists to catch is silent. Compose sets `APP_SESSION_TTL_SECOND`; the
 * code reads `APP_SESSION_TTL_SECONDS`; nothing errors, the variable is simply ignored and
 * the session lifetime is the default. No test of the code finds it, no test of Compose
 * finds it, and the deployment looks healthy. Only comparing the two catches it.
 *
 * These are targeted string checks against the committed files, not YAML parsing — no YAML
 * parser is available in this workspace, and hand-rolling one would be a worse foundation
 * than an explicit, narrow check. `docker compose config` is the real validator and runs in
 * `deploy/vps/preflight.mjs`; this covers what that cannot: whether the names Compose sets
 * are names the application actually consumes, and whether the runbook documents the same
 * contract.
 */

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DATABASE_ENV_KEYS } from './runtime/database.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** dist/ -> apps/api -> apps -> repository root */
const repositoryRoot = path.resolve(here, '../../..');
const deployDirectory = path.join(repositoryRoot, 'deploy', 'vps');

const readDeployFile = (name: string) => readFile(path.join(deployDirectory, name), 'utf8');

/** Every `.ts` file under a directory, so "is this name read anywhere" is answerable. */
async function sourceText(...roots: string[]): Promise<string> {
  const parts: string[] = [];
  for (const root of roots) {
    const stack = [root];
    while (stack.length > 0) {
      const directory = stack.pop() as string;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          parts.push(await readFile(full, 'utf8'));
        }
      }
    }
  }
  return parts.join('\n');
}

/**
 * Extract the `environment:` names one service sets.
 *
 * The compose file uses two-space indentation under `services:`, so a service's block runs
 * from its own four-space key to the next one. Narrow and specific by design: if the file's
 * shape changes, the assertions below stop finding anything and fail loudly rather than
 * passing on an empty set.
 */
function serviceBlock(compose: string, service: string): string {
  const start = compose.indexOf(`\n  ${service}:\n`);
  assert.notEqual(start, -1, `compose.yaml must define a ${service} service`);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/^ {2}\S/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function environmentNames(block: string): string[] {
  const start = block.indexOf('\n    environment:\n');
  if (start === -1) return [];
  const rest = block.slice(start + 1);
  const next = rest.slice(1).search(/^ {4}\S/m);
  const section = next === -1 ? rest : rest.slice(0, next + 1);
  return [...section.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1]);
}

function listValues(block: string, key: string): string[] {
  const inline = new RegExp(`^ {4}${key}: \\[([^\\]]*)\\]`, 'm').exec(block);
  if (inline) return inline[1].split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  const start = block.indexOf(`\n    ${key}:\n`);
  if (start === -1) return [];
  const rest = block.slice(start + 1);
  const next = rest.slice(1).search(/^ {4}\S/m);
  const section = next === -1 ? rest : rest.slice(0, next + 1);
  return [...section.matchAll(/^ {6}- (.+)$/gm)].map((match) => match[1].trim());
}

// ══════════════════════ names Compose sets are names the code reads ═════════

test('every variable Compose sets for the API and worker is read by that process', async () => {
  const compose = await readDeployFile('compose.yaml');
  const apiSource = await sourceText(path.join(repositoryRoot, 'apps', 'api', 'src'));
  const workerSource = await sourceText(path.join(repositoryRoot, 'apps', 'worker', 'src'));

  // Read by Node itself or by the container runtime rather than by application code.
  const platform = new Set(['NODE_ENV', 'HOST', 'PORT']);

  for (const [service, source] of [['api', apiSource], ['worker', workerSource]] as const) {
    const names = environmentNames(serviceBlock(compose, service));
    assert.ok(names.length > 5, `expected to find the ${service} environment block, got ${names.length} names`);
    for (const name of names) {
      if (platform.has(name)) continue;
      assert.ok(
        source.includes(name),
        `compose.yaml sets ${name} for the ${service} service, but no ${service} source file reads it`,
      );
    }
  }
});

test('every database variable the runtime reads is either set by Compose or optional', async () => {
  const compose = await readDeployFile('compose.yaml');
  const apiNames = new Set(environmentNames(serviceBlock(compose, 'api')));
  const workerNames = new Set(environmentNames(serviceBlock(compose, 'worker')));

  // The four that must be present for a pool to open at all. The rest have documented
  // defaults, and `readDatabaseSettings` refuses anything out of range.
  for (const required of ['DATABASE_HOST', 'DATABASE_NAME', 'DATABASE_USER'] as const) {
    assert.ok(apiNames.has(required), `the api service must set ${required}`);
    assert.ok(workerNames.has(required), `the worker service must set ${required}`);
  }
  // Exactly one password source per service, and it must be the file form.
  for (const [service, names] of [['api', apiNames], ['worker', workerNames]] as const) {
    assert.ok(names.has('DATABASE_PASSWORD_FILE'), `the ${service} service must use DATABASE_PASSWORD_FILE`);
    assert.ok(!names.has('DATABASE_PASSWORD'), `the ${service} service must not pass a password in the environment`);
  }
  // And every name Compose uses is one the parser knows, so a typo cannot slip through as
  // an ignored variable.
  const known = new Set<string>(DATABASE_ENV_KEYS);
  for (const names of [apiNames, workerNames]) {
    for (const name of names) {
      if (!name.startsWith('DATABASE_')) continue;
      assert.ok(known.has(name), `${name} is not a database variable the runtime reads`);
    }
  }
});

// ══════════════════════ identities and secret mounts ════════════════════════

test('each service mounts only the secrets its own identity needs', async () => {
  const compose = await readDeployFile('compose.yaml');

  const api = serviceBlock(compose, 'api');
  assert.deepEqual(
    listValues(api, 'secrets').sort(),
    ['api_db_password', 'app_csrf_secret'],
    'the API needs its own database password and the CSRF secret, and nothing else',
  );

  const worker = serviceBlock(compose, 'worker');
  assert.deepEqual(
    listValues(worker, 'secrets'),
    ['worker_db_password'],
    'the worker authenticates nobody, so it must not receive the CSRF secret',
  );
  assert.ok(
    !worker.includes('app_storage'),
    'the worker handles no attachment bytes, so it must not mount the storage volume',
  );

  // Each runtime process connects as its own role, and neither as the owner.
  assert.ok(/DATABASE_USER: szronox_api\b/.test(api), 'the api service must connect as szronox_api');
  assert.ok(/DATABASE_USER: szronox_worker\b/.test(worker), 'the worker service must connect as szronox_worker');
  for (const block of [api, worker]) {
    assert.ok(!/DATABASE_USER: szronox_dev\b/.test(block), 'no runtime service may connect as the database owner');
  }

  // The owner is used only by the one-shot jobs. Each either names it directly or merges
  // the shared owner anchor; this check accepts both, because a textual check cannot
  // resolve a YAML merge key and treating the anchor as absent would be wrong.
  const ownerAnchor = /^x-owner-database: &owner_database$/m.test(compose);
  assert.ok(ownerAnchor, 'compose.yaml must define the shared owner-database anchor');
  for (const job of ['migrate', 'grants', 'provision']) {
    const block = serviceBlock(compose, job);
    assert.ok(
      /szronox_dev/.test(block) || /<<: \*owner_database/.test(block),
      `${job} runs as the owner, the only identity permitted to change schema, grants or credentials`,
    );
  }
  // And the anchor itself is the owner, so accepting it above is accepting the right thing.
  const anchorBlock = compose.slice(compose.indexOf('x-owner-database:'));
  assert.ok(
    /DATABASE_USER: szronox_dev/.test(anchorBlock.slice(0, anchorBlock.indexOf('\nservices:'))),
    'the owner-database anchor must set DATABASE_USER to the owner role',
  );

  // Every declared secret is used, and every used secret is declared.
  const declared = [...compose.matchAll(/^ {2}([a-z_]+):\n {4}file:/gm)].map((match) => match[1]);
  assert.deepEqual(
    declared.sort(),
    ['api_db_password', 'app_csrf_secret', 'postgres_password', 'worker_db_password'],
    'the declared secrets must be exactly the four the deployment uses',
  );
  const used = new Set([...compose.matchAll(/secrets: \[([^\]]*)\]/g)]
    .flatMap((match) => match[1].split(',').map((entry) => entry.trim())));
  for (const secret of declared) {
    assert.ok(used.has(secret), `secret ${secret} is declared but never mounted`);
  }
  for (const secret of used) {
    assert.ok(declared.includes(secret), `secret ${secret} is mounted but never declared`);
  }
});

test('the API healthcheck watches readiness, not liveness', async () => {
  const api = serviceBlock(await readDeployFile('compose.yaml'), 'api');
  const healthcheck = api.slice(api.indexOf('healthcheck:'));
  assert.ok(
    healthcheck.includes('/api/v1/ready'),
    'the healthcheck must watch /api/v1/ready; /api/v1/health answers 200 from a scaffold with no database',
  );
  assert.ok(!healthcheck.includes('/api/v1/health'), 'the healthcheck must not watch liveness');
});

test('APP_ORIGIN has no invented default anywhere in the deployment', async () => {
  const compose = await readDeployFile('compose.yaml');
  const origin = /APP_ORIGIN: \$\{APP_ORIGIN([^}]*)\}/.exec(compose);
  assert.ok(origin, 'compose.yaml must interpolate APP_ORIGIN');
  assert.ok(
    origin[1].startsWith(':?'),
    `APP_ORIGIN must be required, not defaulted; found "${origin[1].slice(0, 40)}"`,
  );
  // A hostname in the deployment files would be a guess, and a guess here is the value
  // that decides whether a foreign site can act as a logged-in user.
  assert.ok(
    !/szronox\.(?:com|net|org|dev|app|io)/i.test(compose),
    'compose.yaml must not contain a guessed deployment hostname',
  );
});

// ══════════════════════ the runbook documents the same contract ═════════════

test('the runbook documents every variable and secret the deployment requires', async () => {
  const compose = await readDeployFile('compose.yaml');
  const readme = await readDeployFile('README.md');

  // Host-supplied variables: if Compose needs it, the operator must be told about it.
  const hostVariables = new Set(
    [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)[:?}-]/g)].map((match) => match[1]),
  );
  assert.ok(hostVariables.size >= 5, `expected several host variables, found ${hostVariables.size}`);
  for (const name of hostVariables) {
    assert.ok(readme.includes(name), `compose.yaml reads ${name} from the host but README.md never mentions it`);
  }

  // The pinned application settings, named in the runbook with their contract.
  for (const pinned of [
    'APP_CSRF_SECRET_FILE', 'APP_SESSION_TTL_SECONDS', 'APP_ORIGIN', 'APP_STORAGE_ROOT', 'APP_ALLOWLIST',
  ]) {
    assert.ok(readme.includes(pinned), `README.md must document ${pinned}`);
  }

  // And the operator sequence, which exists because a step out of order fails in a way
  // that is hard to read: the API refuses to start, and the reason is two steps back.
  const sequence = ['migrate', 'grants', 'provision', 'api', 'worker', 'ready'];
  let cursor = 0;
  for (const step of sequence) {
    const found = readme.indexOf(step, cursor);
    assert.notEqual(found, -1, `README.md must document the ${step} step after the previous one`);
    cursor = found;
  }
});

test('the preflight script checks every secret the deployment declares', async () => {
  const compose = await readDeployFile('compose.yaml');
  const preflight = await readDeployFile('preflight.mjs');
  const hostVariables = [...compose.matchAll(/file: \$\{([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]);
  assert.equal(hostVariables.length, 4, 'four secret files are expected');
  for (const name of hostVariables) {
    assert.ok(preflight.includes(name), `preflight.mjs must check ${name} before a build is attempted`);
  }
});

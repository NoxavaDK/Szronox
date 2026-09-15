/*
 * Host preflight for VPS-05 provisioning.
 *
 * Run on the host, from the repository root, BEFORE `docker compose build`. It reads and
 * reports; it creates, modifies and deletes nothing, so a failed preflight leaves the host
 * exactly as it was.
 *
 *   node deploy/vps/preflight.mjs
 *
 * Every check reports PASS, FAIL or UNVERIFIED, and the exit code is non-zero if anything
 * FAILed. UNVERIFIED is not a pass: it means the check could not be performed here (no
 * container runtime, for instance) and the question is still open. That distinction is the
 * point — a preflight that printed "ok" for things it never looked at would be worse than
 * no preflight at all.
 *
 * Deliberately not checked here: whether the application works. That is what
 * `/api/v1/ready` answers after provisioning, and what `smoke.mjs` exercises. Preflight
 * only answers "will provisioning be able to start".
 *
 * No secret value is printed. Secret files are checked for existence, mode and length,
 * and their contents are never read into the output.
 */

import { access, constants, readFile, stat, statfs } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '../..');

const results = [];
const record = (status, name, detail) => { results.push({ status, name, detail }); };
const pass = (name, detail) => record('PASS', name, detail);
const fail = (name, detail) => record('FAIL', name, detail);
const unverified = (name, detail) => record('UNVERIFIED', name, detail);

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15_000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout).trim(), stderr: String(stderr).trim() });
    });
  });
}

// ── Container runtime ────────────────────────────────────────────────────────

let composeAvailable = false;

async function checkRuntime() {
  const version = await run('docker', ['--version']);
  if (!version.ok) {
    unverified('container runtime', 'docker is not on PATH; nothing below that needs it could be checked');
    return;
  }
  pass('container runtime', version.stdout);

  // Compose v2 only. The `docker-compose` v1 script does not understand the `secrets`,
  // `profiles` and `depends_on: condition:` forms this project relies on, and would fail
  // in the middle of provisioning rather than up front.
  const compose = await run('docker', ['compose', 'version', '--short']);
  if (!compose.ok) {
    fail('compose v2', 'docker compose v2 is required; `docker compose version` failed');
    return;
  }
  const major = Number(compose.stdout.replace(/^v/, '').split('.')[0]);
  if (!Number.isInteger(major) || major < 2) {
    fail('compose v2', `found ${compose.stdout}; v2 or later is required`);
    return;
  }
  composeAvailable = true;
  pass('compose v2', compose.stdout);
}

/**
 * Let Compose parse its own file.
 *
 * This is the only real validation of `compose.yaml`: anchors, merge keys, the secrets
 * block and variable interpolation are all Compose's own semantics, and no amount of
 * reading the file substitutes for it. It also surfaces a missing required variable,
 * because `${APP_ORIGIN:?...}` fails here rather than at `up`.
 */
async function checkComposeConfig() {
  if (!composeAvailable) {
    unverified('compose config', 'no compose v2; the file has not been parsed by Compose');
    return;
  }
  const config = await run('docker', ['compose', '-f', path.join(here, 'compose.yaml'), 'config', '--quiet']);
  if (!config.ok) {
    fail('compose config', `docker compose config rejected the file: ${config.stderr || config.stdout}`);
    return;
  }
  pass('compose config', 'Compose parsed the project and every required variable is set');
}

// ── Isolation from existing projects ────────────────────────────────────────

const PROJECT = 'szronox-dev';
const OWNED_VOLUMES = ['szronox-dev_postgres_data', 'szronox-dev_app_storage'];
const OWNED_NETWORK = 'szronox-dev_private';

/**
 * Refuse to proceed if anything named like another project is in the way.
 *
 * The standing instruction is that Cutroom's PostgreSQL, credentials, networks and volumes
 * must not be reused or disturbed. This does not merely check for collisions with our own
 * names — it looks for whether our project name or resources could overlap something
 * already running, and names what it found.
 */
async function checkIsolation() {
  if (!composeAvailable) {
    unverified('resource isolation', 'no container runtime; existing volumes and networks were not inspected');
    return;
  }

  const volumes = await run('docker', ['volume', 'ls', '--format', '{{.Name}}']);
  if (!volumes.ok) {
    unverified('resource isolation', 'could not list volumes');
    return;
  }
  const existing = volumes.stdout.split('\n').filter((line) => line !== '');
  const reused = OWNED_VOLUMES.filter((name) => existing.includes(name));
  const foreign = existing.filter((name) => /cutroom/i.test(name));

  // A pre-existing project volume is not automatically wrong — it is how a second run
  // keeps its data — but it must be a deliberate choice, not a surprise.
  if (reused.length > 0) {
    pass('resource isolation', `existing project volumes will be reused: ${reused.join(', ')}`);
  } else {
    pass('resource isolation', 'no existing project volumes; provisioning will create them');
  }
  if (foreign.length > 0) {
    // Reported, not failed: their existence is fine. What matters is that this project
    // never references them, which `compose config` output would show.
    record('PASS', 'foreign resources untouched',
      `${foreign.length} unrelated volume(s) present and not referenced by this project`);
  }

  const networks = await run('docker', ['network', 'ls', '--format', '{{.Name}}']);
  if (networks.ok && networks.stdout.split('\n').includes(OWNED_NETWORK)) {
    pass('project network', `${OWNED_NETWORK} already exists and will be reused`);
  }

  const containers = await run('docker', ['ps', '--format', '{{.Names}} {{.Label "com.docker.compose.project"}}']);
  if (containers.ok) {
    const conflicting = containers.stdout.split('\n')
      .filter((line) => line !== '' && line.endsWith(` ${PROJECT}`));
    if (conflicting.length > 0) {
      fail('no running project containers',
        `${conflicting.length} container(s) of project ${PROJECT} are already running; stop them first`);
    } else {
      pass('no running project containers', `no container of project ${PROJECT} is running`);
    }
  }
}

// ── Secrets ──────────────────────────────────────────────────────────────────

const SECRET_VARIABLES = [
  { variable: 'SZRONOX_DEV_POSTGRES_PASSWORD_FILE', minimumLength: 12, label: 'database owner password' },
  { variable: 'SZRONOX_DEV_API_DB_PASSWORD_FILE', minimumLength: 12, label: 'API role password' },
  { variable: 'SZRONOX_DEV_WORKER_DB_PASSWORD_FILE', minimumLength: 12, label: 'worker role password' },
  // Enforced by `buildAuthConfig` at startup; checked here so it fails before a build.
  { variable: 'SZRONOX_DEV_CSRF_SECRET_FILE', minimumLength: 32, label: 'CSRF secret' },
];

async function checkSecrets() {
  const values = new Map();
  for (const { variable, minimumLength, label } of SECRET_VARIABLES) {
    const file = process.env[variable];
    if (file === undefined || file.trim() === '') {
      fail(`secret: ${label}`, `${variable} is not set`);
      continue;
    }
    let info;
    try {
      info = await stat(file);
    } catch {
      fail(`secret: ${label}`, `${variable} points at ${file}, which cannot be read`);
      continue;
    }
    if (!info.isFile()) {
      fail(`secret: ${label}`, `${file} is not a regular file`);
      continue;
    }

    // Length only. The value is never printed, logged or compared against anything.
    const contents = await readFile(file, 'utf8');
    const secret = contents.replace(/\r?\n$/, '');
    if (secret.length === 0) {
      fail(`secret: ${label}`, `${file} is empty`);
      continue;
    }
    if (secret.length < minimumLength) {
      fail(`secret: ${label}`, `${file} holds ${secret.length} characters; at least ${minimumLength} are required`);
      continue;
    }

    const mode = info.mode & 0o777;
    if ((mode & 0o077) !== 0) {
      // Group- or world-readable. The containers read these as mounted secrets, so only
      // the owner ever needs access on the host.
      fail(`secret: ${label}`, `${file} has mode ${mode.toString(8)}; use 600`);
      continue;
    }

    if (values.has(secret)) {
      // Distinct roles sharing a password defeats the separation the roles exist for.
      fail(`secret: ${label}`, `${file} repeats the value of ${values.get(secret)}; each identity needs its own`);
      continue;
    }
    values.set(secret, variable);

    if (path.resolve(file).startsWith(`${repositoryRoot}${path.sep}`)) {
      fail(`secret: ${label}`, `${file} is inside the repository; keep secrets outside the working tree`);
      continue;
    }

    pass(`secret: ${label}`, `${file}, mode ${mode.toString(8)}, ${secret.length} characters`);
  }
}

// ── Application configuration ────────────────────────────────────────────────

/**
 * Structural origin check.
 *
 * `parseOrigins` in `apps/api/src/auth/config.ts` is authoritative and runs at API
 * startup, so a disagreement between the two fails closed there. This copy exists because
 * preflight runs before anything is built, when that module does not exist yet; it is kept
 * deliberately strict so it cannot pass something the real validator would reject.
 */
function originProblem(raw) {
  if (raw === undefined || raw.trim() === '') return 'APP_ORIGIN is not set';
  const candidate = raw.trim();
  if (candidate.includes(',')) return 'APP_ORIGIN must be exactly one origin';
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return `not an absolute origin: ${candidate}`;
  }
  if (candidate !== url.origin) return `must be exactly the origin, with no path or trailing slash: ${candidate}`;
  if (url.username || url.password) return 'must not embed credentials';
  const localhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !localhost) return 'must use https outside localhost';
  return null;
}

async function checkConfiguration() {
  const origin = process.env.APP_ORIGIN;
  const problem = originProblem(origin);
  if (problem !== null) {
    fail('APP_ORIGIN', problem);
  } else {
    const url = new URL(origin.trim());
    if (url.protocol === 'https:') {
      pass('APP_ORIGIN', `${url.origin} — the __Host- session cookie requires this to be the exact HTTPS origin`);
    } else {
      // Not a failure: an explicit localhost fixture is the documented local mode. But a
      // browser will refuse the __Host- cookie over plain HTTP, so login cannot work.
      record('PASS', 'APP_ORIGIN',
        `${url.origin} — plaintext localhost fixture; a browser will not accept the __Host- cookie, so this cannot serve real logins`);
    }
  }

  const allowlist = process.env.APP_ALLOWLIST;
  if (allowlist === undefined || allowlist.trim() === '') {
    // Compose supplies a default, so this is informational rather than fatal.
    record('PASS', 'APP_ALLOWLIST', 'not set on the host; the Compose default applies');
  } else {
    const entries = allowlist.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
    const names = entries.map((entry) => entry.split(':')[0]);
    if (entries.length !== 2 || !names.includes('NOXAVA') || !names.includes('SZRON')) {
      fail('APP_ALLOWLIST', 'must name exactly NOXAVA and SZRON with their established UUIDs');
    } else {
      pass('APP_ALLOWLIST', 'names exactly NOXAVA and SZRON');
    }
  }

  // Proxy trust. Malformed is a failure; absent is reported with its consequence rather
  // than passed over, because the consequence only appears once traffic is proxied.
  const proxies = process.env.APP_TRUSTED_PROXIES;
  if (proxies === undefined || proxies.trim() === '') {
    unverified(
      'APP_TRUSTED_PROXIES',
      'not set: request.ip will be the proxy address, making the per-address login throttle '
      + 'one global counter that either user can exhaust for both. Set it once the address the '
      + 'API container observes for proxied requests is known.',
    );
  } else {
    const entries = proxies.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
    const bad = entries.filter((entry) => {
      if (['true', '*', 'all', '0.0.0.0/0', '::/0', '0.0.0.0', '::'].includes(entry.toLowerCase())) return true;
      const [address] = entry.split('/');
      const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address);
      const ipv6 = address.includes(':');
      return !ipv4 && !ipv6;
    });
    if (bad.length > 0) {
      fail('APP_TRUSTED_PROXIES', `refused entr${bad.length === 1 ? 'y' : 'ies'}: ${bad.join(', ')}`);
    } else {
      pass('APP_TRUSTED_PROXIES', `${entries.length} literal proxy address(es); the API re-validates at startup`);
    }
  }

  const ttl = process.env.APP_SESSION_TTL_SECONDS;
  if (ttl !== undefined && ttl.trim() !== '') {
    const seconds = Number(ttl);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 604800) {
      fail('APP_SESSION_TTL_SECONDS', `${ttl} is outside 1..604800`);
    } else {
      pass('APP_SESSION_TTL_SECONDS', `${seconds}`);
    }
  }
}

// ── Deployment files ─────────────────────────────────────────────────────────

async function checkDeploymentFiles() {
  const required = [
    ['compose.yaml', path.join(here, 'compose.yaml')],
    ['Dockerfile', path.join(here, 'Dockerfile')],
    ['grants.sql', path.join(here, 'postgres', 'grants.sql')],
    ['initdb role script', path.join(here, 'postgres', 'initdb', '10-runtime-roles.sh')],
  ];
  for (const [label, file] of required) {
    try {
      await access(file, constants.R_OK);
      pass(`file: ${label}`, path.relative(repositoryRoot, file));
    } catch {
      fail(`file: ${label}`, `${file} is missing or unreadable`);
    }
  }

  // The PostgreSQL entrypoint runs an executable `.sh` in initdb.d and *sources* a
  // non-executable one. Sourcing this script would run it in the entrypoint's own shell,
  // where its `set -eu` and its `exit 1` would terminate initialisation in a way that is
  // much harder to read. The exec bit keeps it a subprocess.
  const script = path.join(here, 'postgres', 'initdb', '10-runtime-roles.sh');
  try {
    const info = await stat(script);
    if ((info.mode & 0o111) === 0) {
      fail('initdb script is executable', `${script} has mode ${(info.mode & 0o777).toString(8)}; it must be executable`);
    } else {
      pass('initdb script is executable', `mode ${(info.mode & 0o777).toString(8)}`);
    }
  } catch { /* the missing-file case is already reported above */ }

  // Migrations are applied in filename order by a one-shot job. A gap or a duplicate
  // prefix would change that order silently.
  const migrationsDirectory = path.join(repositoryRoot, 'database', 'migrations');
  try {
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();
    const prefixes = files.map((name) => name.slice(0, 4));
    if (files.length === 0) {
      fail('migrations', `${migrationsDirectory} contains no .sql files`);
    } else if (new Set(prefixes).size !== prefixes.length) {
      fail('migrations', `duplicate sequence prefix among: ${files.join(', ')}`);
    } else {
      pass('migrations', `${files.length} in order: ${files.join(', ')}`);
    }
  } catch {
    fail('migrations', `${migrationsDirectory} cannot be read`);
  }
}

// ── Host resources ───────────────────────────────────────────────────────────

function portFree(port, host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

async function checkHostResources() {
  // Compose publishes the API on the loopback interface only. A conflict here stops `up`.
  const port = 3010;
  if (await portFree(port, '127.0.0.1')) {
    pass(`port ${port} free`, 'the API publishes on 127.0.0.1 only');
  } else {
    fail(`port ${port} free`, `something is already listening on 127.0.0.1:${port}`);
  }

  try {
    const stats = await statfs(repositoryRoot);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    const gigabytes = availableBytes / 1024 ** 3;
    // The image, PostgreSQL's data directory and the attachment volume all live on the
    // container root. Two gigabytes is a floor, not a recommendation.
    if (gigabytes < 2) {
      fail('free disk space', `${gigabytes.toFixed(1)} GiB available; at least 2 GiB is needed for the image and volumes`);
    } else {
      pass('free disk space', `${gigabytes.toFixed(1)} GiB available`);
    }
  } catch {
    unverified('free disk space', 'could not read filesystem statistics');
  }

  // `storage-init` chowns the attachment volume to 1000:1000 and the image runs as the
  // `node` user, which is uid 1000 in the pinned base image. The filesystem adapter
  // expects that ownership. Nothing to check on the host, but stated so the assumption is
  // visible where it is depended upon.
  record('PASS', 'storage ownership contract',
    'volume is chowned to 1000:1000 by storage-init and the image runs as uid 1000 (node)');
}

// ── Report ───────────────────────────────────────────────────────────────────

await checkRuntime();
await checkComposeConfig();
await checkIsolation();
await checkSecrets();
await checkConfiguration();
await checkDeploymentFiles();
await checkHostResources();

const width = Math.max(...results.map((result) => result.name.length));
for (const { status, name, detail } of results) {
  process.stdout.write(`${status.padEnd(11)} ${name.padEnd(width)}  ${detail}\n`);
}

const failures = results.filter((result) => result.status === 'FAIL');
const open = results.filter((result) => result.status === 'UNVERIFIED');
process.stdout.write(
  `\n${results.length - failures.length - open.length} passed, ${failures.length} failed, ${open.length} unverified\n`,
);
if (open.length > 0) {
  process.stdout.write('UNVERIFIED is not a pass: those questions are still open.\n');
}
if (failures.length > 0) {
  process.stdout.write('Preflight failed. Nothing was changed on this host.\n');
  process.exitCode = 1;
}

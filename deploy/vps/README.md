# SzroNox isolated development environment

Integration status: VPS-04 runtime assembly complete in source, **never executed**. The
API and worker now compose real dependencies and fail closed; Compose defines separate
migration, API and worker database identities with per-service secret mounts;
`APP_CSRF_SECRET_FILE`, `APP_SESSION_TTL_SECONDS`, `APP_ORIGIN` and `APP_STORAGE_ROOT`
agree between Compose and this runbook; and an operator provisioning command exists.

What has **not** happened, stated so nothing here reads as a passing result:

- **No container was built or started.** Docker is unavailable in the environment where
  VPS-04 was implemented, so every command in this file is unexecuted. The Linux image,
  Compose permissions, the volume UID/GID, the `initdb` role bootstrap, the grants job
  and the backup/restore procedure are all VPS-05 gates.
- **No real PostgreSQL ran.** The API and worker were exercised against PGlite, which is
  real PostgreSQL compiled to WASM but single-connection and single-role — so it cannot
  demonstrate a race and cannot demonstrate role separation. Concurrency is VPS-06.
- **No browser ran.** HTTPS, the `__Host-` cookie, the service worker and the upload flow
  in a real browser are VPS-07.
- **No credential was provisioned and no secret exists in this repository.**

The race harness now records controlled overlap: it holds one writer inside its open
transaction and asks PostgreSQL, from a third connection, whether the other writer is
blocked on it. If it cannot observe that, it fails instead of falling back to the weaker
"exactly one winner" assertion. It still needs a real server, at VPS-06.

Do not run anything here against the live VPS. VPS-04 authorises no deployment.

The operator sequence is fixed: (1) PostgreSQL is available and its runtime roles exist;
(2) migrations complete; (3) the operator provisions and verifies exactly NOXAVA and
SZRON; (4) grants and storage prerequisites complete, then the API starts; (5) the worker
starts; (6) application readiness is checked. The commands below keep that order.

This directory defines the disposable local `szronox-dev` Compose project used
for VPS-03 preparation. It has a dedicated PostgreSQL instance, private Docker
network and project-scoped volumes. It does not deploy to the VPS and it does
not use Cutroom or any other existing project resource.

The PostgreSQL image is pinned to `postgres:17.6-bookworm`. The migration job
uses the same image build as the API, runs `database/migrations/*.sql` once, and
serializes concurrent runners with a PostgreSQL advisory transaction lock. API
and worker startup never run migrations.

## Identities, secrets and configuration

Four database identities, so no process holds authority it does not need:

| Identity | Used by | May do |
| --- | --- | --- |
| `szronox_dev` (owner) | migration, grants, provisioning, harness | everything in `app` |
| `szronox_api` | the API process | read the roster and credential hashes; read/write sessions and domain data |
| `szronox_worker` | the worker process | read domain data only |
| `postgres` | nothing | — |

`szronox_api` and `szronox_worker` are created once by
`postgres/initdb/10-runtime-roles.sh` when the data directory is initialised, with
`NOSUPERUSER NOCREATEDB NOCREATEROLE` spelled out and `search_path` pinned. Table grants
are applied by the `grants` job after migrations, from `postgres/grants.sql`; rerun that
job after adding any migration, because new tables are deliberately granted **nothing**
by default.

The API and worker read their own grants at startup and **refuse to run** if they are too
wide — an API that could write `app.user_credentials`, or a worker that could read them,
exits 1 with the specific violation. `APP_ENFORCE_DB_PRIVILEGES=false` downgrades that to
a warning for a single-role local run, and the startup line then says
`privilegeEnforcement: reported_only` so nobody mistakes it for verified separation.

Four secret files, each mounted only where it is needed:

| Compose secret | Variable | Mounted into |
| --- | --- | --- |
| `postgres_password` | `SZRONOX_DEV_POSTGRES_PASSWORD_FILE` | postgres, migrate, grants, provision, harness |
| `api_db_password` | `SZRONOX_DEV_API_DB_PASSWORD_FILE` | postgres (init only), api |
| `worker_db_password` | `SZRONOX_DEV_WORKER_DB_PASSWORD_FILE` | postgres (init only), worker |
| `app_csrf_secret` | `SZRONOX_DEV_CSRF_SECRET_FILE` | api |

The worker gets no CSRF secret and no storage volume: it authenticates nobody and handles
no attachment bytes.

Application configuration, identical here and in `compose.yaml`:

| Variable | Value | Note |
| --- | --- | --- |
| `APP_ORIGIN` | required exact browser origin | one origin, no path, HTTPS except an explicit localhost development fixture; no Compose default |
| `APP_CSRF_SECRET_FILE` | `/run/secrets/app_csrf_secret` | ≥ 32 characters; rotating it invalidates live sessions |
| `APP_SESSION_TTL_SECONDS` | `604800` | absolute maximum, never extended by use |
| `APP_STORAGE_ROOT` | `/var/lib/szronox/storage` | outside the served web tree |
| `APP_ALLOWLIST` | `NOXAVA:<uuid>,SZRON:<uuid>` | compared against the database, never written by the API |
| `LOG_LEVEL` | `info` | redacting options are applied; `silent` disables logging |
| `AI_AUTO_DRAFT_ENABLED` | `false` | CAPTURE-DRAFT-01: capture queues one automatic `develop` run only when exactly `true`; capture always succeeds either way |
| `AI_AUTO_DRAFT_DAILY_LIMIT` | `50` | CAPTURE-DRAFT-01: capture-triggered runs allowed per Europe/Warsaw day; integer 0–1000, a config error otherwise |

One more host variable, not application configuration:

| Variable | Default | Note |
| --- | --- | --- |
| `SZRONOX_RELEASE` | `local` | image tag. Every service — `migrate`, `grants`, `provision`, `api`, `worker`, the harness — resolves `szronox-dev:${SZRONOX_RELEASE}`, so it must hold the **same** value for the build and for every later command in a session. Exporting it for `up` but not for `build` runs one tag and starts another. |

## Preflight

Run this first, from the repository root, before building anything. It reads and reports
and changes nothing, so a failure leaves the host untouched:

```bash
node deploy/vps/preflight.mjs
```

It reports `PASS`, `FAIL` or `UNVERIFIED` per check and exits non-zero on any `FAIL`.
`UNVERIFIED` is **not** a pass — it means the check could not run here (no container
runtime, for instance) and the question is still open. It checks the container runtime and
Compose v2, lets `docker compose config` parse the project, looks for resource collisions
and running project containers, verifies each secret file's existence/mode/length/
uniqueness and that none live inside the repository, validates `APP_ORIGIN`,
`APP_ALLOWLIST`, `APP_SESSION_TTL_SECONDS` and `APP_TRUSTED_PROXIES`, confirms the
deployment files exist with the initdb script executable, and checks the published port and
free disk space.

## HTTPS in front of the application

**Required input, not supplied yet: the exact hostname.** The session cookie carries the
`__Host-` prefix, which a browser only accepts when the cookie is `Secure`, `Path=/` and
has no `Domain`. So plaintext HTTP cannot carry a login at all, and the hostname is not a
detail to fill in later: `APP_ORIGIN` must be the exact browser origin, and every deployment
file deliberately refuses to guess it — `compose.yaml` uses the required
`${APP_ORIGIN:?...}` form and contains no default.

The architecture is browser → existing Caddy (TLS) → `127.0.0.1:3010` → Fastify. Caddy
already runs on the host for other projects, so a **new site block** is added and nothing
existing is edited:

```caddyfile
# Replace REPLACE_ME_HOSTNAME with the actual hostname before applying.
REPLACE_ME_HOSTNAME {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3010
}
```

Caddy sets `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` on
`reverse_proxy` by default, which is what the API needs. Nothing about TLS termination
needs to reach the application: origin checking compares the browser's `Origin` header
against `APP_ORIGIN`, and the session cookie is emitted with `Secure` regardless of the
internal hop, so the application never has to infer the external scheme.

Then set `APP_ORIGIN=https://REPLACE_ME_HOSTNAME` and, if DNS is not yet pointing at the
host, do not start: a certificate request for a name that does not resolve fails, and
`APP_ORIGIN` pointing at a name the browser cannot reach produces a login that can never
succeed.

### The proxy address, and why it matters

`APP_TRUSTED_PROXIES` tells the API which addresses may speak for a client. Behind a proxy
this is not cosmetic:

- **Unset.** `request.ip` is the proxy's own address for every request, so the
  per-address login throttle becomes **one global counter** — twenty failed attempts from
  anyone locks out both NOXAVA and SZRON.
- **Set to the proxy.** `request.ip` is the real client, and the throttle works per client.
- **Set to `true`, `*` or `0.0.0.0/0`.** Refused at startup. Any client could then choose
  its own throttle bucket by sending a header, which removes the limit entirely.

Unset is the default because it fails safely — a shared limit is an availability problem,
a spoofable limit is a security one. Determine the address the API container actually
observes for a proxied request, then set it:

```bash
# With the project running, make one proxied request and read the address the API saw.
docker compose -f deploy/vps/compose.yaml logs api | tail -5
# Or inspect the network the container is attached to:
docker network inspect szronox-dev_private -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
export APP_TRUSTED_PROXIES=172.18.0.1   # example only; use the observed value
```

Two provisioning questions cannot be answered without a running Docker and must be checked
at that point rather than assumed:

1. **Whether a published port works on an `internal: true` network.** The `api` service is
   attached only to `szronox-dev_private`, which is internal, and also publishes
   `127.0.0.1:3010`. If publishing does not work there, the API is unreachable and the
   network configuration needs a second, non-internal network for the API alone — not a
   change to the private one.
2. **What source address the container sees** for a request arriving through the published
   port, which is the value `APP_TRUSTED_PROXIES` needs.

## Prepare a local disposable run

Create development-only secret files outside the repository, with mode 600. No password
is committed, and none is ever passed as a command-line argument:

```bash
umask 077
d=/private/tmp/szronox-dev-secrets
mkdir -p "$d"
printf '%s\n' 'choose-a-local-only-owner-password'  > "$d/postgres"
printf '%s\n' 'choose-a-local-only-api-password'    > "$d/api"
printf '%s\n' 'choose-a-local-only-worker-password' > "$d/worker"
# At least 32 characters. Rotating this file invalidates every live session.
printf '%s\n' "$(head -c 48 /dev/urandom | base64)" > "$d/csrf"

export SZRONOX_DEV_POSTGRES_PASSWORD_FILE="$d/postgres"
export SZRONOX_DEV_API_DB_PASSWORD_FILE="$d/api"
export SZRONOX_DEV_WORKER_DB_PASSWORD_FILE="$d/worker"
export SZRONOX_DEV_CSRF_SECRET_FILE="$d/csrf"
# Explicit local-only fixture. VPS-05 supplies the actual HTTPS deployment origin.
export APP_ORIGIN=http://localhost:3010

docker compose -f deploy/vps/compose.yaml build
docker compose -f deploy/vps/compose.yaml up -d --wait postgres
docker compose -f deploy/vps/compose.yaml run --rm migrate
```

Provision the two accounts before starting the API. It will refuse to start otherwise —
an API serving 401s because one account has no password is worse than one that says so.
Passwords go in on **stdin** as one bounded JSON object, so they never reach the process
table, the shell history or a file:

```bash
printf '%s' '{"NOXAVA":"local-only-password-1","SZRON":"local-only-password-2"}' \
  | docker compose -f deploy/vps/compose.yaml run --rm -T provision
# NOXAVA: user_created, credential_created
# SZRON: user_created, credential_created
```

Verify the ordinary rerun before any application process starts. Exactly two configured
accounts must be reported, both with `credential_unchanged`; any mismatch is a stop:

```bash
printf '' | docker compose -f deploy/vps/compose.yaml run --rm -T provision
# NOXAVA: user_unchanged, credential_unchanged
# SZRON: user_unchanged, credential_unchanged
```

Rerunning it with no stdin input changes nothing and reports
`credential_unchanged` — it does not need, and will not rotate, a password it already has.
Changing one deliberately requires naming the account, and revokes that account's live
sessions and no others:

```bash
printf '%s' '{"NOXAVA":"new-local-only-password"}' \
  | docker compose -f deploy/vps/compose.yaml run --rm -T provision --replace NOXAVA
```

Apply the runtime grants and initialize private storage after provisioning and before
their consumers start. Then start the API, start the worker, and only then check
application readiness. These commands deliberately spell out the required order:

```bash
docker compose -f deploy/vps/compose.yaml run --rm grants
docker compose -f deploy/vps/compose.yaml run --rm storage-init
docker compose -f deploy/vps/compose.yaml up -d api
docker compose -f deploy/vps/compose.yaml up -d worker
docker compose -f deploy/vps/compose.yaml ps

# Liveness: answered by a scaffold with no database at all. Never treat it as readiness.
curl --fail http://127.0.0.1:3010/api/v1/health

# Readiness: 200 only when the database, the storage root and both provisioned accounts
# are all present right now. The body names the failing check when it is 503.
curl --fail http://127.0.0.1:3010/api/v1/ready
```

The Compose API healthcheck watches `/api/v1/ready` for the same reason. The worker also
depends on the API container reaching its started state, so a combined Compose request
cannot launch the worker before the API container has started. The operator still performs
the readiness check only after both application processes have been started.

The `storage-init` service is the only root container. It initializes only the
named `app_storage` volume, creates `staging` and `objects`, and assigns those
directories to UID:GID `1000:1000` with mode 700. The API mounts the volume
read/write at `/var/lib/szronox/storage`; the worker has no storage mount. The
application root is supplied through `APP_STORAGE_ROOT` and is outside the
served web tree.

For a clean disposable run, stop the project and remove only its named volumes:

```bash
docker compose -f deploy/vps/compose.yaml down
docker volume rm szronox-dev_postgres_data szronox-dev_app_storage
```

## Migrations and real PostgreSQL harness

Build the API first, then run the harness with the Compose database connection.
It opens independent node-postgres pools and composes the existing
`CoreRepository` through `pgPoolDatabase`; PGlite is not used by this harness:

```bash
npm ci
npm run build --workspace @szronox/contracts
npm run build --workspace @szronox/api
DATABASE_URL='postgres://szronox_dev:YOUR_LOCAL_PASSWORD@127.0.0.1:5432/szronox_dev' \
  node apps/api/test/postgres/real-pg-harness.mjs
```

The database has no published Compose port. For the harness, use a temporary
local port-forward or run the harness in a disposable helper container on the
`szronox-dev_private` network. If Docker/PostgreSQL is unavailable, the harness
prints an explicit `UNVERIFIED` gate and does not claim race evidence.

The harness covers concurrent same-version writes (one winner and one
`EDIT_CONFLICT`), concurrent same-operation retries (one effect), changed-payload
idempotency rejection, rollback of domain and ledger writes, migration rerun,
and independent API/worker pool coexistence. It cleans its uniquely identified
test rows when the run completes.

Both concurrency cases now prove the overlap rather than assuming it. `overlap.mjs` wraps
the `Database` handed to the production `CoreRepository`, pauses the first writer *inside*
its open transaction at the conflicting statement — the guarded `UPDATE`, or the ledger
insert — and then starts the second writer. A third connection polls
`pg_blocking_pids(<second writer>)` until PostgreSQL itself reports the second session as
waiting on the first, and only then is the first released. The run prints the recorded
overlap (`pid`, `wait_event_type`, `wait_event`).

If that blocking relationship is never observed within the deadline, the harness **fails**
with `controlled overlap was not demonstrated`. It does not fall back to asserting that
exactly one writer won: that assertion is satisfied by two sequential writes, which is why
it was insufficient on its own.

The wrapper is test-only and lives under `apps/api/test/`. The repository, its SQL and the
`pgPoolDatabase` boundary are the production ones.

## Development backup and restore

Pause API and worker briefly so the database and private files form a matching
pair. Keep the archive and file snapshot under the same timestamped directory;
never use a production backup as development input:

```bash
BACKUP_DIR=/private/tmp/szronox-dev-backups/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP_DIR"
docker compose -f deploy/vps/compose.yaml stop api worker
docker compose -f deploy/vps/compose.yaml exec -T postgres \
  pg_dump -U szronox_dev -d szronox_dev --format=custom \
  > "$BACKUP_DIR/database.dump"
docker run --rm \
  -v szronox-dev_app_storage:/source:ro \
  -v "$BACKUP_DIR":/backup \
  alpine:3.20 tar -C /source -czf /backup/app-storage.tar.gz .
sha256sum "$BACKUP_DIR/database.dump" "$BACKUP_DIR/app-storage.tar.gz" \
  > "$BACKUP_DIR/SHA256SUMS"
docker compose -f deploy/vps/compose.yaml start api worker
```

Restore only into disposable development volumes. For a timestamped backup,
stop the project, restore the private files, start PostgreSQL, and load the
custom archive with PostgreSQL 17.x-compatible tooling:

```bash
docker compose -f deploy/vps/compose.yaml down
docker run --rm \
  -v szronox-dev_app_storage:/target \
  -v "$BACKUP_DIR":/backup:ro \
  alpine:3.20 sh -ec 'rm -rf /target/staging /target/objects && tar -C /target -xzf /backup/app-storage.tar.gz'
docker compose -f deploy/vps/compose.yaml up -d --wait postgres
docker compose -f deploy/vps/compose.yaml exec -T postgres \
  pg_restore -U szronox_dev -d szronox_dev --clean --if-exists < "$BACKUP_DIR/database.dump"
docker compose -f deploy/vps/compose.yaml run --rm migrate
docker compose -f deploy/vps/compose.yaml run --rm grants
docker compose -f deploy/vps/compose.yaml run --rm real-pg-harness
```

`pg_restore --clean` drops and recreates objects, so the runtime grants go with them —
hence the `grants` job in the sequence above. The login roles themselves survive, because
they live in the cluster rather than the database; a restore into a **fresh** volume
re-runs `initdb` and recreates them from the secret files.

Verify readiness after a restore rather than assuming it, since a restore that lost the
grants or a user would otherwise look like a healthy container:

```bash
docker compose -f deploy/vps/compose.yaml up -d --wait api worker
curl --fail http://127.0.0.1:3010/api/v1/ready
```

Container image rollback does not reverse database migrations.

Production requires a separate approved project, volume, network, credentials,
encrypted off-host backup policy and recovery objective. This task provides no
production backup or deployment command.

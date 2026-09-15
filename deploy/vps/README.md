# SzroNox isolated development environment

Integration status: VPS-03 preparation only; not ready for application deployment.
VPS-04 must finish API/worker process composition, separate runtime/migration database
roles and secret mounts, APP_CSRF_SECRET_FILE/APP_SESSION_TTL_SECONDS configuration,
and operator two-user provisioning. Current Compose API/worker settings are incomplete;
a healthy scaffold response does not prove authenticated application readiness.
Real PostgreSQL concurrency evidence is deferred to VPS-06, and HTTPS/browser evidence
to VPS-07. The harness migration expectations now include all four combined migrations;
it still needs controlled overlap evidence before it can certify races. Do not run
these commands on the live VPS under the VPS-00–03 approval.

This directory defines the disposable local `szronox-dev` Compose project used
for VPS-03 preparation. It has a dedicated PostgreSQL instance, private Docker
network and project-scoped volumes. It does not deploy to the VPS and it does
not use Cutroom or any other existing project resource.

The PostgreSQL image is pinned to `postgres:17.6-bookworm`. The migration job
uses the same image build as the API, runs `database/migrations/*.sql` once, and
serializes concurrent runners with a PostgreSQL advisory transaction lock. API
and worker startup never run migrations.

## Prepare a local disposable run

Create a development-only password file outside the repository, with mode 600,
then point Compose at it. The password is never committed or placed in a
command-line argument:

```bash
umask 077
printf '%s\n' 'choose-a-local-only-password' > /private/tmp/szronox-dev-postgres-password
export SZRONOX_DEV_POSTGRES_PASSWORD_FILE=/private/tmp/szronox-dev-postgres-password
docker compose -f deploy/vps/compose.yaml build
docker compose -f deploy/vps/compose.yaml up -d --wait postgres
docker compose -f deploy/vps/compose.yaml run --rm migrate
docker compose -f deploy/vps/compose.yaml run --rm storage-init
docker compose -f deploy/vps/compose.yaml up -d --wait api worker
docker compose -f deploy/vps/compose.yaml run --rm real-pg-harness
docker compose -f deploy/vps/compose.yaml ps
curl --fail http://127.0.0.1:3010/api/v1/health
```

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
docker compose -f deploy/vps/compose.yaml run --rm real-pg-harness
```

Container image rollback does not reverse database migrations.

Production requires a separate approved project, volume, network, credentials,
encrypted off-host backup policy and recovery objective. This task provides no
production backup or deployment command.

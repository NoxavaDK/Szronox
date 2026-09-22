# VPS-03 environment result

Task: VPS-03 environment / real-PostgreSQL harness.

Owned scope completed in the VPS-03 worktree:

- Moved `0001_core_schema.sql` and `0002_script_revision.sql` from
  `supabase/migrations/` to `database/migrations/` without changing their bytes.
  No new numbered migration was created; `0003_vps_auth.sql` and
  `0004_vps_storage.sql` remain reserved for VPS-01 and VPS-02.
- Updated the provider-neutral migration runner to use `database/migrations`, a
  PostgreSQL advisory transaction lock, and one atomic transaction per migration
  script plus its ledger insert. API and worker startup remain migration-free.
- Added the one-shot `apps/api/dist/db/migration-cli.js` entry point. It reads
  development database settings from environment variables and a password file,
  uses bounded `pg` pool/statement/lock timeouts, and does not print secrets.
- Reworked `deploy/vps/compose.yaml` as project `szronox-dev`: dedicated
  PostgreSQL 17.6, private internal network, project-scoped PostgreSQL and
  `app_storage` volumes, one-shot migration and storage initialization services,
  unprivileged API, and a worker placeholder with no storage mount.
- Updated the Docker build to include `database/migrations/` and added the
  development backup/restore/runbook instructions.
- Added `apps/api/test/postgres/real-pg-harness.mjs`, which uses two independent
  `pg` pools and the existing `CoreRepository`/`pgPoolDatabase` boundary to cover
  overlapping expected-version writes, same-operation replay, changed-payload
  rejection, rollback of domain and ledger writes, migration rerun, and separate
  API/worker sessions.

Verification:

```text
npm ci                                      PASS (isolated worktree install)
npm run build --workspace @szronox/contracts PASS
npm run build --workspace @szronox/api       PASS
npm run typecheck --workspace @szronox/api   PASS
node --test apps/api/dist/core.test.js       PASS (55/55)
node apps/api/test/postgres/real-pg-harness.mjs UNVERIFIED gate (DATABASE_URL absent)
cmp historical migration files               PASS (byte-identical)
git diff --check                              PASS
docker compose ...                            UNVERIFIED gate (Docker unavailable)
```

The full API test command was also attempted. Its 55 API/core tests passed; the
remaining eight baseline health/shutdown tests require built web assets or local
socket binding and failed in this restricted environment, independent of VPS-03
changes. Real PostgreSQL races, Compose startup, backup/restore and volume
permissions remain unverified until disposable local Docker/PostgreSQL is
available. No VPS, production credentials, paid resource or unrelated volume was
used.

# SzroNox VPS deployment

This task owns VPS installation and deployment. The user explicitly selected the
existing VPS instead of managed Supabase hosting and authorized deployment here.
Application implementation and integration remain with the implementation task.

## Server and isolation

- SSH: `ssh ubuntu@51.195.103.79` using the existing local key/agent.
- Root: `/opt/szronox`; source releases: `/opt/szronox/releases/<release>`.
- Compose project: `szronox`; private address: `127.0.0.1:3010`.
- Docker and Compose were already installed. No host package installation needed.
- Preserve `/opt/task-tracker`, `/opt/cutroom`, `/opt/rezyserka`, their containers,
  databases, credentials, host services and Caddy configuration.
- No borrowed credentials, shared application database, public port or Caddy route.
- Do not use global Docker cleanup commands or remove other projects' resources.

## Initial release

Release `f0e8e9b-infra-20260914` contains application commit `f0e8e9b` plus the
Dockerfile and Compose configuration in this directory. Deployment files are
currently uncommitted. The pre-existing edit to `docs/implementation/tasks.md`
was not deployed or changed. No feature worktree was merged.

This is the integrated scaffold: Polish placeholder page and health endpoint.
It has no working persistence, authentication or feature API. The placeholder
worker is not started. No database or auth service was installed speculatively.
VPS PostgreSQL, authentication and private storage still need configuration
against the integrated application interfaces; deploying here does not by itself
replace Supabase-specific adapters or complete those application features.

## Build, start and inspect

Run on the VPS from the relevant release directory:

```bash
export SZRONOX_RELEASE=f0e8e9b-infra-20260914
docker compose -f deploy/vps/compose.yaml build
docker compose -f deploy/vps/compose.yaml up -d --no-build --wait --wait-timeout 60
docker compose -f deploy/vps/compose.yaml ps
curl --fail http://127.0.0.1:3010/api/v1/health
curl --fail http://127.0.0.1:3010/
docker exec -i szronox-app-1 node --input-type=module < deploy/vps/smoke.mjs
```

The image build runs `npm ci`, `npm run build`, `npm run typecheck`, and `npm test`.
Build precedes typecheck because workspace imports require compiled contracts.
Runtime uses an unprivileged user, read-only filesystem, bounded logs/resources,
health checks and automatic restart. No application secrets are in the image.

Local browser access without publishing:

```bash
ssh -N -L 3010:127.0.0.1:3010 ubuntu@51.195.103.79
```

Then open `http://localhost:3010`.

## Subsequent releases and rollback

Deploy only the intended integrated revision, in a new release directory. Build
before replacing the container. Set `SZRONOX_RELEASE` to that directory's unique
release identifier, run the commands above and verify assets and API responses.
Update `/opt/szronox/current` only after verification succeeds. Keep the preceding
release directory and tagged image. Roll back by running its Compose file with
its original `SZRONOX_RELEASE` and `up -d --no-build --wait --wait-timeout 60`, then
restore the current symlink. The initial release has no earlier app to roll back to.

Before a release introduces persistence, define isolated volumes, backups,
migration and restore procedures. Never assume container rollback reverses data
migrations. Public routing requires the intended domain and functioning access
control; both remain pending for this scaffold.

## Verified handoff — 2026-09-14

Owned files: `deploy/vps/Dockerfile`, `compose.yaml`, `smoke.mjs`, and this README.
No application code, shared contracts, dependencies or lockfiles changed.

- Build and typecheck PASS; `npm test`: 11/11 PASS on the VPS.
- Compose startup with `--wait`: healthy.
- `smoke.mjs`: health JSON, page, both generated assets, unknown API and missing
  asset responses PASS. Host-loopback health request also PASS.
- Existing containers retained their uptime; existing HTTP services on ports
  3000 and 3001 returned 200 before and after deployment.
- `/opt/szronox/current` points to `releases/f0e8e9b-infra-20260914`.
- No Caddy, existing service/data, DNS, or firewall modifications.
- Base image resolved to
  `node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`.
- Built application image ID:
  `sha256:22f65d034e732ae78b75829f5d4e02a9e3282820efb57f2b6076543accca9473`.

The first clean build failed when typecheck ran before contracts were compiled;
the corrected build-first order passed all checks. Public access, persistence,
authentication, provider integrations and full product behavior remain unverified
and unavailable in this scaffold. Deployment configuration has no commit yet.

# MONITOR-01 — DEV deployment

Date: 2026-11-07. The operator approved merging Streamy and MONITOR-01 into master and deploying
to DEV (`https://dev.szronox.zieloni.tech`) only. Master merge `fcb1c42` (MONITOR-01 `1ab3937` +
Streamy `57b7d15`) ran as image `szronox-dev:fcb1c42`, ID
`sha256:eb08d0e4f7503825282daec7fbf000b52091ca1af0517dec4801463c410ecb0d`. Previous release
`589393b`.

## Pre-deployment safety check

`589393b` was not on origin. Its running source (`app.589393b`, identical to `app`, `node_modules`
and `dist` excluded) was compared tree-to-tree against git. It equals Streamy commit `3ca3db8` apart
from `docs/implementation/STREAM-PLAN-01-deployment-result.md` (a doc only; added to master with
this record) and an executable bit on `deploy/vps/postgres/initdb/10-runtime-roles.sh`. No code
change outside `57b7d15` / `fcb1c42` was dropped. `claude/phone-save-queue` (`0839588`) was not
what DEV ran.

## Deployment

Archive `git archive fcb1c42 | gzip -n` (6,338,035 bytes) SHA-256
`1856d4d0e78dafbace746c6b3ada6183f76dfc6c5a9bb19573c4c336611c3706`, identical after transfer.
Before rollout: 0 queued/running AI runs; applied migrations 0001–0020 (0019/0020 from Streamy).
Backup `backups/pre-fcb1c42/`: 1,062,226-byte custom-format dump (25 TABLE DATA entries),
`runtime.env`, `release.before.txt` (`589393b`), migrations list, container and neighbour state,
SHA256SUMS.

Rollout: `app` → `app.pre-fcb1c42`, `app.fcb1c42` copied to `app`; only `SZRONOX_RELEASE` changed
(diffed); `config/dc-gemini.sh build` (log `config/build-fcb1c42.log`);
`config/dc-gemini.sh run --rm migrate` — 21 files checked, 1 applied (`0021_monitor.sql`);
`config/dc-gemini.sh run --rm grants` exit 0;
`config/dc-gemini.sh up -d --no-deps --force-recreate api worker`.

## Verification

- api/worker on `szronox-dev:fcb1c42`, 0 restarts, 0 error lines. Worker ready line:
  `privilegeEnforcement: enforced`, `privilegeViolations: []`, `aiLifecycle: enabled`.
- `/api/v1/ready` 200 on loopback 3011 and HTTPS; `/`, `/sw.js`, `/manifest.webmanifest` 200.
- Tables `app.monitor_posts`, `monitor_reports`, `monitor_runs`, `monitor_sources` exist.
  `access_keys_scope_check` is `scope = ANY (ARRAY['live_feed', 'monitor_collect'])`.
- Reels unchanged: 77 total, 45 not deleted. Stream plan still present (1).
- Served bundle `index-CAvp5RTd.js` contains `Monitoring`, `Źródła`, `Raport`.
- Neighbours (`app-api-1`, `app-web-1`, `cutroom-postgres-1`, `szronox-app-1`,
  `szronox-dev-postgres-1`) StartedAt unchanged; Caddy MainPID 1226 and Caddyfile SHA-256
  `c672bd75…` unchanged. No production, Task Tracker, Caddy, provider or kDrive change.

Superseded on DEV on 2026-11-09 by the phone save-queue fix `98e2cd7` (web-only, parent
`fcb1c42`; record on branch `claude/project-thread-8y3fi0`).

## Collector

`tools/monitor-collector` on the operator laptop: `.venv` on Python 3.13, requirements installed,
`.env` points at DEV; `python -m pytest` 14/14. The `monitor_collect` key and the 20 DEV sources
were set up by the operator, not in this deployment. Open gates: Facebook/X login, first collector
run, first live Gemini report.

## Rollback

Code only: restore `app.pre-fcb1c42` as `app` and `backups/pre-fcb1c42/runtime.env`, then
`config/dc-gemini.sh up -d --no-deps --force-recreate api worker`. Keep `0021_monitor.sql`: it is
additive (new tables and a widened scope check), and `589393b` does not read them. Do not restore
the dump for a code rollback.

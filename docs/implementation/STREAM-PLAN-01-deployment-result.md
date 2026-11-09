# STREAM-PLAN-01 — DEV deployment

Date: 2026-10-16. Branch `claude/project-thread-loz3r2` fast-forwarded into master (`64df396`),
deployed as image `szronox-dev:64df396`. Previous release `280ebb8`.

## Steps

- Archive `git archive 64df396 | gzip -n`, SHA-256
  `d4ffa1f6b39d8114e2947662d2b1fc6f4b6b65503e7f6bcd7e53dd7d070f0e66`, identical after transfer.
- Before rollout: 0 queued/running AI runs; 1 open kDrive upload (stale, last updated
  2026-10-13, the pre-fix failed upload).
- Backup `backups/pre-64df396/`: 863,633-byte custom-format dump, `runtime.env`,
  `release.before.txt` (`280ebb8`).
- `app` → `app.pre-64df396`; `app.64df396` copied to `app`; `SZRONOX_RELEASE=64df396`;
  `dc-gemini.sh build migrate`.
- Migrate: 19 files checked, 1 applied (`0019_stream_plans`). Grants job exit 0.
- `dc-gemini.sh up -d --no-deps --force-recreate api worker`.

## Verification

api/worker on `64df396`, api healthy, 0 error lines, "API ready" / "worker ready";
`/api/v1/ready` 200 on loopback and HTTPS; `/`, `/sw.js`, `/manifest.webmanifest` 200.

Local before deploy: typecheck clean; API tests 306 pass / 6 fail (not triaged; failing test
names not captured).

Open gate: operator check of the new stream screen in the app.

Rollback (code only): restore `app.pre-64df396` as `app` and `backups/pre-64df396/runtime.env`,
then `config/dc-gemini.sh up -d --no-deps --force-recreate api worker`. Keep `0019`: migrations
are forward-only.

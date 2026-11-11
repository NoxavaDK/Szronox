# Phone save-queue fix — DEV deployment

Date: 2026-11-09. The operator approved deploying the phone save-queue fix to DEV
(`https://dev.szronox.zieloni.tech`) only. Commit `98e2cd7` (parent `fcb1c42`, master) runs as image
`szronox-dev:98e2cd7`, ID `sha256:8b43256c40e4d98b6b6de61d69bcb87b69dbc040f2e6de3327300a3c6ddc6793`.
Previous release `fcb1c42`.

## Change

Only `apps/web/src/drafts/queue.ts` and `apps/web/src/controllers/useAppController.ts`. The sync
queue no longer waits for `navigator.onLine`. A conflict or failure now holds back only the later
operations on the same Reel instead of the whole queue, and a network error keeps the item
pending. An expired session shows a re-login message. No API, worker or schema change.

## Deployment

Archive `git archive 98e2cd7 | gzip -n` SHA-256
`27a573d1755ffbf605d22b4ae27346662e1a761001df79a30e1c855b5e4c0c04`, identical on the server
(`incoming/szronox-98e2cd7.tar.gz`). Before rollout: 0 queued/running AI runs, no migrate/grants
job running. Backup `backups/pre-98e2cd7/`: 1,092,413-byte custom-format dump (29 TABLE DATA
entries), `runtime.env`, `release.before.txt` (`fcb1c42`), neighbour state, SHA256SUMS.

Rollout: `app` → `app.pre-98e2cd7`, `app.98e2cd7` copied to `app`; only `SZRONOX_RELEASE` changed
(diffed); `config/dc-gemini.sh build` (log `config/build-98e2cd7.log`); no migrations (migration
files identical, last applied still `0021_monitor.sql`);
`config/dc-gemini.sh up -d --no-deps --force-recreate api worker`.

## Verification

api/worker on `szronox-dev:98e2cd7`, 0 restarts, 0 error lines; worker `privilegeViolations: []`,
AI lifecycle enabled. `/api/v1/ready` 200 on loopback 3011 and HTTPS; `/`, `/sw.js`,
`/manifest.webmanifest` 200. Served bundle `index-ut4kvGVD.js` contains the new re-login text.
Monitor tables untouched (20 sources, 0 posts, 0 runs, 0 reports). Neighbour containers'
StartedAt unchanged.

Open gate: operator check on the phone that a capture saves while an older queue item is stuck.

Rollback (code only): restore `app.pre-98e2cd7` as `app` and `backups/pre-98e2cd7/runtime.env`,
then `config/dc-gemini.sh up -d --no-deps --force-recreate api worker`.

# KDRIVE-02 DEV deployment

Date: 2026-09-30. The operator explicitly authorized deployment to DEV (`https://dev.szronox.zieloni.tech`) only. Master `57cef02` (MEME-UPLOAD `9a52944`, KDRIVE-02 `0da424f`, race fixes `57cef02`) runs as image `szronox-dev:57cef02`, ID `sha256:f35232147717c8919523caa871db163fae14f136172c5d744aaa589bf70e26ee`.

Root review: ACCEPTED / NO FURTHER TESTING NOW. Checked the relay routes against the plan: the provider token and session token never leave the API, the start reservation counts and inserts under requester+Reel row locks, finish reconciles a non-replayable kDrive finish by the file id from start, grants give `szronox_api` read/write and `szronox_worker` nothing on `app.kdrive_uploads`. Concrete integration risk checked: 16 MiB chunks pass (Caddy site block has no `request_body` limit; the chunk route sets `bodyLimit` to the chunk size).

Archive `git archive 57cef02 | gzip -n` SHA-256 `5352d4781dc8fa97009e382b77726047ab356f90f9803a5b37450922dba1ae28`, identical after transfer. Backup `/opt/szronox-dev/backups/pre-57cef02/`: 743,176-byte custom-format dump (20 TABLE DATA entries), `runtime.env` (release `a86a057`), container/neighbour/schema state, build log, SHA256SUMS. Zero queued/running AI runs before rollout.

Rollout: `app` → `app.pre-57cef02` (= `a86a057` source), `app.57cef02` copied to `app`; only `SZRONOX_RELEASE` changed (diffed); `migrate` (13 files checked; 1 applied: `0013_kdrive_uploads.sql`); `grants` exit 0; `up -d --no-deps api worker`.

Checks: `/api/v1/ready` ready on loopback 3011 and HTTPS; `/`, `/sw.js`, `/manifest.webmanifest` 200; api and worker on the new image, 0 restarts; API startup reports `privilegeEnforcement: enforced`, no violations, kDrive drive `1990403` / base folder `1349`. `szronox_api` may insert into `app.kdrive_uploads`; `szronox_worker` may not select it. Neighbours' StartedAt, Caddy MainPID 170439 and Caddyfile hash unchanged. No production, Task Tracker or provider change.

Not performed (separate operator approval): `deploy/vps/kdrive-upload-live.mjs`, any live kDrive upload or SMOKE file, the `copy-memes-to-kdrive` CLI (DEV has 0 memes). Open manual gates: real phone video upload over mobile data, opening uploaded files as NOXAVA and SZRON, Android tab-switch/background behaviour, single-file kDrive browser URL, real PostgreSQL concurrency (VPS-06).

Rollback (code only): restore `app.pre-57cef02` as `app` and `backups/pre-57cef02/runtime.env`, then `config/dc-gemini.sh up -d --no-deps api worker`. Keep 0013: additive (nullable/defaulted columns and a new table), and `a86a057` selects explicit columns. Do not restore the dump for a code rollback.

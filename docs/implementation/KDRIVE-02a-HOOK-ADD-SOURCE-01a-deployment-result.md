# KDRIVE-02a + HOOK-ADD-01 + SOURCE-01a DEV deployment

Date: 2026-10-02. Operator-authorized deployment to DEV only. Master `8943899` runs as image `szronox-dev:8943899`, ID `sha256:21273e69c73ec004006dd3d09a5e4ed1cca58cc9d17c22025dabbccf88d38008`.

Contents:
- `564f9c7` KDRIVE-02a: every kDrive upload start returned 500 on DEV. The capacity reservation used `select … for update` on `app.users`, which needs UPDATE privilege that `szronox_api` deliberately lacks (reproduced on DEV as `permission denied for table users`). It now uses `pg_advisory_xact_lock` on the user id. The client reads the server version before start and attach retry, refuses a combined folder+upload while edits are unsaved, and picks up its own folder-link/attach writes. This removes the false "Rolka zmieniła się na innym urządzeniu" after a failed combined start. Missed earlier because the upload tests run on single-role PGlite and the live upload helper was never run.
- `037fb78` HOOK-ADD-01: `+ Dodaj hook` in Reel Detail (delta spec §F).
- `8943899` SOURCE-01a: 401/403 and unreadable links end `failed` at the first attempt with `failure: blocked|unsupported`; only transient failures retry.

Archive SHA-256 `d43ed475db5f7648de970ae7f4d59207c90e77c573ce6cbe03c1500998812197`, identical after transfer. Backup `backups/pre-8943899/` (794,776-byte dump, 21 TABLE DATA, `runtime.env` release `7ddefcc`). Before rollout: 0 queued/running AI runs, 0 open uploads. Migrate: 14 checked, 0 applied; grants exit 0; api/worker recreated, 0 restarts. HTTPS ready, `/`, `/sw.js`, `/manifest.webmanifest` 200. The bundle contains `+ Dodaj hook` and `Strona blokuje automatyczne pobieranie`. `pg_advisory_xact_lock` succeeds as `szronox_api`. Neighbours and Caddy unchanged.

Open gate: a real cover and video upload from the browser on DEV (operator). Rollback (code only): restore `app.pre-8943899` and `backups/pre-8943899/runtime.env`, then `config/dc-gemini.sh up -d --no-deps api worker`.

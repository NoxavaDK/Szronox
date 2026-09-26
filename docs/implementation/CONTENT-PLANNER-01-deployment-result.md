# CONTENT-PLANNER-01 DEV deployment

Date: 2026-09-25. The user explicitly authorized deployment to DEV (`https://dev.szronox.zieloni.tech`) only. Merge commit `25e58b0` (implementation `194cbc8`, result `62d755b`) runs as image `szronox-dev:25e58b0`, ID `sha256:0e7284ceeeb252b6f1a0cb2fa5bd975c15ea58dcccc22728ae1b956e3fc1f1e0`.

Archive `git archive 25e58b0 | gzip -n` SHA-256 `65b3dac4092a6326e87233e8a1e13d256664fe232c7d7e01b2532cbc8169faac`, identical after transfer. Backup `/opt/szronox-dev/backups/pre-25e58b0/`: 665,924-byte custom-format dump (20 TABLE DATA entries), `runtime.env` (release `d75c94e`), schema/container/neighbour state, build log, SHA256SUMS. Zero queued/running AI runs before rollout.

Rollout: `app` → `app.pre-25e58b0` (= `d75c94e` source), `app.25e58b0` copied to `app`; only `SZRONOX_RELEASE` changed (diffed); `migrate` (11 files checked; 1 applied: `0011_planned_publication.sql`); `grants` exit 0; `up -d --no-deps api worker`.

Checks: `/api/v1/ready` ready on loopback 3011 and HTTPS; `/`, `/sw.js`, `/manifest.webmanifest` 200; api and worker on the new image, 0 restarts. Live schema: two nullable columns (`date`, `time without time zone`) and `reels_planned_time_needs_date`; all 23 existing Reels unplanned. Served bundle `index-Dc8VxNg2.js` contains `Zaplanuj publikację`, `Niezaplanowane`, `Po terminie`. Neighbours (`app-api-1`, `app-web-1`, `cutroom-postgres-1`, `szronox-app-1`, `szronox-dev-postgres-1`) have identical StartedAt; Caddy MainPID 170439 and Caddyfile SHA-256 `c672bd75…` unchanged. No production, Task Tracker, provider or kDrive change.

Live API acceptance (`deploy/vps/planner-live.mjs`, session minted through the app store and revoked): 14/14 — existing Reels valid; date-only plan; persisted on reload; move with time; exactly one Reel carries the plan; stale 409; invalid date and time-without-date 422; unschedule clears both, status unchanged; CSRF enforced; one SMOKE Reel added (23 → 24) and soft-deleted (restorable from Usunięte). No real Reel was planned or modified.

Open manual gate: operator browser pass on DEV (desktop wide/two-pane, physical mouse drag-and-drop, Android touch). The same flows passed 45/45 in local headless Chrome against the real API code (see CONTENT-PLANNER-01-result.md).

Rollback (code only): restore `app.pre-25e58b0` as `app`, restore `backups/pre-25e58b0/runtime.env`, run `config/dc-gemini.sh up -d --no-deps api worker`. Migration 0011 stays: additive, and `d75c94e` selects explicit columns, so it ignores the plan columns; plans stored meanwhile reappear on roll-forward. Do not restore the dump for a code rollback.

## Publication-slot correction deployment (2026-09-26)

Merge `650c581` (implementation `79f6307`) runs as image `szronox-dev:650c581`, ID `sha256:1f50281f23e54cb9be0d4b1b75b74465da971d3c0d44adcb078e8bab0f67c97c`. Archive SHA-256 `af02dcafebf6575457787e69e48f576fb125a6fe2df3edb6abda11a621339715`, identical after transfer. Backup `backups/pre-650c581/`: 667,976-byte dump (20 TABLE DATA), `runtime.env` (release `25e58b0`), state files, build log. Before rollout: 0 planned Reels, 0 queued/running AI runs.

Migrate: 12 files checked, 1 applied (`0012_publication_slot.sql`); grants exit 0; only DEV api/worker recreated (0 restarts). Ready on loopback and HTTPS; `/`, `/sw.js`, `/manifest.webmanifest` 200. Live schema has `reels_planned_slot_check`, `reels_planned_slot_needs_date` and trigger `reels_clear_slot_without_date`. Bundle `index-DbD-gBzF.js` contains `Pora dnia`, `Popołudnie`, `Wieczór`, `plannedPublicationSlot` and no `plannedPublicationTime`. Neighbours' StartedAt, Caddy MainPID 170439 and Caddyfile hash unchanged.

Live API acceptance 14/14 (`deploy/vps/planner-live.mjs`, updated for slots): date-only plan, move with `evening`, one Reel per plan, stale 409, slot-without-date / free time / retired `plannedPublicationTime` all 422, unschedule clears the slot, CSRF enforced, one SMOKE Reel added (24 → 25) and soft-deleted, session revoked. No real Reel planned or changed.

Rollback (code only): restore `app.pre-650c581` as `app` and `backups/pre-650c581/runtime.env`, then `config/dc-gemini.sh up -d --no-deps api worker`. Keep 0012: `25e58b0` ignores the slot column, and the trigger lets it clear dates on Reels that have a slot.

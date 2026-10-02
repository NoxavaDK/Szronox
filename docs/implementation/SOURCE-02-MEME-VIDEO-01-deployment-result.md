# SOURCE-02 + MEME-VIDEO-01 DEV deployment

Date: 2026-10-02. Operator-authorized deployment to DEV only. Master `ff2beac` (pin `b0ff4a6`, SOURCE-02 `8fb5e24`/`cfa6abb`, MEME-VIDEO-01 `c427243`/`ff2beac`) runs as image `szronox-dev:ff2beac`, ID `sha256:85bc114a9b494c40f40b5338cae7f514135472623650f70ce12ad3a0e0365bf2`.

Root review: ACCEPTED / NO FURTHER TESTING NOW. Checked the integration risks:
- Role privileges: no new row locks outside tables `szronox_api` may update; grants are table-level, so the new columns are covered.
- Migration 0015: it replaces `attachments_kind_check` and `attachments_validated_metadata_complete` (both confirmed on DEV) and adds `attachments_video_meme_only` and the `meme` purpose. It applied cleanly against the existing rows.
- Uploads: the content route's `bodyLimit` is 25 MiB + 1, and its content-type parser covers `video/*` and `application/octet-stream`.
- Declared video MIME is validated by `^video/[a-z0-9.+-]+$` before it is stored or sent as a header. The container is sniffed (no decoding).
- `/memes/:id/media` answers single ranges with 206, invalid ones with 416, with `nosniff` and `no-store`.
- The worker falls back to `sourceLink` only when `originalInput.url` is absent.

One build passed, plus the targeted API suites (meme video routes/storage, source link, source metadata, kDrive meme copy, kDrive upload): 29/29.

Archive SHA-256 `43a929d5a579fe0c6f190eb3504c675c964b9858efe97811d23fc2928082cd61`, identical after transfer. Backup `backups/pre-ff2beac/` (794,776-byte dump, 21 TABLE DATA, `runtime.env` release `8943899`). Before rollout: 0 queued/running AI runs, 0 open uploads. Migrate: 15 checked, 1 applied (`0015_source_link_video_memes.sql`). Grants exit 0. api/worker recreated, 0 restarts, no error-level log lines. HTTPS ready; `/`, `/sw.js`, `/manifest.webmanifest` 200. New columns present (`reels.source_link`; `memes.media_kind/mime_type/poster_ref`; DEV has 0 memes). The bundle contains `Dodaj link do artykułu` and `Wideo przekracza limit 25 MB`. Neighbours and Caddy unchanged.

Open gates (operator, browser): add an article link to an image/text Reel and see Źródło fill; create a video meme (mp4 and one other format), poster, muted inline playback; Safari/iOS playback; the kDrive `Memy` copy of a video; a real cover upload after KDRIVE-02a.

Rollback (code only): restore `app.pre-ff2beac` and `backups/pre-ff2beac/runtime.env`, then `config/dc-gemini.sh up -d --no-deps api worker`. Keep 0015 unless no video attachment or meme exists yet. `8943899` doesn't read the new columns, but it would refuse to serve video memes.

# kDrive chunk numbering fix — DEV deployment

Date: 2026-10-13. Operator-reported bug ("can't upload the video… error when I upload it to
kDrive"); operator ran the rollout. Master `280ebb8` runs as image `szronox-dev:280ebb8`, ID
`sha256:c6f27a83b1c7d0351785fd4a11e2a778621e10299ac9f64d8deba1d87422a94d`. Previous release
`2438429`.

## Diagnosis

The DEV API log for upload `54787e84…` (video, 110,810,198 bytes): `POST …/kdrive-uploads` → 201,
then `PUT …/chunks/0` → **502** twice (8.1 s and 10.7 s). The relay sent `chunk_number=0`;
kDrive numbers upload-session chunks from 1 (KDRIVE-02 live probe, `deploy/vps/kdrive-upload-probe.mjs`
uses `index + 1`), so kDrive refused the chunk and the API mapped the rejection to 502. Every
video and feed-cover upload was affected. The route tests used a fake provider that accepted 0,
and no live upload through the app had been run (KDRIVE-02 deployment record: "Not performed").

## Fix

`apps/api/src/kdrive/upload-client.ts`: `chunk_number=${index + 1}`. The finish hash was already
ordered by index. New `apps/api/src/kdrive-upload-client.test.ts` pins the exact chunk request
(1-based number, size, hash, bearer token, octet-stream body) and the 400 → non-retryable
rejection mapping. kDrive upload tests 10/10.

## Deployment

Archive SHA-256 `99e9b546d74870e5cd85d937d6bf694e1c298b878810f574d0773ecd7c0d7219`, identical after
transfer. Backup `backups/pre-280ebb8/` (847,228-byte dump, `runtime.env`, release `2438429`).
Before rollout: 0 AI runs in flight, 1 open upload (the failed one above). No migrations.
Rollout (operator): `SZRONOX_RELEASE=280ebb8`, `app` swapped, build, `dc-gemini.sh up -d
--no-deps --force-recreate api worker`.

Verified: api/worker on `280ebb8`, 0 restarts, 0 error lines, ready on loopback and HTTPS; `/`,
`/sw.js`, `/manifest.webmanifest` 200; migrations still 0016–0018; 57 Reels; the running
`dist/kdrive/upload-client.js` contains the fix.

Open gate: a real video and a real feed-cover upload from the app into a Reel's kDrive folder
(operator, now).

Rollback (code only): restore `app.pre-280ebb8` as `app` and `backups/pre-280ebb8/runtime.env`,
then `config/dc-gemini.sh up -d --no-deps --force-recreate api worker`.

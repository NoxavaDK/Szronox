# Image capture fix — DEV deployment

Date: 2026-10-03. Operator-reported: image ideas fail to upload. Master `21516dc` runs as image `szronox-dev:21516dc`, ID `sha256:2ec3edf7f56bc667321a09ddf81f9d26a599e8c2cdde0a7f54e2bc9adbbcd716`.

Findings on DEV:
- Only PNG captures had ever succeeded (4 ready, all `image/png`). Both JPEG captures (2026-10-01 18:15, 2026-10-03 06:55 UTC) stayed `pending`: the reel was created, and the content PUT returned 422.
- The 2026-10-01 capture's replay at 06:55 returned 409. MEME-VIDEO-01 hashes the initiation as `{ ...request, kind }`, while its operation was recorded without `kind`. Recomputed hash: `8a7aa081…` without `kind` = the stored hash; with `kind:'image'` = `fbe6e674…`. Every image queued before `ff2beac` therefore got a permanent false 409.
- The 422 reason wasn't logged. Reproduced in the DEV container: a WebP named `.jpg` decodes as `webp`, so it was refused as `mime_type_mismatch` (Android declares the type from the file name). A truncated JPEG also fails the full decode, which stays refused.

Fix: replays recorded under the pre-`kind` shape are accepted (a different payload still gets 409). A supported decoded image is stored and recorded under its decoded type. Content refusals are logged at warn level with `reason` (no content). A stale migration-test table list was updated. Targeted API suites 55/55, including the new `attachment-recovery.test.ts`.

Archive SHA-256 `53e8a9a24d5c7c4e133d007248b46242000c2cf7b0f5275da793390736fbf4c2`. Backup `backups/pre-21516dc/`. Migrate: 0 applied. api/worker 0 restarts, HTTPS ready, neighbours unchanged.

Rollback: restore `app.pre-21516dc` and `backups/pre-21516dc/runtime.env`, then `config/dc-gemini.sh up -d --no-deps api worker`.

## Follow-up `443d78d` (same day)

After `21516dc`, the 2026-10-03 capture (`67945.jpg`, really a WebP) recovered automatically and is `ready` as `image/webp`. The 2026-10-01 capture's replay passed initiation but its content PUT got 403. Its ticket had been renewed on 2026-10-02, and the replayed initiation returns the original, now superseded, ticket. The client renewed only on expiry, so it stopped. The server now tags this refusal `upload_authorization_superseded` (after the owner check), and the client renews once for it. Web transport tests 11/11 (new case included), API 55/55. Deployed as `szronox-dev:443d78d`: archive `73fff481…`, backup `backups/pre-443d78d/`, 0 migrations, 0 restarts, neighbours unchanged.

Not fixed (product gap, reported to the operator): Reel Detail shows a pending or failed capture image with no state and no `Ponów`, and `Otwórz` on an attachment still shows the stale placeholder "Podgląd załącznika będzie dostępny po wdrożeniu transportu plików."

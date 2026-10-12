# STREAM-LIVE-01 + STREAM-01 + VOICE-01 + CAPTURE-DRAFT-01 + WIRE-01 + attachment preview — DEV deployment

Date: 2026-10-12. Operator-authorized deployment to DEV only ("Do it, deploy"; auto drafts on, as
proposed). Master `2438429` runs as image `szronox-dev:2438429`, ID
`sha256:972f8c7d8e9d4ad1d58ab1b5958c7eab6c88f06fc9ef6e898e971aeb6eee2b4e`. Previous release `443d78d`.

Contents: STREAM-LIVE-01 (`Na żywo`, live messages, device keys), STREAM-01a/b (streams and
topics), VOICE-01 (spoken/caption voice, team examples in AI snapshots), CAPTURE-DRAFT-01 (label
chain, article headline, automatic develop draft at capture), WIRE-01 (screen wiring), the
root integration fixes and the attachment preview fix (`2438429`).

## Steps

- Archive `git archive 2438429 | gzip -n`, SHA-256
  `8193829bc10e4c48926386b622ffdcbd9bb904d7cd20cd1fe5c453336e1ac3c5`, identical after transfer.
- Before rollout: 0 queued/running AI runs, 0 open kDrive uploads.
- Backup `backups/pre-2438429/`: 805,250-byte custom-format dump (21 TABLE DATA), `runtime.env`
  (release `443d78d`), migration list, container list, `release.before.txt`.
- `runtime.env`: `SZRONOX_RELEASE=2438429`; appended `AI_AUTO_DRAFT_ENABLED=true` and
  `AI_AUTO_DRAFT_DAILY_LIMIT=50` (key diff checked: only those two keys added).
- `app` → `app.pre-2438429`; `app.2438429` copied to `app`; `dc-gemini.sh build migrate`.
- Migrate: 18 files checked, 3 applied (`0016_live_messages`, `0017_streams`, `0018_capture_draft`).
- Grants: the first run inside the scripted rollout exited non-zero with its output suppressed
  (cause not captured). An immediate rerun by the operator completed (GRANT/REVOKE/ALTER DEFAULT
  PRIVILEGES). Verified read-only: `szronox_api` has SELECT on `access_keys` (plus the
  `last_used_at` column grant), SELECT/INSERT/UPDATE on `live_messages`, and full DML on
  `stream_topics`; `szronox_worker` has none on any of the three. The old `443d78d` containers
  served throughout; `/api/v1/ready` stayed 200.
- Rollout by the operator: `dc-gemini.sh up -d --no-deps --force-recreate api worker`.
  The auto-mode classifier refused these live-changing steps from the assistant session.

## Verification (read-only)

- `api` and `worker` on `szronox-dev:2438429`, 0 restarts, 0 error lines, "API ready" / "worker
  ready".
- 200 for `/api/v1/ready` on loopback 3011 and HTTPS, and for `/`, `/sw.js`,
  `/manifest.webmanifest`.
- Bundle `index-pnUKrp-N.js` contains `Na żywo`, `Tematy · `, `Nowy stream`,
  `Przygotowuję szkic`, `Propozycja tytułu` and the attachment `/content` route, and no longer
  contains the `wdrożeniu transportu plików` placeholder.
- Schema has 0016–0018 and `ai_runs.trigger`; 54 Reels intact. The API container sees
  `AI_AUTO_DRAFT_ENABLED=true` and `AI_AUTO_DRAFT_DAILY_LIMIT=50`.
- Neighbours (`szronox-app-1`, `app-api-1`, `app-web-1`, `cutroom-postgres-1`) unchanged; Caddy
  active.

## Open real-world gates (operator, phone/browser)

1. Android share of an article link and of a photo from both phones into the installed PWA:
   saved Reel, readable name, `Przygotowuję szkic…` → `Propozycja tytułu` within about 20 s.
2. `Otwórz` and the thumbnail of a captured PNG/JPG.
3. Create a stream, add a `Nowy temat`, absorb an idea, link a Rolka, reorder, Odłącz, then
   `Kopiuj opis`; delete the stream and restore it.
4. Opracuj quality before/after VOICE-01 on 5 real captures (live Gemini).
5. `Na żywo` against StreamControl: needs a device key created with the operator CLI on DEV
   (not done).

## Rollback (code only)

Restore `app.pre-2438429` as `app` and `backups/pre-2438429/runtime.env`, then
`config/dc-gemini.sh up -d --no-deps --force-recreate api worker`. Keep 0016–0018: they are
additive and `443d78d` selects explicit columns. Do not restore the dump for a code rollback,
because that would discard later DEV edits.

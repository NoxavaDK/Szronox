# LIST-01 + SOURCE-01 integration and DEV deployment

Date: 2026-09-22. Deployed source: `6b9032f`. Previous live release: `d4cddd3`.

## Decision: ACCEPTED / NO FURTHER TESTING NOW

Merged corrected LIST-01 (`f8030bd`, including `bd422ef`) and SOURCE-01 (`7320e20`) with the corpus baseline into master through integration branch `codex/release-list-source`. No database or deployment configuration source changes relative to the previous live release. No migrations executed.

Recorded child evidence accepted: LIST-01 web typecheck/build and 54 tests; SOURCE-01 12 targeted source/worker tests. No repeat full suite, audit, or Gemini call.

Integration commands, all PASS:

```sh
npm ci --include=dev
npm run typecheck --workspace @szronox/web
npm run build --workspace @szronox/web
npm run build --workspace @szronox/worker
```

Actual VPS image build also passed all workspace builds using the existing host Dockerfile:

```sh
docker build -f /opt/szronox-dev/config/Dockerfile.deploy \
  -t szronox-dev:6b9032f /opt/szronox-dev/app.6b9032f
/opt/szronox-dev/config/dc-gemini.sh up -d --no-deps api worker
```

The source was transferred by `git archive 6b9032f`, excluding temporary browser harness files and local untracked inputs. Both API and worker run `szronox-dev:6b9032f`, image `25bd7a84e771`, zero restarts. Worker privilege enforcement passes with no violations. HTTPS `/api/v1/ready` returns ready, roster/storage pass. `/sw.js` and `/manifest.webmanifest` return 200 with correct MIME and max-age=0.

## Bounded browser and source checks

Actual in-app browser, local fixture harness:
- Right drag reveals status action and remains revealed; status action and undo work.
- Left drag reveals Więcej; it opens the quick-actions sheet.
- Shift+Tab and Tab cycle at sheet boundaries; Escape restores row focus.

Actual authenticated DEV browser, disposable text idea only:
- Quick actions open via context click.
- Moving Pomysł to Do nagrania removes it from the active Pomysły filter (4 to 3).
- Cofnij restores the row to Pomysły (3 to 4).
- Tap opens `/reels/:id`; browser Back returns list; Forward and reload resolve the same detail.
- Confirmed soft-delete removes the test idea; three pre-existing urgent ideas remain untouched.
- Fixture ID: `050a7f60-1a6d-449f-9c54-7f13e07443e0` (recoverable in Usunięte).

The built Linux image ran `retrievePublicSource` directly on the reported Onet URL through the existing worker egress network. PASS: extracted article is 2,460 characters. No Gemini key was mounted in this disposable container; no provider call occurred. The 2 MiB streamed download limit and separate 20,000-character article limit remain in effect.

## Infrastructure preservation

Task Tracker API/web, cutroom PostgreSQL, and the older scaffold retain identical container StartedAt values before/after. Caddy MainPID remains 170439, Caddyfile SHA-256 remains `c672bd759e6de23cb4367544c23e3349b81e6d638db6c3a7e40f1109a67a9a03`. No Caddy edit/reload or production hostname configuration. Database remains at eight migrations; active corpus `zieloni-programme-2026-draft-r1` retains 1,423 proposals.

## Rollback retained, not executed

- Previous application directory: `/opt/szronox-dev/app.pre-6b9032f`.
- Previous image: `szronox-dev:d4cddd3`.
- Protected configuration and pre-release custom-format database backup: `/opt/szronox-dev/backups/pre-6b9032f/`.
- To revert code, retain the failed/current directory, restore the previous directory as `/opt/szronox-dev/app`, restore that backup's runtime.env, then run the same `dc-gemini.sh up -d --no-deps api worker` and readiness check. Do not restore the database for this code-only rollback: that would discard later user activity.

Root untracked deployment drafts that collided with the integrated files were preserved at `.local-preserved-before-release-20260922/deploy/vps/`. Other user inputs were untouched. Temporary fixture entry files were removed and the local preview server stopped.

## OPEN REAL-WORLD GATE

Physical phone long-press/scroll competition, pinch zoom, haptics, screen-reader behavior and native edge-back gesture remain unverified. Browser pointer/keyboard checks above do not substitute for device acceptance. No unrelated provider acceptance was repeated. Archive/duplicate and manual ordering remain outside this implementation's existing contracts, as documented in LIST-01.

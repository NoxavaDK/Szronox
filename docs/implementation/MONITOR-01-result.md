# MONITOR-01 — implementation result

Branch: `luna/monitor-01`

Base: `origin/claude/project-thread-5g65na` at `44e650bac7aeedc15d0e2940833578ba871c0202`

Implementation commit: `ac92745`
No merge of this feature branch into the project base, deployment, DEV migration, social-account login or live Gemini request was performed.

## Delivered

- Added the monitor database grants and API/worker startup privilege checks, scoped `monitor_collect` device keys, and operator CLI scope selection. Existing live-feed keys still default to `live_feed`.
- Added canonical URL handling, versioned source management, collector routes, canonical post upserts, day runs/reports, post listing and Reel creation through the existing capture transaction.
- Added the leased monitor synthesis worker with bounded batches, strict JSON schema, post-input URL and exact-quote filters, retries and preservation of the last successful result.
- Added the Raport / Posty / Źródła screen, report navigation, date and group filters, source management, report actions and Reel creation.
- Ported the collector to `tools/monitor-collector/`. It uses the SzroNox API and a local JSON outbox, launches visible installed Chrome (Edge fallback) with a persistent profile, and supports optional Patchright. Its Facebook/X selectors are platform-local; parser failures save HTML and screenshots. Sample sources are marked `TODO-verify`.

## Verification

- `npm run typecheck` — passed. After the final privilege compatibility adjustment, `npm run typecheck --workspace @szronox/api` also passed.
- `npm run build` — passed. After the final privilege adjustment, `npm run build --workspace @szronox/api` passed.
- `node --test apps/api/dist/monitor.test.js` — 5/5 passed.
- `node --test --test-name-pattern="API and worker privilege rules refuse an over-privileged role" apps/api/dist/runtime.test.js` — 1/1 passed.
- `node --test apps/worker/dist/ai/monitor.test.js` — 4/4 passed.
- From `tools/monitor-collector/`, `C:\Users\sille\Desktop\StreamOverlay\filmiki-monitor\.venv\Scripts\python.exe -m pytest` — 6/6 passed (Python 3.13.16 on this host; Python 3.11 was not available for a separate run).
- Temporary Vite preview at `http://127.0.0.1:5173/monitor-preview.html` with mock API data — report synthesis and Sources/source form rendered in the local browser. The temporary page was removed after inspection.
- `node "$env:LOCALAPPDATA\Temp\monitor-01-e2e.mjs" "C:\Users\sille\Desktop\StreamOverlay\Szronox\.worktrees\monitor-01"` — passed with a local PGlite database, test collect key and stub provider: source created, fixture post collected, run finish queued a report, and worker wrote a succeeded synthesis. The one-off harness was kept in the host temp directory, not the repository; no live Gemini request was made.
- `git diff --check` — passed.

The all-at-once API suite command, `node --test --test-force-exit --test-reporter=tap apps/api/dist/*.test.js apps/api/dist/*/*.test.js`, reported 283 passed and 35 failed. No MONITOR API test failed. It includes the five pre-existing CI failures named in the handoff: migration inventory stopping at 0008, deployment Compose checks, the runbook's `AI_ENABLED` entry, the kDrive config check, and a storage-body test. This Windows run also failed unrelated storage ownership/path checks and spawned-server readiness checks. The existing synthetic privilege fixture initially exposed a compatibility issue; the checker was adjusted and its focused runtime test now passes. The full-suite result does not establish a clean base comparison on this host.

## Remaining real-world gates

- Apply migration `0021_monitor.sql` and the grants on DEV.
- Mint a `monitor_collect` key.
- Log in to Facebook and X with spare accounts using `python -m monitor_collector login facebook|x`.
- Run the collector against DEV once and inspect its saved posts and source statuses.
- Generate and inspect a live Gemini report.

Those steps were intentionally not performed under this handoff. Branch remains unmerged and undeployed.

## Review follow-up — 2026-11-07

Merged the requested `origin/claude/project-thread-5g65na` update carrying T00 amendment `1e4fcfa` into `luna/monitor-01` at merge commit `23296a2`. Follow-up code commit: `d039769`.

- Both API and collector canonicalizers retain `fbid` on `/photo/` and `/photo.php`, and `v` on `/watch/`; values are required so photo/video URLs remain distinct. Table-driven cases cover the new paths and missing identifiers.
- `listPosts` filters by the joined source's `s.platform`; the API test exercises both `platform=x` and `platform=facebook`.
- Facebook repost/pin flags now read only the designated post-header selectors. X flags read only `[data-testid="socialContext"]`. New saved fixtures cover an ordinary Facebook post with the `Udostępnij` action, a Facebook share, a pinned Facebook post, and English/Polish X repost and pin labels.
- Collector API failures are queued only for network failures, 5xx and 429. Other 4xx responses are logged and dropped; outbox replay drops a rejected entry and continues, while retaining entries on retryable failures.
- A zero-post day completes as `succeeded` with `emptyMonitorSynthesis()` before provider/key initialization.

Follow-up verification:

- `npm run typecheck` — passed.
- `npm run build` — passed.
- `node --test apps/api/dist/monitor.test.js` — 6/6 passed.
- `node --test apps/worker/dist/ai/monitor.test.js` — 5/5 passed, including empty day with no Gemini key.
- From `tools/monitor-collector/`, `C:\Users\sille\Desktop\StreamOverlay\filmiki-monitor\.venv\Scripts\python.exe -m pytest` — 14/14 passed.
- `node "C:\Users\sille\AppData\Local\Temp\monitor-01-e2e.mjs" "C:\Users\sille\Desktop\StreamOverlay\Szronox\.worktrees\monitor-01"` — passed; local PGlite report succeeded and the stub synthesis contained `Ceny energii`.
- `git diff --check` — passed.

The broad API suite was not rerun for this targeted follow-up. The earlier 283/318 result and its documented baseline/Windows-host failures remain recorded above.

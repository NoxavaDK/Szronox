# STREAM-PLAN-01 — result (handoff, draft)

Requested by the operator on 2026-10-15 after a broadcast: a separate stream screen set up per
stream (topics from recent Reels, main and extra links, points to discuss, Szron's pings,
comment highlighting), not a new Reel item. Implemented on branch `claude/project-thread-loz3r2`
as a draft PR. **Not merged, not migrated on DEV, not deployed.** Contract: T00 STREAM-PLAN-01.

## What was built

- Migration `0019_stream_plans.sql`, wire types in `packages/contracts`, grants and startup
  privilege rules.
- API `apps/api/src/stream-plans/` (list, candidates, get, create, update, current, delete) and the
  device read `GET /live/stream` in `live/routes.ts`.
- Web: `Streamy` header link, `/streamy` and `/streamy/:id`, `screens/StreamPlansScreen.tsx`:
  list + create; stream screen with TEMATY (picker of 30 newest Reels/ideas with search, or a
  typed topic; per topic: title on screen, main link prefilled from the Reel's article/captured
  link, extra links, points; up/down/remove), autosave with conflict choice, `Bieżący na PC`,
  KOMENTARZE (SSN session → embedded dock + link), NA ŻYWO (the existing panel, extracted as
  `LivePanel`), delete with confirmation. Quick Add no longer offers `ROLKA | STREAM`.

## Verification

| Command | Result |
| --- | --- |
| `cd apps/api && npx tsc -p tsconfig.json && node --test dist/stream-plans.test.js dist/live.test.js dist/deploy-grants.test.js dist/runtime.test.js dist/core.test.js` | 86/86 pass |
| `cd apps/web && npm run typecheck && npm run build` | OK |
| `npm run test:t08` (incl. new `stream-plans.test.mjs`), `test:list-01`, `test:share` | 100/100, 23/23, 21/21 |

Visual: the screen was rendered with fixture data in headless Chromium at 320, 360, 400 and
1280 px (list, open topic, picker, invalid link, two-column desktop); no horizontal overflow, no
console errors. The temporary preview harness was removed.

## Limitations / UNVERIFIED

- DEV migration 0019, `grants.sql` rerun, deployment.
- The SSN dock inside the app was not loaded here (the sandbox cannot reach socialstream.ninja);
  `Otwórz w osobnym oknie` is the fallback if SSN ever refuses framing.
- StreamControl's import against DEV.
- The full app shell around the screen was not rendered (only the screen itself).

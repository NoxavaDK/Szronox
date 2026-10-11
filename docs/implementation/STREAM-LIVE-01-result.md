# STREAM-LIVE-01 — result (handoff)

Implemented manually on Claude Opus 5.5 in `.worktrees/stream-live-01`, branch
`claude/stream-live-01`, from master `626ca14`. **Not merged, not migrated on DEV, not deployed.**

## What was built

- **Contracts / T00 / migration** (operator-approved step 1): T00 section STREAM-LIVE-01, additive
  wire types, `0016_live_messages.sql` (`app.live_messages`, `app.access_keys`), OCT plan
  renumbered (STREAM-01/02 → 0017/0018).
- **API** `apps/api/src/live/`: `POST /live/messages`, `GET /live/messages/mine` (session; Origin +
  CSRF on POST; idempotent on operationId via `app.operations`); `GET /live/feed`,
  `POST /live/status` (`live_feed` key only; refused with cookie/Origin; transition table);
  per-user and per-key rate limits; registered in `app.ts`.
- **Operator command** `runtime/access-key-cli.ts`: `create "<label>" | list | revoke <id>`; secret
  printed once, SHA-256 digest stored.
- **Grants** `deploy/vps/postgres/grants.sql` and startup refusal rules `runtime/privileges.ts`:
  API select/insert/update on live messages, select + `update(last_used_at)` on keys; worker none.
- **Web** `screens/LiveScreen.tsx` + `.module.css` to the approved `design/live-delta-spec.md`:
  `Na żywo` header link after `Plan`; direct URL `/na-zywo`; signal block for SZRON only
  ("Sygnał dla Kuby"); quote/source/send; `WYSŁANE`; 5 s refresh while visible; fluid one/two
  columns (760 px breakpoint).

## Files outside the proposal's list (small, necessary)

`apps/web/src/controllers/useAppController.ts` (route `live`, `/na-zywo`), `ui/screen-contracts.ts`
(`onOpenLive`), `screens/ReelListScreen.tsx` + `.module.css` (header link), `data/api.ts` (two
methods), `apps/api/src/runtime/privileges.ts`, `runtime.test.ts` (fixture lists the new tables),
`core.test.ts` (table list).

## Verification

| Command (from the worktree) | Result |
| --- | --- |
| `npm ci`; build contracts + source-fetch | OK |
| `cd apps/api && npx tsc -p tsconfig.json && node --test dist/live.test.js` | 8/8 pass |
| `cd apps/api && npm test` (web built) | 270 tests, 265 pass, 5 fail |
| same suite on untouched master `626ca14` (web not built) | 261 tests, 249 pass, 12 fail |
| `cd apps/web && npm run typecheck && npm run build` | OK |
| `npm run test:t08`, `test:share`, `test:list-01` | 67/67, 21/21, 23/23 |

The 5 remaining API failures are pre-existing on master and unrelated (vps-integration migration
list stops at 0008; compose secret mounts; runbook `AI_ENABLED`; kDrive config; storage body
test). The 7 other master failures need a built web app and pass once it is built.
New tests: `live.test.ts` (validation per kind, idempotency + CSRF/Origin, own-message isolation,
feed cursor / start-at-now / read-only, key only on device routes and refused with cookie/Origin,
revocation, transition table, rate limits, operator command) and a `deploy-grants.test.ts` case
that acts *as* `szronox_api` / `szronox_worker` (can write live messages and stamp keys; cannot
delete messages, insert keys or un-revoke).

Visual: the screen was rendered with fixture data in headless Chrome at 320×568, 360×600,
480×640, 400×600 (NOXAVA), 780×560 and 1200×800; one horizontal-overflow defect in `WYSŁANE`
was found and fixed (explicit `minmax(0, 1fr)` grid columns). The temporary preview harness was
removed.

## UNVERIFIED / open real-world gates

- DEV migration 0016, `grants.sql` rerun, deployment; creating the real key with the CLI on DEV.
- Real use on Szron's computer/phone against DEV; the full app shell around the screen (only the
  screen itself was rendered).
- StreamControl reading DEV (its poller is not written yet).
- Concurrency on real PostgreSQL (PGlite serialises).

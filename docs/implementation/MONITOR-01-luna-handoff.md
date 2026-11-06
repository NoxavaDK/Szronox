# Luna dispatch — MONITOR-01 (Facebook/X monitoring in SzroNox)

Status: **OPERATOR-APPROVED 2026-11-06 — dispatched from the root pin on branch
`claude/project-thread-5g65na`** (commit `ad229b2` or later on that branch). Steps 1 (contracts,
migration) and 2 (visual delta) are approved by the operator.

| | |
| --- | --- |
| Model | `gpt-6-luna`, high reasoning |
| Suitability | new device scope, API module, worker job, one screen, and porting an existing Python collector |
| Difficulty | medium–high |
| Worktree / branch | `.worktrees/monitor-01`, branch `luna/monitor-01` |
| Base | `origin/claude/project-thread-5g65na` |

Luna does not merge, deploy, run migrations on DEV, mint real keys, log in to Facebook/X, call
Gemini live, send messages or spawn agents.

## Read first

1. `AGENTS.md`
2. `docs/implementation/T00-contracts.md` — section **MONITOR-01** (authoritative), plus
   STREAM-LIVE-01 (device keys) and CAPTURE-DRAFT-01 (what happens on Reel creation).
3. `docs/implementation/MONITOR-01-proposal.md`
4. `design/monitor-delta-spec.md` (the whole screen; no UI beyond it) and
   `design/frozen-visual-spec.md` §1
5. `database/migrations/0021_monitor.sql` and the MONITOR-01 block at the end of
   `packages/contracts/src/index.ts`
6. The standalone prototype on the operator's PC: `C:\Users\sille\Desktop\StreamOverlay\filmiki-monitor`
   (parsers, login flow, tests) and the review of it:
   https://claude.ai/artifact/MJBum61feHpNFfrZqUaN6K

The pinned files (T00 section, migration 0021, contract types, delta spec) are **read-only**. If
something in them is wrong or missing, stop and report it instead of changing it.

## Work packages

### A. Database access

- `deploy/vps/postgres/grants.sql`: grants exactly as T00 MONITOR-01 **Grants** (API select/insert/
  update on the four tables, no delete; worker select on sources and posts, column-limited update
  on reports, nothing on runs).
- `apps/api/src/runtime/privileges.ts`: watch the four tables; refuse the API if it can delete them,
  refuse the worker if it can write sources/posts/runs or insert/delete reports.
- `apps/api/src/deploy-grants.test.ts`: role-exercised test in the STREAM-LIVE-01 style.

### B. Device scope

- `apps/api/src/live/keys.ts`: `AccessKeyScope = 'live_feed' | 'monitor_collect'`;
  `authenticateDevice(..., scope)` must refuse a key of the other scope with the generic 401.
- `apps/api/src/runtime/access-key-cli.ts` and `live/key-admin.ts`: `create "<label>" [--scope
  monitor_collect]`, default `live_feed` (existing usage unchanged).

### C. API module `apps/api/src/monitor/`

- `canonical-url.ts`: the T00 canonicalisation rules, pure function, table-driven tests (Facebook
  `__cft__`/`__tn__` removal, `m.`/`web.` hosts, `permalink.php?story_fbid&id`, `comment_id`
  rejection; X `twitter.com`/`mobile.` hosts, `/photo/1` and `/analytics` suffixes, non-status
  rejection).
- `repository.ts`: sources CRUD (version-checked, idempotent via `app.operations`), post upsert
  with the T00 hash/engagement rules, runs, report queueing, report read (including per-source
  status for the day), post listing with the day number (order of first sighting within the
  Europe/Warsaw day).
- `routes.ts`: the 11 routes in T00 with their auth (session + Origin + CSRF for browser writes,
  `monitor_collect` key for `/monitor/collect/*`, cookie/Origin refused there).
- `Zrób rolkę`: reuse the existing `createReel` path in `core/repository.ts` inside one
  transaction that also sets `monitor_posts.reel_id`; do not duplicate capture logic.
- `apps/api/src/app.ts`: one registration line. Tests in `apps/api/src/monitor.test.ts`.

### D. Worker job

- `apps/worker/src/ai/monitor.ts`: claim/lease/retry on `app.monitor_reports` exactly like
  `jobs.ts` does for `ai_runs` (SKIP LOCKED, lease token fencing, max 5 attempts, expiry).
- Prompt `monitor-provisional-v1` (stage `development_provisional`), Polish output, original-language
  quotes, posts marked as third-party material. Batches ≤ 35 non-repost posts, then one merge.
- Structured JSON through the existing `provider.ts`; schema in **standard lowercase JSON Schema**
  (`"object"`, `"array"`, `"string"`).
- Post-filter: drop URLs not in the day's input; keep a quote only if it occurs in its post text
  after whitespace collapse. Store `MonitorSynthesis`; on failure keep the previous `result`.
- Register in `jobs.ts` / `index.ts` with one line each. Fixture tests for the filter, retry and
  lease expiry; no live Gemini call.

### E. Web

- `apps/web/src/screens/MonitorScreen.tsx` + `.module.css` (Raport, Posty, Źródła exactly per
  `design/monitor-delta-spec.md`), `apps/web/src/data/monitor.ts`, the `Monitoring` header link in
  `ReelListScreen.tsx` and one navigation entry in `App.tsx`. Polish copy exactly as specified.

### F. Collector `tools/monitor-collector/`

Port the prototype (Python 3.13, Playwright) and change it as follows:

- **No SQLite.** Config in a Git-ignored `.env`: `SZRONOX_URL`, `SZRONOX_MONITOR_KEY`, `MAX_SCROLLS`,
  delays. Flow: `POST /monitor/collect/runs` → `GET /monitor/collect/sources` → per source collect →
  `POST /monitor/collect/posts` (≤ 100 per call) → `POST …/runs/:id/finish` with per-source status.
  Unsent batches go to a local `outbox/` JSON file and are retried first on the next run.
- **Browser:** real installed Chrome via `channel="chrome"` (fallback `msedge`), always visible,
  `launch_persistent_context` with `no_viewport=True` and `ignore_default_args=["--enable-automation"]`,
  no user-agent override; optional `BROWSER_ENGINE=patchright`. Same profile dir for `login` and runs.
- **Review fixes:** canonical URLs (same rules as the API); ignore pinned posts and reposts when
  deciding where to stop and stop after 3 known posts in a row (known = in `knownUrls`); flag
  `isPinned`/`isRepost`; max post age (default 48 h) where a date is known; Facebook timestamps
  from the post's time link (Polish and English relative dates); skip nested comment articles;
  expand `Zobacz więcej` / `See more`; Polish login-wall strings; wait for the first post (15 s)
  instead of fixed delays; scroll one viewport at a time.
- CLI: `python -m monitor_collector login facebook|x`, `run`. README with Task Scheduler setup
  (Run only when user is logged on, logon trigger with 5 min delay + daily 07:00).
- Parser tests with saved HTML fixtures, including a pinned post, a repost and a comment.

## Editable files

Exactly the files named in A–F, plus `docs/implementation/MONITOR-01-result.md` (new) and the
MONITOR-01 status row in `docs/implementation/tasks.md`. Nothing else; in particular not the
pinned T00 section, migration 0021, the contract types or the delta spec.

## Acceptance

T00 MONITOR-01 **Acceptance**, plus:

- `npm run typecheck` and `npm run build` pass; the API suite shows no new failures compared with
  the base (the base currently has 5 known CI failures, e.g. `vps-integration.test.ts` expecting
  migrations up to 0008: list them, don't fix them here).
- `python -m pytest` passes in `tools/monitor-collector/`.
- A local end-to-end check against PGlite or a local API with a test key: collector posts a fixture
  batch, finish queues the report, the worker (with a stubbed provider) writes a synthesis, and the
  screen renders it.

## Handoff

`MONITOR-01-result.md` with owned files, exact commands and results, known limitations, and the
**UNVERIFIED real-world gates**: DEV migration and grants, minting the `monitor_collect` key, the
spare-account logins, the first live collector run against DEV, and a live Gemini report. Commit ID.
No merge.

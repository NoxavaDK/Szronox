# Proposal: social monitoring ("filmiki-monitor") inside SzroNox

Status: **proposal for operator approval, 5 November 2026.** Nothing in SzroNox has been changed.
`AGENTS.md` applies: the root pins the T00 amendment, contracts and migration first, and every
step marked below stops for the operator.

## Goal

Kuba wants the daily Facebook + X monitor of Polish right-wing parties (built standalone by Luna
in `filmiki-monitor` on the streaming PC, reviewed 2026-11-05) to live in SzroNox, so that:

1. The monitored profiles are set up in SzroNox, by either user.
2. Collected posts and the daily Gemini synthesis are stored in the SzroNox PostgreSQL database,
   not a local SQLite file.
3. Szron sees the same posts and reports in the app and can turn a post into a Reel.

The platform choice (Facebook and X through a logged-in spare account) is the operator's decision
and is not reopened here.

## Shape: collector on the PC, everything else in SzroNox

Collection must stay on Kuba's Windows PC. It needs a real, visible, logged-in Chrome profile on
a residential connection; the VPS has no display, and a datacentre IP is the fastest way to get
the spare accounts checkpointed. So the split mirrors STREAM-LIVE-01:

| Part | Runs on | Owns |
| --- | --- | --- |
| Collector (Python + Playwright, real Chrome) | Kuba's PC, Task Scheduler | Browser profile and login only. No database. |
| Sources, posts, run log, reports | SzroNox API + PostgreSQL | All data |
| Daily synthesis (Gemini, structured JSON) | SzroNox worker | Uses the existing provider setup and `GEMINI_MODEL` |
| "Monitoring" screen (Polish UI) | SzroNox web | Both users: sources, posts, report, "Zrób rolkę" |

The PC makes only outbound HTTPS calls with a narrowly scoped device key, as StreamControl does.

## Proposed data model (migration `0021_monitor.sql`, additive)

- `app.monitor_sources` — `id uuid`, `name`, `group_label` (e.g. Konfederacja, KKP/Braun),
  `platform` check in (`facebook`, `x`), `profile_url` unique, `active bool`, `created_by` fk users,
  `created_at`, `updated_at`, `last_collected_at`, `last_status` check in
  (`ok`, `login_wall`, `parse_failure`, `error`), `last_status_at`.
- `app.monitor_posts` — `id uuid`, `seq` identity (cursor), `source_id` fk, `platform`,
  `url` unique (canonical, tracking parameters stripped by the collector and re-checked by the
  API), `author`, `published_at` nullable, `text`, `media jsonb`, `engagement jsonb`,
  `is_repost bool`, `is_pinned bool`, `content_hash`, `first_seen_at`, `last_seen_at`.
- `app.monitor_runs` — one row per collector run: `started_at`, `finished_at`, per-source results
  (`jsonb`: source id, status, posts seen, posts new).
- `app.monitor_reports` — one per local date: `report_date` unique, `status` check in
  (`queued`, `running`, `done`, `failed`), `synthesis jsonb`, `model`, `prompt_id`,
  `post_count`, `error`, timestamps.
- `app.access_keys.scope` check extended with `monitor_collect` (an explicit amendment, as the
  STREAM-LIVE-01 table comment requires).

Grants: API role gets DML on the four tables; worker gets select on posts/sources and
update on reports only.

## Proposed API

Device (`monitor_collect` key only, rejected everywhere else):

- `GET /api/v1/monitor/collect/sources?limit=` — today's rotating window of active sources, with
  each source's last known post URLs so the collector knows where to stop.
- `POST /api/v1/monitor/collect/posts` — up to 100 posts per call, idempotent upsert on `url`.
- `POST /api/v1/monitor/collect/runs` — run start/finish with per-source status. Finishing a run
  queues that day's report.

Browser (session + exact Origin + CSRF, both users):

- Sources: list, add, edit, deactivate. No hard delete, so old posts keep their source.
- Posts: cursor list filtered by date, group and platform.
- Reports: get by date; "Wygeneruj ponownie" re-queues one.
- `POST /api/v1/monitor/posts/:id/capture` — creates a Reel through the existing capture path
  (post URL + text as the captured source). Never automatic.

## Synthesis rules (worker)

- Batches of ≤ 35 posts, then one merge call; strict JSON via the existing Gemini provider.
- Output sections: main topics, repeated messaging, differences between groups, fact / opinion /
  mixed per post, notable quotes, video topic ideas.
- Every cited URL must exist in `monitor_posts`; every quote must appear verbatim (whitespace
  normalised) in its post's text, in the original Polish. Anything else is dropped.
- The prompt is labelled provisional (`monitor-provisional-v1`); it is not a frozen editorial prompt.
- The report also lists collection status per source, so login walls are visible in the app.

## Collector changes (from the 2026-11-05 review)

The existing `filmiki-monitor` code is reused, moved to `tools/monitor-collector/` in this repo,
with:

- SQLite removed; a small local outbox file only for posts that could not be sent.
- Real installed Chrome (`channel="chrome"`, fallback `msedge`), always visible, no
  `--enable-automation`, no viewport/user-agent override; optional patchright switch.
- Facebook URL canonicalisation, pinned/repost handling, stop after 3 known posts in a row,
  max post age, Facebook timestamps, nested comments skipped, "Zobacz więcej" expanded, Polish
  login-wall strings.
- Config in a Git-ignored `.env`: SzroNox URL and the device key.

## Out of scope

Instagram, TikTok, YouTube, Telegram; Whisper transcripts; alerts or notifications; analytics or
charts; automatic Reel creation; any change to existing Reel, stream or live-message behaviour.

---

## Task proposal for approval (format required by `AGENTS.md`)

**Task ID:** MONITOR-01.

**Exact task:** social monitoring in SzroNox: migration 0021, `monitor_collect` device key scope,
device and browser routes above, worker synthesis job, a "Monitoring" screen for both users, and
the PC collector moved into `tools/monitor-collector/` and pointed at the SzroNox API.

**Exact model:** root (Claude) pins contracts, T00 amendment, migration and visual delta; Luna
(`gpt-6-luna`, high) implements in its own worktree.

**Suitability / difficulty:** medium-high. A second device scope, a new worker job and a new
screen; the collector already exists and its fixes are known.

**Order of work:**
1. Root pins the T00 amendment (device scope `monitor_collect`, monitor tables and routes), contract
   types and migration number. **Operator approves.**
2. Visual delta `design/monitor-delta-spec.md` for the Monitoring screen (Polish copy, list,
   report and source form, following the frozen visual language). **Operator approves.**
3. Luna implements in `.worktrees/monitor-01`, branch `luna/monitor-01`.
4. Handoff with commands, results, limitations, UNVERIFIED gates and commit ID. **No merge, DEV
   migration or deployment** without separate approval.

**Dependencies:** STREAM-LIVE-01 access keys (merged). No dependency on open branches.

**Editable files:**
- `docs/implementation/T00-contracts.md` (new section), `tasks.md` (status row),
  `MONITOR-01-proposal.md`, `MONITOR-01-result.md`
- `design/monitor-delta-spec.md` (new)
- `packages/contracts/src/index.ts` (additive types only)
- `database/migrations/0021_monitor.sql`
- `deploy/vps/postgres/grants.sql`, `apps/api/src/deploy-grants.test.ts`
- `apps/api/src/live/keys.ts` (scope type only)
- `apps/api/src/monitor/` (new), `apps/api/src/monitor.test.ts`, `apps/api/src/app.ts` (one line)
- `apps/worker/src/ai/monitor.ts` (new) + test, `apps/worker/src/ai/jobs.ts` (one registration)
- `apps/web/src/screens/MonitorScreen.tsx` + `.module.css`, `apps/web/src/data/monitor.ts`,
  `apps/web/src/app/App.tsx` (one navigation entry)
- `tools/monitor-collector/` (new)

**Acceptance criteria:**
- Both users can add, edit and deactivate sources and read posts and reports.
- The device key works only on the three collect routes and cannot read Reels or other data.
- Re-sending the same post never creates a duplicate; a Facebook URL with tracking parameters
  maps to the same row.
- The worker report drops unknown URLs and non-verbatim quotes (tests with fixtures).
- "Zrób rolkę" creates one Reel through the existing capture path, only on click.
- Migration additive; grants test updated; API tests, contracts build and web typecheck pass;
  collector parser tests pass.
- **OPEN REAL-WORLD GATES:** DEV migration and deployment, live Gemini report, first collector
  run against DEV with the spare accounts.

## Open questions for the operator

1. Can Szron add and edit sources, or only see them? (Proposed: both users edit.)
2. Report language: Polish (proposed) or English?
3. Keep the standalone `filmiki-monitor` running until MONITOR-01 is deployed? (Proposed: yes,
   after the review fixes, so collection can start now.)

## Operator approval — 2026-11-05

Approved by the operator as proposed: both users add and edit sources; reports in Polish; Luna
implements after the root pins contracts and the visual delta. Steps 1 and 2 still stop for the
operator's review. No merge, DEV migration or deployment is authorized.

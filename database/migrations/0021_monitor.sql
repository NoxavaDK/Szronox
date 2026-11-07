-- MONITOR-01: daily monitoring of public Facebook and X profiles, stored in SzroNox.
--
-- Filename note: 0019 and 0020 are taken by the open Streamy branch (stream_plans), so this is 0021.
--
-- A collector on the streaming PC (a logged-in, visible Chrome) visits the profiles listed here
-- and sends what it sees through a `monitor_collect` access key. The worker writes one Gemini
-- synthesis per Europe/Warsaw day. Both users manage sources, read posts and reports, and may
-- turn a post into a Reel explicitly. Nothing here touches existing Reel, stream or live rules.
--
-- Roles and grants live in deploy/vps/postgres/grants.sql, as for every table.

-- ── Access key scope ─────────────────────────────────────────────────────────────
-- STREAM-LIVE-01 made the scope set a CHECK so that a new scope is a deliberate amendment.
-- This is that amendment: `monitor_collect` may only use the three /monitor/collect routes.
alter table app.access_keys drop constraint if exists access_keys_scope_check;
alter table app.access_keys
  add constraint access_keys_scope_check check (scope in ('live_feed', 'monitor_collect'));

-- ── Sources ──────────────────────────────────────────────────────────────────────
-- Never hard-deleted: deactivating keeps old posts attached to their source.
create table if not exists app.monitor_sources (
  id               uuid primary key,
  name             text not null check (char_length(btrim(name)) between 1 and 120 and char_length(name) <= 120),
  group_label      text not null check (char_length(btrim(group_label)) between 1 and 80 and char_length(group_label) <= 80),
  platform         text not null check (platform in ('facebook', 'x')),
  profile_url      text not null unique check (profile_url ~ '^https://' and char_length(profile_url) <= 2048),
  active           boolean not null default true,
  version          integer not null default 1 check (version >= 1),
  created_by       uuid not null references app.users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_collected_at timestamptz,
  last_status      text check (last_status in ('ok', 'login_wall', 'parse_failure', 'error')),
  last_status_at   timestamptz,
  constraint monitor_sources_status_time check ((last_status is null) = (last_status_at is null))
);

create index if not exists monitor_sources_due_idx
  on app.monitor_sources (last_collected_at nulls first, created_at) where active;

-- ── Posts ────────────────────────────────────────────────────────────────────────
-- `url` is the canonical post URL (tracking parameters removed; rules in T00 MONITOR-01).
-- `seq` only orders listings. `first_seen_at` decides which day's report a post belongs to.
-- `reel_id` is set once, by the explicit "Zrób rolkę" action, never automatically.
create table if not exists app.monitor_posts (
  id             uuid primary key,
  seq            bigint generated always as identity unique,
  source_id      uuid not null references app.monitor_sources (id),
  url            text not null unique check (url ~ '^https://' and char_length(url) <= 2048),
  author         text not null default '' check (char_length(author) <= 300),
  published_at   timestamptz,
  text           text not null default '' check (char_length(text) <= 20000),
  media          jsonb not null default '[]'::jsonb check (jsonb_typeof(media) = 'array'),
  engagement     jsonb not null default '{}'::jsonb check (jsonb_typeof(engagement) = 'object'),
  is_repost      boolean not null default false,
  is_pinned      boolean not null default false,
  content_hash   text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  content_changed_at timestamptz,
  reel_id        uuid unique references app.reels (id)
);

create index if not exists monitor_posts_first_seen_idx on app.monitor_posts (first_seen_at desc, seq desc);
create index if not exists monitor_posts_source_idx on app.monitor_posts (source_id, seq desc);

-- ── Collector runs ───────────────────────────────────────────────────────────────
-- One row per collector run, id chosen by the collector so retries are idempotent.
-- `results` is a list of {sourceId, status, seen, new}, validated by the API.
create table if not exists app.monitor_runs (
  id             uuid primary key,
  access_key_id  uuid not null references app.access_keys (id),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  results        jsonb not null default '[]'::jsonb check (jsonb_typeof(results) = 'array'),
  constraint monitor_runs_results_when_finished check (finished_at is not null or results = '[]'::jsonb)
);

-- ── Daily reports ────────────────────────────────────────────────────────────────
-- One row per Europe/Warsaw date, leased by the worker exactly like app.ai_runs.
-- Regenerating re-queues the same row; the previous result is replaced only on success.
create table if not exists app.monitor_reports (
  id               uuid primary key,
  report_date      date not null unique,
  state            text not null default 'queued' check (state in ('queued', 'running', 'succeeded', 'failed')),
  requested_by     uuid references app.users (id),
  model            text not null,
  prompt_id        text not null,
  attempt_count    integer not null default 0 check (attempt_count between 0 and 5),
  lease_token      uuid,
  lease_expires_at timestamptz,
  next_attempt_at  timestamptz not null default now(),
  post_count       integer not null default 0 check (post_count >= 0),
  result           jsonb,
  error            jsonb,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz,
  constraint monitor_reports_lease_consistent check (
    (state = 'running' and lease_token is not null and lease_expires_at is not null)
    or (state <> 'running' and lease_token is null and lease_expires_at is null)
  ),
  constraint monitor_reports_error_consistent check (state <> 'failed' or error is not null)
);

create index if not exists monitor_reports_claim_idx
  on app.monitor_reports (next_attempt_at, created_at, id)
  where state in ('queued', 'running');

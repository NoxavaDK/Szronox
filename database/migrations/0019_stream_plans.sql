-- STREAM-PLAN-01: a stream screen set up per broadcast, separate from Reels.
--
-- Operator request (2026-10-15): preparing a broadcast should not create a new item in the Reel
-- list. A stream plan is its own record: a title and date, up to eight topics picked from recent
-- Reels (or typed by hand), each with a main link, extra links and the points to go through, the
-- Social Stream Ninja session whose comments either user can highlight, and a flag marking the
-- plan the streaming PC (StreamControl) imports.
--
-- STREAM-01's stream Reels (format 'stream', stream_topics) are untouched by this migration.
--
-- Topics are one JSON document edited as a whole: the screen autosaves the plan with
-- `expectedVersion`, like a Reel's fields. The API validates each topic's shape and limits; the
-- database pins the parts that must hold whatever the application does. A topic's `reelId` is a
-- reference read live (status, deletion); it is never a copy and never changes that Reel.
--
-- Roles and grants live in deploy/vps/postgres/grants.sql, as for every table.

create table if not exists app.stream_plans (
  id                uuid primary key,
  title             text not null check (char_length(btrim(title)) between 1 and 120 and char_length(title) <= 120),
  scheduled_for     date null,
  -- Social Stream Ninja session ID: the screen embeds that session's dock, where a click
  -- highlights a comment on the broadcast.
  comments_session  text null check (comments_session ~ '^[A-Za-z0-9_-]{1,64}$'),
  topics            jsonb not null default '[]'::jsonb
                    check (jsonb_typeof(topics) = 'array' and jsonb_array_length(topics) <= 8),
  -- The plan StreamControl reads through the live_feed key. At most one at a time.
  is_current        boolean not null default false,
  version           integer not null default 1 check (version >= 1),
  created_by        uuid not null references app.users (id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz null,
  constraint stream_plans_deleted_not_current check (deleted_at is null or not is_current)
);

create unique index if not exists stream_plans_one_current
  on app.stream_plans ((true)) where is_current;

create index if not exists stream_plans_active_idx
  on app.stream_plans (scheduled_for desc nulls last, created_at desc) where deleted_at is null;

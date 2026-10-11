-- STREAM-01: a stream is a Reel with format 'stream' plus an ordered list of topics.
--
-- Planning, the five statuses, editor, verification, kDrive folder, export, feed cover,
-- publication fields and soft delete all apply to a stream unchanged. What is new:
--   * reels.format         'reel' (default, every existing row) or 'stream'; fixed at creation.
--   * reels.absorbed_into  set on an idea moved into a stream. Such a Reel is hidden from lists,
--                          the planner and search. It is not deleted and this is not a status.
--   * stream_topics        one row per topic, ordered by position.
--
-- Topic kinds:
--   absorbed  the idea's editable copy of title / notes / script lives on the topic row; the
--             capture and source metadata are read through the idea. Odłącz writes the copy back
--             to the idea, clears absorbed_into and removes the row.
--   linked    a reference to an independent Reel, shown live and never edited from the stream.
--             The row carries no copy of its own (title / notes / script stay '').
--
-- Rules the database enforces; the API enforces the rest (see T00 STREAM-01):
--   a stream is never absorbed and never a topic, a Reel appears at most once per stream,
--   an absorbed idea belongs to exactly one stream, positions are unique per stream.

alter table app.reels
  add column format text not null default 'reel'
    check (format in ('reel', 'stream')),
  add column absorbed_into uuid null references app.reels(id),
  add constraint reels_stream_never_absorbed
    check (format = 'reel' or absorbed_into is null),
  add constraint reels_not_absorbed_into_self
    check (absorbed_into is null or absorbed_into <> id);

create index if not exists reels_absorbed_into_idx
  on app.reels (absorbed_into) where absorbed_into is not null;

create table if not exists app.stream_topics (
  id              uuid primary key,
  stream_id       uuid not null references app.reels(id),
  position        integer not null check (position >= 0),
  kind            text not null check (kind in ('absorbed', 'linked')),
  source_reel_id  uuid not null references app.reels(id),
  title           text not null default '',
  notes           text not null default '',
  script          text not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint stream_topics_not_self check (stream_id <> source_reel_id),
  constraint stream_topics_once_per_stream unique (stream_id, source_reel_id),
  -- Reordering rewrites several positions in one transaction.
  constraint stream_topics_position_unique unique (stream_id, position) deferrable initially deferred,
  constraint stream_topics_linked_has_no_copy
    check (kind = 'absorbed' or (title = '' and notes = '' and script = ''))
);

-- An absorbed idea belongs to exactly one stream.
create unique index if not exists stream_topics_absorbed_once
  on app.stream_topics (source_reel_id) where kind = 'absorbed';

create index if not exists stream_topics_source_reel_idx
  on app.stream_topics (source_reel_id);

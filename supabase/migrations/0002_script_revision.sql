-- Script-only change counter.
--
-- The pinned contract adds `Reel.scriptRevision`: "Monotonic script-only change
-- counter; unrelated metadata edits do not increment it." A separate column is
-- required because `version` bumps on every accepted mutation, so it cannot answer
-- "has the script itself changed since this AI run read it?".
--
-- Existing rows start at 0. A backfill cannot invent past script edits, and
-- claiming one would make an AI run look stale or fresh on invented evidence.

alter table app.reels
  add column if not exists script_revision integer not null default 0
    check (script_revision >= 0);

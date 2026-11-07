-- STREAM-PLAN-02: switch topics from the stream screen, and see which topic is on air.
--
-- Operator request (2026-10-17): the streaming PC is not the only place topics should be switched;
-- anyone with the plan open (Szron included) should be able to put a topic on air.
--
-- A switch is a cue, not an edit: it never touches `topics` or `version`, so it cannot collide with
-- the screen's autosave. `cue_seq` only grows; StreamControl applies each new sequence number once
-- (it remembers the last one it saw per imported plan) and ignores cues older than its import.
--
-- StreamControl reports what it shows through the live_feed key: the topic on air, the topic ids it
-- holds from its last import (so the screen can tell a topic added after the import), and when it
-- last reported. Topic ids are the plan's own topic ids, never Reel ids.

alter table app.stream_plans
  add column if not exists cue_seq          integer not null default 0 check (cue_seq >= 0),
  add column if not exists cue_topic_id     text null check (cue_topic_id is null or char_length(cue_topic_id) <= 64),
  add column if not exists cued_at          timestamptz null,
  add column if not exists on_air_topic_id  text null check (on_air_topic_id is null or char_length(on_air_topic_id) <= 64),
  add column if not exists pc_topic_ids     jsonb not null default '[]'::jsonb
                                            check (jsonb_typeof(pc_topic_ids) = 'array' and jsonb_array_length(pc_topic_ids) <= 8),
  add column if not exists pc_seen_at       timestamptz null;

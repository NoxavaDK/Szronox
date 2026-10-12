-- CAPTURE-DRAFT-01: an automatic Opracuj (develop) run queued by capture.
--
-- `trigger` tells a run the capturer asked for ('user') from one capture queued for them
-- ('capture'). It feeds Reel.autoDraft and the daily auto-draft limit; it changes nothing about
-- how the run executes or how its results are applied.
--
-- Filename note: OCT-2026-plan.md reserved 0018 for STREAM-02 (outline only, not dispatched).
-- The operator approved CAPTURE-DRAFT-01 on 2026-10-11; STREAM-02 moves to the next free number.

alter table app.ai_runs
  add column trigger text not null default 'user'
    check (trigger in ('user', 'capture'));

-- One capture draft per Reel, at most.
create unique index if not exists ai_runs_one_capture_draft
  on app.ai_runs (reel_id) where trigger = 'capture';

-- The daily limit counts capture drafts by creation time.
create index if not exists ai_runs_capture_created_idx
  on app.ai_runs (created_at) where trigger = 'capture';

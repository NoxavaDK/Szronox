-- CONTENT-PLANNER-01: one current publication plan per Reel.
--
-- The plan is two nullable columns on the Reel itself, never a separate planner/event row,
-- so one Reel has exactly one plan and every surface (planner, list quick action, Reel
-- Detail) reads and writes the same state through the ordinary version-checked PATCH.
--
-- The date is the plan; the time is optional detail and cannot exist without a date.
-- Neither column is tied to status: scheduling never moves a Reel through the workflow.
--
-- Additive only: existing Reels stay unplanned (null), and the previous release selects
-- explicit column lists, so it neither reads nor writes these columns.
alter table app.reels
  add column planned_publication_date date null default null,
  add column planned_publication_time time(0) without time zone null default null;

alter table app.reels
  add constraint reels_planned_time_needs_date
    check (planned_publication_time is null or planned_publication_date is not null);

create index reels_planned_publication_date_idx
  on app.reels (planned_publication_date)
  where planned_publication_date is not null and deleted_at is null;

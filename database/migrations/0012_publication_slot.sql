-- CONTENT-PLANNER-01 correction: a Reel is published in one of exactly three day slots
-- (morning, afternoon, evening), never at a free clock time.
--
-- The slot is optional detail of the planned date, exactly as the time was: a slot without a
-- date is refused. Any time recorded under 0011 is converted to its slot (before 12:00 →
-- morning, before 17:00 → afternoon, otherwise evening) and then cleared.
--
-- `planned_publication_time` is left in place, unused and null, so the previous release
-- (which selects it by name) keeps running if the code is rolled back. Additive otherwise.
alter table app.reels
  add column planned_publication_slot text null default null;

alter table app.reels
  add constraint reels_planned_slot_check
    check (planned_publication_slot is null or planned_publication_slot in ('morning', 'afternoon', 'evening')),
  add constraint reels_planned_slot_needs_date
    check (planned_publication_slot is null or planned_publication_date is not null);

update app.reels
   set planned_publication_slot = case
         when planned_publication_time < time '12:00' then 'morning'
         when planned_publication_time < time '17:00' then 'afternoon'
         else 'evening'
       end,
       planned_publication_time = null
 where planned_publication_time is not null;

-- Clearing the date always clears the slot, for every writer. The API already does this; the
-- trigger also covers the previous release (which knows only the date/time pair), so a code
-- rollback can still unschedule a Reel that has a slot instead of hitting the check above.
create or replace function app.reels_clear_slot_without_date() returns trigger
  language plpgsql as $$
begin
  if new.planned_publication_date is null then
    new.planned_publication_slot := null;
  end if;
  return new;
end;
$$;

create trigger reels_clear_slot_without_date
  before insert or update of planned_publication_date, planned_publication_slot on app.reels
  for each row execute function app.reels_clear_slot_without_date();

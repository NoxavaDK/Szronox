-- HOOKS-SELECT-EDIT: one optional, explicitly chosen hook per Reel.
--
-- The shortlist stays in app.reel_hooks; the Reel stores only the chosen row's ID, never a
-- copy of its text. Historical Reels, including Reels that already have hooks, stay null:
-- nothing here backfills or infers a choice.
--
-- Same-Reel integrity is a property of the schema rather than of application sequencing.
-- The composite foreign key (id, selected_hook_id) -> reel_hooks (reel_id, id) cannot be
-- satisfied by another Reel's hook, a deleted hook or an invented ID. ON DELETE SET NULL
-- names only selected_hook_id, so deleting the selected hook clears the choice in the same
-- statement (and therefore the same versioned transaction) without guessing a replacement,
-- while never touching the Reel's own id. MATCH SIMPLE leaves a null selection unchecked.
--
-- Additive only: the previous release neither reads nor writes the column, and its hook
-- deletes keep working because the database clears the reference itself.
alter table app.reel_hooks
  add constraint reel_hooks_reel_id_id_key unique (reel_id, id);

alter table app.reels
  add column selected_hook_id uuid null default null;

alter table app.reels
  add constraint reels_selected_hook_fk
    foreign key (id, selected_hook_id) references app.reel_hooks (reel_id, id)
    on delete set null (selected_hook_id);

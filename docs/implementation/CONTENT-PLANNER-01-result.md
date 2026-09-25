# CONTENT-PLANNER-01 implementation result

User-authorized bounded task (2026-09-25): a deliberately simple Content Planner over existing Reels. Contract amendment recorded at the end of `T00-contracts.md`.

## Data model

- `database/migrations/0011_planned_publication.sql` (additive): `app.reels.planned_publication_date date null`, `planned_publication_time time(0) null`, check `reels_planned_time_needs_date`, partial index on the date. No backfill; every existing Reel is unplanned. The previous release selects explicit columns and is unaffected. No grant change (API role already has table UPDATE; worker writes nothing here).
- Wire: `Reel.plannedPublicationDate: 'YYYY-MM-DD' | null`, `plannedPublicationTime: 'HH:MM' | null`, both in the ordinary version-checked PATCH allowlist. Selected as text (`to_char`) so no driver date parsing can shift the day. Clearing the date alone clears the time; a time without a date, impossible dates and malformed times are 422. A plan change never touches status or `scriptRevision`.
- One Reel → one plan. No planner/event table.

## UI

- `data/planner.ts`: pure derivation (Monday week start, local days, DZIŚ/JUTRO labels, grouping, `Po terminie`, NIEZAPLANOWANE = not deleted, unplanned, status `to_record|editing|ready`).
- `screens/PlannerPane.tsx`: week agenda (current week starts today; ‹ › week switch + `Dziś`), compact cards (title, time, status, feed-cover indicator for editing/ready/published), card tap opens the Reel, calendar button opens `Zaplanuj`. Desktop drag-and-drop between days / to NIEZAPLANOWANE as a shortcut only.
- `screens/ScheduleSheet.tsx`: shared `Zaplanuj publikację` sheet: 7 day shortcuts, `Inny dzień`, optional `Godzina`, `Usuń z planu`, `Anuluj`, `Gotowe`.
- Reel Detail: one quiet row under the selectors: `Zaplanuj publikację` / `Publikacja: Jutro, 18:00`.
- List: `Zaplanuj` in the long-press/Więcej sheet; plan label in row metadata; `Plan` entry beside the `Rolki` title on mobile.
- Layout (`ui/workspace-layout.ts`, thresholds derived from the 480px content width and 320/360px reference widths): ≥1280px PLAN | CURRENT REEL | REELS; ≥960px PLAN | centre (REELS folds into the centre when no Reel is open); below that the unchanged mobile one-view app plus the PLAN view.
- Controller: every surface calls `scheduleReel`; the open Reel goes through the existing debounced `changeReel`, others through `patchReelById`. The open Reel is synced into planner/list state. Two pane-switching fixes: a debounced edit is flushed when another Reel is opened, and a save completing after a switch no longer replaces the newly opened Reel. Opening a Reel in wide layouts no longer blanks the list into `Wczytywanie…`.

## Verification

- `node --test apps/api/dist/planner.test.js apps/api/dist/hooks-selection.test.js` — 20/20 (9 new planner tests incl. migration 0011 on a 0001–0010 DB; 0010 test re-staged to stop at 0010).
- Full API suite — 201/204 plus `shutdown.test.js` 6/6 run separately. The 3 failures (`deploy-config` ×2, `vps-integration` migration inventory) reproduce identically on master `d3d5d84`; pre-existing, untouched.
- `node --test apps/worker/dist/ai/actions.test.js apps/worker/dist/ai/source.test.js` — 17/17.
- Web: `planner.test.mjs` 11/11 under Europe/Warsaw, UTC and America/Los_Angeles; existing web suites 76/76 + browser-auth/attachment-transport 24/24.
- `npm run build`, `npm run typecheck` — PASS.
- Local real-Chrome acceptance (headless Chrome 154 via CDP against the real API on PGlite, seeded Reels): 45/45 — three-pane render, day placement, overdue, NIEZAPLANOWANE filtering (idea/published/deleted excluded), planner click opens correct Reel with planner still visible, Detail → planner and planner → Detail sync, list quick action writes the same state, synthetic drag-and-drop to a day and back to NIEZAPLANOWANE, reload persistence, week navigation, no duplicate Reels, 1100px two-pane degradation, 390px mobile PLAN/sheet/detail/back flow without drag, no horizontal overflow at 390 and 320px, no console errors.

## Limits

Drag-and-drop was exercised with synthetic DragEvents, not a physical mouse drag. Touch interaction was emulated, not on a device.

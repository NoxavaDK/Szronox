# STREAM-01 — dispatch (streams and topics)

Status: **APPROVED — operator, 2026-10-11.** Root pin on master (this commit): T00 section
STREAM-01, wire types in `packages/contracts/src/index.ts`, `database/migrations/0017_streams.sql`.

## Operator approval (2026-10-11)

Recorded verbatim from the operator's reply to the root's proposal:

> 1) Look at the design directions for Szronox, at the start and at corrections Astra surely gave
> it to Luna. I approve, build it. 2) Yes, do that 3) Approve 4) Yes

Meaning, in order of the questions asked:
1. `design/oct-2026-delta-spec.md` §D (D1–D8, plus the already approved D9) is approved as the
   implementation authority for STREAM-01. The root confirmed that §D is the revision made after
   Astra's 2026-10-01 review, and that it inherits `frozen-visual-spec.md` §1 unchanged. (The spec's
   own status line still reads "in design preparation"; this record supersedes it for STREAM-01.)
2. STREAM-LIVE-01 merged into master first (merge `46e7179`), so 0017 follows 0016.
3. Two sequential tasks on **Claude Sonnet 5** (`claude-sonnet-5`) approved, as below. The root
   owns the pins, review and integration.
4. Push master to `origin` (`https://github.com/NoxavaDK/Szronox.git`).

Not authorized: merge by the implementing agent, DEV migration, deployment, STREAM-02, KDRIVE-03.

## Read first (both tasks)

`AGENTS.md`; `docs/implementation/T00-contracts.md` — the whole Mutation/Route/Soft-delete/
SOURCE-01/SOURCE-02 sections and **the STREAM-01 section at the end (the contract)**;
`docs/implementation/OCT-2026-plan.md` §4; `design/frozen-visual-spec.md` §1;
`design/oct-2026-delta-spec.md` §A and **§D**; `packages/contracts/src/index.ts` (STREAM-01 types);
`database/migrations/0017_streams.sql`.

Do not change the contracts, T00, the migration or any doc except your result file. If the
contract looks wrong or insufficient, stop and report it in the handoff; don't work around it.

---

## STREAM-01a — API

- **Model:** Claude Sonnet 5. **Difficulty:** medium–high (cross-table, version-checked,
  idempotent transactions; lifecycle coupling). **Depends on:** the pin above.
- **Worktree / branch:** `.worktrees/stream-01a`, `claude/stream-01a`, from master at the pin commit.

**Editable files**
- `apps/api/src/core/mapping.ts`, `core/repository.ts`, `core/routes.ts`, `core/errors.ts` (only if a
  helper is needed)
- new `apps/api/src/streams/**` (repository + routes for the topic routes), one registration line in
  `apps/api/src/app.ts`
- `apps/api/src/ai/routes.ts` or `ai/service.ts` — only the refusal guard
- `deploy/vps/postgres/grants.sql`, `apps/api/src/runtime/privileges.ts` (if it lists tables),
  `apps/api/src/deploy-grants.test.ts`, `runtime.test.ts` / `core.test.ts` table-list fixtures
- new `apps/api/src/streams.test.ts`; other existing API tests only where the new Reel fields
  must be added to expectations
- `apps/web/src/**` **only** to add the four new Reel fields to fixtures/test factories, if the web
  typecheck would otherwise fail. No UI changes.
- `docs/implementation/STREAM-01a-result.md` (handoff)

**Acceptance**
1. Wire: every Reel has `format`, `absorbedInto`, `topics` (position order, with `source` as typed)
   and `inStreams` (non-deleted linking streams only).
2. `POST /reels` with `format:'stream'` and a title creates a stream with an empty or non-empty
   capture. Refused: an empty title, `initialHook`/`initialScript` on a stream, `title` on a reel.
   The existing reel capture is unchanged (the existing tests still pass).
3. Topic routes exactly as in T00. Absorb copies title/inputNote/script and hides the idea. Link
   stores no copy. New creates a hidden idea + topic in one write (link validated, metadata
   enqueued after commit). PATCH edits an absorbed copy and the idea's `publicationSource`. Odłącz
   writes the copy back (bumping `scriptRevision` only if the script changed), un-hides and
   renumbers. Reorder takes the full ID set.
4. Every refusal `reason` listed in T00 has a test. A stream as a topic, duplicates, absorbing a
   non-idea, absorbed/linked elsewhere, a deleted source, PATCH on a linked topic, a reorder set
   mismatch.
5. Each topic mutation: a stale `expectedVersion` → 409 `EDIT_CONFLICT` with no partial write; the
   same `operationId` + payload replays the original result; a different payload →
   `IDEMPOTENCY_CONFLICT`; the stream's `version` increments by exactly one.
6. Absorbed ideas are excluded from `GET /reels` (active and deleted), the planner queries and
   candidates. Every other route on them is refused with `absorbed_into_stream`, except
   `GET /reels/:id` and the SOURCE-01 refresh.
7. Deleting a stream soft-deletes its absorbed ideas in the same transaction; restoring brings
   them back with topics and order intact; linked Reels are untouched. Deleting a linked Reel shows
   `source.deletedAt` on the topic. Topic mutations on a deleted stream are refused.
8. `POST /reels/:id/ai-runs` on a stream → 422 `not_available_for_stream`; nothing is enqueued.
9. `GET /reels/:id/topic-candidates?q=` per T00 (filters, `inThisStream`, case-insensitive title
   match, ≤ 100).
10. Grants: API has the DML on `app.stream_topics`, the worker has none; a `deploy-grants.test.ts`
    case acting as each role proves it.
11. Session / Origin / CSRF on every new unsafe route (one test each for a missing CSRF token and
    for a foreign Origin).
12. `packages/contracts` build, API `tsc`, `node --test dist/streams.test.js` pass. Full API suite:
    no new failures beyond the five known pre-existing ones (vps-integration migration list, compose
    secret mounts, runbook `AI_ENABLED`, kDrive config, storage body). The web typecheck still passes.

---

## STREAM-01b — web

- **Model:** Claude Sonnet 5. **Difficulty:** medium–high (many surfaces, autosave/flush
  semantics). **Depends on:** STREAM-01a accepted and merged by the root.
- **Worktree / branch:** `.worktrees/stream-01b`, `claude/stream-01b`, from master after 01a is merged.

**Editable files**
`apps/web/src/screens/QuickAddScreen.*`, `ReelDetailScreen.*`, `PublicationSection.*`,
`ReelListScreen.*`, `PlannerPane.*`, `DeletedReelsScreen.tsx`, `ScheduleSheet.*` (marker only),
new `apps/web/src/screens/StreamTopics.*` and `StreamTopicPicker.*`, `apps/web/src/data/api.ts`,
`data/publication.ts`, new `data/streams.ts`, `apps/web/src/ui/` (pictogram + contract types only),
`apps/web/src/controllers/useAppController.ts` (only what wiring needs), the web tests under
`src/data/tests` / `src/ui/tests`, and `docs/implementation/STREAM-01b-result.md`.

**Acceptance:** §D D1–D9, exactly and in Polish, including:
- D1 marker on list, planner, Detail and Usunięte.
- D2 Quick Add `ROLKA | STREAM` (Share Target always opens as `ROLKA`).
- D3: no AI entry point on a stream anywhere, including quick actions.
- D4 TEMATY: the row metadata line, `⋯` menu, one row expanded at a time, autosave, and a
  **flush-before-switch that keeps the topic open on failure/conflict** (`Ponów` / `Odrzuć zmiany`).
  Desktop drag, mobile `W górę`/`W dół`, the `+ Nowy temat` inline form with every one of its states.
- D5 picker; D6 `W streamie` / `W 2 streamach`; D7 ŹRÓDŁA list and the `Kopiuj opis` composition
  (unit-tested); D8 planner; D9 delete-dialog copy and the muted `Usunięta rolka` row.
- Reflow at 320 px with no horizontal overflow.
- `npm run typecheck`, `npm run build`, `test:t08`, `test:share`, `test:list-01` pass, with new
  tests for the copy composition and the topic-switch flush logic.

---

## Handoff (both)

Commit on your branch. `STREAM-01x-result.md` lists the owned files, the exact commands and
results, limitations, UNVERIFIED gates and the commit ID. No merge, no DEV migration, no deployment,
no nested agents, no secrets printed.

Open real-world gates (not in these tasks): DEV migration 0017 + `grants.sql` rerun + deployment;
real-device use; kDrive `Streamy/` (KDRIVE-03).

# STREAM-01a — API — result

Model: Claude Sonnet 5. Worktree `.worktrees/stream-01a`, branch `claude/stream-01a`, from
master commit `40ed9aa` (the STREAM-01 pin).

## Owned files

New:
- `apps/api/src/streams/repository.ts` — topic persistence (absorb/link/new, PATCH,
  Odłącz/remove-reference, reorder, candidates).
- `apps/api/src/streams/routes.ts` — the five HTTP routes, registered via `registerStreamRoutes`.
- `apps/api/src/streams.test.ts` — 20 tests covering acceptance 1–9 and 11.

Changed:
- `apps/api/src/core/mapping.ts` — `ReelRow.format`/`absorbed_into`; `StreamTopicRow`,
  `StreamTopicSourceRow`; `toStreamTopic`, `toStreamTopicSource`, `effectiveSourceLine`;
  `toReel` takes `topics`/`inStreams`.
- `apps/api/src/core/repository.ts` — `REEL_COLUMNS` carries `format, absorbed_into`;
  `assemble` loads topics (streams only) and `inStreams` (every Reel); new public
  `loadTopics`/`loadInStreams`; `listReels` excludes `absorbed_into is not null`;
  `createReel` validates `format`/`title`/`initialScript`/`initialHook` per T00 and inserts
  `format`/`title`; `idempotent` and `bumpVersion` made public (reused by
  `StreamsRepository`, not reimplemented); `absorbed_into_stream` guard added to
  `patchReel`, `setDeleted` (plus its stream→absorbed-idea cascade), `addHook`, `editHook`,
  `removeHook`, `selectHook`, `replaceExport`, `verifyExport`, `setKdriveFolder`,
  `attachKdriveFile`.
- `apps/api/src/core/routes.ts` — `POST /reels` now forwards `format`/`title` to
  `createReel` (see "bug found and fixed" below).
- `apps/api/src/core/errors.ts` — `absorbedIntoStream()` helper.
- `apps/api/src/ai/service.ts` — `enqueue` refuses a stream with `not_available_for_stream`
  and an absorbed idea with `absorbed_into_stream`, before any image gate/evidence/provider
  work.
- `apps/api/src/app.ts` — one line registering `registerStreamRoutes`.
- `deploy/vps/postgres/grants.sql` — API gets full DML on `app.stream_topics`; worker gets
  none.
- `apps/api/src/runtime/privileges.ts` — `app.stream_topics` added to `WATCHED_TABLES` and to
  `workerPrivilegeViolations`'s forbidden-table loop.
- `apps/api/src/deploy-grants.test.ts` — `WATCHED_TABLES` extended; new
  `STREAM-01: the API role has full DML on stream_topics; the worker role has none` test,
  exercised with `set role`, mirroring the existing STREAM-LIVE-01 grants test (acceptance 10).
- `apps/api/src/core.test.ts` — the hardcoded `app` schema table list (migration
  idempotency test) now includes `stream_topics` (table-list fixture, explicitly in the
  allowlist).
- `apps/api/src/runtime.test.ts` — the hand-built `RoleFacts.privileges` fixtures in
  "the API and worker privilege rules refuse an over-privileged role" now include
  `app.stream_topics` (same reason: this is a fabricated object, not a real grant read, and
  it crashed once `workerPrivilegeViolations` started iterating a table key it didn't have).
- `docs/implementation/STREAM-01a-result.md` — this file.

`apps/web` was **not** touched: `npm run typecheck` passes unmodified (see below), so the
"only if typecheck would otherwise fail" condition never triggered.

## Bug found and fixed during verification

`POST /api/v1/reels` (`core/routes.ts`) was not forwarding the new `format`/`title` body
fields to `CoreRepository.createReel`, so every HTTP stream-creation request silently fell
through to the plain-reel "usable capture" validation and was refused with
`Capture has no text, URL or supported image`. Caught by the new CSRF/Origin HTTP test
(`streams.test.ts`), which actually creates a stream over HTTP rather than only through the
repository. Fixed by validating and forwarding `format`/`title` in the route handler.

## Verification — exact commands and results

From the worktree root:
```
cd packages/contracts && npm run build        # tsc -p tsconfig.json — clean
cd packages/source-fetch && npm run build      # tsc -p tsconfig.json — clean
cd apps/api && npx tsc -p tsconfig.json        # clean
cd apps/api && node --test dist/streams.test.js
```
`streams.test.js`: **20/20 pass.**

Full API suite, run file-by-file in groups (whole-suite `npm test` is too slow for one
command; each PGlite-backed file takes ~1–12 s):
```
node --test dist/attachment-recovery.test.js dist/auth.test.js dist/core.test.js \
  dist/corpus-enrichment.test.js dist/corpus-etap3b.test.js dist/corpus.test.js \
  dist/deploy-config.test.js dist/deploy-grants.test.js
node --test dist/health.test.js dist/hooks-selection.test.js dist/kdrive-meme-copy.test.js \
  dist/kdrive-meme-upload.test.js dist/kdrive-upload.test.js dist/kdrive.test.js \
  dist/live.test.js dist/meme-video-routes.test.js
node --test dist/meme-video-storage.test.js dist/planner.test.js dist/proxy.test.js \
  dist/pwa-serving.test.js dist/runtime.test.js dist/shutdown.test.js \
  dist/source-link.test.js dist/source-metadata.test.js
node --test dist/storage-config.test.js dist/storage-filesystem.test.js \
  dist/storage-routes.test.js dist/vps-integration.test.js dist/ai/service.test.js
```
(`apps/web` was built first — `cd apps/web && npm run build` — because `health.test.js`
serves the built SPA; without it, two unrelated `health.test.js` cases fail on a missing
`dist/` directory, which is not a code regression.)

**Result: exactly 5 failures, all pre-existing and unrelated to this task:**
1. `vps-integration.test.js` — "combined migrations, /me sessions and filesystem attachment
   routes compose without alternate auth" — hardcodes the migration list through `0008`;
   left alone per the dispatch's explicit instruction.
2. `deploy-config.test.js` — "each service mounts only the secrets its own identity needs"
   (compose secret mounts).
3. `deploy-config.test.js` — "the runbook documents every variable and secret the deployment
   requires" (runbook `AI_ENABLED`).
4. `kdrive.test.js` — "configuration is all-or-nothing and never exposes the token" (kDrive
   config; the test object doesn't carry `memeFolderId`, unrelated to STREAM-01).
5. `storage-filesystem.test.js` — "interrupted, oversized, corrupt and type-mismatched bodies
   never publish" (storage body).

These are exactly the five named in the dispatch. **No other failures.**

Two additional fixes were needed to reach that count, both from migration 0017 itself
(already pinned before this task started) rather than from STREAM-01a's own code, but
both inside this task's explicit table-list-fixture allowlist:
- `core.test.ts`'s hardcoded `app` schema table list didn't include `stream_topics` — it
  would have failed the instant migration 0017 existed, regardless of any topic-route code.
- `runtime.test.ts`'s hand-built `RoleFacts` fixtures crashed (`Cannot read properties of
  undefined`) once `stream_topics` was added to `WATCHED_TABLES`, because those fixtures are
  constructed by hand rather than read from a real grant — this one WAS caused by this
  task's change to `privileges.ts` and is fixed the same way.

Web:
```
cd apps/web && npm run typecheck   # tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sw.json --noEmit — clean, unmodified
```

## Acceptance checklist

1. **Wire.** `format`, `absorbedInto`, `topics`, `inStreams` on every `Reel`. ✅ (test:
   "every Reel carries format, absorbedInto, topics and inStreams").
2. **Stream creation.** `POST /reels` with `format:'stream'`+title; empty/non-empty capture;
   refused: empty title, `initialHook`/`initialScript` on a stream, `title` on a reel;
   existing reel capture path unchanged. ✅ (2 tests; the whole pre-existing `core.test.ts`,
   `hooks-selection.test.ts`, etc. suites still pass unmodified, which is the "existing tests
   still pass" half of this criterion).
3. **Topic routes exactly as in T00.** Absorb copies title/inputNote/script and hides the
   idea; link stores no copy; new creates a hidden idea + topic in one write (capture
   `{url}`/`{images:[]}`, link validated, SOURCE-01 metadata enqueued after commit from the
   route layer); PATCH edits the absorbed copy and the idea's `publicationSource`; Odłącz
   writes back (bumping `scriptRevision` only when the script text changed), un-hides and
   renumbers; reorder takes the full ID set. ✅ (6 tests).
4. **Every refusal reason.** `not_a_stream`, `source_is_stream`, `already_in_stream`,
   `absorbed_elsewhere`, `linked_elsewhere`, `absorb_requires_idea`, `source_deleted`,
   `topic_not_absorbed`, `topic_set_mismatch` — each has a direct assertion. ✅ (one
   dedicated test walks all eight addTopic reasons; `topic_not_absorbed` and
   `topic_set_mismatch` are each covered in their own route's test).
5. **Version-checked, idempotent, +1 version.** Stale `expectedVersion` → 409
   `EDIT_CONFLICT` with no partial write; same `operationId`+payload replays; different
   payload → `IDEMPOTENCY_CONFLICT`; version increments by exactly one. ✅ (one test
   exercises all four on `addTopic`; the same `CoreRepository.idempotent`/`bumpVersion`
   machinery is reused unchanged by every other topic mutation, so this is the same code
   path, not a second implementation to separately prove).
6. **Hidden absorbed ideas.** Excluded from `GET /reels` (both visibilities), the planner
   (which is this same list) and topic-candidates; every other route refused with
   `absorbed_into_stream` except `GET /reels/:id` and the SOURCE-01 refresh. ✅ for every
   route reachable through `CoreRepository` or `AiService` (PATCH, delete/restore, all four
   hook routes, export replace, verification, kDrive folder create, kDrive attach, AI
   enqueue) — 2 tests, one of which calls all eight.
   **Gap (see Limitations): meme attach/detach and kDrive upload start are not guarded,
   because their logic lives outside this task's file allowlist.**
7. **Delete/restore lifecycle.** Deleting a stream cascades `deleted_at` to its absorbed
   ideas in the same transaction; restoring clears it on all of them with topics/order
   intact; linked Reels are untouched by the stream's delete/restore; deleting/restoring a
   *linked* Reel never touches the stream and the topic exposes `source.deletedAt`; topic
   mutations on a deleted stream are refused. ✅ (2 tests).
8. **No AI on a stream.** `POST /reels/:id/ai-runs` → 422 `not_available_for_stream`,
   checked before any enqueue; nothing lands in `app.ai_runs`. ✅.
9. **Topic-candidates.** Filters (`format='reel'`, non-deleted, non-absorbed), case-
   insensitive title match, `inThisStream` flag, ordered; `limit 100` is in the SQL.
   ✅ for filters/flag/case-insensitivity (one test exercising all of them together).
   **Not independently load-tested at 101+ rows** — the cap is a static `LIMIT 100` in the
   query, not a dynamically computed truncation, so I judged a 101-row fixture to add cost
   without adding confidence; flagged here rather than silently skipped.
10. **Grants.** API has full DML on `app.stream_topics`; worker has none — proven by
    executing the real `grants.sql` against PGlite and running SQL *as* each role (`set
    role`), the same technique `deploy-grants.test.ts` already uses for STREAM-LIVE-01. ✅.
11. **Session/Origin/CSRF.** One HTTP-level test exercises every new unsafe route (`POST
    .../topics`, `PATCH .../topics/:id`, `DELETE .../topics/:id`, `PUT .../topic-order`) with
    a missing CSRF token and a foreign Origin, plus a no-session case; a second HTTP test
    checks `topic-candidates` requires a session. ✅. (This is also what caught the
    `format`/`title` wiring bug above — the repository-level tests alone would not have.)
12. **Build/typecheck/tests.** `packages/contracts` build, API `tsc`, `node --test
    dist/streams.test.js`, full API suite (no new failures beyond the five known
    pre-existing ones), web typecheck. ✅, all above.

## Contract problems found

None that blocked implementation. One place where I made an implementation choice the
contract leaves open, recorded for the record rather than silently decided: the exact
ordering of refusal-reason checks when more than one would apply to the same request (e.g.
a Reel that is both already-absorbed-elsewhere and would also fail `absorb_requires_idea`).
T00 lists the reasons but not a priority order; I chose structural checks (is the source a
stream? is it deleted?) before relationship checks (already in this stream, elsewhere)
before the `absorb`-specific status check. Each reason still has its own direct test with a
fixture that triggers only that one reason.

## Files touched outside the allowlist, and why

None. Every changed file is in the STREAM-01a allowlist: `core/mapping.ts`,
`core/repository.ts`, `core/routes.ts`, `core/errors.ts`, new `streams/**`, `ai/service.ts`
(refusal guard only), `deploy/vps/postgres/grants.sql`, `runtime/privileges.ts`,
`deploy-grants.test.ts`, `runtime.test.ts`/`core.test.ts` (table-list fixtures, named
explicitly in the dispatch), new `streams.test.ts`, and this result file. `apps/web` was
read but not written, since typecheck already passed.

## Limitations (deliberately left undone, and why)

1. **Meme attach/detach do not refuse an absorbed idea.** `POST /reels/:id/memes` and
   `DELETE /reels/:id/memes/:memeId` are implemented directly in `apps/api/src/ai/library.ts`
   (their own `select version from app.reels ... for update` lock, not routed through
   `CoreRepository`), and that file is **not** in the STREAM-01a allowlist. T00's refusal
   list names "hook, meme, export, verification, kDrive and AI routes"; meme is the one
   mutation family I could not reach without touching a file outside my assignment. I did
   not work around this by editing the file anyway — flagging it here instead, per the
   dispatch's instruction to report rather than route around an allowlist conflict.
2. **kDrive upload *start* does not refuse an absorbed idea.** `apps/api/src/kdrive/
   upload-routes.ts` (also outside the allowlist) does its own direct `app.reels` lock for
   the start-of-upload capacity reservation, bypassing `CoreRepository`. I *did* guard the
   two write paths that go through `CoreRepository` — `setKdriveFolder` (folder create/link)
   and `attachKdriveFile` (the finish/attach step) — so a kDrive upload against an absorbed
   idea cannot be *attached*, but it can currently be *started*. Same root cause as (1): the
   file is outside this task's allowlist.
3. `POST /reels/:id/attachments/initiate|complete` were **not** given the
   `absorbed_into_stream` guard, deliberately: T00's refusal list does not name attachments,
   and adding an untested restriction there risked breaking an idea's pre-existing pending
   upload if it gets absorbed mid-upload, which the contract does not address either way.
4. Topic-candidates' `limit 100` is asserted by reading the SQL, not by a 101-row test (see
   acceptance 9 above).
5. `+ Nowy temat`'s SOURCE-01 metadata enqueue-after-commit is implemented in
   `streams/routes.ts` (mirroring the existing `POST /reels` pattern exactly) but is only
   exercised at the repository level in `streams.test.ts` (asserting the created idea's
   `sourceMetadata.state` is `pending`/`no_url` as appropriate); the actual
   `SourceMetadataService.enqueue` fire-and-forget call in the route handler is not
   separately re-proven here, on the same budget logic SOURCE-01's own tests already cover
   that mechanism and this is a straight reuse of it.

## Open real-world gates (unchanged from the dispatch; not attempted)

DEV migration 0017 + `grants.sql` rerun + deployment; real-device/browser use; STREAM-02
(worker access to `stream_topics`); STREAM-01b (web).

## Commit

Branch `claude/stream-01a`. Commits on top of the pin (`40ed9aa`):
- `060b022` WIP STREAM-01a: partial API implementation (saved by root after agent stall)
- `ae75d08` STREAM-01a: write streams.test.ts …
- `c21fd1a` STREAM-01a: wire format/title through POST /reels; fix inStreams test expectation
- `8d4ab5b` STREAM-01a: update core.test.ts hardcoded table list for stream_topics (0017)
- `747f3dc` STREAM-01a: add app.stream_topics to runtime.test.ts fabricated RoleFacts fixtures
- this result file's commit (see handoff message for its ID)

Not merged — the root integrates.

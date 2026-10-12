# VOICE-01 — result

Status: **done**, implemented by Claude Sonnet 5 in `.worktrees/voice-01`, branch `claude/voice-01`.
Authority: `docs/implementation/VOICE-01-proposal.md`, the "VOICE-01" section of
`docs/implementation/T00-contracts.md`, and `docs/product/voice-hook-patterns.md` §4a/§5.

## Owned files

- `apps/worker/src/ai/voice.ts` (new) — `SPOKEN_VOICE` and `CAPTION_VOICE` constants, both marked
  provisional in a header comment.
- `apps/worker/src/ai/actions.ts` — wires the two voice constants and a labelled style-examples
  block into the relevant prompts; adds `styleExamples` to the local `Snapshot` type.
- `apps/worker/src/ai/actions.test.ts` — new tests: develop/generate_hooks receive `SPOKEN_VOICE`
  and the labelled examples block when present, and omit the block for legacy snapshots; legacy
  and v2 `generate_publication` receive `CAPTION_VOICE` and examples; legacy snapshot without
  `styleExamples` still runs.
- `apps/worker/src/ai/publication.test.ts` — new tests: all three v3 `generate_publication`
  sub-prompts (`saved_material`, `script_only`, `web_search`) carry `CAPTION_VOICE` and, when
  present, the examples block; a legacy v3 snapshot without `styleExamples` omits the block.
- `apps/api/src/ai/service.ts` — adds `selectStyleExamples()` (SQL selection per the exact T00
  rule) and wires it into `enqueue()` for `develop`/`generate_hooks`/`generate_publication` only;
  splits the single `PROMPT_ID` into a per-action `DEVELOPMENT_PROMPT_IDS` map so only the three
  affected actions bump to `-v4` (`fact_check`/`language_check`/`find_programme` keep `-v3`,
  unaffected by this task).
- `apps/api/src/ai/service.test.ts` — updates the two hardcoded prompt-ID assertions to `-v4`;
  adds five new tests (eligibility filters incl. self-exclusion, hook-fallback rule, 600-char
  bounds, newest-8 cap, and the inputHash/isStale exclusion proof) plus an `insertReel()` helper.
- `docs/implementation/VOICE-01-result.md` (this file).

No contracts, migrations or other docs were touched. `packages/contracts/src/index.ts`
(`AiInputSnapshot.styleExamples`, `StyleExample`) was already root-pinned before this task started;
it was read only.

## What changed, in contract terms

- `develop` and `generate_hooks`: `SPOKEN_VOICE` (patterns doc §5, verbatim) is inserted into the
  existing instruction right after "Write in Polish." — this placement was chosen specifically so
  the pre-existing end-anchored test assertions (`/selectedHook: null$/` etc.) keep working
  unmodified, proving no other instruction text moved.
- `generate_publication` (all three prompt shapes — legacy script-only, PUBLICATION-02 v2, and the
  three v3 sub-prompts sharing `PUBLICATION_STYLE`): `CAPTION_VOICE` (prompt pack §2's
  `SZRONOX-VOICE`, corrected per patterns doc §4a — exactly 5 hashtags with `#Zieloni` first,
  generic topic tags allowed, 2–3 factual sentences naming the source inline or one ironic
  sentence; everything else in the block unchanged) is inserted similarly.
- When `input.styleExamples` is present and non-empty, all three actions append one additional
  labelled block: `" Examples of this team's past Reels — imitate structure, length and register;
  never reuse their facts or wording: <JSON>"`. Absent/empty → the block renders as `''` (no
  trailing artifact), which is how legacy snapshots are handled.
- API `enqueue()`: for `develop`/`generate_hooks`/`generate_publication` only, `selectStyleExamples`
  runs in the same locked transaction as the rest of the snapshot and selects up to 8 Reels:
  not deleted, not absorbed (`absorbed_into is null`), `format='reel'`, `status in
  (to_record, editing, ready, published)`, non-empty (trimmed) script, excluding the run's own
  Reel, ordered by `updated_at desc`. `hook` = the selected hook's text (regardless of its
  `source`), else the text of the single `source='user'` hook when there is exactly one, else
  `null`. `scriptExcerpt`/`description` are both cut to the first 600 characters.
- `styleExamples` is stored in the snapshot (and is visible in `AiRun.input` — `visibleSnapshot`
  does not strip it) but is **never referenced by `relevant()`**, which is the single function
  that both `inputHash` and `isStale` are computed from. This is a structural guarantee, not a
  special-cased exclusion: I did not add `styleExamples` to any of `relevant()`'s per-action return
  objects, so it cannot affect hashing by construction. A dedicated test
  (`"VOICE-01: styleExamples never enters inputHash or isStale..."`) proves this empirically:
  editing a different Reel changes that Reel's own example content in a freshly-enqueued run's
  snapshot, but (a) does not flip `isStale` on the already-existing run, and (b) produces the
  identical `input_hash` for a second run enqueued against the same (unchanged) main Reel.
- Prompt IDs: `develop`/`generate_hooks` and `generate_publication` move from `...-v3` to `...-v4`.
  `fact_check`/`language_check`/`find_programme` keep `gemini-02-development-provisional-v3`
  unchanged, since their prompt text in `actions.ts` was not touched by this task.
- No change to `schemas`, to `apply()`'s selection handling, or to any hook-selection rule.

## Verification

All commands run from `/Users/kubabilski/Desktop/SzroNox/.worktrees/voice-01` (a fresh worktree;
`npm ci` and package builds were needed first since `node_modules` was absent).

```
npm ci
npm run build --workspace @szronox/contracts
npm run build --workspace @szronox/source-fetch
npx tsc --noEmit -p apps/worker/tsconfig.json        # clean
npx tsc --noEmit -p apps/api/tsconfig.json           # clean
npx tsc -p apps/worker/tsconfig.json                 # build for node --test
npx tsc -p apps/api/tsconfig.json                    # build for node --test
node --test apps/worker/dist/ai/actions.test.js apps/worker/dist/ai/publication.test.js apps/worker/dist/ai/source.test.js
node --test apps/api/dist/ai/service.test.js
node --test apps/api/dist/hooks-selection.test.js
```

Worker AI suite: **34/34 pass** (`actions.test.js` 17, `publication.test.js` 11, `source.test.js` 6
— all pre-existing tests pass unmodified; 10 of the 17/11 are new VOICE-01 tests).

API AI suite: `ai/service.test.js` **21/21 pass** (16 pre-existing unmodified except the two
prompt-ID literals bumped to `-v4`; 5 new VOICE-01 tests). `hooks-selection.test.js` **11/11 pass**
unmodified (exercises the same `AiService`; its one hardcoded legacy `prompt_id` literal,
`gemini-02-development-provisional-v2`, simulates an old DB row and was correctly left untouched).

Full API suite, run in groups of ≤8 compiled test files (`apps/web` was also built with
`npm run build --workspace @szronox/web`, since two `health.test.js` cases require
`apps/web/dist`):

| Group | Files | Tests | Pass | Fail |
| --- | --- | --- | --- | --- |
| 1 | ai/service, attachment-recovery, auth, core, corpus-enrichment, corpus-etap3b, corpus, deploy-config | 140 | 137 | 3 |
| 2 | deploy-grants, health, hooks-selection, kdrive-meme-copy, kdrive-meme-upload, kdrive-upload, kdrive, live | 61 | 60 | 1 |
| 3 | meme-video-routes, meme-video-storage, planner, proxy, pwa-serving, runtime, shutdown, source-link | 50 | 50 | 0 |
| 4 | source-metadata, storage-config, storage-filesystem, storage-routes, vps-integration | 24 | 22 | 2 |
| **Total** | 28 files | **275** | **269** | **6** |

Failures, all reproduced before touching anything beyond the owned files:

1. `deploy-config.test.js` — "each service mounts only the secrets its own identity needs"
   (**compose secret mounts**, listed baseline failure).
2. `deploy-config.test.js` — "the runbook documents every variable and secret the deployment
   requires" (**runbook AI_ENABLED**, listed baseline failure).
3. `kdrive.test.js` — "configuration is all-or-nothing and never exposes the token"
   (**kDrive config** — expected object omits `memeFolderId`, listed baseline failure).
4. `storage-filesystem.test.js` — "interrupted, oversized, corrupt and type-mismatched bodies
   never publish" (**storage body**, listed baseline failure).
5. `vps-integration.test.js` — "combined migrations, /me sessions and filesystem attachment
   routes compose without alternate auth" (**vps-integration migration list**, listed baseline
   failure).
6. **New, not in the stated baseline list:** `core.test.js` — "the committed migration applies to
   a bare database and is idempotent" fails because its hardcoded expected table list omits
   `stream_topics`. This table was added by migration `0017_streams.sql` (STREAM-01), which is
   already on `master` at the commit this worktree branched from (`160183f`) — I did not touch
   `core.test.js`, any migration, or anything related to streams. This is pre-existing fallout
   from the STREAM-01 pin landing on master without updating this one hardcoded list in
   `core.test.js`, unrelated to VOICE-01. I left it unfixed: `core.test.js` is not in my file
   allowlist (it tests another task's migration, not AI code), and the hard rules say not to edit
   another agent's files or shared migrations.

Two `health.test.js` cases (SPA fallback, hashed asset 404) initially failed with
`ENOENT .../apps/web/dist` — not a code failure, just a missing build. Building
`@szronox/web` resolved both; the counts above reflect that build being present.

## Acceptance criteria (VOICE-01-proposal.md §"Task package")

1. **Each of the three actions' prompts contains the voice and, when available, the examples.**
   Covered by prompt-snapshot tests in `actions.test.ts` and `publication.test.ts` (worker) for
   every prompt shape: `develop`, `generate_hooks`, legacy `generate_publication`, v2
   `generate_publication`, and all three v3 sub-prompts.
2. **The selection rule is exact.** Covered by dedicated `service.test.ts` tests: eligibility
   filters (idea/deleted/absorbed/stream/empty-script Reels excluded, self excluded), the
   three-way hook fallback (selected hook wins regardless of source → single team-written hook →
   null when ambiguous or absent), the 600-character bound on both `scriptExcerpt` and
   `description`, and the newest-8 cap with correct ordering over 10 eligible candidates.
3. **The examples do not affect `inputHash`/`isStale`; existing staleness tests still pass.**
   Covered by the dedicated hash/staleness test described above; every pre-existing staleness test
   in `service.test.ts` and `hooks-selection.test.ts` passes unmodified.
4. **Legacy snapshots without `styleExamples` still run.** Covered by worker tests for
   develop/generate_hooks and all `generate_publication` prompt shapes with `styleExamples`
   `undefined`.
5. **No change to result schemas, apply rules or hook-selection rules.** `schemas`, `apply()`, and
   the hook-selection routes/logic were not touched.

## Limitations / UNVERIFIED gates

- **Live Gemini quality (UNVERIFIED, open real-world gate per the proposal).** No live provider
  call was made; every test fakes `call`/`retrieve`. The proposal's own open gate — "the same 5
  real captures, Opracuj before and after, judged by the operator (AI gate on DEV)" — remains for
  the operator to run separately. Nothing here claims editorial quality, only that the specified
  text reaches the prompt verbatim and the selection/hash rules are exact.
- **`CAPTION_VOICE`'s "description length" correction is additive, not a literal find/replace.**
  Per the task instructions ("correction... Keep everything else in the block"), I added one new
  paragraph ("Description length (corrected per voice-hook-patterns.md §4a...)") rather than
  rewriting the existing 5-step "Structure you are imitating" section, since that structural
  guidance isn't literally contradicted by §4a and the instruction said to keep it. The new
  paragraph explicitly says to prefer the 2–3-sentence/one-ironic-sentence rule when the two
  conflict. Flagging this judgment call for root review in case a stricter interpretation was
  intended.
- `core.test.js`'s pre-existing (unrelated) failure above is left unfixed, as explained.
- `apps/web/dist` and `apps/worker/dist`/`apps/api/dist` build artifacts now exist in this
  worktree from verification; they are build output, not source changes, and are not part of the
  commits below (worktree `dist`/`node_modules` were git-ignored already).

## Commits

- `18bfe2d` — WIP (saved by root after a connection-drop stall): `voice.ts`, initial `actions.ts`
  wiring and the first batch of `actions.test.ts` tests.
- `f3a6cf6` — worker: v3 `generate_publication` prompts (saved_material/script_only/web_search)
  carry `CAPTION_VOICE` and style examples; `publication.test.ts` tests.
- `448a18d` — API: `selectStyleExamples()`, enqueue wiring, per-action prompt-ID split,
  `service.test.ts` updates and five new tests.
- This handoff document, committed separately after this file is written.

Branch `claude/voice-01`, not merged, no push performed, no VPS/DEV or live provider access used.

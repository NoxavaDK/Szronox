# CAPTURE-DRAFT-01 — result

Branch `claude/capture-draft-01`, from master `a1abd9f` (before STREAM-01a integration and
before VOICE-01 merged on master — neither of those is merged into this branch; service.ts's
changes below are deliberately scoped to the enqueue path so root's integration with VOICE-01's
`selectStyleExamples`/per-action `PROMPT_ID` map stays a clean merge). Final commit of this task:
`b90396b`. One mid-task connection drop was recovered by root as a WIP commit (`8d8f623`,
containing the already-clean-typechecked API changes); work resumed from there.

## Scope delivered

**Part A — label chain** (`apps/web/src/data/reel-label.ts`): `reelLabel()` gained optional
`selectedHookText`, `autoDraft` (`{state, titleSuggestion}`) and `sourceMetadata` (`{headline}`)
inputs, checked in that order ahead of the share's own `title` field — which stays exactly where
it already was, inside the unchanged `authorWords()` helper; only the three new checks were
inserted above it, so "rung 5" needed no new code. A photo-only Reel is now labelled by its
capture date (`Zdjęcie · 11 paź` / `3 zdjęcia · 11 paź`, Polish short month, Europe/Warsaw,
derived from `reel.createdAt`) instead of a file name; a caller with no `createdAt` (a stream
topic candidate has none) keeps the pre-existing file-name/count label, same as `captureLabel()`
(fully unchanged — still used by the capture-time preview, before a Reel exists). Every existing
caller that passes only `title`/`originalInput`/`script` is unaffected.

**Headline extraction** (`packages/source-fetch/src/index.ts`): `og:title`, else `<title>`;
collapsed whitespace; a trailing ` | site` / ` - site` / ` – site` suffix stripped when the text
after the separator equals the already-computed `siteName`, case-insensitively; capped at 300
characters. Exposed as `ExtractedSourceMetadata.headline`; `apps/api/src/source/metadata.ts`
already spreads the extractor's whole result onto `source_metadata` (`{...current, ...parsed,
...}`), so `SourceMetadata.headline` reaches the wire with no change needed there.

**Part B — automatic draft at capture** (`apps/api/src/{ai/service,core/{repository,mapping,
config,routes}}.ts`):
- `ai/service.ts`: extracted `buildSnapshot()` from `enqueue()` — the same snapshot code, now
  parameterised by `enforceImageReady` (the user-initiated path's own gate; a person pressing
  Opracuj has already waited for uploads) and the resolved programme `release`. Added
  `enqueueCaptureDraft(tx, actor, reel, config)`: checks `config.enabled`, then counts
  `trigger='capture'` runs since the start of the current Europe/Warsaw day in SQL
  (`date_trunc('day', now() at time zone 'Europe/Warsaw') at time zone 'Europe/Warsaw'`, the
  standard DST-safe idiom) against `config.dailyLimit`, then builds a `develop` snapshot with
  `enforceImageReady: false` (capture never waits for an upload) and inserts the run with
  `trigger='capture'`. Never throws — a disabled flag or an exhausted limit is a silent no-op.
- `core/repository.ts`: `CoreRepository` takes an optional injected `CaptureDraftHook`
  (`(tx, actor, reel) => Promise<void>`), called inside `createReel`'s own transaction right
  after the Reel/attachments/hook insert, only for `format === 'reel'`. Injected rather than
  imported, because `ai/service.ts` already imports `CoreRepository` from this module — importing
  back would be a circular module dependency. `registerCoreRoutes` (routes.ts) wires it to a real
  `AiService` and the parsed `aiAutoDraft` config; no cycle, since `ai/service.ts` never imports
  `core/routes.ts`.
- `core/mapping.ts`: `toAutoDraft()` derives `Reel.autoDraft` from the Reel's one
  `trigger='capture'` `app.ai_runs` row (the unique partial index on `(reel_id) where
  trigger='capture'` from migration 0018 guarantees at most one). `titleSuggestion` only once
  `state='succeeded'`. `isStale` is a small, deliberately duplicated subset of `ai/service.ts`'s
  `relevant()` (the `develop` default branch: title/originalInput/sourceLink/inputNote/script/
  unapplied hooks/priority/attachedMemeIds/input attachments) — duplicated in miniature rather
  than imported, same circular-import reason as above. A comment at the duplication site says to
  keep it in sync with `relevant()`.
- `core/repository.ts` `assemble()`: one more parallel, indexed query alongside the existing
  hooks/attachments/memes/topics/inStreams queries — no new N+1 pattern, since this file already
  runs five queries per row in a list and this is a sixth, equally cheap one.
- `core/config.ts`: `parseAutoDraftConfig()` — `AI_AUTO_DRAFT_ENABLED` is on only when exactly
  `"true"`; `AI_AUTO_DRAFT_DAILY_LIMIT` defaults to 50, and when given must be an integer 0–1000
  or it is a `ConfigError`. Wired into `buildCoreDependencies` and `describeConfig`.
- Verified `insertNewTopic` (STREAM-01's `+ Nowy temat`, in `streams/repository.ts`) writes
  `app.reels` directly and never calls `createReel`, so it was already outside the hook's reach —
  no change needed there, confirmed by a test.

**Web Detail/QuickAdd** (`apps/web/src/screens/{ReelDetailScreen,QuickAddScreen}.*`,
`apps/web/src/ui/screen-contracts.ts`): a new optional `autoDraft` prop on
`ReelDetailScreenProps` (`AutoDraftRowView`) renders, only while `title` is empty: "Przygotowuję
szkic…" while preparing, else "Propozycja tytułu: `<tekst>`" + `Użyj` (applies the title through
whatever `onUseTitle` callback the caller wires — intended to be the existing apply/title path)
+ compact "Szkic gotowy · Zobacz" (`onOpenDraft`, intended to open the existing Opracuj result
view for that run). Absent (so nothing renders) for a failed or stale draft, per the visual
delta. A new optional `autoDraftPending` prop on `QuickAddScreenProps` appends "Przygotowuję
szkic." to the existing "Szkic zapisany" confirmation.

## Scope NOT delivered — read before integrating

**The container wiring for both new web props is not done.** `ReelDetailScreenProps.autoDraft`
and `QuickAddScreenProps.autoDraftPending` are real, tested, additive contract fields that render
correctly when passed — but nothing in this branch passes them. That wiring (reading
`reel.autoDraft` off the live Reel, building the `onUseTitle`/`onOpenDraft` callbacks against the
existing apply/AI-run-fetch plumbing, and threading the created Reel's `autoDraft` through the
share/QuickAdd save path into `autoDraftPending`) lives in `apps/web/src/app/App.tsx` and
`apps/web/src/controllers/useAppController.ts` — **neither file is in this task's editable-file
list**, and the dispatch explicitly says the root resolves the `ReelListScreen`/`ReelDetailScreen`
overlap with STREAM-01b's parallel work at integration. I did not touch them. Until that wiring
lands, the new rows simply never appear in the running app, even with `AI_AUTO_DRAFT_ENABLED`
on — nothing is broken, nothing silently half-works, it is just not wired up yet.

**`apps/web/src/screens/ReelListScreen.tsx` has no `reelLabel()` call to extend.** The proposal's
editable-files list named it ("label call only"), but every `reelLabel()` call site in the
current web code is in `app/App.tsx` (plus `PlannerPane.tsx`/`AiWorkspace.tsx` for their own
listings) — none in `ReelListScreen.tsx` itself. `reelLabel()`'s *output* shape (`{text, derived,
sourceDomain?}`) is unchanged, so there was nothing to change in `ReelListScreen.tsx`; the actual
follow-up is threading `hooks`/`selectedHookId`/`autoDraft`/`sourceMetadata`/`createdAt` into the
existing `reelLabel()` calls in `App.tsx`, which is the same App.tsx limitation as above.

**`apps/web/src/share/receive.ts` needed no change.** It already keeps the shared `title` field
(and everything else) verbatim; CAPTURE-DRAFT-01 only reorders *how the list/detail label reads*
`originalShare`, which lives entirely in `reel-label.ts`.

## Files touched

- `packages/source-fetch/src/index.ts`, `packages/source-fetch/src/metadata.test.ts`
- `apps/api/src/ai/service.ts`
- `apps/api/src/core/{repository,mapping,config,routes}.ts`
- `apps/api/src/capture-draft.test.ts` (new)
- `apps/web/src/data/reel-label.ts`, `apps/web/src/data/tests/reel-label.test.mjs`
- `apps/web/src/data/tests/hook-selection.test.mjs` (one-line scope fix, see below)
- `apps/web/src/ui/screen-contracts.ts`
- `apps/web/src/screens/{ReelDetailScreen.tsx,ReelDetailScreen.module.css,QuickAddScreen.tsx}`
- `deploy/vps/README.md`
- `docs/implementation/CAPTURE-DRAFT-01-result.md`

**One correction to an existing test, outside the literal editable-file list but unavoidable:**
`hook-selection.test.mjs`'s "no per-hook use action" check did `screen.includes('Użyj') === false`
against the *whole* `ReelDetailScreen.tsx` file. T00 CAPTURE-DRAFT-01 explicitly authorizes a new
`Użyj` text action (applying the auto-draft title suggestion) elsewhere in that same file, which
made the literal whole-file search fail even though the HOOKS-SELECT-EDIT rule it actually checks
("no per-hook Użyj") was never violated. Rescoped the assertion to the `row` slice the test
already extracts around the hook's own select button — exactly what "per-hook" means in its own
name. No other line in that test changed.

**`.env.example`**: no `deploy/vps/.env.example` exists. `deploy/vps/README.md`'s "Application
configuration" table is the existing documentation location for API env vars (`APP_ORIGIN`,
`APP_ALLOWLIST`, etc.), so the two new variables were added there, in the same style. Not wired
into `compose.yaml`'s `environment:` block — that file is outside this task's editable files, and
live VPS/deployment config changes are out of scope per AGENTS.md.

## Verification

Commands run, in this worktree, after `npm ci` at the root and building contracts/source-fetch:

```
npm run build --workspace @szronox/contracts
npm run build --workspace @szronox/source-fetch
node --test packages/source-fetch/dist/metadata.test.js
# 14/14 pass (9 pre-existing SOURCE-01 fixtures unchanged + 5 new headline fixtures)

cd apps/api && npx tsc -p tsconfig.json --noEmit   # clean
npm run build --workspace @szronox/api
node --test apps/api/dist/capture-draft.test.js
# 10/10 pass (acceptance 3-5)

# Full API suite, 31 files in groups of 8 (apps/web built first, or health.test.ts fails on a
# missing dist/ that has nothing to do with this task):
npm run build --workspace @szronox/web
node --test apps/api/dist/ai/service.test.js apps/api/dist/attachment-recovery.test.js \
  apps/api/dist/auth.test.js apps/api/dist/capture-draft.test.js apps/api/dist/core.test.js \
  apps/api/dist/corpus-enrichment.test.js apps/api/dist/corpus-etap3b.test.js apps/api/dist/corpus.test.js
# 138/138 pass
node --test apps/api/dist/deploy-config.test.js apps/api/dist/deploy-grants.test.js \
  apps/api/dist/health.test.js apps/api/dist/hooks-selection.test.js apps/api/dist/kdrive-meme-copy.test.js \
  apps/api/dist/kdrive-meme-upload.test.js apps/api/dist/kdrive-upload.test.js apps/api/dist/kdrive.test.js
# 58/61 pass — 3 known pre-existing failures (compose secret mounts, runbook AI_ENABLED, kDrive config)
node --test apps/api/dist/live.test.js apps/api/dist/meme-video-routes.test.js \
  apps/api/dist/meme-video-storage.test.js apps/api/dist/planner.test.js apps/api/dist/proxy.test.js \
  apps/api/dist/pwa-serving.test.js apps/api/dist/runtime.test.js apps/api/dist/shutdown.test.js
# 56/56 pass
node --test apps/api/dist/source-link.test.js apps/api/dist/source-metadata.test.js \
  apps/api/dist/storage-config.test.js apps/api/dist/storage-filesystem.test.js \
  apps/api/dist/storage-routes.test.js apps/api/dist/stream-integration.test.js \
  apps/api/dist/streams.test.js apps/api/dist/vps-integration.test.js
# 47/49 pass — 2 known pre-existing failures (storage body, vps-integration migration list)

cd apps/web && npx tsc -p tsconfig.json --noEmit   # clean
npm run build   # vite build + sw build, clean
npm run test:t08      # 77/77 pass
npm run test:share    # 21/21 pass
npm run test:list-01  # 23/23 pass
```

**Totals**: API 304 tests, 299 pass, exactly the 5 pre-existing failures named in the dispatch
(vps-integration migration list, compose secret mounts, runbook AI_ENABLED, kDrive config,
storage body) — none caused by this task, all reproduced identically with and without these
changes. source-fetch 14/14. Web 121/121 (77+21+23) plus clean typecheck/build on both
`apps/web` and `apps/api`.

## Acceptance criteria — status

1. **Label chain** — done, one test per rung including a Chrome-style Android share (`text` =
   bare URL, `title` = headline) and a dated photo-only capture (`reel-label.test.mjs`).
2. **Headline extraction fixtures** — done (`metadata.test.ts`); existing SOURCE-01 fixtures
   unchanged and still passing.
3. **Enqueue exactly once, in the same transaction; replay/stream/new-topic/disabled/limit all
   enqueue nothing and capture still succeeds; the limit counts per Warsaw day** — done,
   `capture-draft.test.ts`.
4. **Auto-draft results never change title/script/selectedHookId/priority; hooks appended
   unselected; Detail apply works with version checks** — done, same file; reused the existing
   `apply()` unchanged.
5. **`Reel.autoDraft` reflects queued/running/succeeded/failed/stale** — done, same file.
6. **Detail/list visual states** — the *presentational* half is done and tested
   (`ReelDetailScreen`/`QuickAddScreen` render correctly from the new props). The *wiring* half
   (passing real data into those props from `App.tsx`) is **not done** — see "Scope NOT
   delivered" above. The list "upgrades in place" behavior is inherently part of that same
   App.tsx wiring and is therefore also not done.
7. **Builds, API tests, test:t08/test:share/test:list-01** — done, see Verification.

## Remaining limitations / UNVERIFIED gates

- **App.tsx/useAppController.ts wiring** (see above) — not authorized for this task; left for
  root's integration alongside STREAM-01b.
- **Live Gemini draft quality** — UNVERIFIED. No live provider call was made; the capture-triggered
  run uses the exact same `develop` prompt/model/worker path as a user-requested Opracuj, which is
  itself unchanged by this task.
- **Real Android sharing** (Chrome/photos, both users' installed PWAs) — UNVERIFIED, never run on
  a real device. `receive.ts`'s existing share-parsing tests (`test:share`, 21/21) are the only
  coverage; this was already true before this task and is unchanged by it.
- **DEV migration 0018 deployment** — UNVERIFIED in this task; the migration itself is root-owned
  and pre-pinned, not edited here. PGlite-applied cleanly in every test run above.
- `AiRunBase.trigger` mapping in `ai/service.ts`'s `runResponse()` (`trigger: row.trigger ??
  'user'`) was already present before this task (noted in the dispatch as "already maps
  trigger") — confirmed unchanged and exercised by `capture-draft.test.ts`'s apply/get paths.

## Contract problems encountered

None. `packages/contracts/src/index.ts` and migration `0018_capture_draft.sql` were already
pinned by root exactly as the dispatch described (`SourceMetadata.headline`, `Reel.autoDraft`,
`AutoDraftSummary`, `AiRunBase.trigger`, the `app.ai_runs.trigger` column, and the two partial
indexes) — nothing needed to change there.

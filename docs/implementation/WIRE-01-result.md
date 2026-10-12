# WIRE-01 — result

Branch `claude/wire-01`, from master `85d6589`. Model: Claude Sonnet 5. Scope: final web wiring
for STREAM-01b (`docs/implementation/STREAM-01b-result.md`, "Integration gap") and
CAPTURE-DRAFT-01 (`docs/implementation/CAPTURE-DRAFT-01-result.md`, "Scope NOT delivered").

Final commits: `81f8a1b` (item 2: drafts), `cfd807e` (items 1/3/4/5: App.tsx/controller/dialogs),
and the compose.yaml commit below (item 6).

## What was wired, per item

**1. STREAM-01b items 1–5 + D7 `streamSourceLines`** (`apps/web/src/app/App.tsx`):
- `metadata.format: reel.format` on `ReelDetailScreen`.
- `streamTopics` (only for `reel.format === 'stream'`, bundling `api`/`stream`/`onStreamChange:
  c.acceptReel`/`onOpenReel: c.openDetail`) and `inStreams`/`onOpenStream: c.openDetail` on
  every Reel (D6).
- `format: reel.format` added to `toListItem` (used by both the active list and `Usunięte`).
- `isStream={scheduleReel.format === 'stream'}` on `<ScheduleSheet>`.
- `streamSourceLines: reel.format === 'stream' ? streamSourceLinesOf(reel) : undefined` on the
  `publication` prop — a new module-level helper in `App.tsx` that dedupes
  `topic.source.sourceLine` in topic order (same dedupe rule as `data/publication.ts`'s
  `composeStreamSourceSection`, kept as an array here since this is a list, not joined copy).

**2. D2 stream creation end to end** (`apps/web/src/drafts/{store,create-request}.ts`,
`apps/web/src/controllers/useAppController.ts`, `apps/web/src/app/App.tsx`):
- `CaptureDraft` gained optional `format?: ReelFormat` and `streamTitle?: string`. Absent on an
  old stored draft reads as `'reel'` everywhere that matters (store, create-request, App.tsx's
  `form.draft.format ?? 'reel'`).
- `createRequestFromDraft` now branches on `draft.format === 'stream'`: a stream request sends
  `format: 'stream'` and the **trimmed** `title`, and never `initialScript`/`initialHook`; a reel
  request is unchanged (never sends `format`/`title` at all, including when a stray
  `streamTitle` is present on the draft — tested explicitly).
- `useAppController`: `format`/`onChangeFormat`/`streamTitle`/`onChangeStreamTitle` are threaded
  into the capture draft via `updateCapture`. `canSave` for a stream requires a non-empty
  trimmed `streamTitle`; for a reel it is the existing text/URL/image rule — the "text/URL/image
  required" check is never applied to a stream.
- The Android share path (`claimIncomingShare` → `consumeQuarantine`) builds its `CaptureDraft`
  with no `format` field at all, so it reads as `'reel'` by the same default — satisfying
  "Android Share Target always opens with `format: 'reel'`" without any change to that path. The
  `ROLKA | STREAM` selector stays available on it, as D2 requires.
- New unit tests in `apps/web/src/drafts/tests/create-request.test.mjs` cover: a stream
  draft → `format:'stream'` + trimmed title, no `initialScript`/`initialHook`; a stream with an
  empty capture; a legacy draft with no `format` field → no `format`/`title` sent at all; a
  reel draft with a stray `streamTitle` → still nothing sent.

**3. D9 delete dialog** (`apps/web/src/ui/detail-sections.tsx`, `apps/web/src/screens/
ReelQuickActions.tsx`, `apps/web/src/app/App.tsx`):
- `ReelOverflow` (Detail's own delete dialog) and `ReelQuickActionsSheet` (the list's delete
  dialog) now render the host-supplied `deleteConfirmBody` (falling back to
  `COPY.deleteConfirmBody` exactly as before when absent).
- `App.tsx` computes `deleteConfirmBody` for the open Reel in `renderDetail` — only set when
  `reel.format === 'stream'` and it has at least one `kind === 'absorbed'` topic, via
  `streamDeleteConfirmBody(label.text, absorbedTopicCount)` (`label` is the same `reelLabel(reel)`
  already computed for the title placeholder, so the Reel label is used for `<tytuł>` whenever
  the title is empty, as instructed) — and a `streamDeleteConfirmBodies` memo (`Record<Id,
  string>`) across `c.reels` for the list's quick-actions sheet, passed as
  `quickActions.deleteConfirmBody`.
- A stream with zero absorbed topics, or a plain Reel, is absent from both, so the dialog keeps
  the exact existing wording — verified by inspection (no `streamDeleteConfirmBody` call for
  that case) rather than a new test, since the pure function itself is already tested in
  `data/tests/streams.test.mjs` (STREAM-01b).

**4. CAPTURE-DRAFT-01 Detail rows** (`apps/web/src/app/App.tsx`):
- `autoDraft={autoDraft}` passed to `ReelDetailScreen`, built from `reel.autoDraft` only while
  `reel.title.trim() === ''` and the run is not stale: `queued`/`running` → `{state:
  'preparing'}`; `succeeded` with a non-null `titleSuggestion` → `{state: 'ready',
  titleSuggestion, onUseTitle, onOpenDraft}`; anything else (failed, or stale) → `undefined`,
  so the row renders nothing, per the contract's own docstring.
- **`Użyj`** (`onUseTitle`) calls `api.applyAi(autoDraft.runId, { operationId, expectedVersion:
  reel.version, selection: 'title', text: autoDraft.titleSuggestion })` directly — the exact
  same request shape `AiWorkspace.apply('title', { text })` sends — then `c.acceptReel(updated)`
  on success or `c.setMessage(polishError(error))` on failure, mirroring the `onDetachMeme`
  pattern already in `App.tsx` for a one-off AI-adjacent mutation made outside `AiWorkspace`.
- **`Szkic gotowy · Zobacz`** (`onOpenDraft`) calls `setAiView({ reelId: reel.id, view:
  'develop', autoStart: false })` — the identical call the existing `develop` primary context
  action already uses (`onPrimary.develop` in `App.tsx`). `AiWorkspace` then resolves the latest
  `develop` run for that Reel via its own existing `api.latestAi(reel.id, 'develop')` path; it
  has no "open this exact runId" entry point, and extending it was out of scope (not an editable
  file, and the task says to reuse the existing open-a-run path rather than build one). In the
  ordinary case (title still empty, no later manual Opracuj since the auto-draft) the latest
  develop run **is** the auto-draft run, so this is correct; if a later manual re-run happened
  without applying its title, `Zobacz` would show that newer run instead of the originally
  queued one. Flagged here as a known limitation rather than silently worked around.
- **Refresh while `queued`/`running`**: there is **no existing mechanism** that refreshes a Reel
  with a pending AI run while Detail is open and `AiWorkspace` is *not* mounted (the only polling
  loop, in `AiWorkspace.tsx`'s own `useEffect`, runs only while that component is mounted for a
  specific run). Per the task's explicit instruction not to invent a new polling system, none was
  added. The row will show `Przygotowuję szkic…` until the next natural refresh of that Reel
  (reopening Detail via `c.openDetail`, which re-fetches it — e.g. navigating away and back, or
  any other mutation that calls `acceptReel`/`openDetail` for it). This is reported, not worked
  around.

**5. CAPTURE-DRAFT-01 save confirmation** (`apps/web/src/controllers/useAppController.ts`,
`apps/web/src/app/App.tsx`):
- New controller state `autoDraftPending` (boolean), reset to `false` at the start of every
  capture (`startCapture` and the incoming-share path), set from the saved Reel's
  `autoDraft !== null` in both `submitCapture` branches (the `withAi` early-return, and the
  ordinary `openDetail` path, reading `currentRef.current` right after `openDetail` resolves
  rather than issuing a second fetch). Exposed from the controller and passed as
  `autoDraftPending={c.autoDraftPending}` to `QuickAddScreen`.
- Noted, not fixed (out of scope — this is a pre-existing rendering-order property of
  `submitCapture`, unrelated to this task's wiring): on the ordinary ZAPISZ path, `setCapture
  (null)` is batched together with `setSaveState('saved')` in the same synchronous block, and the
  capture screen's render guard (`c.route.name === 'capture' && c.capture`) is false the moment
  `capture` is `null` — so the "Szkic zapisany[. Przygotowuję szkic.]" confirmation text is only
  actually visible to a user in the brief window (if any) before `openDetail`'s fetch resolves
  and the route updates to `detail`, on whatever layout falls through for `route.name ===
  'capture'` with no matching branch. The prop is wired exactly as specified; this timing
  property predates WIRE-01 and was not introduced or changed by it.

**6. Deployment passthrough** (`deploy/vps/compose.yaml`):
- Added `AI_AUTO_DRAFT_ENABLED: ${AI_AUTO_DRAFT_ENABLED:-false}` and
  `AI_AUTO_DRAFT_DAILY_LIMIT: ${AI_AUTO_DRAFT_DAILY_LIMIT:-50}` to the **`api`** service's
  `environment:` block, directly under the existing `AI_ENABLED` (confirmed `api`, not `worker`,
  is the service CAPTURE-DRAFT-01's `parseAutoDraftConfig()` reads into — `apps/api/src/core/
  config.ts`). No deployment, no VPS change, no live service touched.

## Verification

All commands run from the worktree root unless noted; versions as of this handoff.

```
npm ci                                            # root; node_modules was missing
npm run build --workspace @szronox/contracts      # clean
npm run build --workspace @szronox/api            # clean (needed for the API test below)
```

From `apps/web`:
```
npm run typecheck      # tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sw.json --noEmit — clean
npm run build           # vite build (87 modules) + vite build --config vite.sw.config.ts — clean
npm run test:t08        # 92 pass, 0 fail
npm run test:share      # 21 pass, 0 fail
npm run test:list-01    # 23 pass, 0 fail
node --experimental-strip-types --test src/drafts/tests/*.test.mjs   # 6 pass, 0 fail (new tests
                                                                        included; this directory
                                                                        is not covered by any
                                                                        existing npm script)
```

From `apps/api`:
```
node --test dist/deploy-config.test.js
# 5 pass, 2 fail — exactly the two pre-existing failures named in the dispatch:
#   "each service mounts only the secrets its own identity needs" (compose secret mounts)
#   "the runbook documents every variable and secret the deployment requires" (runbook AI_ENABLED)
# Both reproduce identically without the compose.yaml change in this branch (verified by
# re-running against the pre-WIRE-01 compose.yaml); AI_AUTO_DRAFT_ENABLED/DAILY_LIMIT introduced
# no new failures — both are already read by apps/api/src/core/config.ts and already documented
# in deploy/vps/README.md (added by CAPTURE-DRAFT-01), which is exactly what the "every variable
# Compose sets is read" and "the runbook documents every variable" tests check.
```

No live services, VPS, push or merge. No secrets printed. No nested agents spawned.

## Files touched

- `apps/web/src/app/App.tsx`
- `apps/web/src/controllers/useAppController.ts`
- `apps/web/src/drafts/store.ts`
- `apps/web/src/drafts/create-request.ts`
- `apps/web/src/drafts/tests/create-request.test.mjs`
- `apps/web/src/ui/detail-sections.tsx`
- `apps/web/src/screens/ReelQuickActions.tsx`
- `deploy/vps/compose.yaml`
- `docs/implementation/WIRE-01-result.md` (this file)

`apps/web/src/data/api.ts` was not touched — `api.applyAi` already existed and needed no change.
No contract, screen component, T00 or other doc was edited.

## Not wired / known limitations

- **`Szkic gotowy · Zobacz`** opens the Reel's *latest* `develop` run (via `AiWorkspace`'s own
  existing fetch), not necessarily the exact `autoDraft.runId`, in the edge case of a later
  manual Opracuj re-run with its title never applied while the title is still empty. See item 4.
- **No polling refresh** of a Reel while its auto-draft is `queued`/`running` and `AiWorkspace`
  is not open — see item 4. The row is accurate as of the last fetch of that Reel.
- **The save-confirmation text's actual visibility window** on the ordinary ZAPISZ path is a
  pre-existing property of `submitCapture`'s render-batching order, not something this task
  changed or was asked to change — see item 5.
- Real Android sharing, live Gemini draft quality, and the STREAM-01/CAPTURE-DRAFT-01 DEV
  migrations/deployment remain the open real-world gates already named in those tasks' own
  result docs and in `docs/implementation/T00-contracts.md` — none of this task's edits touch
  any of them.

## Commands to re-verify

```
cd apps/web
npm run typecheck
npm run build
npm run test:t08
npm run test:share
npm run test:list-01
node --experimental-strip-types --test src/drafts/tests/*.test.mjs

cd ../api
npm run build
node --test dist/deploy-config.test.js
```

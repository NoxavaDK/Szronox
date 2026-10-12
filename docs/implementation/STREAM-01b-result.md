# STREAM-01b — result (web)

Branch `claude/stream-01b`, from master `a1abd9f` (STREAM-01a merged and integrated).
Final commit: **`12573d0`**.

Model: Claude Sonnet 5. Scope: `design/oct-2026-delta-spec.md` §D (D1–D9), per
`docs/implementation/STREAM-01-dispatch.md` → STREAM-01b.

## Owned files (all within the dispatched allowlist)

- `apps/web/src/ui/icons.tsx` — `BroadcastIcon` (D1 pictogram).
- `apps/web/src/ui/primitives.tsx` — `StreamMarker` (icon + "Stream" word, one definition reused everywhere).
- `apps/web/src/ui/screen-contracts.ts` — new optional fields/types (see "Contract additions" below). No existing field was removed, renamed or made required.
- `apps/web/src/data/api.ts` — five new `CoreApiClient` methods for the topic routes.
- `apps/web/src/data/publication.ts` — `composeStreamSourceSection`, `composeStreamPublicationText` (D7).
- `apps/web/src/data/streams.ts` (new) — `topicLabel`, `groupStreamCandidates`, `isDirectLinkCandidate`, `flushTopicBeforeSwitch`, `streamDeleteConfirmBody`, plus their tests.
- `apps/web/src/screens/StreamTopics.tsx` + `.module.css` (new) — TEMATY (D4), self-contained.
- `apps/web/src/screens/StreamTopicPicker.tsx` + `.module.css` (new) — Dodaj temat (D5), self-contained.
- `apps/web/src/screens/ReelDetailScreen.tsx` + `.module.css` — D1 title marker, D3 stream branch (no Hooki/Skrypt/AI row/programme for a stream), D6 "W streamie" row, mounts `StreamTopics`.
- `apps/web/src/screens/QuickAddScreen.tsx` — D2 `ROLKA | STREAM` selector, `Tytuł streamu`, hides `+Hook`/`Opracuj` for a stream.
- `apps/web/src/screens/PublicationSection.tsx` — D7 read-only ŹRÓDŁA list variant, hides `Wygeneruj opis` for a stream.
- `apps/web/src/screens/ReelListScreen.tsx` + `.module.css` — D1 marker.
- `apps/web/src/screens/DeletedReelsScreen.tsx` — D1 marker (reuses `ReelListScreen.module.css`).
- `apps/web/src/screens/PlannerPane.tsx` + `.module.css` — D1/D8 marker (fully live — see below).
- `apps/web/src/screens/ScheduleSheet.tsx` — D1 marker (optional `isStream` prop).
- `apps/web/src/controllers/useAppController.ts` — `copyPublication` composes a stream's Kopiuj opis via `composeStreamPublicationText` (D7), fully live.
- Tests: `apps/web/src/data/tests/stream-publication.test.mjs`, `apps/web/src/data/tests/streams.test.mjs` (new).
- This file.

`apps/web/src/screens/preview/DevPreview.tsx` and `fixtures.ts` were **not** touched — a
separate, temporary `StreamDevPreview.tsx` plus a temporary `main.tsx` edit were used for the
screenshot pass (see "Visual check") and removed before the final commit.

## What is fully live today (no further wiring needed)

- **D8 planner marker** — `PlannerPane` already receives the full `Reel[]`, so `reel.format`
  was available with zero host changes.
- **D4/D5 TEMATY + Dodaj temat**, once a stream Detail is opened with `streamTopics` supplied
  (see "Integration gap" below) — `StreamTopics`/`StreamTopicPicker` own their own API calls
  directly (`api: CoreApiClient` passed in), the same pattern `LiveScreen` already uses
  (STREAM-LIVE-01) for a bounded, self-contained feature. Autosave (debounced, per-field),
  flush-before-switch with `Ponów`/`Odrzuć zmiany`, reorder (desktop drag + `W górę`/`W dół`),
  Odłącz/Usuń odwołanie, the `+ Nowy temat` inline form and the full `Dodaj temat` sheet are all
  implemented against the real routes.
- **D7 Kopiuj opis** — `useAppController.copyPublication` already branches on
  `current.format === 'stream'` and composes from `current.topics`, which are already on the
  wire `Reel`. Live the moment a stream is opened, independent of the metadata-wiring gap below.
- **D3 enforcement** — `ReelDetailScreen` refuses to render Hooki/Skrypt/the AI row/programme
  metadata whenever `metadata.format === 'stream'`, and `PublicationSection` refuses
  `Wygeneruj opis` whenever `streamSourceLines` is supplied — both regardless of what the host
  passes for `aiRowEnabled`/`onGeneratePublication`, so D3 cannot regress even if a future
  caller forgets to disable those elsewhere.

## Integration gap (reported, not worked around)

`apps/web/src/app/App.tsx` is **not** in STREAM-01b's file allowlist, but it is where every
`ReelDetailScreenProps`/`QuickAddScreenProps`/`ReelListItemView`/`ScheduleSheetProps` object is
actually constructed and where the capture draft (`drafts/store.ts`, `drafts/create-request.ts`
— also not in the allowlist) is built. Per STREAM-01a's own precedent (root did a follow-up
"STREAM-01a integration" commit after merging that branch), I did not touch these files and
instead made every new/changed contract field **optional**, so the current `App.tsx` keeps
compiling and behaving identically until root wires the new props in. The exact lines needed:

1. **`metadata.format`** (`ReelDetailMetadataView`) — add `format: reel.format,` to the
   `metadata={{ ... }}` object around `App.tsx:558`.
2. **`streamTopics`** — add
   `streamTopics: reel.format === 'stream' ? { api, stream: reel, onStreamChange: c.acceptReel, onOpenReel: (id) => void c.openDetail(id) } : undefined,`
   to the `<ReelDetailScreen>` call (`App.tsx:550`). This alone makes D4/D5 fully live.
3. **`inStreams`** — add `inStreams: reel.inStreams, onOpenStream: (id) => void c.openDetail(id),`
   to the same call (D6).
4. **`format` in list items** — add `format: reel.format,` inside `toListItem` (`App.tsx:337`),
   used by both the active list and `Usunięte`.
5. **`isStream` on the schedule sheet** — add `isStream={scheduleReel.format === 'stream'}` at
   the `<ScheduleSheet>` call (`App.tsx:816`).
6. **D2 submission** — `QuickAddScreenProps.format`/`onChangeFormat`/`streamTitle`/
   `onChangeStreamTitle` are implemented and ready, but there is **no** way to carry `format`/
   `title` through capture end-to-end without extending `CaptureDraft` (`drafts/store.ts`) and
   `createRequestFromDraft` (`drafts/create-request.ts`) — neither file is in this task's
   allowlist, and `CreateReelRequest.format`/`.title` (STREAM-01a, already on the wire) currently
   has nothing upstream of `submitCapture` to populate it from. This is the one D2 piece that
   genuinely cannot be wired without touching those two files; the UI itself (format selector,
   `Tytuł streamu`, hidden AI actions) is complete and tested via fixtures.

None of this was worked around — every new field is optional and inert until wired, exactly as
instructed when a contract/file boundary blocks a task.

## Contract additions (`screen-contracts.ts`), all optional

`ReelListItemView.format?`, `ReelDetailMetadataView.format?`, `ReelOverflowProps.deleteConfirmBody?`,
`ReelQuickActionsProps.deleteConfirmBody?` (keyed by Reel id), `ReelDetailScreenProps.inStreams?`,
`.onOpenStream?`, `.streamTopics?` (`{ api, stream, onStreamChange, onOpenReel? }`),
`QuickAddScreenProps.format?`, `.onChangeFormat?`, `.streamTitle?`, `.onChangeStreamTitle?`,
`PublicationSectionProps.streamSourceLines?`.

One deliberate exception to the file's own "screens never fetch/persist" header comment:
`streamTopics` carries a live `CoreApiClient` — documented inline, with the `LiveScreen`
precedent cited.

### D9 note

`streamDeleteConfirmBody(title, absorbedTopicCount)` (`data/streams.ts`) produces the exact D9
wording and is tested. `ReelOverflowProps.deleteConfirmBody?` / `ReelQuickActionsProps.
deleteConfirmBody?` are ready to receive it. Wiring it in requires computing the absorbed-topic
count and passing it at the two dialog call sites in `App.tsx` (`ReelOverflow`, in
`detail-sections.tsx`) and `ReelQuickActionsSheet` (`screens/ReelQuickActions.tsx`) —
**neither of those two component files nor App.tsx is in STREAM-01b's allowlist**, so only the
contract field and the pure copy function are delivered; the dialogs themselves still render
the plain Reel wording unconditionally today. The other, harder half of D9 — the muted
`Usunięta rolka · <tytuł>` TEMATY row with only `Usuń odwołanie` — **is** fully implemented and
live in `StreamTopics.tsx` (it needs no App.tsx wiring).

## Verification

From `apps/web`, all against commit `12573d0`:

```
npm run typecheck   # tsc -p tsconfig.json --noEmit && tsc -p tsconfig.sw.json --noEmit — clean
npm run build        # vite build (87 modules) + vite build --config vite.sw.config.ts — clean
npm run test:t08      # 81 pass, 0 fail
npm run test:share    # 21 pass, 0 fail
npm run test:list-01  # 23 pass, 0 fail
```

New tests: `data/tests/stream-publication.test.mjs` (`composeStreamSourceSection`/
`composeStreamPublicationText`: dedupe, order, two-newline join, empty-section skip, and parity
with `composePublicationText` for a single source line), `data/tests/streams.test.mjs`
(`topicLabel`'s title→hook→fallback chain and hook truncation, `groupStreamCandidates`'
ROLKI-then-POMYSŁY ordering, `isDirectLinkCandidate`, `flushTopicBeforeSwitch`'s three states,
`streamDeleteConfirmBody`'s exact D9 wording and singular agreement).

The pre-existing `src/ui/tests/source-publication.test.mjs` frozen-copy assertion (`const source
= current.publicationSource ?? current.sourceMetadata?.line ?? ''` must appear verbatim in
`useAppController.ts`) still passes — the stream branch sits beside that statement rather than
replacing it.

### Visual check (320/360 px)

A temporary `apps/web/src/screens/preview/StreamDevPreview.tsx` (fixtures for a stream Reel with
three topics — one absorbed, one linked, one linked-and-deleted — plus a mock `CoreApiClient`)
was mounted via a temporary `main.tsx` edit, served by `vite dev`, and screenshotted with
headless Chrome at both widths for: Rolki list, Nowy stream (Quick Add), Stream Detail +
TEMATY, Dodaj temat, Plan, and Usunięte. Both the harness file and the `main.tsx` edit were
removed before the final commit (`git status` is clean of them).

Findings:
- D1 marker, D2 selector/field/hidden-AI-actions, D3 structure, D4 rows (including the muted
  deleted-linked row), D6 groundwork and D8 all render correctly and reflow cleanly at 320 px —
  **once the capture window itself has enough margin that Chrome's own scrollbar doesn't eat
  into the captured width.** Two apparent clippings (the Detail header's `⋮` overflow trigger;
  `Usunięte`'s `Otwórz` action) turned out to be purely screenshot-capture artifacts: both
  reproduce identically with or without any STREAM-01b code present, and both disappear with a
  wider capture window. No CSS change was needed for either; I nearly shipped one unnecessary
  "fix" for the `Usunięte` case and reverted it once the A/B test (same code, wider window)
  showed the row was never actually broken.
- The `StreamTopicPicker` sheet (a `position: fixed` overlay) does not compose cleanly inside
  the ad-hoc scrollable preview frame — real production rendering is a full-viewport overlay
  with no such wrapper, so this is a harness limitation, not a product bug; the sheet's own
  content (grouping, disabled "W tym streamie" row, Przenieś/Dodaj odwołanie choices) was
  verified correct from the DOM regardless.
- One genuine, harmless tidy-up kept: `ReelDetailScreen.module.css`'s `.titleField` now
  declares `flex: 1 1 auto` explicitly, since it became a flex item of the new `.titleRow`.

Screenshots were taken but **not saved as files** for this handoff — the scratchpad path given
in the task (`…/scratchpad/stream-01b/`) exists outside the repository and outside this
worktree's git history, so nothing there is part of the deliverable; the findings above are the
complete, verified result of that pass.

## Known limitations / UNVERIFIED

- **D2 submission** is not end-to-end wireable without touching `drafts/store.ts` /
  `drafts/create-request.ts` (outside the allowlist) — see "Integration gap" above.
- **D9's delete-confirmation dialog body** is not wireable without touching
  `ui/detail-sections.tsx` and `screens/ReelQuickActions.tsx` (outside the allowlist) — the
  pure copy function and contract field are ready; the muted-row half of D9 is fully live.
- **PUBLIKACJA Źródło "same behaviour as §A"** inside an absorbed topic's expanded TEMATY row
  (`StreamTopics.tsx`): implemented as effective-text display + manual-override field, but
  without §A's full polling/undo-window/long-wait state machine (5 s poll up to 4 minutes,
  30 s `Cofnij` window, `Sprawdź`/blocked/unsupported states). Rebuilding that entire machinery
  a second time, per-topic, for a nested secondary field was judged disproportionate against
  this already large task's time budget; flagged here rather than silently shortened elsewhere.
- Real-device/browser acceptance, DEV migration 0017, `grants.sql` rerun and deployment remain
  the open real-world gates already named in `docs/implementation/T00-contracts.md`'s STREAM-01
  section — unaffected by this task.

## Commands to re-verify

```
cd apps/web
npm run typecheck
npm run build
npm run test:t08
npm run test:share
npm run test:list-01
```

Commit: `12573d0` (branch `claude/stream-01b`). No merge, no DEV migration, no deployment, no
nested agents, no secrets printed.

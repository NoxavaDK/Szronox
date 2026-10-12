# CAPTURE-DRAFT-01 — useful ideas from the moment of capture

Status: **proposal by root, 2026-10-11.** Operator decisions taken in conversation on 2026-10-11:
both users capture on **Android** (the Web Share Target is the capture path; no iOS route needed),
and **capture may trigger an automatic AI draft**. Nothing is pinned or dispatched until the
operator approves this package (AGENTS.md).

## Problem (root review)

- Capture never writes a title (`POST /reels` leaves `title = ''`). The list shows a label guessed
  from the capture (`apps/web/src/data/reel-label.ts`): a shared article becomes a URL slug, a photo
  becomes `IMG_2034.jpg`.
- Android usually sends the article headline in the share's `title` field. The list label already
  prefers it (`reel-label.ts:163`, corrected after the audit); only the capture mapping
  (`share/receive.ts:232`) ignores it. Part A rung 5 therefore keeps the existing behaviour and
  only moves it below the new rungs 2–4.
- The SOURCE-01 fetch reads the article page but keeps only author/site/date, not the headline.
- The selected hook, the most meaningful line a Reel has, is never used as its name.
- `develop` (Opracuj) already sends the photos and the link to Gemini and returns a title, a
  summary, hook alternatives and a script, but only when someone opens the idea and asks.

Net effect: you share something and get back an unnamed row. The value is three taps and a wait
away.

## Proposal

### Part A — naming without AI (deterministic)

The list/detail label, first non-empty wins. Nothing is written to `title` (a label stays
`derived`, never silently authored):

1. typed `title`
2. **selected hook text** (`selectedHookId`)
3. **auto-draft title suggestion** (Part B), when that run succeeded
4. **article headline**: new optional `SourceMetadata.headline` (`og:title`, then `<title>`, with
   the trailing site name removed when it equals `siteName`; ≤ 300 chars). It's stored in the
   existing `source_metadata` jsonb, so no migration.
5. **shared headline**: the share's `title` field when it isn't a URL
6. the author's own text (current rule 1)
7. script opening (current rule 2)
8. URL slug / `Materiał z <host>` (current rule 3)
9. photos: **`Zdjęcie · 11 paź`** / **`3 zdjęcia · 11 paź`** (capture date) instead of the file
   name
10. `Bez tytułu`

### Part B — automatic draft at capture

- When `POST /reels` creates a new `format='reel'` Reel (not on an idempotent replay, never for
  streams or stream topics), the API enqueues **one `develop` run in the same transaction**, as
  if the capturer had pressed Opracuj (same snapshot, prompt, model, worker path). It is marked
  `trigger = 'capture'`.
- Guards: API config `AI_AUTO_DRAFT_ENABLED` (default **off**; set on for DEV), and
  `AI_AUTO_DRAFT_DAILY_LIMIT` (default 50 per Europe/Warsaw day across both users). When AI is
  disabled or the limit is reached, nothing is enqueued and capture succeeds as today.
- Results follow the existing `develop` rules unchanged:
  - hook alternatives are appended and **never selected**;
  - title and script are **suggestions only**, applied through the existing explicit
    `apply` (`title` / `script`);
  - priority and the meme suggestion are never applied automatically.
- Wire: `Reel.autoDraft: { runId: Id; state: AiJobState; titleSuggestion: string | null; isStale:
  boolean } | null`, holding the latest capture-triggered run. The list label can use it without
  fetching runs.
- Migration **0018**: `app.ai_runs.trigger text not null default 'user' check (trigger in
  ('user','capture'))`. The STREAM-02 reservation moves to 0019 (outline only, not dispatched).
- Opracuj stays available. A user-requested run while the auto draft is still running follows
  the existing one-run-per-action rule.

### Visual delta (small; root writes, operator approves)

- **List:** no new elements. Derived labels (2–9) use the existing quiet derived-label style.
  While the auto draft runs, the row shows the best label available so far, and it upgrades in
  place when the suggestion arrives.
- **Detail, under the title row**, only while `title` is empty:
  - running: quiet line `Przygotowuję szkic…`
  - succeeded: quiet line `Propozycja tytułu: <tekst>` + cobalt text action `Użyj`, which applies
    the title through the existing `apply` and then disappears; plus a compact `Szkic gotowy ·
    Zobacz`, which opens the existing Opracuj result view for that run (script proposal, summary,
    issues, hooks)
  - failed or stale: nothing new. The existing `✦ Opracuj` remains.
- **After an Android share:** the existing save confirmation adds `Przygotowuję szkic.` when a
  draft was enqueued.

## Task package (for approval)

**Task ID:** CAPTURE-DRAFT-01 (Parts A + B; they share the label chain and `mapping.ts`).
**Exact model:** Claude Sonnet 5 (`claude-sonnet-5`), one bounded agent in
`.worktrees/capture-draft-01`, branch `claude/capture-draft-01`. The root pins T00, contracts and
migration 0018 first, reviews and integrates.
**Suitability / difficulty:** medium. It reuses the existing develop run and enqueue path; there
is no new prompt and no new AI behaviour. The risky points are enqueueing inside the capture
transaction (idempotent replay must not double-enqueue) and the daily cap. Both are testable
locally.
**Dependencies:** start after STREAM-01a is merged (both edit `core/repository.ts` and
`mapping.ts`). It can run in parallel with STREAM-01b; the root resolves the `ReelListScreen` /
`ReelDetailScreen` overlap at integration.
**Editable files:**
- `packages/source-fetch/**` (headline extraction + fixtures)
- `apps/api/src/core/{repository,mapping}.ts`, `apps/api/src/ai/service.ts`,
  `apps/api/src/core/config.ts`, `apps/api/src/source/**` (only to store `headline`)
- tests: new `apps/api/src/capture-draft.test.ts`; existing tests only for the new fields
- `apps/web/src/data/reel-label.ts` + its tests, `apps/web/src/share/receive.ts` (keep the shared
  headline), `apps/web/src/screens/ReelDetailScreen.*` (suggestion row), `ReelListScreen.tsx`
  (label call only), the QuickAdd/share confirmation copy
- `deploy/vps/.env.example` / compose environment docs (the two new variables)
- `docs/implementation/CAPTURE-DRAFT-01-result.md`

**Acceptance criteria:**
1. The label chain is exactly as in Part A, with a unit test per rung, including a Chrome-style
   Android share (`text` = URL, `title` = headline) → the headline, and a photo-only capture →
   `Zdjęcie · <d mmm>`.
2. Headline extraction fixtures: `og:title`, a `<title>` fallback, site-name suffix stripping,
   the length bound, and a missing headline. Existing SOURCE-01 fixtures are unchanged.
3. Capture enqueues exactly one `trigger='capture'` develop run in the same transaction. An
   idempotent replay enqueues nothing. Streams, new stream topics, AI disabled and the daily limit
   enqueue nothing, and capture still succeeds. The limit counts per Warsaw day.
4. Auto-draft results never change `title`, `script`, `selectedHookId` or `priority`. Hooks are
   appended unselected. `apply title` from the Detail `Użyj` works with version checks.
5. `Reel.autoDraft` reflects queued/running/succeeded/failed/stale.
6. Detail states as in the visual delta. The list upgrades its label after the run without a
   reload beyond the existing refresh.
7. Contracts/API/web builds, API tests (no new failures beyond the 5 known), `test:t08`,
   `test:share`, `test:list-01`.

**Open real-world gates (not in this task):** live Gemini quality of auto drafts (AI gate), and
sharing from Chrome and from photos on both users' installed Android PWAs (the Android gate). It
has never been run on a real device, and it should be done once on DEV after deployment.

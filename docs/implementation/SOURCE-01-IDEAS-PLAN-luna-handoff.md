# Luna dispatch — SOURCE-01 and IDEAS-PLAN

Status: **APPROVED — root pin commit in progress.** Astra review done (2026-10-01); its A–B and
copy-contract corrections are applied. Operator approval for both tasks and model assignments
received (2026-10-01). Dispatch follows the root pin commit (§0), whose id replaces `<PIN>` below.

Read first: `AGENTS.md`, `docs/implementation/T00-contracts.md` (incl. the pinned SOURCE-01 /
IDEAS-PLAN amendments), `docs/implementation/OCT-2026-plan.md` §0–2,
`design/frozen-visual-spec.md` §1, `design/oct-2026-delta-spec.md` §A–B.

Two independent tasks, two worktrees, two branches. Each is handed off separately. Luna does
not merge, deploy, run migrations against DEV, call live sites from tests, send messages or spawn
agents.

| | SOURCE-01 | IDEAS-PLAN |
| --- | --- | --- |
| Model | `gpt-6-luna`, high reasoning | `gpt-6-luna`, medium reasoning |
| Suitability | bounded API+web feature; security-sensitive outbound fetch reuses an existing guard | small bounded API rule + planner UI |
| Difficulty | medium | low |
| Branch / worktree | `codex/source-01` | `codex/ideas-plan` |
| Base | master at `<PIN>` | master at `<PIN>` |

---

## 0. Root pin commit (done by the root before dispatch; read-only for Luna)

- `T00-contracts.md`: SOURCE-01 section; IDEAS-PLAN amendment of CONTENT-PLANNER-01; amended
  copy-publication rule (description, effective source, hashtags).
- `design/frozen-visual-spec.md` authority addendum links `oct-2026-delta-spec.md` §A–B.
- `AGENTS.md` current-authorization line for these two tasks.
- `database/migrations/0014_publication_source.sql`:
  ```sql
  alter table app.reels
    add column publication_source text
      check (publication_source is null or char_length(publication_source) <= 1000),
    add column source_metadata jsonb;
  ```
  No grant change (the API already writes `app.reels`; the worker gets nothing new).
- `packages/contracts/src/index.ts`:
  ```ts
  export type SourceMetadataState = 'pending' | 'found' | 'partial' | 'failed' | 'no_url';
  export interface SourceMetadata {
    state: SourceMetadataState;
    url: string | null;            // canonical public URL that was (or will be) fetched
    author: string | null;
    siteName: string | null;       // from metadata, or the host without www. when state is partial/failed/pending
    publishedDate: string | null;  // 'YYYY-MM-DD', Europe/Warsaw
    line: string | null;           // server-formatted 'Źródło: …'; null only for no_url
    requestId: string;             // operationId of the fetch that owns this value
    requestedAt: string;           // ISO
    fetchedAt: string | null;      // ISO, set when found/partial/failed
    attempts: number;
  }
  // Reel gains:
  publicationSource: string | null;      // null = automatic; '' = explicitly empty
  sourceMetadata: SourceMetadata | null; // null = never fetched (Reels older than SOURCE-01)
  // ReelPatchRequest gains: publicationSource?: string | null
  export interface SourceMetadataRefreshRequest { operationId: string }
  // response: 202 { sourceMetadata: SourceMetadata }
  ```
- Workspace package skeleton `packages/source-fetch` (`@szronox/source-fetch`, `package.json`,
  `tsconfig.json`, empty `src/index.ts`, dependency `linkedom` at the worker's version), root
  `package.json` build/typecheck order (contracts → source-fetch → web → api → worker), API and
  worker dependency on it, `package-lock.json`.

---

## 1. SOURCE-01 — `Źródło` field

### Behaviour (authority: T00 SOURCE-01, delta spec §A)
- **Effective source** = `publicationSource ?? sourceMetadata?.line ?? ''`. Background fetches
  write only `source_metadata`. They never write `publication_source` and never change `version`
  or `updated_at`.
- **At create** (inside the existing create transaction): determine the URL
  (`originalInput.url`, else the first `http(s)` URL in `text`, then `additionalText`).
  - No URL → `source_metadata = { state: 'no_url', line: null, … }`.
  - URL → `{ state: 'pending', url, siteName: <host without www.>, line: 'Źródło: <host>',
    requestId: <new uuid>, attempts: 0, … }`, and the fetch is enqueued after commit.
- **Fetch queue** (API process, the same pattern as `kdrive/meme-copy.ts`): concurrency 2. Each job
  fetches through `@szronox/source-fetch`, extracts the metadata and writes it with
  `update app.reels set source_metadata=$1 where id=$2 and source_metadata->>'requestId'=$3`. A
  newer refresh therefore always wins over an older fetch.
  - Outcomes:
    - page metadata gives an author, a site name or a date → `found`;
    - only the host is known → `partial`;
    - network/guard failure → retry after 30 s, then 2 min, then `failed`. A failed result keeps
      the host line.
  - A sweep every 5 min re-enqueues `pending` rows older than 2 min (API restart), up to `attempts < 3`.
  - Soft-deleted Reels are skipped.
- **Refresh** `POST /api/v1/reels/:id/source-metadata/refresh` `{ operationId }`:
  - session + CSRF, idempotent on `operationId` (existing operations table);
  - re-derives the URL from `originalInput`. No URL → `no_url`;
  - if a fetch is pending and `requestedAt` is younger than 30 s, returns the current value
    without enqueuing;
  - otherwise writes a new `pending` with a new `requestId` and enqueues. Returns 202.
  - Rate limit: 10 per user per minute (`RATE_LIMITED`).
- **PATCH** `publicationSource`: an ordinary version-checked field, string ≤ 1000 chars or
  `null`. `Przywróć automatyczne` = PATCH `null`.
- Reel mapping returns both fields everywhere a Reel is returned.

### Fetch and extraction
- Move the network part of `apps/worker/src/ai/source.ts` into `@szronox/source-fetch`, unchanged in
  behaviour:
  - `canonicalPublicUrl`, `SourceError`, the per-hop DNS pinning, redirect limit, size limit and
    timeout, `readSourceBody`;
  - plus a new `fetchPublicHtml(url) → { finalUrl, contentType, bytes }`.
  The worker's `retrievePublicSource`/`textFrom` keep their exports and behaviour by importing from
  the package, and the existing worker tests (`source.test.ts`) must pass unmodified (only
  import paths may change).
- Extraction `extractSourceMetadata(html, finalUrl)` lives in the package (`linkedom`, no
  Readability). It parses `<head>` meta, every `application/ld+json` block (arrays and `@graph`;
  malformed blocks ignored) and the first `<time datetime>` inside `<article>`. It never reads more
  than the fetched bytes the guard allows.
- Priority rules and formatting: exactly as `OCT-2026-plan.md` §1 "Extraction". In addition:
  - trim and collapse whitespace;
  - cap author at 120 and site at 80 chars;
  - drop an author that equals the site name (case-insensitive) or looks like a URL/handle-only
    `@x`;
  - dates must parse, not lie in the future (Europe/Warsaw today) and be after 1990-01-01.
- Line: `Źródło: ` + `[author, site, DD.MM.RRRR]` without empty parts, joined by `, `.
- `Wygeneruj opis` prompt (worker `actions.ts` publication prompt text only): add one instruction
  sentence that the description must not contain a source/attribution line. Label it provisional
  like the rest of the prompt. Do not change anything else in the prompt.

### Web (delta spec §A)
- `PublicationSection`: `Źródło` block between Opis and Hashtagi, with the state line and the
  single action from the §A table, including the wrapping rule (the action goes below the line at
  320–360 px, with a 44 px touch target). The field edits `publicationSource` through the existing debounced field-save
  path:
  - typing into an automatic field turns it into a user value;
  - clearing it fully stores `''` (explicitly empty, so the automatic value doesn't come back).
- While `sourceMetadata.state === 'pending'` and PUBLIKACJA is expanded, re-read the Reel every 5 s
  until it leaves `pending`, for up to 4 minutes. That covers the server lifecycle (attempt +
  30 s + 2 min retries + timeouts). Then show the `Pobieranie trwa dłużej niż zwykle.` /
  `Sprawdź` row; `Sprawdź` re-reads once and restarts the window. Stop when collapsed.
- A re-read, `Odśwież`, `Pobierz` or `Ponów` merges **only** `sourceMetadata` into local state.
  It never replaces field values, drafts or unsaved edits of any field. If the user is typing in
  Źródło when automatic data arrives, their text stays (it becomes the manual value on save).
- `Przywróć automatyczne`: PATCH `null` immediately, keep the previous manual text in view state,
  and show `Przywrócono automatyczne źródło.` + `Cofnij` until the next edit of the field, leaving
  the Reel, or 30 s. `Cofnij` saves the previous text back through the normal field save.
- `composePublicationText(description, source, hashtags)`: the **current editable values,
  including unsaved edits** (source = the effective text shown in the field). A part is empty only
  when it is `''`. **No trimming or rewriting.** Non-empty parts are joined by exactly `\n\n`, with
  no added leading/trailing newlines. Clipboard success/failure/fallback behaviour is unchanged.
  All call sites updated.

### Allowlist
`packages/source-fetch/src/**` (+ tests), `apps/worker/src/ai/source.ts`,
`apps/worker/src/ai/source.test.ts` (import paths only), `apps/worker/src/ai/actions.ts`
(the one prompt sentence only), new `apps/api/src/source/**`, `apps/api/src/core/{repository,routes,mapping}.ts`,
`apps/api/src/app.ts`, `apps/api/src/runtime/api.ts`, new `apps/api/src/source-metadata*.test.ts`,
`apps/web/src/screens/PublicationSection*`, `apps/web/src/data/{publication,api}.ts`,
`apps/web/src/controllers/useAppController.ts`, `apps/web/src/ui/detail-sections*`,
`apps/web/src/ui/screen-contracts.ts`, adjacent web tests. Anything else: ask the root.

### Acceptance (Luna runs before handoff)
- Extraction fixtures (saved HTML, no live calls):
  - JSON-LD NewsArticle with author and date;
  - `@graph` publisher;
  - OG-only;
  - meta author only;
  - two and three authors;
  - an author equal to the site;
  - a URL-valued `article:author`;
  - invalid and future dates;
  - malformed JSON-LD;
  - a social post with no metadata (→ `partial`, host line).
  - Expected lines asserted exactly.
- The guard is preserved: a private/loopback address, a redirect to a private address, an
  oversize body and a timeout are each refused (reuse the existing worker test cases through the
  package).
- API:
  - create with a URL → `pending` with the host line, version 1;
  - a completed fetch changes `source_metadata` only; `version` and `updated_at` are unchanged;
  - an older `requestId` can't overwrite a newer one;
  - a refresh within 30 s of a pending fetch doesn't enqueue; refresh is idempotent on `operationId`;
  - no URL → `no_url`;
  - PATCH `publicationSource` is version-checked, `null` restores automatic, and 1001 chars → 422;
  - the fetch failing → `failed` with the host line, and capture still 201;
  - a soft-deleted Reel is skipped.
- Worker: `source.test.ts` passes unchanged; the publication prompt contains the new sentence.
- Web:
  - `composePublicationText` for all 8 empty/non-empty combinations (exact strings), plus
    whitespace-only and leading/trailing-newline parts copied unmodified, and an unsaved edit in
    each of the three fields;
  - each §A state renders its line and action; at 320 px the action wraps below the line;
  - typing turns automatic into manual; clearing stores `''`; `Przywróć automatyczne` sends `null`;
    `Cofnij` restores the exact previous text and expires after the next edit or 30 s;
  - polling stops on a non-pending state, switches to the "longer than usual" row after 4 min, and a
    re-read during typing leaves every field's unsaved text intact.
- One `npm run build` and `npm run typecheck` pass, targeted test suites, and a local Chrome run at
  360/390/1100 px of PUBLIKACJA (fake fetch).

---

## 2. IDEAS-PLAN — ideas in NIEZAPLANOWANE

### Behaviour (authority: T00 IDEAS-PLAN amendment, delta spec §B)
- API, in the existing PATCH path (`repository.ts`, plan handling around the
  `plannedPublicationDate` logic):
  - promotion happens only on **first assignment of a date**: the stored
    `planned_publication_date` is null before the write, the PATCH sets it to a non-null date, the
    current status is `idea`, and the PATCH doesn't contain `status`. Then also set
    `status = 'to_record'` in the same version-checked write;
  - every existing side effect of entering `to_record` from `idea` applies exactly as for an
    explicit status change (follow the same code path, no copy).
  - Clearing or moving the date never changes status. An explicit `status` in the same PATCH
    wins.
- Web:
  - `data/planner.ts`: the unscheduled candidates include `idea`. Order is non-ideas (today's
    order), then ideas (same order). `groupPlanner` exposes the two parts separately so the pane
    can render the sub-label.
  - `unscheduledEmptyLabel` counts ideas too.
  - `PlannerPane`: the divider and `POMYSŁY · n` sub-label.
  - `ScheduleSheet`: the quiet idea line when the Reel is an idea.
  - After a successful schedule of an idea from any path, show the transient
    `Przeniesiono do „Do nagrania”`, decided from the server response (status changed from `idea`
    to `to_record`), never guessed client-side.
  - Under the `POMYSŁY` sub-label, the quiet hint `Zaplanowanie zmieni status na „Do nagrania”.`
    on every layout. The sheet's idea line appears only for an idea **without** a date.
  - Desktop drag of an idea onto a day works like any card.

### Allowlist
`apps/api/src/core/repository.ts` (PATCH plan/status logic only), `apps/api/src/planner.test.ts`
(or a new `ideas-plan.test.ts`), `apps/web/src/data/planner.ts`, `apps/web/src/screens/{PlannerPane,ScheduleSheet}*`,
`apps/web/src/controllers/useAppController.ts` (schedule notice only), `apps/web/src/app/App.tsx` (wiring only),
`apps/web/src/data/tests/planner.test.mjs`, `apps/web/src/ui/screen-contracts.ts` (copy only).
Anything else: ask the root.

### Acceptance
- API:
  - unplanned idea + date → `to_record` (version +1, one write);
  - an idea that **already has a date** (created by an explicit `status: 'idea'` PATCH) moved to
    another date or slot → stays `idea`;
  - `to_record`/`editing`/`ready` + date → status unchanged;
  - idea + date + explicit `status: 'idea'` → stays `idea`;
  - unplan after promotion → `to_record`;
  - date move/slot change → status unchanged;
  - stale version → 409, with neither the plan nor the status changed;
  - the idea→to_record side effects equal those of an explicit transition.
- Web:
  - `planner.test.mjs` passes in Europe/Warsaw, UTC and America/Los_Angeles;
  - ideas listed after non-ideas, each part in its existing order;
  - sub-label only when ideas exist;
  - the empty label is correct in all 4 combinations;
  - the notice appears only when the response shows the promotion;
  - the `POMYSŁY` hint renders in both the pane and the screen variants; the sheet line shows for an
    unplanned idea and not for a dated one.
- Local Chrome at 360/390/1100 px: NIEZAPLANOWANE with both parts; scheduling an idea from the sheet
  and by drag (1100 px).

---

## 3. Handoff (each task, separately)

Owned files changed; exact commands and exact results; the §Acceptance list item by item; known
limitations; explicit UNVERIFIED gates (live sites for SOURCE-01 extraction quality, DEV,
Android); commit id. Do not merge.

Coordination: both tasks edit `repository.ts` and `useAppController.ts` in different places. The
root integrates IDEAS-PLAN first (smaller), then SOURCE-01 rebased on it.

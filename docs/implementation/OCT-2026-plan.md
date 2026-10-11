# October 2026 plan — source attribution, ideas in the planner, kDrive layout, streams

Status: **operator decisions recorded 2026-10-01 (§0)**. Migration numbers renumbered 2026-10-11: 0016 is taken by STREAM-LIVE-01 (operator-approved), so STREAM-01 uses 0017 and STREAM-02 0018. Draft plan, root-owned. Nothing here is
dispatched. Before each task starts, the root presents task, model, files and acceptance for explicit
approval (AGENTS.md), and pins that task's T00 amendment, contracts and migration first.

Order and dependencies:

| Task | Size | Depends on | Migration |
| --- | --- | --- | --- |
| SOURCE-01 — Źródło field | small–medium | — | 0014 |
| IDEAS-PLAN — ideas in NIEZAPLANOWANE | small | — | none |
| KDRIVE-03 — folder layout | medium | GATE: kDrive move probe | none (or 0015 if a column is needed) |
| STREAM-01 — stream format and topics | large | SOURCE-01, IDEAS-PLAN; visual spec delta | 0017 |
| STREAM-02 — AI per topic | large | STREAM-01 | 0018 |

SOURCE-01 and IDEAS-PLAN are independent and can run in parallel worktrees. KDRIVE-03 can create
`Streamy/` only after STREAM-01 exists; until then it ships `Rolki/` and `Memy/`.

## 0. Operator decisions (2026-09-30 / 2026-10-01)

1. **Source attribution** lives in a separate, editable `Źródło` field, auto-filled from the
   source link's metadata. Format `Źródło: <autor>, <serwis>, <DD.MM.RRRR>`; each part is dropped
   when unknown; the date (article publication date) is included whenever known. `Kopiuj opis`
   includes it.
2. **kDrive layout** by type, then month: `Rolki/<RRRR-MM>/`, `Streamy/<RRRR-MM>/`, `Memy/`. The
   month is the **planned publication month**; a Reel without a date lives in `Bez terminu/`;
   rescheduling into another month (or planning/unplanning) moves the folder.
3. **Stream** is a container of topics with the Reel's planning, status, editor, materials and
   publication, plus per-topic notes/script and (phase 2) AI per topic. Stream and weekly long video
   are **one format** for now (`Stream`).
4. **Two topic types:** *linked Rolka* (an independent Reel the stream only references) and
   *absorbed idea* (an idea that becomes part of the stream). Adding a `Pomysł` absorbs it by
   default, with an option to link it instead; a Reel at `Do nagrania` or later is always linked.
5. **Ideas in the planner:** `Pomysł` items appear in NIEZAPLANOWANE, below the other statuses.
   Scheduling an idea moves it to `Do nagrania`; unscheduling never changes status.
6. **Stream copy:** `Kopiuj opis` on a stream lists **one Źródło line per topic**.
7. **Stream deletion (2026-10-01):** absorbed ideas are deleted and restored together with their
   stream; to keep one, detach it first. Referenced Reels are never affected (delta spec D9).

---

## 1. SOURCE-01 — `Źródło` field

### Behaviour
- New field **Źródło** in PUBLIKACJA, between Opis and Hashtagi (visual: `design/oct-2026-delta-spec.md` §A).
- **Automatic value is derived, not written into user content.** When a Reel has a source URL
  (`originalInput.url`, else the first URL in the captured text), the API fetches the page's
  metadata in the background and stores it in a derived cache `source_metadata`, including the
  server-formatted line. The **effective source** is `publicationSource ?? sourceMetadata.line ?? ''`.
  `publicationSource` stays `null` (automatic) until the user edits the field. So a background fetch
  never overwrites or races a user edit, and never bumps the Reel version.
- `Odśwież` / `Ponów` refetch the metadata (explicit, idempotent on `operationId`).
  `Przywróć automatyczne` is an ordinary version-checked PATCH `publicationSource: null`.
- A fetch failure never fails capture. Existing Reels have `source_metadata = null`; they show
  `Pobierz` (delta spec §A) and nothing is backfilled automatically.

### Extraction (deterministic, no AI)
Priority per part, first hit wins:
- **Author:** JSON-LD `NewsArticle|Article|BlogPosting.author.name` → `meta[name=author]` →
  `meta[property=article:author]` (only when not a URL) → `meta[name=parsely-author]`.
  Two authors → `A i B`; more → `A i in.` Organisation-as-author equal to the site name is dropped.
- **Site:** JSON-LD `publisher.name` → `og:site_name` → `application-name` → host without `www.`.
- **Date:** JSON-LD `datePublished` → `article:published_time` → `meta[name=date|pubdate]` →
  `<time datetime>` inside the article. Rendered `DD.MM.RRRR` in Europe/Warsaw; invalid/future → dropped.
- Output `Źródło: ` + non-empty parts joined by `, `. Social posts without metadata fall back to
  the site (e.g. `Źródło: instagram.com`).
- Fetch reuses the existing SSRF-guarded retriever (`apps/worker/src/ai/source.ts`
  `retrievePublicSource`: per-hop DNS pinning, redirect limit, size limit, timeout), moved into a
  shared module so the API can call it without a second fetch implementation. HTML `<head>` and
  JSON-LD only; nothing else from the page is stored.

### Data / contracts
- Migration 0014: `app.reels.publication_source text null` (user value; `null` = automatic, `''` =
  explicitly empty), `app.reels.source_metadata jsonb null` (derived cache, see handoff for shape).
- Contract: `Reel.publicationSource: string | null` (PATCHable, version-checked, ≤ 1000 chars),
  `Reel.sourceMetadata: SourceMetadata | null` (read-only); `POST /api/v1/reels/:id/source-metadata/refresh`
  `{ operationId }` → 202 with the pending metadata.
- The fetch reuses the worker's SSRF-guarded retriever, moved into a new workspace package
  `@szronox/source-fetch` used by both worker and API (root pins the package skeleton, root build
  order and lockfile).
- **Kopiuj opis** (amends T00 "copy publication text"): non-empty parts in order description,
  effective source, hashtags, joined by exactly two newlines. Still no persistence side effect, truthful
  clipboard failure.
- `Wygeneruj opis` prompt gains: never write a source line into the description (it is separate).

### Acceptance
Unit fixtures for JSON-LD, OG-only, author-less, multi-author, invalid date, social-post pages;
SSRF guard reused (private address refused); a background fetch never changes `version` or
`publicationSource`; refresh re-fetches without touching `publicationSource`; copy composition for all 8 empty/non-empty combinations; capture succeeds when the fetch
fails. Live: one real Polish news URL on DEV after separate deployment approval.

---

## 2. IDEAS-PLAN — ideas in NIEZAPLANOWANE

### Behaviour
- NIEZAPLANOWANE = not deleted, no planned date, status in `idea | to_record | editing | ready`.
  Non-ideas first in today's order (priority, then newest), then ideas in the same order, each idea
  marked with the existing `Pomysł` status label.
- **Scheduling an idea** (drag onto a day, list `Zaplanuj`, Detail `Zaplanuj publikację`): a PATCH
  that gives an `idea` a date **for the first time** (stored date null → non-null) also sets status `to_record`
  **in the same version-checked write**, server-side, so every path behaves the same. Response
  carries the new status; the UI shows the transient `Przeniesiono do „Do nagrania”` (delta spec §B).
- Unscheduling, moving between days, or changing the slot never changes status. This includes
  an idea that already holds a date.
- A PATCH that sets a date **and** an explicit status keeps the explicit status (no inference
  over an explicit choice).

### T00 amendment (CONTENT-PLANNER-01)
Replace "A plan change never changes `status`…" with: a plan change never changes any other field,
**except** that first giving an `idea` a date (null → date) promotes it to `to_record` in the same write. Replace
the NIEZAPLANOWANE definition as above. No new status.

### Acceptance
API: idea + date → `to_record`; non-idea + date unchanged; explicit status wins; unplan keeps
`to_record`; stale → 409. Web: ordering, label, drag of an idea onto a day, notice copy.

---

## 3. KDRIVE-03 — folder layout

### Layout (under `KDRIVE_ROOT_FOLDER_ID`)
```
<base>/
├─ Rolki/
│  ├─ Bez terminu/
│  └─ 2026-10/  <Reel title> [1a2b3c4d]/
├─ Streamy/
│  ├─ Bez terminu/
│  └─ 2026-10/  <Stream title> [9f8e7d6c]/
└─ Memy/
```
- `Rolki`, `Streamy`, `Memy`, `Bez terminu` and `RRRR-MM` folders are found by exact name under
  their parent first and created once when missing (same lookup-before-create and ambiguous-create
  reconciliation as Reel folders). Ids are cached in memory, never assumed.
- `Memy` replaces the KDRIVE-02 name `SzroNox Memy` (DEV has 0 memes; no copy exists to move).
  `KDRIVE_MEME_FOLDER_ID` keeps overriding.
- **Create** places the folder in the parent derived from format + planned month.
- **Move.** After a committed plan change that changes the target parent (date set, cleared, or
  moved across months), the API enqueues a move of the Reel's folder. Moves run in the existing
  bounded in-process queue (as meme copies): idempotent, 3 attempts with backoff, then a quiet
  `Nie udało się przenieść folderu · Ponów` in MATERIAŁY. A failed move never fails or reverts the
  plan change. The Reel stores `{ driveId, folderId }`; uploads, links and `Otwórz` keep working
  because they use the id, not the path.
- **Only SzroNox-layout folders move:** a folder that is not inside `<base>` (e.g. manually linked
  from elsewhere) is never moved.
- **Lookup by tag** searches the expected parent first, then `Bez terminu` and the type folder's
  months (bounded), so a folder moved by a previous attempt is found again, never duplicated.
- Nothing in kDrive is deleted or renamed; empty month folders are left in place.

### Reorganisation of existing folders
One-off operator CLI `reorganize-kdrive-folders` (dry-run default, `--apply` to move), idempotent,
DEV only with approval. Moves every SzroNox-tagged Reel folder directly under `<base>` into its
target parent.

### GATE (before dispatch)
Live probe on the disposable DEV folder `1349`: kDrive v3 move of a folder (endpoint, response,
behaviour on name collision in the destination, idempotency on replay, whether the file id is
preserved). Recorded in `KDRIVE-03-probe.md`; the build proceeds only on a confirmed id-preserving
move.

### T00 amendment (KDRIVE-01a)
"Nothing existing in kDrive is deleted, renamed, moved or written" → SzroNox may **move a Reel
folder it holds inside its own layout** when the plan's month changes, and create the fixed type,
`Bez terminu` and month folders. Still no delete, rename, or write outside `<base>`.

### Acceptance
Fake kDrive: create lands in the right parent for each format/date; plan change enqueues exactly one
move; move failure leaves the plan; replay is a no-op; folder outside `<base>` never moved; tag
lookup finds a moved folder; CLI dry-run lists, apply is idempotent. Live: probe only, then a
separate DEV acceptance after deployment approval.

---

## 4. STREAM-01 — stream format and topics

### Model
A stream **is a Reel** with `format = 'stream'`, so planning, the five statuses, editor,
verification, kDrive folder, export upload, feed cover, description/hashtags/Źródło and soft
delete all apply unchanged. What is new is an ordered topic list.

- Migration 0017:
  - `app.reels.format text not null default 'reel' check (format in ('reel','stream'))`. Chosen at
    creation, not changeable in v1. Existing rows are `reel`.
  - `app.reels.absorbed_into uuid null references app.reels(id)` — set on an idea absorbed into a
    stream; such a Reel is hidden from lists, planner and search (not deleted, not a status).
  - `app.stream_topics(id uuid pk, stream_id uuid fk reels, position int, kind text check in
    ('absorbed','linked'), source_reel_id uuid fk reels not null, title text, notes text, script
    text, created_at, updated_at, unique(stream_id, source_reel_id))`. Topic edits are versioned
    through the stream's `version`.
- **Absorbed topic:** `source_reel_id` is the original idea; its capture (`originalInput`),
  `inputNote`, `script`, `publicationSource`/`sourceMetadata` become the topic's material (read
  through the source Reel; the topic's title/notes/script are the editable copy). **Odłącz** clears
  `absorbed_into`, writes the topic's current title/notes/script back to the idea, and removes the
  topic — the idea returns to the list as a `Pomysł`.
- **Linked topic:** references an independent `format='reel'` Reel; the stream shows its title,
  status and Źródło live and never edits it. Removing the topic only removes the reference.
- **Rules:** an idea may be absorbed or linked (default absorbed); `to_record` and later only
  linked; a stream is never a topic; one Reel at most once per stream; an absorbed idea belongs to
  exactly one stream. Absorbing/linking/reordering/removing are version-checked stream mutations
  with `operationId`.

- **New topic** (`+ Nowy temat`): creates a hidden absorbed idea from a title, plus an optional link
  and note. This is the one exception to the capture rule "text, URL or image required": a stream
  topic may start with a title only. Created only on explicit `Dodaj`.
- **Topic edits:** title/notes/script autosave as version-checked stream mutations; switching topics
  flushes first and never drops unsaved text (delta spec D4).
- **No AI on streams in STREAM-01:** every AI entry point is absent from the UI (delta spec D2/D3),
  and the API refuses AI actions on `format='stream'` with `422 VALIDATION_ERROR`
  `reason: not_available_for_stream`. Publication copy is manual.
- **Deleting/restoring (operator-approved 2026-10-01):** absorbed ideas
  share their stream's lifecycle. Soft-deleting a stream soft-deletes its absorbed ideas with it, and
  restoring it restores them in place. `Usunięte` lists only the stream. A deleted referenced Reel
  stays as a muted `Usunięta rolka` row. Wording: delta spec D9.

### UI
Authority: `design/oct-2026-delta-spec.md` §D (Astra-reviewed draft). In the UI the topic kinds are
called `Temat streamu` (absorbed) and `Odwołanie` (linked). The picker's choices are
`Przenieś do streamu` / `Dodaj odwołanie`, each with its consequence line. The stream marker is the
pictogram plus the word `Stream`.
- Planner: streams schedule exactly like Reels; same slot rules.
- **Kopiuj opis for a stream:** description, then one `Źródło: …` line per topic in topic order
  (topics without a source line are skipped; duplicates removed), then hashtags; sections joined by
  two newlines, source lines by one newline. Nothing is trimmed or rewritten.
- `Utwórz folder` for a stream creates under `Streamy/` (KDRIVE-03).

### Explicitly not in STREAM-01
AI actions on a stream or topic (STREAM-02), separate long-video format, live-stream tooling,
per-topic exports.

### T00 amendment
New section STREAM-01 recording the model, the absorbed/linked rules, the hidden-not-deleted
absorbed idea, the shared delete/restore lifecycle, the title-only topic exception, the AI refusal, and
the stream copy composition. "Five statuses only" unchanged.

---

## 5. STREAM-02 — AI per topic (outline only)

Opracuj, Sprawdź fakty and programme search run **per topic**, using that topic's sources and
script; results land on the topic (hooks are not generated for topics in v1). Needs: `ai_runs`
gains nullable `topic_id`; evidence and Użyj-korekty targets scoped to topic fields; one run per
topic action at a time. Detailed plan written after STREAM-01 lands — it touches frozen AI
contracts and prompts, which are not frozen for wording but are for behaviour.

---

## 6. Open items before dispatch

- Visual spec delta for: Źródło field, idea marker in NIEZAPLANOWANE, stream marker, TEMATY section
  and topic picker, folder-move failure line (root writes, operator approves).
- KDRIVE-03 move probe (needs separate approval for a live call on folder `1349`).
- Per-task model, worktree and allowlist proposals for approval.

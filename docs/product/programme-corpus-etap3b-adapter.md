# C — ETAP 3B input adapter and enrichment revisions

Status: operator documentation, prepared 2026-09-21 for CORPUS-02. Implements
`docs/implementation/CORPUS-02-etap3b-dispatch.md` against the CORPUS-01 bundle format
(`docs/product/programme-corpus-operator-bundle.md`) and content specification
(`docs/product/programme-corpus-spec.md`). Where this document and either of those disagree,
the content specification wins.

The adapter reads the ETAP 3B canonical dataset and a small hand-authored companion manifest,
and writes the four bundle files (`manifest.json`, `vocabulary.json`, `proposals.json`,
`coverage.json`) the unmodified `validate`/`import`/`approve`/`activate` commands already
consume. It never touches a database, never contacts a model, and never repairs the source
data — a malformed or missing input is reported, not guessed.

---

## 1. Running it

```
npm run build --workspace @szronox/api

node apps/api/dist/ai/import-programme-cli.js etap3b-adapt Program
node apps/api/dist/ai/import-programme-cli.js validate     Program --report report.json
```

`Program/` must contain, unchanged, exactly as supplied:

- `Finalszronox_programme_proposals.json` — the canonical proposal dataset (1423 records)
- `Finalszronox_programme_metadata(2).json` — controlled tags, tagging-rule notes, the
  operator's section code map, page count, source hash
- `Finalszronox_programme_coverage.json` — one entry per section (151), including the 10 with
  zero proposals
- `ProgramSzroNox.pdf` / `.docx` — the archived source, basenames matching the companion
  manifest
- `etap3b.manifest.json` — the companion manifest (§2 below)

`etap3b-adapt` writes `manifest.json`, `vocabulary.json`, `proposals.json` and `coverage.json`
into the same directory, alongside (never overwriting) the canonical `Finalszronox_*` inputs.
From that point the directory is an ordinary CORPUS-01 bundle; `validate`/`import`/`approve`/
`activate` run exactly as documented in `docs/product/programme-corpus-operator-bundle.md`,
completely unmodified by this adapter.

`Finalszronox_programme_qa(2).json` (the CORRECTED/REMOVED/MERGED audit trail against the
1456-record ETAP 3A output) is not read by the adapter. It documents how the 1423 final
records were produced, which is ETAP 3B's own grounding-verification evidence, not something
this task re-derives; it is kept beside the other inputs for the operator's own reference.

## 2. The companion manifest (`etap3b.manifest.json`)

A small, hand-authored file the operator maintains — everything the canonical ETAP 3B files
cannot supply themselves: release/document identity, admission, and ingestion policy. See
`Program/etap3b.manifest.json` for the checked-in example. Three `version` fields are
overwritten by the adapter regardless of what the companion contains
(`source_sha256`, `page_count` from `metadata.authoritative_pdf_page_count`,
`dataset_file_name` fixed to `proposals.json`); every other field passes through verbatim,
including `category_vocabulary_id`, which the adapter also uses to label the vocabulary file
it writes — the two are never allowed to drift apart.

**Pinned identifiers**, per the CORPUS-02 handoff: `corpus_id: zieloni-programme`,
`release_id: zieloni-programme-2026-draft-r1`. Not invented: `version.adopted_at` stays
`null` (this is a draft, not a Congress-adopted programme) and `version.source_url` stays
`null` — no formal adoption date and no public URL exist for this snapshot, and the importer
enforces that by requiring `document.admission_amendment` to be present whenever `adopted_at`
is null (`admission_refused` otherwise), and `unpublished_source: true` whenever `source_url`
is null (`source_url_missing` otherwise). The amendment's `approved_by`/`approved_at` record
who admitted the *draft snapshot* to the corpus for testing — a separate act from the named
release **approval** the `approve --by` command still requires before activation.

## 3. Field mapping

| ETAP 3B field | Bundle field | Rule |
| --- | --- | --- |
| `proposal_id` | `proposal_id` (→ `external_id`) | Verbatim. Never regenerated. |
| `chapter` | `chapter` | Verbatim. |
| `section` | `subchapter` | Verbatim, never null. ETAP 3B's (chapter, section) pair is exactly the 151-way partition the bundle's (chapter, subchapter) pair models (`metadata.section_count === 151`). |
| — | `section_id` | Derived. `metadata.section_code_map`'s `chapter_code-section_code`, lower-cased, for the 146 sections that have one; for the remaining 5, the chapter's own code (shared with its other sections) plus a deterministic slug of the section name. |
| — | `order_index` | Adapter-assigned: position within the section, in dataset order. Not a source-declared field — ETAP 3B carries no ordering. |
| — | `title` | The first sentence of `proposal_text`, via the same deterministic sentence-boundary rule chunks are split on (`apps/api/src/ai/corpus/chunking.ts`'s `sentenceStarts`). Always an exact prefix of the text — never a paraphrase, never fails the verbatim-title check. Longer than the 500-character bundle limit: cut at the last word boundary under it. |
| — | `category` | Left absent. The companion manifest sets `category_from_primary_tag: true`, the existing bundle mechanism — category is resolved once at import from the vocabulary label and stored as a plain column, untouched by enrichment revisions (§5). |
| `primary_tag`, `secondary_tags` | same | Slugified (ASCII, diacritics transliterated explicitly, e.g. `gospodarka obiegu zamkniętego` → `gospodarka-obiegu-zamknietego`) to match vocabulary entry ids. A record with more than four secondary tags is **rejected**, not truncated. |
| `pdf_page` / `pdf_pages` | same | Passed through verbatim; the bundle format's existing either-or already matches this shape. |
| `keywords` | same | Passed through verbatim (already NFC Polish text). |

**Tag slugging and retrieval.** `tags_text` (used at ranking weight B) loses diacritics through
slugging, but `keywords_text` (weight A) and `chapter`/`subchapter` (weight C) keep the
original Polish text unchanged — the primary search signal is unaffected. This is a documented
tradeoff, not a regression.

## 4. Vocabulary

`vocabulary.json` is built from `metadata.approved_controlled_tags` (53 entries): id =
`slugify(tag)`, label = the tag's own Polish text. Where a tag participates in one of
`metadata.tagging_rules`'s six disambiguation notes (e.g. `środowisko_vs_przyroda`), that note
becomes the entry's `definition` — real operator-authored guidance, not invented text. A tag
outside every documented pair gets an explicit placeholder definition
(`Kontrolowany tag ETAP 3B; zobacz metadata.approved_controlled_tags.`). `definition` is
ingestion documentation only; it never reaches `ProgrammeCitation` or the UI, which is what
makes this synthesis safe — unlike printed page labels or grounding offsets (§6), which do
reach a citation and are never fabricated.

## 5. Empty sections

10 of the 151 sections have zero proposals (mostly chapter introductions). Retaining them
required a small, general extension to the existing pipeline (not specific to ETAP 3B):
`bundle.ts`'s `LedgerSection` gained optional structural fields (`chapter`, `subchapter`,
`order_index`, `start_pdf_page`, `end_pdf_page`), and `validate.ts` now seeds the section set
from the coverage ledger first, then verifies proposal-derived sections agree with it, instead
of building sections from proposals alone. The adapter populates these fields for all 151
`coverage.json` entries; `repository.ts` already inserted every `validation.sections` row
regardless of proposal count, so no change was needed there.

The page-level ledger (`coverage.json`'s `pages` array) is built independently, purely from
which physical pages the validated proposals actually touch — **not** from `coverage.json`'s
section page ranges, because those ranges are not mutually exclusive (a page can close one
section and open the next). A page no proposal touches is `excluded` with a stated reason; the
real corpus has five such pages (1, 30, 52, 118, 145).

## 6. What is genuinely missing, and reported rather than guessed

**`printed_page_labels`.** None of the four canonical ETAP 3B files supply the 154 printed
page labels the bundle format requires. The adapter does not invent them. `validate` reports
`printed_labels_invalid` until the operator supplies this array (front matter pages recorded
as `""`, never omitted, never back-filled with the physical page number) — this is the
"otherwise report the missing companion input" case the CORPUS-02 handoff names explicitly.

## 7. A line-join fix discovered while validating the real dataset

Running `validate` against the real PDF/dataset pair surfaced 15 `passage_not_found`
findings, all traced to one mechanism: `assembleDocument` (in `normalize.ts`) was joining a
page's extracted lines with a blind single space (`kept.join(' ')`), so a word wrapped across
a line break at a hyphen (`"agencj-"` / `"ach wykonawczych"`, two separate extracted lines)
kept a stray space at the join (`"agencj- ach"`) instead of joining per corpus specification
§3 ("join words hyphenated across line breaks"). This mechanism existed before CORPUS-02 but
was never actually reachable for PDF-extracted text — the pre-existing hyphen-join regex
inside `normalizePassage` only fires on a string that still contains an embedded `\n`, and
page-assembly always splits lines (and removes their newlines) before normalizing each one
individually.

Fixed with a new `joinHyphenatedLines` function used in place of the blind join: a line ending
in a hyphen **directly attached** to a letter or digit joins with the next without a space —
the hyphen is dropped for a letter (`agencj-` + `ach` → `agencjach`, per spec) and kept for a
digit (`35-` + `krotności` → `35-krotności`, since the hyphen is part of the token, not an
inserted wrap). A hyphen used as standalone punctuation (a dash with a space on each side,
`"pozarządowych - oraz"`) is left alone — the "directly attached" check (no space between the
letter/digit and the hyphen) is exactly what tells the two apart, and an earlier version of
this fix without that check wrongly collapsed two such dashes before the real-data run caught
it.

Net effect on the real corpus: 1408 → 1411 of 1423 proposals now ground successfully (three
additional records fixed: `SZR-CIV-ANTI-006`, `SZR-ANM-VET-003` were false alarms from an
intermediate version of the fix and are not part of the final count — see
`docs/implementation/CORPUS-02-result.md` §4 for the precise before/after). Regression-tested
in `apps/api/src/corpus-etap3b.test.ts` (`joinHyphenatedLines` unit tests) and confirmed against
the full existing `corpus.test.ts` suite, unchanged.

**12 records still fail `passage_not_found` after this fix**, for reasons outside this
adapter's or this normalization function's scope — see
`docs/implementation/CORPUS-02-result.md` §5 for the itemized root-cause breakdown (a
hyphen-retention judgment call our deterministic pipeline cannot make without a dictionary; a
distinct stray-space extraction artifact unrelated to hyphenation; one subscript-digit
encoding difference; one apparent footnote-content bleed; one case where ETAP 3B's own curated
text drops a bullet dash present in the raw PDF). None of these is fixed here — doing so would
mean either guessing at linguistic judgment or further, separately-scoped extraction-pipeline
work.

## 8. Enrichment revisions

Migration 0007 replaces the blanket immutability trigger on `app.programme_proposals` with a
narrower one: only `primary_tag`, `secondary_tags`, `keywords`, `keywords_raw` (and their
derived `keywords_text`/`tags_text`) may change; every other column — including `category` —
raises `programme_proposals_enrichment_only`'s exception if touched. `DELETE` stays fully
blocked. Every revision is recorded in the new append-only
`app.programme_proposal_enrichment_revisions` table (previous/new values, a SHA-256 checksum,
the operator, a revision number scoped to the proposal).

```
node apps/api/dist/ai/import-programme-cli.js revise-enrichment <release-slug> <external-id> \
  --by "Imię Nazwisko" --primary-tag <slug> [--secondary-tags a,b] [--keywords a,b,c]
```

Owner-role only, like `import`/`approve`/`activate` — no API route, no worker change, no new
runtime-role grant. New tags are validated against the **release's pinned vocabulary
snapshot** (`programme_vocabulary_entries`), not the live `vocabulary.json` file, so a revision
is bound to what the release was actually approved against. A source change (text, pages,
structure) still requires a new document version and release, exactly as before; only tagging
and keywords can move without one.

## 9. Retrieval: short controlled terms

`retrieval.ts`'s `searchTerms()` kept only runs of four or more letters, which dropped `AI` and
`UE` — both controlled-vocabulary terms in `metadata.approved_controlled_tags` and both real
search intent. A small named allow-list (`ai`, `ue`) now survives alongside the existing
four-letter rule, rather than lowering the general threshold, which would reopen the noise
problem that rule exists to prevent. No other retrieval behaviour changed: the eight-candidate
cap, the worker's three-candidate selection, dedup-by-proposal, invented-id rejection and the
"no active release is an explicit error" behaviour are unchanged CORPUS-01 code.

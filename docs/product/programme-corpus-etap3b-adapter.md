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

## 6. Printed page labels

**Resolved in CORPUS-03.** None of the four canonical ETAP 3B files supply printed page
labels, and the adapter never invents them — CORPUS-02 correctly reported
`printed_labels_invalid` rather than guess. CORPUS-03 established, by rendering and visually
inspecting representative pages (1, 77, 154) of `ProgramSzroNox.pdf` and exhaustively scanning
all 154 pages' extracted text for any candidate label line, that **this document has no
printed pagination at all** — not a gap in the supplied files, a genuine property of the
source. Per corpus specification §4, the honest encoding of "no printed pagination" is 154
empty strings, one per physical page, supplied in `Program/etap3b.manifest.json`'s
`version.printed_page_labels` — not omitted, not back-filled with the physical page number.

## 7. Fixes found and applied while validating the real dataset (CORPUS-02 → CORPUS-03)

Running `validate` against the real PDF/dataset pair first surfaced 15 `passage_not_found`
findings (CORPUS-02), traced to `assembleDocument` (in `normalize.ts`) joining a page's
extracted lines with a blind single space (`kept.join(' ')`) — so a word wrapped across a
line break at a hyphen kept a stray space at the join (`"agencj- ach"`) instead of joining, per
corpus specification §3. This mechanism existed before CORPUS-02 but was never actually
reachable for PDF-extracted text — the pre-existing hyphen-join regex inside `normalizePassage`
only fires on a string that still contains an embedded `\n`, and page-assembly always splits
lines (and removes their newlines) before normalizing each one individually. CORPUS-02 fixed
this with a new `joinHyphenatedLines` function, used in place of the blind join: a line ending
in a hyphen **directly attached** to a letter or digit (no space before it — which is exactly
what distinguishes it from standalone punctuation like `"pozarządowych - oraz"`, left alone)
joins with the next without a space. That mechanism fix alone brought grounding from
1408 → 1411 of 1423, leaving 12 `passage_not_found` findings, reduced to **0** by CORPUS-03's
further fixes below — each one verified by rendering the actual PDF page and confirmed against
the full 1,423-record dataset, not guessed from the ETAP 3B text alone.

| Root cause | Records | Fix |
| --- | --- | --- |
| Line-join never reached PDF text at all | (mechanism gap; no record count) | CORPUS-02: new `joinHyphenatedLines`, used at the real per-page join site instead of a blind `kept.join(' ')` |
| Compound-word hyphen wrongly dropped | 4 (`MIR-PIB`, `doradczo-rozwojowych`, `społeczno-ekonomicznego`, `przyczynowo-skutkowych`) | CORPUS-03: `joinHyphenatedLines` always retains an attached hyphen (this document performs no automatic syllable hyphenation; every attached hyphen at a wrap is real, confirmed with zero regressions across all 1,423 proposals) |
| False-positive mid-word space from a PDF glyph-gap heuristic | 5 (`agencj\|ach`, `systemoweg\|o`, `zawsz\|e`, `odb\|yciu`, `wykluczon\|ych`) | CORPUS-03: `pdf-text.ts`'s `assembleLines` gap multiplier raised 0.22 → 0.4× font size, calibrated against every gap in the whole document (detail below) |
| Subscript-digit encoding (`CO₂` vs `CO2`) | 1 (`SZR-ENG-NFMPP-014`) | CORPUS-03: `normalize.ts` gained a `SUBSCRIPT_DIGITS` table, same class of fix as the existing ligature table |
| Footnote text spliced into body flow by stream-order reading | 1 (`SZR-ECO-GREEN-005`) | CORPUS-03: no code change — declared the footnote's two lines in `etap3b.manifest.json`'s `header_footer.drop_exact_lines` |
| Genuine content divergence (PDF has a real list-bullet dash; ETAP 3B's curated text dropped it) | 1 (`SZR-EDU-EE-002`) | CORPUS-03: corrected `Finalszronox_programme_proposals.json`'s `proposal_text` after user approval — see `docs/implementation/CORPUS-03-result.md` for the exact before/after |

**The glyph-gap threshold, in detail.** `pdf-text.ts`'s `assembleLines` inserts a
space between two horizontally-separated text fragments when the gap exceeds a multiple of the
font size — this is what lets a PDF that positions words individually still yield word
boundaries. Instrumented against the whole 154-page document: filtering to space-insertions
between two letters where *neither* side already carries its own explicit space glyph (i.e.
the position heuristic is the *only* thing providing the space) found exactly 6 events in the
entire document, at gap/fontSize ratios 0.242–0.341 — all false positives, none a real word
boundary (confirmed by rendering the affected pages: e.g. "agencjach" on page 26 reads as one
normal, tightly-set word). The widest ratio among the genuine same-word letter-pairs correctly
left unjoined anywhere in the document is 0.177 — a clean separation. Raising the multiplier to
0.4 sits comfortably above every observed false positive and cannot create a new false negative
here, because every real inter-word gap in the whole document already carries its own explicit
space-glyph fragment (so the position heuristic is never actually the only signal for a
genuine word boundary in this document).

Regression-tested in `apps/api/src/corpus-etap3b.test.ts`. Full acceptance evidence (commands,
exact record IDs, final counts) is in `docs/implementation/CORPUS-03-result.md`.

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

## 10. Migration state and archive configuration (CORPUS-03)

`import-programme-cli.ts` no longer assumes migrations 0006/0007 are applied. Every
database-touching command (`import`, `approve`, `activate`, `revise-enrichment`) now runs a
read-only check against `public.schema_migrations` first and fails with the exact missing
migration name(s) if either is absent, instead of surfacing a raw `relation does not exist`
error partway through. See `docs/product/programme-corpus-operator-bundle.md` §6 for the full
runbook, including the exact `PROGRAMME_ARCHIVE_ROOT` value the operator must set to match the
deployed containers' resolved archive path when running the CLI outside them.

# B — Programme corpus operator bundle

Status: input specification, prepared 2026-09-19. Defines the exact files an operator hands over for
one corpus release, and what the importer refuses. It implements `docs/product/programme-corpus-spec.md`
(the content specification) and does not change it: where the two disagree, the content specification wins.

The importer reads **one directory and nothing else**. It never fetches a URL, never consults a model,
and never completes a field the operator left out.

---

## 1. Directory layout

```
<bundle>/
  manifest.json          release, document, version and ingestion parameters
  proposals.json         the semantic dataset (or proposals.csv — §5)
  vocabulary.json        the pinned category/tag vocabulary
  coverage.json          the coverage ledger
  ProgramZielonych.pdf   the archived source; the PDF bytes are authoritative
  ProgramZielonych.docx  the same document as a structural aid; basenames must match
```

Every file name is a plain name in that directory — never a path. The PDF and the DOCX must share one
basename, which is how the bundle states that the two describe the same document.

The DOCX is archived and hashed but never parsed. It exists so a later reader can recover heading
structure by hand; nothing in the index is derived from it.

All files are UTF-8. Field names are `snake_case`.

---

## 2. `manifest.json`

```json
{
  "corpus_id": "zieloni-programme",
  "release_id": "zieloni-programme-2026-01",
  "release_label": "Program Zielonych — wydanie styczeń 2026",
  "category_vocabulary_id": "cat-vocab-2026-01",
  "imported_by": "NOXAVA",
  "expected_proposal_count": 812,
  "notes": "Operator notes; never shown in the Reel UI.",

  "document": {
    "document_id": "doc-program-zielonych",
    "title": "Program Partii Zieloni",
    "document_type": "programme",
    "issuing_body": "Partia Zieloni",
    "admission_rationale": "Program przyjęty przez Kongres partii 17.01.2026.",
    "admission_amendment": null
  },

  "version": {
    "document_version_id": "dv-program-zielonych-2026-01",
    "source_title": "Program Partii Zieloni (2026)",
    "edition": "przyjęty przez Kongres, 01.2026",
    "adopted_at": "2026-01-17",
    "language": "pl",
    "source_file_name": "ProgramZielonych.pdf",
    "structure_file_name": "ProgramZielonych.docx",
    "dataset_file_name": "proposals.json",
    "source_url": "https://zieloni.org.pl/program-2026.pdf",
    "source_sha256": "…64 lower-case hex…",
    "retrieved_at": "2026-09-19T08:00:00.000Z",
    "page_count": 154,
    "printed_page_labels": ["", "", "3", "4", "…one entry per physical page…"],
    "structure_coverage": "full"
  },

  "ingestion": {
    "ingested_by": "NOXAVA",
    "normalization_profile_id": "szronox-normalization-1",
    "punctuation_map": {},
    "chunking": { "target_chars": 700, "max_chars": 900, "min_chars": 400, "overlap": "none" },
    "structure_source": "operator_declared",
    "excluded_ranges": [{ "pages": [1, 2], "reason": "strona tytułowa i spis treści" }],
    "header_footer": { "drop_exact_lines": [], "drop_printed_page_label_lines": false },
    "category_from_primary_tag": true,
    "notes": "Anything a later reader needs to interpret the index correctly."
  }
}
```

**Identifiers.** `corpus_id`, `release_id`, `category_vocabulary_id`, `document_id` and
`document_version_id` are stable lower-case slugs, never reused for different content. They are the
operator's identifiers; the database keeps its own UUIDs and maps them internally, so a slug always
means the same thing to the operator and a UUID always means the same row to the application.

**`printed_page_labels`** has exactly `page_count` entries, in physical page order. An unlabelled page —
front matter, usually — is `""`. Never omit an entry, and never back-fill the physical number.

**`header_footer.drop_exact_lines`** removes a running head or foot from indexed text. Each declared line
must match somewhere in the document; a line that never matches is a stale declaration and blocks the
import. `drop_printed_page_label_lines` additionally drops a line whose whole content is that page's
printed label or its physical number.

**`punctuation_map`** is empty by default, which keeps the source's own quotation marks and dashes.
Supply a mapping only when the source genuinely mixes forms, one source character per entry.

**`category_from_primary_tag: true`** means each record's `primary_tag` also supplies its
`ProgrammeCitation.category`, which is then the vocabulary entry's **label**. Set it to `false` and give
every record an explicit `category` if the two must differ.

### 2.1 Admission

Only a formally adopted, published document qualifies (content specification §2.2). The importer enforces
this: `adopted_at: null` is refused unless `document.admission_amendment` is present.

```json
"admission_amendment": {
  "approved_by": "Imię Nazwisko",
  "approved_at": "2026-09-19",
  "statement": "Dlaczego ten nieprzyjęty jeszcze projekt jest dopuszczony i na jakich warunkach.",
  "unpublished_source": true
}
```

`unpublished_source: true` additionally allows `source_url: null`, for a document with no public URL. The
archived copy is then declared authoritative and the stored provenance becomes
`urn:szronox:programme-archive:<document_version_id>`. The amendment is recorded on the document and
appears in the validation report; it is never inferred.

---

## 3. `proposals.json` — the semantic dataset

```json
{
  "records": [
    {
      "proposal_id": "prop-3-2-04",
      "section_id": "sec-3-2",
      "chapter": "OCHRONA ŚRODOWISKA",
      "subchapter": "Gospodarka wodna",
      "order_index": 3,
      "title": "Postulat: Ochrona małej retencji.",
      "text": "Postulat: Ochrona małej retencji. Będziemy wspierać …",
      "primary_tag": "srodowisko",
      "secondary_tags": ["samorzad"],
      "keywords": ["retencja", "mokradła", "melioracja"],
      "pdf_pages": [12, 13]
    }
  ]
}
```

| Field | Rule |
| --- | --- |
| `proposal_id` | Unique within the document version. Preserved verbatim. |
| `section_id` | Every record naming one section must agree on its `chapter` and `subchapter`. |
| `chapter` | Heading verbatim from the source, including its own numbering. |
| `subchapter` | Heading verbatim, or **explicit `null`**. Omitting the key is an error, not a shortcut. |
| `order_index` | Position within the section; unique per section. |
| `title` | The postulat title or lead sentence, verbatim. Must appear inside `text`. |
| `text` | The full passage, verbatim from the source. |
| `category` | Optional when `category_from_primary_tag` is true; otherwise required. |
| `primary_tag` | One vocabulary id. |
| `secondary_tags` | Vocabulary ids; may be empty. |
| `keywords` | Free operator keywords. Normalized (NFC, trimmed, collapsed, de-duplicated) for ranking; the raw form is retained beside it. |
| `pdf_page` / `pdf_pages` | Exactly one of the two. |

**Pages.** `pdf_pages` **enumerates every physical page the passage touches**, ascending and contiguous.
A passage on pages 12, 13 and 14 is `[12, 13, 14]` — never `[12, 14]`. Declaring both `pdf_page` and
`pdf_pages` is an error rather than a preference.

**Verbatim means verbatim.** The importer normalizes the supplied `text` exactly as it normalizes the
page text extracted from the PDF (NFC, ligatures, hyphen joins, whitespace collapse) and then requires it
to appear **exactly once within the declared pages**. Three outcomes are rejections, and each is an
operator correction:

- `passage_not_found` — the words are not in the archived PDF;
- `passage_ambiguous` — the passage occurs twice on those pages, so the citation would be ambiguous;
- `pages_mismatch` — it was found, but not where the record says it is.

Nothing repairs a passage. There is no fuzzy match and no model in this path.

Chunks are **not** supplied. The server generates them from the located passage, so every chunk's text is
literally a slice of the hashed document text.

---

## 4. `vocabulary.json` and `coverage.json`

```json
{
  "vocabulary_id": "cat-vocab-2026-01",
  "entries": [
    { "id": "srodowisko", "label": "Środowisko", "definition": "Ochrona przyrody, wód i klimatu." }
  ]
}
```

`vocabulary_id` must equal the manifest's `category_vocabulary_id`. Labels are stored in normal case; the
UI renders them uppercase. The vocabulary is snapshotted onto the release, so a later release may retire
an entry without changing what an existing attachment means.

```json
{
  "pages": [
    { "pdf_page": 1, "status": "excluded", "reason": "strona tytułowa" },
    { "pdf_page": 12, "status": "indexed", "proposal_ids": ["prop-3-2-04"] }
  ],
  "sections": [
    { "section_id": "sec-3-2", "status": "indexed" }
  ]
}
```

Every physical page from 1 to `page_count` appears exactly once. `status` is `indexed` or `excluded`, and
`excluded` requires a `reason`. **"Reviewed" is not a status**: a page is either indexed or excluded on
the record.

The importer cross-checks the ledger against what it actually validated and reports each disagreement
separately: `ledger_pages_missing`, `ledger_duplicate`, `ledger_page_orphan`, `ledger_page_conflict`,
`ledger_page_unindexed`, `ledger_proposal_orphan`, `ledger_proposal_missing`, `ledger_section_missing`,
`ledger_section_orphan`, `ledger_section_conflict`.

---

## 5. CSV adapter

`dataset_file_name` ending in `.csv` selects the adapter. Columns are the §3 field names; array cells hold
JSON (`["retencja","mokradła"]`); `subchapter` holds the literal `null` when the source has none; an empty
cell means the field is absent. Both formats go through one validator and produce the same index.

---

## 6. Commands

```
npm run build --workspace @szronox/api

# 1. Prove the bundle. Touches no database. Exit code 1 means rejected.
node apps/api/dist/ai/import-programme-cli.js validate <bundle-dir> --report report.json

# 2. Archive the files and commit the index as an INACTIVE release.
PROGRAMME_ARCHIVE_ROOT=/srv/szronox/programme \
node apps/api/dist/ai/import-programme-cli.js import <bundle-dir>

# 3. Read the report. Then record the named human who accepts it.
node apps/api/dist/ai/import-programme-cli.js approve <release-slug> --by "Imię Nazwisko"

# 4. Re-prove hashes and completeness, and make it searchable.
PROGRAMME_ARCHIVE_ROOT=/srv/szronox/programme \
node apps/api/dist/ai/import-programme-cli.js activate <release-slug>
```

All four run as the schema owner (`szronox_dev`) against the configured database. The API and worker roles
can read the corpus and cannot write it.

`PROGRAMME_ARCHIVE_ROOT` defaults to `<APP_STORAGE_ROOT>/programme`. The API serves archived sources from
the same root at `/api/v1/programme/versions/<id>/source`, behind the session, verifying the recorded
SHA-256 before sending a byte.

**The CLI runs outside the containers, on the operator's own machine or session — it must be pointed at
the same archive root the deployed API and worker resolve, not a fresh empty directory on the host.**
In the current deployment (`deploy/vps/compose.yaml`), both services set `APP_STORAGE_ROOT=
/var/lib/szronox/storage` and no explicit `PROGRAMME_ARCHIVE_ROOT`, so they resolve
`/var/lib/szronox/storage/programme` by the default above. Set exactly that when invoking `import`,
`activate` or `revise-enrichment` on the deployment host:

```
PROGRAMME_ARCHIVE_ROOT=/var/lib/szronox/storage/programme \
node apps/api/dist/ai/import-programme-cli.js import <bundle-dir>
```

Pointing the CLI at any other path archives the files somewhere the running API can never serve them from
— `import` and `activate` would succeed, but the source route would 503 for every citation.

### Migration state is checked, not assumed

Every command that touches the database (`import`, `approve`, `activate`, `revise-enrichment` — not
`validate`, which touches nothing) first runs a read-only check against `public.schema_migrations` (the
ledger the migration CLI writes) for `0006_programme_corpus.sql` and
`0007_programme_enrichment_revisions.sql`. If either is missing, the command fails immediately with the
exact migration name(s) still needed, instead of assuming they're applied and surfacing a raw
`relation "app.programme_releases" does not exist` error partway through. Apply migrations with the
existing migration CLI before running any corpus command:

```
node apps/api/dist/db/migration-cli.js
```

### What each step will not do

- **Import** never makes anything searchable and never overwrites an existing release or version slug.
- **Approval** is refused while the stored report carries any finding.
- **Activation** is refused unless the release is `approved`, the archived PDF, DOCX and dataset still
  hash to their recorded digests, every proposal has at least one chunk, and the persisted counts still
  match the report. It then supersedes the previous active release in one transaction.
- Nothing deletes a superseded release. Its files, versions, vocabulary and any Reel attachment pinned to
  it stay resolvable for ever.

---

## 7. Manual checks the report cannot do for you

Validation proves the index is consistent with the archived bytes. It cannot prove the *bytes* are the
right document. The report ends with the specification §7 items a human still owes, naming the exact
samples to look at:

1. ten sample chunks, with their physical and printed pages, checked against the rendered PDF;
2. the named page-spanning chunk;
3. the named chunk inside a list or table;
4. one front-matter page and one body page, confirming the printed labels;
5. that `source_url` serves a file with the recorded hash, or that the discrepancy is recorded and the
   archived copy is declared authoritative.

Approve only after those are done. The command records who approved; the report records what they were
looking at.

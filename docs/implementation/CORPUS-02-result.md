# CORPUS-02 — ETAP 3B input adapter, enrichment revisions, operator instructions

Branch `codex/corpus-01`, worktree `.worktrees/corpus-01`, extending CORPUS-01 (`902a2fa`,
implementation commit `7be52b5`). Not merged. Implemented by the root agent (Claude, Sonnet 5)
directly on the user's handoff (`docs/implementation/CORPUS-02-etap3b-dispatch.md`, `a807fb4`);
no coding agent was dispatched and no nested agent was spawned.

Authority: `docs/product/programme-corpus-spec.md` (content model, unchanged),
`docs/product/programme-corpus-operator-bundle.md` (bundle format, unchanged). New:
`docs/product/programme-corpus-etap3b-adapter.md` (this task's input contract and field
mapping — read that document for the detailed rationale; this record is the acceptance
evidence and the account of what changed and why).

---

## 1. What changed, and why

The user supplied the real programme content — `Program/Finalszronox_programme_proposals.json`
(1423 ETAP 3B-verified records), its metadata/coverage companions, and the archived
`ProgramSzroNox.pdf`/`.docx` — which does not match CORPUS-01's bundle format directly. This
task bridges that gap without rebuilding CORPUS-01's architecture:

| Gap | Correction |
| --- | --- |
| ETAP 3B's field names, tag vocabulary and section structure don't match the bundle format. | A new adapter (`etap3b-adapter.ts`) maps the canonical dataset plus a small hand-authored companion manifest onto the existing bundle format, then hands off to the **unmodified** `validate`/`import`/`approve`/`activate` pipeline. |
| 10 of 151 sections have zero proposals; the existing pipeline only ever produced a section from a proposal record. | `bundle.ts`'s `LedgerSection` gained optional structural fields; `validate.ts` now seeds the section set from the coverage ledger first, proposals second, so an empty section survives. |
| Migration 0006 made every proposal column immutable, including operator tagging, which legitimately needs revision after import. | Migration 0007 narrows the guard to six enrichment columns, adds an append-only revision log, and a new `reviseProposalEnrichment` repository function validates against the release's *pinned* vocabulary snapshot. |
| `searchTerms()` dropped every term under four letters, including the controlled terms `AI`/`UE`. | A small named allow-list keeps them, without lowering the general threshold. |
| Discovered while validating the real PDF: a blind line-join left a stray space at word-wrap hyphens, breaking grounding for real proposals. | `normalize.ts` gained `joinHyphenatedLines`, replacing the naive `kept.join(' ')` in page assembly. Scope-expanded from the original file list with the user's explicit sign-off (§4 below) after diagnosing the root cause. |

No change to `packages/contracts/src/index.ts`, `apps/web/**` (frozen UI), or
`apps/worker/src/ai/actions.ts` (Gemini job pathway) — none was needed.

## 2. Files owned by this task

**New**

- `apps/api/src/ai/corpus/etap3b-adapter.ts` — field mapping, section-id derivation, tag
  slugging, vocabulary synthesis, coverage-ledger construction
- `Program/etap3b.manifest.json` — the companion manifest (pinned `zieloni-programme` /
  `zieloni-programme-2026-draft-r1`, admission amendment, ingestion parameters)
- `database/migrations/0007_programme_enrichment_revisions.sql`
- `apps/api/src/corpus-etap3b.test.ts` — adapter, empty-section retention, short-controlled-term
  retrieval, secondary-tag cap, `joinHyphenatedLines` unit tests, full lifecycle
- `apps/api/src/corpus-enrichment.test.ts` — revision path and the narrowed immutability guard
- `docs/product/programme-corpus-etap3b-adapter.md` — operator documentation
- `docs/implementation/CORPUS-02-etap3b-dispatch.md` (`a807fb4`) — the recorded handoff

**Modified**

- `apps/api/src/ai/corpus/bundle.ts` — `LedgerSection` optional structural fields
- `apps/api/src/ai/corpus/validate.ts` — ledger-seeded section set
- `apps/api/src/ai/corpus/repository.ts` — `reviseProposalEnrichment`
- `apps/api/src/ai/corpus/retrieval.ts` — `searchTerms()` short-controlled-term allow-list
- `apps/api/src/ai/corpus/normalize.ts` — `joinHyphenatedLines`, used by `assembleDocument`
  (§4)
- `apps/api/src/ai/import-programme-cli.ts` — `etap3b-adapt` and `revise-enrichment` commands
- `apps/api/src/core.test.ts`, `apps/api/src/vps-integration.test.ts` — hard-coded table/
  migration lists updated for `programme_proposal_enrichment_revisions` and migration 0007,
  the same maintenance CORPUS-01 itself already did once for its own additions

No change to `deploy/vps/postgres/grants.sql`: the revision path runs only as the schema owner
from the operator CLI, identical in privilege shape to import/approve/activate, so the existing
grants (corpus tables read-only to both runtime roles) already cover it correctly.

## 3. Contract decisions

1. **The adapter writes real bundle files; it does not bypass or reimplement validation.**
   `etap3b-adapt` writes `manifest.json`/`vocabulary.json`/`proposals.json`/`coverage.json`
   into `Program/`, distinct names from the canonical `Finalszronox_*` inputs. From that point
   the directory is an ordinary bundle — `validate`/`import`/`approve`/`activate` are entirely
   unmodified by this task.
2. **`category_vocabulary_id` is owned by the companion manifest, not invented by the
   adapter.** An early version of `buildVocabulary` hard-coded its own vocabulary id, which
   would have produced a guaranteed `vocabulary_mismatch` on every real run; caught before any
   real validation attempt, by tracing the fixture's own logic rather than trusting it. Fixed
   by threading the id through from the companion manifest.
3. **Printed page labels are reported missing, never fabricated** (§6 of the adapter doc).
   This is the one gap in the real dataset this task deliberately does not close.
4. **`joinHyphenatedLines`'s scope boundary.** Fixing the mechanism gap (the existing
   hyphen-join logic was never reachable for PDF-extracted text at all) is squarely inside
   corpus specification §3's mandate ("join words hyphenated across line breaks... required to
   be applied consistently"). Four of the remaining real-data mismatches are a genuine,
   irreducible tension between that spec-mandated rule (always drop the hyphen at a wrap) and
   ETAP 3B's separately-curated text (which sometimes keeps a hyphen that is semantically part
   of a compound word, e.g. `MIR-PIB`, `doradczo-rozwojowych`). Telling these apart from a
   genuine word-wrap requires a dictionary or linguistic judgment, which §3 explicitly forbids
   ("nothing here corrects spelling... a source typo stays a source typo"). Not attempted.
   Five further mismatches are a distinct, unrelated extraction artifact (a stray mid-word
   space with no hyphen present at all); one is a subscript-digit encoding difference; one is
   an apparent footnote-content bleed; one is a case where ETAP 3B's own curated text drops a
   bullet dash present in the raw PDF. None of these five is addressed — each is a separately
   scoped investigation, and chasing them past the one approved, evidenced fix would have kept
   silently widening this task's file scope. See §5 below for the itemized list.

## 4. The `joinHyphenatedLines` fix — sequence and evidence

Running `validate` against the real `Program/` directory (task acceptance step, planned as a
report-only real-data check) surfaced 15 `passage_not_found` findings. All 15 traced to one
mechanism: `assembleDocument`'s page-line join (`kept.join(' ')`) always inserted a plain
space between two lines, including when the first line ended in a hyphen from a mid-word line
wrap — producing `"agencj- ach"` instead of `"agencjach"`. This is outside the file list the
plan approved (`bundle.ts`, `validate.ts`, `repository.ts`, `retrieval.ts`); the user was asked
before any fix was made, and explicitly approved widening scope to `normalize.ts` for this one,
diagnosed, narrow issue.

The fix went through two corrections before landing, each caught by re-running the real-data
validation rather than trusting the change in isolation:

1. **First attempt** (regex-based, inside `normalizePassage`, tolerating a stray space after
   an embedded `\n`) changed nothing on the real document — the normalized SHA-256 was
   byte-identical before and after. Root cause: `normalizePassage` never sees an embedded `\n`
   for PDF-extracted text at all; `assembleDocument` splits lines and strips their newlines
   *before* calling it. The actual join point is the later `kept.join(' ')`, a different
   function entirely.
2. **Second attempt** (a new `joinHyphenatedLines`, used at the real join site) fixed the
   intended cases but introduced two new false positives: a standalone dash used as
   punctuation (`"pozarządowych - oraz"`, a space on both sides of the hyphen) was
   incorrectly collapsed to `"pozarządowych oraz"`, losing the dash. Two previously-passing
   records (`SZR-CIV-INST-023`, `SZR-ANM-VET-003`) broke as a result — caught by the same
   real-data re-run.
3. **Final form**: only a hyphen *directly attached* to a letter or digit (no space before it)
   is treated as a word-wrap join; a hyphen preceded by a space is left alone. This is what
   correctly distinguishes `"agencj-"` (attached, word-wrap) from `"pozarządowych -"`
   (detached, punctuation).

Net result on the real corpus, `validate` against `Program/` after `etap3b-adapt`:

| | Before any fix | Final |
| --- | --- | --- |
| Normalized length | 339,044 chars | 339,029 chars |
| Proposals grounded | 1,408 / 1,423 | **1,411 / 1,423** |
| Chunks | 1,411 | 1,414 |
| `passage_not_found` findings | 15 | 12 |

Regression-tested in `corpus-etap3b.test.ts` (four `joinHyphenatedLines` unit tests: the
word-wrap join, the digit-preceded-hyphen retention, the standalone-dash non-match, and two
ordinary lines behaving exactly as the old blind join would). The full pre-existing
`corpus.test.ts` suite — which builds and extracts real PDF fixtures — passes unchanged.

## 5. The 12 remaining `passage_not_found` records — root cause, not fixed

Traced individually against the real extracted document text; grouped by mechanism.

**Hyphen-retention judgment call (4 records)** — the spec-mandated "always drop the hyphen at a
word-wrap" produces a different (but spec-compliant) result than ETAP 3B's text, which keeps
the hyphen because it is semantically part of a compound word:

- `SZR-ENV-BALTIC-005` — `MIR-PIB` (an institute acronym) → ours `MIRPIB`
- `SZR-ANM-FOOD-028` — `doradczo-rozwojowych` → ours `doradczorozwojowych`
- `SZR-HLT-WPROWADZ-004` — `społeczno-ekonomicznego` → ours `społecznoekonomicznego`
- `SZR-CUL-HIST-001` — `przyczynowo-skutkowych` → ours `przyczynowoskutkowych`

**Stray mid-word space, no hyphen present (5 records)** — a distinct extraction artifact, not
touched by this task:

- `SZR-CIV-ANTI-005` — `"agencj ach"` where the dataset has `"agencjach"`
- `SZR-ANM-PZ-002` — `"systemoweg o"` vs `"systemowego"`
- `SZR-SEC-SFB-006` — `"zawsz e"` vs `"zawsze"`
- `SZR-HLT-PWM-001` — `"odb yciu"` vs `"odbyciu"`
- `SZR-DIG-ZTDW-001` — `"wykluczon ych"` vs `"wykluczonych"`

**Subscript-digit encoding (1 record)**:

- `SZR-ENG-NFMPP-014` — the PDF renders `CO₂` (Unicode subscript 2); the dataset has `CO2`.

**Apparent footnote/heading content bleed (1 record)**:

- `SZR-ECO-GREEN-005` — extracted text reads `"...W tym 3 Prace nad tym właśnie..."` where the
  dataset expects `"...W tym kontekście nasza polityka..."` — a stray `"3 Prace..."` fragment
  appears in place of the expected continuation.

**Content curation divergence, not an extraction defect (1 record)**:

- `SZR-EDU-EE-002` — the PDF's extracted text includes a bullet dash (`"prowadzone: - w..."`)
  that ETAP 3B's own curated text omits (`"prowadzone: w..."`). This is ETAP 3B's own editorial
  choice, not something this pipeline could or should silently paper over.

None of these six categories were investigated further or fixed. Each would require either a
separate, narrowly-scoped follow-up (the mid-word-space artifact, most likely a bug in
`pdf-text.ts`'s own line-splitting, independent of `normalize.ts`) or a product decision (does
the corpus want hyphen-retention judgment for compound words, and if so, how — a controlled
list, or accept the current spec-mandated behavior as-is).

## 6. Acceptance evidence

Commands, run in `.worktrees/corpus-01` on Node (workspace-pinned):

```
npm run build --workspace @szronox/contracts
npx tsc -p apps/api/tsconfig.json          # clean
npx tsc -p apps/worker/tsconfig.json       # clean
npm run build                              # contracts, web, api, worker all clean
node --test apps/api/dist/corpus-etap3b.test.js       # 9/9
node --test apps/api/dist/corpus-enrichment.test.js   # 4/4
node --test apps/worker/dist/ai/actions.test.js       # 6/6, unchanged
npm test --workspace @szronox/api                     # 174/176 (§7)
```

### What the new suites prove

`corpus-etap3b.test.ts` — the adapter is exercised against a real, hand-built ETAP-3B-shaped
input (raw proposals/metadata/coverage under the exact canonical file names, plus a companion
manifest), not a simulation of its output:

- the adapter produces a bundle that `loadBundle`/`validateBundle` accept with zero issues;
- 13 sections survive, including the one declared with zero proposals (§5 of the adapter doc);
- import leaves nothing searchable; activation is refused before approval; approval then
  activation makes the release searchable;
- exact retrieval (a Reel quoting a proposal's own text finds it), cross-cutting retrieval (a
  term present only in `keywords`, never in body text, still finds it, on a proposal that also
  has zero secondary tags — both handoff checks in one assertion), short controlled terms
  (`AI`/`UE` survive `searchTerms()` and reach the database layer, both via a mixed Reel query
  and in isolation), bounded candidate input (ten proposals share one rare term; exactly eight
  return, deterministically, on repeat), unrelated content (no shared term, no candidates,
  no provider call implied);
- the archived PDF's bytes read back byte-for-byte through the same archive-integrity path
  CORPUS-01 already proved generically;
- a record naming five secondary tags is rejected by the adapter with `secondary_tags_too_many`,
  not truncated;
- `slugify`, `deriveTitle` (verbatim-prefix, bounded-length truncation) and `buildVocabulary`
  (tagging-rule note vs. explicit placeholder) are unit-tested directly;
- `joinHyphenatedLines` is unit-tested for the word-wrap join, the digit-retention case, the
  standalone-dash non-match, and ordinary two-line joining.

`corpus-enrichment.test.ts`:

- `reviseProposalEnrichment` changes primary tag, secondary tags and keywords while `id`,
  `category`, `exact_text`, `pdf_pages`, `section_id` and `title` are asserted byte-identical
  before and after;
- a revision row is written with the correct previous/new tag values, operator, and a valid
  SHA-256 checksum; a second revision increments the number and both rows persist;
- the new keyword becomes genuinely searchable (the generated `enrichment_vector` column
  recomputed itself from the `UPDATE`, not from application code re-deriving it);
- a tag outside the release's pinned vocabulary snapshot is refused (`tag_unknown`); an
  unnamed operator and an unknown proposal are each refused with their own reason code;
- **the database itself**, not just the repository function, refuses a raw `UPDATE` on
  `category` or `order_index` and any `DELETE`, even issued directly against
  `app.programme_proposals` — proving the guard is a property of migration 0007's trigger, not
  of application discipline.

**Checks not re-implemented, because they are unchanged, data-shape-independent CORPUS-01
mechanics**: invented-chunk-id rejection (`apps/worker/src/ai/actions.test.ts`, unmodified,
6/6) and the "no active release is an explicit error" path (`corpus.test.ts`, unmodified). Both
already exercise the exact code this task did not touch.

### Not run: the one live Gemini call

Per the handoff's own instruction ("Reserve one short live Sprawdź postulat call for the
integrated path; stop on provider/quota failure"), this remains a manual, separately-run step —
it requires live provider credentials and a running deployment, neither of which exist for this
worktree. Documented here as an open gate, consistent with CORPUS-01's own precedent
(`CORPUS-01-result.md` §5).

## 7. Test results

```
npm test --workspace @szronox/api
tests 176, pass 174, fail 2
```

The 2 failures are pre-existing, unrelated to this task, and already documented in
`CORPUS-01-result.md` §7 as GEMINI-02 drift in `apps/api/src/deploy-config.test.ts`
(`each service mounts only the secrets its own identity needs`,
`the runbook documents every variable and secret the deployment requires`) — both concern
`deploy/vps/compose.yaml` and `deploy/vps/README.md`, neither touched by this task, and both
fail identically on `codex/gemini-02-impl` before any CORPUS work.

Two hard-coded assertions this task did update, the same maintenance CORPUS-01 performed once
for its own additions: `core.test.ts`'s full table list (added
`programme_proposal_enrichment_revisions`) and `vps-integration.test.ts`'s full migration list
(added `0007_programme_enrichment_revisions.sql`). Both would otherwise have failed the moment
migration 0007 landed, exactly as CORPUS-01 found and fixed the equivalent staleness from
GEMINI-02.

## 8. One-off check against the real ETAP 3B / PDF pair

Not part of the automated suite — a real-data report, per the handoff's acceptance item 9 and
CORPUS-01's own precedent (`CORPUS-01-result.md` §8). No database was touched; no bundle was
imported.

```
node apps/api/dist/ai/import-programme-cli.js etap3b-adapt Program
  1423 proposals adapted, 0 rejected, 151 sections retained (10 empty).

node apps/api/dist/ai/import-programme-cli.js validate Program
  extraction         szronox-pdf-text@1, 154 pages, 339029 normalized characters
  index              151 sections, 1411 proposals, 1414 chunks
  pages indexed      148 of 154 (5 excluded, none touched by any proposal)
  admission          type=programme adopted=none amendment=NOXAVA
  public source url  waived by amendment (archived copy is authoritative)
  exit 1 — 29 findings: 1 printed_labels_invalid, 12 passage_not_found (§5), 16 ledger
           findings cascading from those 12 (a proposal the ledger references but that
           failed validation is reported as ledger_proposal_orphan, not silently dropped)
```

What this establishes: the adapter runs cleanly end to end against the full real dataset with
zero adapter-level rejections; the corpus's own extraction/grounding machinery — now including
the CORPUS-02 line-join fix — independently verifies 1,411 of 1,423 ETAP 3B-approved passages
against the archived PDF; the 12 that don't verify are itemized by root cause in §5, none of
them silently repaired. `printed_page_labels` remains a genuine open input from the operator.

## 9. Next steps, each separately authorized

1. The operator decides whether to supply `printed_page_labels` (§6 of the adapter doc) and
   whether/how to address the 12 remaining grounding mismatches (§5) — a controlled hyphen
   list, an ETAP 3B data correction, or acceptance as-is.
2. Review this branch; it is not merged.
3. Then, in order, exactly as CORPUS-01 left it: DEV backup, migration 0007 (0006 is already
   applied), `grants.sql` rerun is **not** required (no grant changed), coordinated API/worker
   rollout if the CLI binary needs to move, `etap3b-adapt` → `validate` → read the report →
   `approve --by` → `activate`, and the two programme smoke requests. Live provider
   credentials remain an OPEN gate, as they were after CORPUS-01.
4. Deployment wiring is unchanged from CORPUS-01's own open item: `deploy/vps/compose.yaml`
   still has no `PROGRAMME_ARCHIVE_ROOT` and no archive volume.

# CORPUS-03 — close remaining corpus validation blockers

Branch `codex/corpus-01`, worktree `.worktrees/corpus-01`, extending CORPUS-02 (`50a3a2d`).
Implemented by the root agent (Claude, Sonnet 5) directly on the user's handoff; no coding
agent was dispatched and no nested agent was spawned. **Not committed as of writing this
record** — the commit created immediately after it carries this file and is the one to cite
going forward.

Every fix in this record was verified by rendering the actual PDF pages (Ghostscript, since
poppler/pdftoppm is not installed in this environment — `gs -sDEVICE=png16m` produces
equivalent PNG output) and reading them, plus exhaustive whole-document instrumentation of the
extraction pipeline. Nothing here was inferred from the ETAP 3B dataset text alone.

---

## 1. Result

```
node apps/api/dist/ai/import-programme-cli.js etap3b-adapt Program
  1423 proposals adapted, 0 rejected, 151 sections retained (10 empty).

node apps/api/dist/ai/import-programme-cli.js validate Program
  extraction         szronox-pdf-text@1, 154 pages, 338995 normalized characters
  index              151 sections, 1423 proposals, 1426 chunks
  pages indexed      149 of 154 (5 excluded — pages 1, 30, 52, 118, 145; no proposal touches them)
  admission          type=programme adopted=none amendment=NOXAVA
  public source url  waived by amendment (archived copy is authoritative)
  REJECTED           0 findings
  exit 0
```

**Acceptance met**: 1,423/1,423 proposals grounded, 151/151 sections retained (10 empty),
`printed_page_labels` valid (154 honest empty strings — see §2), zero unresolved validation
findings, exit code 0. No database migration, no `approve`/`activate`, no Gemini call, no
deployment was run, per the handoff's explicit exclusions.

## 2. Printed page labels

Rendered and visually inspected pages 1, 77 (middle), and 154 (last) of `ProgramSzroNox.pdf`.
**None carry a visible page number, header, or footer.** Cross-checked programmatically:
scanning all 154 pages' raw extracted text for any standalone digit or roman-numeral line
found exactly 7 matches, all identified as footnote markers (§4), not pagination — no
sequence 1..154 exists anywhere in the document.

This is a genuinely unlabelled document, not a supplied-files gap. Per
`docs/product/programme-corpus-spec.md` §4, the correct `printed_page_labels` is 154 empty
strings — the spec-mandated encoding of "no printed pagination," not a fabrication.

**Applied**: `Program/etap3b.manifest.json`'s `version.printed_page_labels`, 154 empty strings.

## 3. The 12 grounding mismatches — final disposition

All 12 records left open by CORPUS-02 were re-diagnosed against rendered PDF pages. Four
distinct root causes.

### 3a. Compound-word hyphen retention (4 records) — code fix

`SZR-ENV-BALTIC-005` (p5, `MIR-PIB`), `SZR-ANM-FOOD-028` (p49, `doradczo-rozwojowych`),
`SZR-HLT-WPROWADZ-004` (p82, `społeczno-ekonomicznego`), `SZR-CUL-HIST-001` (p152,
`przyczynowo-skutkowych`).

Visually confirmed on all four rendered pages: each is a genuine Polish compound word or
acronym that happens to wrap at its own internal hyphen. CORPUS-02's `joinHyphenatedLines`
dropped a letter-preceded hyphen at a wrap (treating it as an inserted word-wrap artifact) and
kept only a digit-preceded one — backwards for this document.

Confirmed empirically before changing anything: tested "always retain the hyphen at a wrap"
against all 1,423 canonical proposals — 1,411 → 1,415 grounded, and the *only* records whose
outcome changed are exactly these 4. Zero regressions anywhere else in the 154-page document,
because this document (a standard Word/Docs export) performs no automatic syllable
hyphenation at all — every attached hyphen at a line-wrap in it is real.

**Fix**: `apps/api/src/ai/corpus/normalize.ts`, `joinHyphenatedLines` — removed the
digit/letter distinction; every hyphen directly attached to a letter or digit is now retained,
never dropped. The digit-specific branch became redundant and was deleted. Docstring rewritten
to state the empirical basis.

### 3b. False-positive mid-word space from a PDF glyph-gap heuristic (5 records) — code fix

`SZR-CIV-ANTI-005` (p26, `agencj|ach`), `SZR-ANM-PZ-002` (p31, `systemoweg|o`),
`SZR-SEC-SFB-006` (p75, `zawsz|e`), `SZR-HLT-PWM-001` (p90, `odb|yciu`), `SZR-DIG-ZTDW-001`
(p134/135, `wykluczon|ych`).

Visually confirmed: "agencjach" on page 26 reads as one normal, tightly-set word — no visible
gap. This is a false positive in `pdf-text.ts`'s `assembleLines` word-gap heuristic
(`gap > previous.size * 0.22` inserted a space), unrelated to line-wraps — it fires within a
single extracted line.

Instrumented the heuristic and logged every space-insertion event across all 154 pages.
Filtering to insertions between two letters where *neither* side already carries its own
explicit space glyph (i.e., cases that depend *solely* on the position heuristic) found
**exactly 6** events in the whole document — the 5 above, plus one more (`p|omocy` on page 90,
in text outside any of the 1,423 proposals, harmless either way but fixed at the root anyway).
Gap/font-size ratios: 0.242–0.341. The widest ratio among the 43 letter-to-letter transitions
correctly left unjoined anywhere in the document is 0.177 — a clean, wide separation with
nothing between them. Every genuine inter-word gap in the whole document already carries its
own explicit space-glyph fragment, so raising the threshold cannot fuse two real words.

**Fix**: `apps/api/src/ai/corpus/pdf-text.ts`, `assembleLines` — gap multiplier raised from
`0.22` to `0.4` (comfortable margin above the highest observed false positive at 0.341, far
below the ~0.6 ratio of genuine word/bullet gaps). Docstring rewritten with the empirical
basis; the stale "quarter of the font size" comment (which never matched the `0.22` in code)
is also corrected.

### 3c. Subscript-digit encoding (1 record) — code fix

`SZR-ENG-NFMPP-014` (p57, `CO₂` vs dataset `CO2`).

Visually confirmed: the PDF genuinely renders a subscript "2" (U+2082). Exhaustive scan: this
character appears exactly twice in the whole document (p12, p57), both in "CO₂".

**Fix**: `apps/api/src/ai/corpus/normalize.ts` — new `SUBSCRIPT_DIGITS` table (U+2080–U+2089 →
`0`–`9`), applied in `normalizePassage` alongside the existing `LIGATURES` table. Same class of
fix, same rationale ("typography, not spelling," permitted by spec §3).

### 3d. Footnote text spliced into body flow by stream-order reading (1 record) — manifest fix, no code

`SZR-ECO-GREEN-005` (p61/62).

Raw per-page line dump: page 61 line 34 ends "...zużytego sprzętu. W tym", line 35 is a
standalone "3" (footnote marker), line 36 is " Prace nad tym właśnie trwają." (the footnote
body — confirmed on the rendered page: a real footnote below a horizontal rule, referencing an
unrelated sentence). Page 62 line 0 continues "kontekście nasza polityka...". The footnote's
content-stream position falls between two lines that should be adjacent, splicing its text
into the middle of this proposal's sentence — CORPUS-01's already-documented "reading order is
stream order" limitation, not a new defect.

A general footnote-detection pass (by font size, position, or graphics) is not narrow and was
not attempted. The bundle format already has a sanctioned mechanism for exactly this:
`ingestion.header_footer.drop_exact_lines`. Confirmed the whole document has exactly 4
footnotes (markers 1–4, 7 standalone-digit-line instances total); only footnote 3's two lines
concretely splice into a canonical proposal text, so only those two are declared — footnotes
1, 2 and 4 are left alone, confirmed by the final 0-issue validation that they don't corrupt
any of the 1,423 proposals.

**Fix**: `Program/etap3b.manifest.json`'s `ingestion.header_footer.drop_exact_lines`: `"3"` and
`"Prace nad tym właśnie trwają."`. No code change.

### 3e. Genuine content divergence (1 record) — approved canonical-text correction

`SZR-EDU-EE-002` (p125/126). **User decision requested and received** (this is the one
"product/content decision" the handoff anticipated might remain).

The PDF genuinely prints a three-item dash-bulleted list under "prowadzone:":

```
prowadzone:
- w sposób praktyczny, poza ławką szkolną (teren czy ogród przyszkolny, przestrzeń lokalna -
  park, las, łąka, ekologiczne gospodarstwo ogrodnicze czy rolnicze),
- we współpracy nauczycieli różnych przedmiotów z organizacjami pozarządowymi (NGO),
- na bazie obowiązującej podstawy programowej, rozszerzonej o edukację ekologiczną i
  klimatyczną, a także uczenie przez działanie.
```

ETAP 3B's canonical `proposal_text` flattened this into prose and dropped all three introducing
dashes, while correctly keeping the unrelated punctuation dash inside item 1
("przestrzeń lokalna **-** park, las, łąka"). The user approved correcting the canonical text
to match the PDF exactly rather than adding a new, broader normalization behavior (stripping
list-bullet dashes generally would be unscoped and risk affecting other proposals' text).

**Note on process**: the first attempt at this fix (asked and approved) only restored the
*first* of the three dashes, having missed that the PDF's list has three items, not one. The
subsequent real-bundle validation run caught this immediately (`record[1156]` still failed,
with the remaining mismatch pointing exactly at the second missing dash), so the omission was
caught and corrected before this record was finalized, not left in the shipped result.

**Applied — exact before/after** (`Program/Finalszronox_programme_proposals.json`,
`proposal_id: "SZR-EDU-EE-002"`, field `proposal_text`):

Before:
```
"...prowadzone: w sposób praktyczny, poza ławką szkolną (teren czy ogród przyszkolny,
przestrzeń lokalna - park, las, łąka, ekologiczne gospodarstwo ogrodnicze czy rolnicze), we
współpracy nauczycieli różnych przedmiotów z organizacjami pozarządowymi (NGO), na bazie
obowiązującej podstawy programowej, rozszerzonej o edukację ekologiczną i klimatyczną, a także
uczenie przez działanie."
```

After:
```
"...prowadzone: - w sposób praktyczny, poza ławką szkolną (teren czy ogród przyszkolny,
przestrzeń lokalna - park, las, łąka, ekologiczne gospodarstwo ogrodnicze czy rolnicze), - we
współpracy nauczycieli różnych przedmiotów z organizacjami pozarządowymi (NGO), - na bazie
obowiązującej podstawy programowej, rozszerzonej o edukację ekologiczną i klimatyczną, a także
uczenie przez działanie."
```

(Three dashes inserted, each exactly where the PDF's line-join produces one: after
"prowadzone:", after "rolnicze),", and after "(NGO),".) `title` (`deriveTitle`, the first
sentence) is unaffected — the first dash falls after the sentence-boundary period earlier in
the passage... actually the whole passage is one sentence ending in a period at the very end,
so `title` is the *entire* corrected text; this was checked directly (§5, real-bundle run) and
produces no `title_not_verbatim` finding, confirming the title stays an exact prefix/whole of
the corrected text.

**Not applied**: `Finalszronox_programme_proposals.csv`, the secondary CSV export of the same
dataset, was **not** regenerated to match. It is documented as inspection/export only, not read
by the adapter or any part of the corpus pipeline, so this is a residual, harmless
inconsistency between the two exports — noted here for completeness, not treated as a
blocker.

## 4. Operator runbook corrections

### Migration state, checked not assumed

`apps/api/src/ai/import-programme-cli.ts`'s `withOwnerDatabase` previously checked only
`current_user = 'szronox_dev'`. It now also runs a read-only check
(`assertMigrationsApplied`) against `public.schema_migrations` — the ledger `db/migrate.ts`
already writes — requiring both `0006_programme_corpus.sql` and
`0007_programme_enrichment_revisions.sql` before any database-touching corpus command
(`import`, `approve`, `activate`, `revise-enrichment`; `validate` is unaffected, it touches no
database). A missing migration now fails with its exact name, instead of surfacing a raw
`relation "app.programme_releases" does not exist` error partway through a command, and
instead of the prior assumption (both CORPUS-01 and CORPUS-02 assumed 0006 applied without
checking).

Also handles the "no migration ever applied" case explicitly (`to_regclass` check for the
ledger table itself), rather than that also surfacing as a raw missing-relation error.

### Archive configuration, identified precisely

`deploy/vps/compose.yaml` sets `APP_STORAGE_ROOT=/var/lib/szronox/storage` for both api and
worker; `programmeArchiveRoot()` (`core/config.ts`) falls back to `<APP_STORAGE_ROOT>/programme`
when `PROGRAMME_ARCHIVE_ROOT` is unset, so the *containers* already resolve a working path with
no compose change needed. The gap: there is no explicit `PROGRAMME_ARCHIVE_ROOT` declared, and
the CLI runs *outside* the containers (the operator's own machine/session) — so the operator
must set `PROGRAMME_ARCHIVE_ROOT=/var/lib/szronox/storage/programme` (matching the container's
resolved path exactly) when invoking `import`/`activate`/`revise-enrichment`, or the CLI would
archive files to a path the running API can never serve from (source route would 503 for every
citation). This was undocumented before this task.

**Applied**: `docs/product/programme-corpus-operator-bundle.md` §6 — migration-state
pre-check behavior documented, exact `PROGRAMME_ARCHIVE_ROOT` value spelled out with the
matching compose.yaml reasoning. No `compose.yaml` change — the existing fallback already
works; the fix is documentation plus the read-only CLI check above.

## 5. Files changed

**Modified**
- `apps/api/src/ai/corpus/normalize.ts` — always-retain hyphen join (§3a); `SUBSCRIPT_DIGITS`
  table (§3c)
- `apps/api/src/ai/corpus/pdf-text.ts` — `assembleLines` gap multiplier 0.22 → 0.4 (§3b)
- `apps/api/src/ai/import-programme-cli.ts` — read-only migration-state check (§4)
- `apps/api/src/corpus-etap3b.test.ts` — regression tests for all three code fixes (§6)
- `docs/product/programme-corpus-operator-bundle.md` — runbook corrections (§4)
- `docs/product/programme-corpus-etap3b-adapter.md` — updated to reflect all CORPUS-03 fixes

**Modified, outside git** (`Program/`, untracked per prior task's design — this directory lives
in the main worktree, not `.worktrees/corpus-01`, and stays local scratch/input)
- `Program/etap3b.manifest.json` — `printed_page_labels` (154 empty strings, §2);
  `header_footer.drop_exact_lines` (§3d); `ingestion.notes` updated to record both
- `Program/Finalszronox_programme_proposals.json` — `SZR-EDU-EE-002`'s `proposal_text`
  corrected (§3e, exact before/after above)
- `Program/manifest.json`, `vocabulary.json`, `proposals.json`, `coverage.json` — regenerated
  by `etap3b-adapt` from the above; not hand-edited

**Not touched**: `bundle.ts`, `validate.ts`, `repository.ts`, `retrieval.ts`, both migrations
(0006/0007 unchanged — no schema change needed), `apps/web/**`, `apps/worker/**`,
`deploy/vps/compose.yaml` (existing fallback resolves correctly), `grants.sql`.

## 6. Acceptance evidence

```
cd .worktrees/corpus-01
npx tsc -p apps/api/tsconfig.json                                    # clean
npm run build --workspace @szronox/api                               # clean
node --test apps/api/dist/corpus-etap3b.test.js                      # 12/12
node --test apps/api/dist/corpus-enrichment.test.js apps/api/dist/corpus.test.js   # 18/18
node --test apps/worker/dist/ai/actions.test.js                      # 6/6, unchanged
npm test --workspace @szronox/api                                    # 177/179
```

The 2 failures are pre-existing, unrelated GEMINI-02 drift, already documented in
`CORPUS-01-result.md` §7 and `CORPUS-02-result.md` §7 (`apps/api/src/deploy-config.test.ts`,
concerning `deploy/vps/compose.yaml`/`README.md`, neither touched by this task).

### What the new/changed tests prove

`corpus-etap3b.test.ts` gained 5 tests beyond CORPUS-02's suite (12 total in the file, all
passing):

- `joinHyphenatedLines` now asserts the hyphen is **kept** for `agencj-`/`MIR-`/`doradczo-`
  (previously asserted it was dropped) — directly pins the CORPUS-03 behavior change;
- `normalizePassage expands a subscript digit to its plain form` — `CO₂` → `CO2`, `H₂O` → `H2O`;
- two new tests build a minimal PDF with an explicit `TJ`-array kerning adjustment between
  "agencj" and "ach" at a controlled gap ratio: **0.3** (between the old 0.22 and new 0.4
  thresholds — reproduces the exact real-document defect class) must **not** split the word;
  **0.6** (a genuine wide gap) must still insert a space. This is the same mechanism, same
  font size (12pt), and the same character pair that produced every false positive found in
  the real 154-page document — not a synthetic unrelated case.

The migration-state check (§4) has no dedicated unit test: `import-programme-cli.ts` is a
top-level script (importing it executes `main()` immediately), so unit-testing
`assertMigrationsApplied` in isolation would require restructuring the CLI's export shape,
which was not in scope. It is a single read-only `SELECT`, reasoned about directly rather than
covered by a new automated test.

### Real-bundle validation, full log

```
node apps/api/dist/ai/import-programme-cli.js etap3b-adapt Program
  Wrote Program/manifest.json
  Wrote Program/vocabulary.json
  Wrote Program/proposals.json
  Wrote Program/coverage.json
  1423 proposals adapted, 0 rejected, 151 sections retained (10 empty).

node apps/api/dist/ai/import-programme-cli.js validate Program
  release            zieloni-programme-2026-draft-r1
  document version   dv-program-zielonych-2026-draft-r1
  extraction         szronox-pdf-text@1, 154 pages, 338995 normalized characters
  undecoded glyphs   0
  index              151 sections, 1423 proposals, 1426 chunks
  pages indexed      149 of 154
  pages excluded     5
  admission          type=programme adopted=none amendment=NOXAVA
  public source url  waived by amendment (archived copy is authoritative)
  REJECTED           0 findings
  exit 0
```

("pages indexed" moved from 148 → 149 versus CORPUS-02's baseline: page 75 — claimed by
`SZR-SEC-SFB-006` in the coverage ledger all along — only becomes genuinely *indexed* once that
proposal grounds correctly (§3b), which resolved a `ledger_page_unindexed` finding as a side
effect, not a new fix on its own.)

No database was touched by this validation run — `validate` never opens a connection.

## 7. Remaining blockers

**None for the acceptance criteria in this task's scope.** All 12 grounding mismatches are
resolved, printed page labels are valid, the report carries zero findings.

Carried forward from CORPUS-01/02, unchanged and out of this task's scope:

1. **No corpus has been imported to any database.** `import`/`approve`/`activate` were not run
   (explicitly excluded from this task).
2. **Live provider (Gemini) credentials remain untested** against this corpus — the one
   reserved live `Sprawdź postulat` smoke test from the CORPUS-02 handoff is still open.
3. **`Finalszronox_programme_proposals.csv`** was not regenerated to match the
   `SZR-EDU-EE-002` correction (§3e) — harmless, since it's inspection-only and unread by the
   pipeline, but worth operator awareness if the CSV is ever used for anything else.
4. **PGlite pins PostgreSQL 18; the deployment pins 17.6** — standing note from VPS-04,
   unaffected by this task.

## 8. DEV deployment procedure (documented, not executed)

Per the handoff's explicit instruction, none of the following was run. In order, each a
separately authorized step:

1. **Establish current release.** On `dev.szronox.zieloni.tech`, record the currently deployed
   commit/branch and confirm no newer unrelated work is in flight there.
2. **Back up.** Database: `pg_dump` (or the project's existing backup procedure) of the full
   `app` schema before any migration. Archive: snapshot or note the current
   `PROGRAMME_ARCHIVE_ROOT` directory contents (empty, if no corpus has ever been imported on
   this host).
3. **Deploy reviewed code.** Merge/deploy this branch's `apps/api` and `apps/worker` changes.
   No `apps/web` change in this task, so no frontend redeploy is strictly required, but normal
   deploy procedure applies.
4. **Apply migrations.** `node apps/api/dist/db/migration-cli.js` against the DEV database.
   Confirms `0006_programme_corpus.sql` and `0007_programme_enrichment_revisions.sql` both
   apply cleanly (both already exist from CORPUS-01/02; only rerun if DEV hasn't had them yet).
5. **`grants.sql` rerun is not required** — this task changed no schema and no privilege
   surface; migration 0006/0007 already grant/revoke correctly per `deploy/vps/postgres/
   grants.sql`, unchanged since CORPUS-02.
6. **Import inactive.** On the deployment host, with
   `PROGRAMME_ARCHIVE_ROOT=/var/lib/szronox/storage/programme` (§4) set:
   ```
   node apps/api/dist/ai/import-programme-cli.js etap3b-adapt Program
   node apps/api/dist/ai/import-programme-cli.js validate     Program --report report.json
   node apps/api/dist/ai/import-programme-cli.js import       Program
   ```
   Confirm the report shows 0 findings (as in §6 above) before proceeding.
7. **Approve.** `node apps/api/dist/ai/import-programme-cli.js approve zieloni-programme-2026-draft-r1 --by "<named operator>"`.
8. **Explicitly activate.** `node apps/api/dist/ai/import-programme-cli.js activate zieloni-programme-2026-draft-r1`. This re-checks archive hashes and completeness and atomically supersedes any previous active release for this corpus (none expected on a fresh DEV import).
9. **Verify.**
   - Health: confirm the API's readiness endpoint reports healthy post-activation.
   - Citation opening: resolve `/api/v1/programme/versions/<documentVersionId>/source`
     authenticated, confirm `application/pdf`, `private, no-store`, correct byte count/hash.
   - Unchanged neighbours: confirm an unrelated existing Reel/attachment (if any exist on DEV)
     is untouched — this release is the *first* import for corpus `zieloni-programme`, so no
     supersession should occur; confirm `supersededSlug: null` in the `activate` output.
   - One `Sprawdź postulat` smoke request against real content known to match the programme
     (e.g. a Reel about water policy) and one against unrelated content (expect no candidates,
     no provider call) — the two acceptance checks CORPUS-02's handoff reserved as manual,
     still open (§7.2).

**Rollback, documented separately from deployment**: code rollback is the normal git revert of
this branch's commits plus a redeploy. Release rollback is independent and non-destructive —
`activate` never deletes a superseded release, so if a later release needs to be deactivated,
the corrective action is either (a) importing and activating a replacement release, which
atomically supersedes the current one, or (b) a direct, reviewed `UPDATE` on
`app.programme_releases.state` by the schema owner outside the CLI (no CLI command exists to
deactivate without replacing, by design — the spec requires "exactly one active release" whenever
the corpus is meant to be searchable at all, not a "searchable with nothing active" state). This
is a deliberate product decision from CORPUS-01, restated here rather than changed.

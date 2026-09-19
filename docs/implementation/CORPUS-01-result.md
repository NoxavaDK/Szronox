# CORPUS-01 — approved programme corpus: importer, schema, retrieval, citation source

Branch `codex/corpus-01`, worktree `.worktrees/corpus-01`, based on `codex/gemini-02-impl` (`c13f7a1`).
Implementation commit `7be52b5`; this record is the commit after it. Not merged.
Implemented by the root agent directly on the approved Opus scope brief; no coding agent was dispatched
and no nested agent was spawned.

Authority: `docs/product/programme-corpus-spec.md` (content model) and the approved CORPUS-01 scope.
New input contract: `docs/product/programme-corpus-operator-bundle.md`.

---

## 1. What changed, and why

The GEMINI-02 pipeline had a working programme path with four defects the corpus specification does not
allow. Each is corrected here, and nothing else about the AI pipeline was touched.

| Defect | Correction |
| --- | --- |
| Import approved the version it had just written and un-approved whatever came before, so a half-reviewed index was searchable immediately. | Import, approval and activation are three separate acts. Import writes an inactive release; a named human approves; activation re-proves hashes and completeness and atomically supersedes the previous active release. |
| A chunk carried one physical page. | Chunks carry every page their text touches, with printed labels of equal length and order. The legacy scalar columns are kept in step by a CHECK. |
| Evidence was ranked on chunk text alone, with no operator enrichment and no proposal de-duplication. | Ranking is a weighted `tsvector` over title, operator keywords, tags, headings and body, deduplicated to one chunk per proposal, capped at eight, deterministic to the last tie-break. |
| `sourceUrl` was the operator's public URL, so opening a source depended on a third-party web server still serving the same bytes. | The archived PDF is served from a private root through an authenticated, version-specific route, verified against its recorded SHA-256, opened at the first cited page. |

Added on top of those: a deterministic PDF text extractor, so the server can re-derive what is on a page
from the archived bytes; passage grounding against that text; a coverage ledger; and a validation report.

## 2. Files owned by this task

**New**

- `database/migrations/0006_programme_corpus.sql`
- `apps/api/src/ai/corpus/pdf-text.ts` — deterministic extraction (xref, Flate, ToUnicode / WinAnsi /
  MacRoman / `/Differences`, text operators, widths-based advances)
- `apps/api/src/ai/corpus/normalize.ts` — §3 normalization, document assembly, page offset spans
- `apps/api/src/ai/corpus/chunking.ts` — §2.6 chunk generation
- `apps/api/src/ai/corpus/bundle.ts` — bundle reading, JSON and CSV, structural validation
- `apps/api/src/ai/corpus/validate.ts` — grounding, coverage, validation report
- `apps/api/src/ai/corpus/repository.ts` — import / approve / activate / resolve active release
- `apps/api/src/ai/corpus/archive.ts` — private archive staging and verified reads
- `apps/api/src/ai/corpus/retrieval.ts` — candidate retrieval and archived-source resolution
- `apps/api/src/corpus.test.ts`
- `docs/product/programme-corpus-operator-bundle.md`

**Modified**

- `apps/api/src/ai/import-programme-cli.ts` — rewritten as `validate | import | approve | activate`
- `apps/api/src/ai/service.ts` — active-release resolution, new evidence shape, release in the snapshot
- `apps/api/src/ai/routes.ts` — archived-source route; capabilities follow the release
- `apps/api/src/core/routes.ts` — `programmeArchiveRoot` dependency
- `apps/api/src/core/config.ts` — `PROGRAMME_ARCHIVE_ROOT`, defaulting to `<APP_STORAGE_ROOT>/programme`
- `apps/api/src/deploy-grants.test.ts` — corpus grants and immutability assertions
- `apps/api/src/core.test.ts`, `apps/api/src/vps-integration.test.ts`, `apps/api/src/ai/service.test.ts` — stale assertions and fixtures (§7)
- `apps/api/package.json` — `node --test dist/*.test.js dist/*/*.test.js`, so nested test files actually run
- `apps/worker/src/ai/actions.ts` — page arrays, reduced model projection, proposal de-duplication
- `apps/worker/src/ai/actions.test.ts`
- `deploy/vps/postgres/grants.sql` — corpus tables readable, never writable, by both runtime roles

No shared contract file was edited: `packages/contracts/src/index.ts` is unchanged.

## 3. Contract decisions made as lead

1. **`ProgrammeCitation.sourceUrl` now carries the internal archive route**
   (`/api/v1/programme/versions/<id>/source#page=<first cited page>`), not the operator's public URL.
   The shape of the contract is unchanged; what the string points at is. The operator's public URL stays
   on the version row as provenance and appears in the validation report. Rationale: the citation must
   open the exact bytes the excerpt was derived from, and only the archive can promise that. No existing
   attachment is affected — no corpus has ever been imported.
2. **`programmeDocumentVersionId` in the snapshot** names the release's document version when the release
   has exactly one, and is null otherwise; each candidate carries its own version either way.
3. **`programmeReleaseId`** was added to the *internal* snapshot only. It is stripped from every wire
   response, exactly as `programmeEvidence` and `imageObjects` already were.
4. **A chunk keeps `proposal_id NOT NULL`.** The contract still types `proposalId` as nullable, and the
   content specification allows a null proposal for continuous prose; the bundle format does not, because
   its canonical input is ordered proposal records. Admitting prose-only sources is a later change to
   both the bundle format and this column.

## 4. Acceptance evidence

Commands, run in `.worktrees/corpus-01` on Node 25.9.0 (CI pins 22):

```
npm run build --workspace @szronox/contracts
npx tsc -p apps/api/tsconfig.json          # clean
npx tsc -p apps/worker/tsconfig.json       # clean
node --test apps/worker/dist/ai/actions.test.js
node --test apps/api/dist/corpus.test.js
node --test apps/api/dist/deploy-grants.test.js
npm test --workspace @szronox/api
```

Results are recorded in §7 below.

### What the corpus suite proves

The fixture is a real PDF assembled byte by byte in the test — catalog, page tree, cross-reference table,
a Type1 font with a `/Differences` encoding for the Polish letters WinAnsi lacks. Extraction,
normalization, chunking, offsets, page mapping, the database constraints and all three lifecycle acts run
unstubbed against PGlite with the committed migrations.

- extraction recovers Polish text, page order and page boundaries with zero undecoded glyphs;
- every chunk equals `document.slice(charStart, charEnd)`, stays inside its proposal, and its chunks
  reassemble to the whole proposal without inventing or dropping text;
- the CSV adapter and the JSON dataset produce an identical index;
- ten malformed-bundle cases are rejected with their specific codes, including both page forms at once,
  page endpoints instead of every page, a duplicate proposal id, a passage absent from the PDF, a passage
  on a different page, an omitted (rather than explicitly null) subchapter, a tag outside the vocabulary,
  one section declared with two headings, a record-count disagreement, and an unadopted draft with no
  admission amendment;
- five coverage-ledger failures are rejected, including a page marked only "reviewed";
- import leaves nothing searchable; activation before approval is refused; approval with an empty
  approver is refused; activation then supersedes atomically and exactly one release stays active;
- a superseded release's version still resolves and still opens its archived PDF;
- activation is refused when the archived bytes changed underneath it;
- release and version slugs are never reused;
- retrieval finds the exact proposal, reaches a proposal through operator keywords that do not appear in
  its text, returns an empty result for unrelated content, deduplicates by proposal, and returns the same
  evidence in the same order on repeat;
- every retrieved excerpt equals the stored chunk, with identical page arrays;
- `find_programme` raises `INSUFFICIENT_EVIDENCE` with no active release and uses the release once
  activated, with evidence and release id absent from the wire response;
- the archived source route is 401 anonymous, serves `application/pdf` with `private, no-store` and
  `nosniff`, 404s a version that was never released, 503s with no archive root configured, and 503s
  rather than serving a file whose bytes no longer match the recorded hash.

Worker-side: an invented chunk id fails the run with an evidence error; a selected candidate's pages,
source and proposal come from the index and not from the model; the prompt carries no page, URL or
version the model could quote back; empty retrieval never reaches the provider; two chunks of one
proposal cannot become two candidates.

Grants: both runtime roles read all eight corpus tables and can write none; indexed sections, proposals
and chunks refuse UPDATE and DELETE even from the owner; a version without validated provenance cannot
join a release.

## 5. Real-world gates — OPEN, not passed

- **No corpus has been imported.** `ProgramSzroNox.pdf` / `.docx` sit untracked in the repository root
  and are **not** a bundle: there is no manifest, no semantic dataset, no vocabulary and no coverage
  ledger. Nothing can be imported until the operator supplies them.
- **Admission is a blocker for that document.** It presents itself as a 2026 programme draft. The
  specification excludes unadopted drafts. The importer will refuse it unless the manifest carries an
  `admission_amendment` with a named approver and a written statement, and `--by` names a human at
  approval. This is a decision for the user, not something the code should assume.
- **Extraction on the real file** was exercised as a one-off check outside the suite: 154 pages, 0
  undecoded glyphs, no warnings, ~300 ms, correct Polish diacritics on the pages inspected. That is
  evidence the extractor reads this producer's output; it is not evidence that any passage is correctly
  located, because no dataset exists to locate.
- **No deployment, no migration against DEV or production, no live provider call.** Migration 0006,
  the grants rerun, the API/worker rollout, the import, the approval, the activation and the two
  programme smoke requests all remain separately authorized steps.
- **PGlite is PostgreSQL 18; the deployment pins 17.6.** Unchanged from VPS-04's standing note.

## 6. Limitations worth stating

1. **Extraction scope is deliberate.** Classic cross-reference tables with an object-scan fallback;
   FlateDecode only; no cross-reference streams (PDF 1.5+); form XObjects are reported but not traversed.
   Each unsupported construct produces a warning, and an undecodable byte becomes U+FFFD and is counted —
   a proposal whose text contains one is rejected rather than indexed. A source the extractor cannot read
   fails loudly at validation; it never produces a partially wrong index.
2. **Reading order is stream order.** Correct for a linearly typeset document, which is what the
   admission rules allow in. A multi-column or heavily floated layout would need a column-aware pass.
3. **A completed `find_programme` run does not go stale when a new release is activated.** It keeps
   reporting against the release it ran on, and `Przypnij` on such a run pins a version of a superseded
   release — which stays resolvable by design. Marking those runs stale would require resolving the
   active release on every read; it is a product decision, not an oversight.
4. **The stopword list is small, fixed and grammatical.** It exists because "oraz" in a Reel about a film
   otherwise matches a programme passage. It removes noise, never subject matter, and it is the one place
   in retrieval where a judgement call is baked in.
5. **Sentence splitting does not know about abbreviations.** A split inside "np." costs nothing — both
   halves are still exact contiguous text — and a cleverer rule that differed between runs would change
   chunk identity for the same source.
6. **`npm test --workspace @szronox/api` now runs `dist/` recursively.** That fixes a real gap —
   `apps/api/src/ai/service.test.ts` had never been executed by `npm test` — and it also loads two
   side-effect-free helper modules whose names match Node's `test-*.js` pattern. They contain no tests
   and pass trivially.

## 7. Test results

```
npm run build                                    clean (contracts, web, api, worker)
npm run typecheck                                clean (all four workspaces)
node --test apps/worker/dist/ai/actions.test.js  6 tests, 6 pass, 0 fail
npm test --workspace @szronox/api                163 tests, 161 pass, 2 fail
```

Of the API suite: `corpus.test.js` 14/14, `deploy-grants.test.js` 8/8, `ai/service.test.js` 6/6,
`core.test.js` 45/45. Whole suite, 90 s.

### The two failures are pre-existing and are not from this task

```
✖ each service mounts only the secrets its own identity needs
    the worker handles no attachment bytes, so it must not mount the storage volume
✖ the runbook documents every variable and secret the deployment requires
    compose.yaml reads AI_ENABLED from the host but README.md never mentions it
```

Both are in `apps/api/src/deploy-config.test.ts` and both fail identically on the unmodified base
commit — verified by running `node --test dist/deploy-config.test.js` in `.worktrees/gemini-02-impl`
(`c13f7a1`): 7 tests, 5 pass, the same 2 fail. They are GEMINI-02 drift: that task gave the worker a
real need for attachment bytes and added `AI_ENABLED`, without updating the VPS deployment assertion or
the runbook. Resolving them means editing `deploy/vps/compose.yaml` or `deploy/vps/README.md` and a
security assertion owned by the VPS batch, so they are reported rather than quietly changed here.

### Two stale assertions this task did fix

`core.test.ts` and `vps-integration.test.ts` each asserted a hard-coded list — of tables and of applied
migrations — that GEMINI-02 had already outdated by adding `ai_runs` and `0005_ai_pipeline.sql`. Both
were failing before this task and would have failed again for 0006. Both now list every committed
object, so adding a table or a migration is a deliberate edit rather than a broken test.

`apps/api/package.json` ran `node --test dist/*.test.js`, which never matched `dist/ai/service.test.js`
— GEMINI-02's own service suite had never run under `npm test`. It now runs
`node --test dist/*.test.js dist/*/*.test.js`. (`node --test dist/` also works and is more future-proof,
but on Node 25 it runs the whole directory as one serial unit and takes more than ten minutes instead of
ninety seconds, so the explicit two-level form is used.) Running the previously-skipped suite surfaced
one genuine regression from this task — its fixture built an approved version directly — which is fixed
by giving it a real active release.

## 8. One-off check against the real programme PDF

Not part of the suite, and deliberately discarded afterwards. `ProgramSzroNox.pdf` was placed in a
temporary bundle with a two-record dataset whose passages were taken verbatim from pages 2 and 3, plus a
vocabulary and a ledger accounting for all 154 pages (2 indexed, 152 excluded with a reason).

```
node apps/api/dist/ai/import-programme-cli.js validate <tmp-bundle>
  extraction         szronox-pdf-text@1, 154 pages, 339044 normalized characters
  undecoded glyphs   0
  index              1 sections, 2 proposals, 2 chunks
  pages indexed      2 of 154
  admission          type=programme adopted=none amendment=SMOKE TEST — nie do publikacji
  public source url  waived by amendment (archived copy is authoritative)
  exit 0
```

The first attempt exited 1 with `[order_index_duplicate] record[1]` — a real mistake in the hand-written
dataset, caught by the validator rather than imported.

What this establishes: extraction reads this producer's output completely, grounding locates real
passages on their declared pages, the ledger arithmetic works at 154-page scale, and the admission gate
demands an amendment for an unadopted draft. What it does not establish: anything about a real corpus.
No bundle was imported, no database was touched, and the temporary directory was deleted.

## 9. Next steps, each separately authorized

1. The operator produces a real bundle per `docs/product/programme-corpus-operator-bundle.md`, and the
   user decides the admission question for the 2026 draft — including who signs `approved_by`.
2. Review this branch; it is not merged. `docs/product/programme-corpus-spec.md` remains untracked in the
   repository and is referenced by path only; this branch adds the input specification beside it.
3. Deployment wiring is **not** included: `deploy/vps/compose.yaml` has no `PROGRAMME_ARCHIVE_ROOT` and
   no archive volume. The default `<APP_STORAGE_ROOT>/programme` means the API can serve sources from the
   existing storage mount, but the importer runs as the owner outside the containers and needs write
   access to that directory. Decide this with the VPS owner before rollout.
4. Then, in order: DEV backup, migration 0006, `grants.sql` rerun, coordinated API/worker rollout,
   `validate` → `import` → read the report → `approve --by` → `activate`, and the two programme smoke
   requests (one positive, one unrelated-content). Live provider credentials remain an OPEN gate.

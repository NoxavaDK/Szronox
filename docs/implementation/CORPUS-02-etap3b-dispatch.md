# CORPUS-02 — ETAP 3B input adapter, enrichment revisions, operator instructions

Branch `codex/corpus-01`, worktree `.worktrees/corpus-01`, extending CORPUS-01
(`902a2fa`, implementation commit `7be52b5`). Not merged. This record is the handoff as given
by the user; implementation follows in subsequent commits on this branch.

Status: this handoff is a plan, not implementation or deployment authorization. It sets scope
for work to be done directly in this worktree by the root agent (Claude, Sonnet 5), continuing
the CORPUS-01 lineage — no nested agent dispatched for this record.

---

## 1. Implementation scope

Extend the existing CORPUS-01 implementation at `902a2fa`; do not rebuild its architecture. It
already provides the corpus hierarchy, private PDF archive, separate import/approval/activation
commands, weighted retrieval, eight-candidate provider input and three-result output.

Implement an ETAP 3B input adapter, deterministic validation, controlled enrichment updates and
operator instructions. Preserve the frozen UI and existing Gemini job pathway. This handoff is a
plan, not implementation or deployment authorization.

## 2. Canonical inputs

Read from `/Users/kubabilski/Desktop/SzroNox/Program/`:

- `Finalszronox_programme_proposals.json` — canonical proposal input.
- `Finalszronox_programme_metadata(2).json`
- `Finalszronox_programme_coverage.json`
- `Finalszronox_programme_qa(2).json`
- `ProgramSzroNox.pdf` — authoritative citation artefact.

CSV is inspection/export only; DOCX is not a citation source. Preserve every supplied
`proposal_id` exactly in the existing external_id field. Keep the existing internal UUID
mapping; never regenerate the operator IDs or derive identity from tags.

## 3. Expected files/components

Within `.worktrees/corpus-01`, likely changes are:

- `apps/api/src/ai/corpus/bundle.ts`, `validate.ts`, `repository.ts`, `retrieval.ts`
- A small ETAP 3B adapter alongside those modules.
- `apps/api/src/ai/import-programme-cli.ts`
- Targeted corpus tests.
- One additive migration under `database/migrations/`.
- Corpus operator documentation and narrowly required grants.

Change programme job snapshots or worker handling only if needed to record enrichment revision
provenance. No unrelated Gemini or UI changes.

## 4. Schema and compatibility

Migration 0006 already supplies primary tags, secondary tags, keywords and derived search
vectors. Do not duplicate these fields.

Its blanket proposal-immutability trigger currently prevents enrichment updates. Add a narrowly
constrained operator update path permitting only enrichment fields and their derived search
representation, with a revision/audit record. Preserve immutable IDs, text, structure, pages,
category and source provenance. Runtime API/worker roles remain read-only for corpus data.

Keep citation category separate from mutable retrieval tags. Any initial
primary-tag-to-category mapping must be explicit and pinned; later tag changes must not rewrite
historical citations.

## 5. Validation and missing companion metadata

Validate record/ID counts, chapter/section membership, nonempty text and keywords, exactly one
primary tag, zero–four secondary tags, vocabulary membership, page forms/ranges, PDF checksum,
section totals, complete page coverage and zero unresolved grounding issues. Reject malformed
data without repairing it.

The supplied bundle is not directly compatible with the existing importer's full manifest
format. Supply an explicit adapter and companion manifest covering document/version identity,
named approval, vocabulary mapping and ingestion provenance.

Record the approved draft-snapshot admission through the existing `admission_amendment`
mechanism. Use corpus `zieloni-programme` and release `zieloni-programme-2026-draft-r1`; never
invent formal adoption dates or a public source URL.

Existing validation also requires printed-page labels and normalized-text grounding/offset data
not present in these proposal records. Reuse retained verified grounding artefacts where
available; otherwise report the missing companion input. Do not fabricate labels/offsets,
silently weaken validation, or rerun extraction. Treat ETAP 3B's grounding verification as
operator evidence, not a verification newly performed by this task.

## 6. Ingestion and activation

Validate → present summary → archive checksum-verified PDF → transactionally import the
existing hierarchy inactive → named operator approval → separate explicit activation.

Retain all 151 sections, including empty sections. Preserve proposal text and page grounding
while deriving deterministic chunks/search data. Activation must recheck archive integrity and
completeness, then atomically replace the active release. No direct operator SQL.

## 7. Retrieval

Reuse weighted proposal text, chapter, section, primary tag, optional secondary tags and
keywords. Do not add a secondary-tag requirement or missing-tag penalty. Check short controlled
terms such as AI and UE: current tokenization excludes words shorter than four letters.

Retrieve at most eight distinct real proposals; Gemini selects at most three using the existing
supplied chunk identifiers. Reject unknown identifiers. Reconstruct all citation details from
persisted evidence. Empty retrieval requires no provider call; missing active corpus remains an
explicit error.

## 8. Enrichment revisions

Accept operator updates keyed by frozen proposal ID, validate against the declared vocabulary,
record revision/checksum/operator and rebuild derived search fields transactionally. Preserve
earlier run evidence and attachments. Source changes require a new document version/release;
tag changes do not.

## 9. Targeted acceptance

Cover all thirteen requested checks, including inactive import, explicit activation, exact and
cross-cutting retrieval, no-secondary-tag retrieval, bounded candidate input, invented-ID
rejection, unrelated-content no-match, PDF citation integrity and identity-preserving
enrichment updates.

Use local deterministic fixtures for rejection cases. Reserve one short live Sprawdź postulat
call for the integrated path; stop on provider/quota failure. Do not repeat accepted Gemini
tests.

## 10. Later bounded DEV deployment

After authorization: establish current release, preserve unrelated newer work, back up affected
database/archive state, deploy reviewed corpus changes, apply migrations/grants, import
inactive, explicitly activate, and verify health, citation opening and unchanged neighbours.
Document code rollback and release deactivation/reactivation separately. Target only
`dev.szronox.zieloni.tech`.

---

## Next step

Implementation proceeds directly in this worktree per the user's instruction (record, then
implement). No separate agent dispatch for this phase.

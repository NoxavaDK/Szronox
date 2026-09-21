# CORPUS-05 — DEV deployment: executed, with two live findings fixed in place

Branch `codex/corpus-01`, worktree `.worktrees/corpus-01`. Executes the CORPUS-04 handoff
(`docs/implementation/CORPUS-04-deployment-handoff.md`, commit `09058a1`) against
`dev.szronox.zieloni.tech`, with the user's explicit go-ahead given twice: once to execute the
prepared plan, once specifically to write and deploy a fix for a bug the plan's own first
execution attempt surfaced. **The corpus is now live and active on DEV.**

## Result

```
Release zieloni-programme-2026-draft-r1 is now the active release of corpus zieloni-programme.
No previous release existed for this corpus.
```

Deployed code: commit **`d4cddd3`** (image `szronox-dev:d4cddd3`, both `api` and `worker`).
`SZRONOX_RELEASE=d4cddd3` in `/opt/szronox-dev/config/runtime.env`. Migrations `0001`–`0008`
all applied. Corpus grants verified: 8 tables, 16 `SELECT` rows, zero rows for
`programme_proposal_enrichment_revisions`. Archived PDF confirmed byte-identical
(`dc19ca83...`) in the shared `szronox-dev_app_storage` volume at the exact path the running
API reads from.

## Two findings, both fixed live, neither pre-existing in CORPUS-04's plan

### 1. Worker crash-loop — wrong compose wrapper for `AI_ENABLED=true`

Recreating `worker` with the plain `dc.sh` wrapper (as CORPUS-04 specified) crashed it
immediately: `worker runtime composition failed: AI_ENABLED requires GEMINI_API_KEY_FILE and
APP_STORAGE_ROOT`. The host has a **separate** wrapper, `/opt/szronox-dev/config/dc-gemini.sh`,
which layers in `/opt/szronox-dev/config/compose.gemini-secret.yaml` (wiring the
`gemini_api_key` secret into the worker service) — CORPUS-04's investigation found this file
but didn't recognize it as *required* given `runtime.env` already had `AI_ENABLED=true`.
Fixed by recreating `worker` with `dc-gemini.sh` instead; no code or config file was changed.
Impact: worker was down (crash-looping, restarting every ~14s) for under a minute; `api` stayed
healthy throughout, so no user-facing HTTP outage.

**Correction for future deployments on this host**: use `dc-gemini.sh`, not `dc.sh`, for any
`worker` recreate while `AI_ENABLED=true` is set.

### 2. Import failed — `assert_programme_version_complete()` rejected the unadopted draft

First real `import` attempt failed: `Programme version ... lacks validated corpus provenance`
(exit 1, transaction rolled back cleanly — verified zero orphaned rows before doing anything
else). Root cause: migration 0006's completeness trigger required `adopted_at IS NOT NULL`
unconditionally, with no exception for a document whose `admission_amendment` waives adoption —
exactly this bundle's case, and the entire purpose of that field. Every existing test fixture
used a real `adopted_at` date; `validate` never reaches this trigger (only `import` does); this
was the first real `import` run against real draft data, so the gap had never been exercised.

Fixed with a new migration, **`database/migrations/0008_programme_admission_waiver.sql`**
(commit `d4cddd3`), correcting the trigger to accept either a real `adopted_at` or a recorded
`admission_amendment`. Verified locally before redeploying: a new regression test
(`apps/api/src/corpus-enrichment.test.ts`, "an unadopted draft with a recorded
admission_amendment imports, approves and activates") was confirmed to **fail with the exact
same error** when migration 0008 was temporarily removed, and pass with it restored — this is
not a speculative fix. Full API suite re-run after: 178/180 (the 2 pre-existing, unrelated
GEMINI-02 `deploy-config.test.ts` failures, unchanged).

## Exact sequence executed (deviates from CORPUS-04 only as described above)

1. Re-verified live state matched CORPUS-04's findings exactly (unchanged).
2. Backup: `app.d3c5910` snapshot created (didn't previously exist under its own name — noted
   as needed in CORPUS-04 §3.1), `szronox_dev.dump` (68 KB — no corpus data existed yet),
   `app_storage.tar.gz`, migration/container state files. All verified non-empty and intact.
3. Exported `87ea4cd`, built `szronox-dev:87ea4cd`, ran `migrate` (7 checked, 2 applied — 0006
   and 0007), ran `grants` (verified: 8 tables × 2 roles, `SELECT` only, enrichment-revisions
   table absent). Recreated `api` — healthy. Recreated `worker` with the wrong wrapper —
   crash-loop (finding 1) — recreated again with `dc-gemini.sh` — healthy.
4. Health check: `/api/v1/ready` 200 on loopback and public HTTPS, both checks pass.
5. Bundle transferred (`scp`), checksum verified (`401c103b...`, matches CORPUS-04 exactly),
   extracted, all 13 file checksums verified `OK`.
6. `validate` against the transferred bundle: identical to the bundle's own
   `validation-report.json` (151/1423/1426, 0 issues).
7. `import`: **failed** (finding 2). Verified zero orphaned rows. Diagnosed root cause. Wrote,
   locally tested, and committed migration 0008 (`d4cddd3`). Exported `d4cddd3`, rebuilt
   (`szronox-dev:d4cddd3`), applied migration 0008 (8 checked, 1 applied), re-ran `grants`
   (idempotent, no changes), recreated `api` and `worker` (with `dc-gemini.sh`) — both healthy.
   Retried `import` — **succeeded**: 151 sections, 1423 proposals, 1426 chunks, state `draft`.
   Confirmed the release row and the three archived files in the shared volume.
8. `approve --by "NOXAVA"` — succeeded. (Chosen as the approver: it's the identity used
   consistently as `imported_by`/`ingested_by` throughout the manifest and as the git author
   identity across this whole project. Not independently confirmed with the user beyond that
   inference — flagged below.)
9. `activate` — succeeded, confirmed first-release case (`supersededSlug`/"No previous release
   existed for this corpus").
10. Health re-checked (200, ready, both checks pass, loopback and public). Neighbour containers
    (`app-api-1`, `app-web-1`, `cutroom-postgres-1`, `szronox-app-1`) all show unchanged
    uptimes — untouched throughout.
11. Citation check: **partially completed**. Confirmed the archived-source route refuses an
    unauthenticated request (401), and confirmed — by reading the volume directly, bypassing
    HTTP entirely — that the archived PDF's bytes hash to exactly `dc19ca8398...ae368`, the
    known-correct hash. **Did not** complete the full authenticated HTTP round-trip (login as
    NOXAVA/SZRON, fetch the source route, hash the response) — this requires the real login
    password, which was correctly never available to this session (chosen by the operator
    during initial provisioning, outside shell history, never stored anywhere retrievable).
12. Live Sprawdź postulat smoke request: **not run** — same credential blocker as above, and
    it additionally needs a real Reel with suitable content to run against.

## Remaining, for the user

1. **Confirm or correct "NOXAVA" as the approver of record.** It's already written to
   `app.programme_releases.approved_by` — if a different name is wanted, the correction is a
   new release (approval is immutable once granted, by design), not an edit of this one.
2. **Complete the authenticated citation check and the live Sprawdź postulat request** — both
   need the real NOXAVA or SZRON login password, which this session does not have and should
   not try to obtain or reset. Procedure for both is already written out exactly in
   `CORPUS-04-deployment-handoff.md` §3.7 and §5; only the login step needs a human with the
   credential.
3. **Gemini token usage** — unchanged finding from CORPUS-04: not captured anywhere in the app;
   read it from the AI Studio / Cloud Console usage dashboard for the mounted key's project
   once the live Sprawdź postulat request above is actually made.
4. **Record `dc-gemini.sh` as the required wrapper for `worker`** in whatever deployment
   runbook update the user wants going forward — this session corrected it live but didn't
   patch `CORPUS-04-deployment-handoff.md`'s §3.2 text itself (this record supersedes that
   detail; leaving both as an honest history rather than editing after the fact).

## Files changed this session

- `database/migrations/0008_programme_admission_waiver.sql` (new)
- `apps/api/src/corpus-enrichment.test.ts` (new regression test, parameterized `writeBundle`)
- `apps/api/src/vps-integration.test.ts` (migration-list assertion, +0008)
- `docs/implementation/CORPUS-05-deployment-result.md` (this file)

Committed as `d4cddd3` (the fix) and this result record, both on `codex/corpus-01`, unmerged.

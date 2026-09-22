# GEMINI-02 — root integration, correction and DEV deployment result

Date: 2026-09-17. Bounded root integration of the existing GEMINI-02 implementation. No rebuild,
no duplicate audit, no second implementation agent, no merge.

| | |
| --- | --- |
| Source branch | `codex/gemini-02-impl` (unmerged) |
| Implementation reviewed | `afd53d1`, worker privileges `eecbeeb`, evidence `02e9526` |
| Correction added here | `d3c5910` — DNS pinning fix in bounded public source retrieval |
| **Deployed release** | **`szronox-dev:d3c5910`** on https://dev.szronox.zieloni.tech |
| Previous release | `szronox-dev:758d780` (retained, with its source export) |

## 1. Bounded integration review

Read the handoff, the final diff (35 files) and the seven concrete review triggers in
`GEMINI-02-integration-decisions.md`. Recorded tests were accepted provisionally; targeted checks
were run only where a trigger or a concrete risk pointed at one.

| Root trigger | Where it lands | Verdict |
| --- | --- | --- |
| 1. Idempotency validates actor, route and payload | `ai/service.ts` `replay`/`idempotent`, plus unique-violation replay | Met. Verified live: same operation id replays the same run; a different payload on that id returns `IDEMPOTENCY_CONFLICT` |
| 2. Lease ownership, fencing and bounded execution | `worker/ai/jobs.ts` — `FOR UPDATE SKIP LOCKED`, 5-minute lease, fencing token, 4-minute outer deadline, finalization guarded by token and `clock_timestamp()` | Met. Accepted the recorded PostgreSQL harness rather than re-running it |
| 3. Deterministic manual meme order, first primary; shared asset lifecycle independent of a Reel | `ai/library.ts`, migration `reel_memes.position` | Met and verified live (attach, append, detach, library record survives detach) |
| 4. Programme no-match must not detach | `service.ts` `programme_no_match` rejects with `VALIDATION_ERROR` when an attachment exists | Met; covered by the implementation's own PGlite case |
| 5. Claim-scoped fact freshness with deterministic remapping | `replayScriptEdits`, `mappedClaimSpan`, `claimContext` — sentence-level overlap invalidation, no fuzzy matching | Met |
| 6. `scriptRevision` only on real text change; language freshness checks revision | `script is distinct from` guards on every script write; language apply checks text *and* revision | Met |
| 7. Publication collision allows explicit replacement, protects intervening edits | `replaceCurrentValue` baseline + `confirmReplacement` + `expectedVersion` | Met and verified live in all three branches (stale baseline, missing confirmation, confirmed) |

Additional checks made at the boundary, all clean: private provenance (`imageObjects`,
`programmeEvidence`, storage keys, run `provenance`) is stripped from the run response by
`visibleSnapshot`; `find_programme` candidates can only be expanded from indexed chunks, so the
model supplies a ranking and a rationale but never evidence, identifiers or source metadata; a
single approved programme version is enforced by a unique partial index and by the import CLI.

## 2. Correction made — `d3c5910`

**Bounded public source retrieval was broken for every URL.** `retrievePublicSource` pins DNS per
hop by passing a custom `lookup` to `http.request`, answering with the scalar
`(err, address, family)` form. Node requests `all: true` whenever it chooses between address
families — the default since `autoSelectFamily` — and then reads `addresses[0]`, so the socket saw
`undefined` and threw `ERR_INVALID_IP_ADDRESS` before any request was sent. That is not a
`SourceError`, so the run was recorded as `INTERNAL_ERROR` rather than a truthful source failure.

Evidence, from the worker identity on the DEV host:

```
before   ERR https://example.com/   name=TypeError code=ERR_INVALID_IP_ADDRESS
         ERR https://www.gov.pl/     name=TypeError code=ERR_INVALID_IP_ADDRESS
after    OK  https://example.com/    status=200 type=text/html chars=142  sha=ff67a9d764d6
         OK  https://www.gov.pl/     status=200 type=text/html chars=7185 sha=e6c1123ba547
         ERR https://en.wikipedia.org/wiki/Poland  SourceError UNSUPPORTED_INPUT  (over the
             256 kB bound — the bound working as designed, now correctly typed)
```

Through the application pipeline, the same link capture moved from `INTERNAL_ERROR` to
`PROVIDER_UNAVAILABLE`: retrieval no longer fails the run, and only the provider gate remains.

No unit test accompanies the fix, deliberately and stated rather than hidden: the retrieval guard
rejects loopback and private addresses by design, which is exactly why no local test could have
caught this. It is covered by live evidence above.

## 3. Deployment

Candidate configuration was checked against the real host overrides before anything was built:
worker on `private` + `worker_egress` with the storage volume read-only, `worker_db_password` and
`gemini_api_key`, `read_only` root filesystem and `cap_drop: ALL`; API unchanged on `private` +
`edge` with `127.0.0.1:3011` and **no** Gemini secret; PostgreSQL still on the internal network
only. The host's `compose.override.yaml` and `compose.gemini-secret.yaml` were used unmodified.

```
backup     /opt/szronox-dev/backups/pre-gemini-02-20260917T140941Z/
           szronox_dev.dump, app_storage.tar.gz, schema_migrations.before.txt,
           containers.before.txt, ROLLBACK.md
source     /opt/szronox-dev/candidates/d3c5910  ->  /opt/szronox-dev/app
previous   /opt/szronox-dev/app.758d780 (export), runtime.env.bak.pre-gemini-02
build      dc-gemini.sh build migrate            -> szronox-dev:d3c5910
rollout    dc-gemini.sh up -d                    (migrate, grants, storage-init, api, worker)
env        SZRONOX_RELEASE=d3c5910, AI_ENABLED=true  (only these two keys changed)
```

Migration `0005_ai_pipeline.sql` applied as the owner identity (`5 files checked; 1 applied`);
`grants.sql` re-applied through the owner role, exit 0. Both are additive; the previous release
runs unchanged against this schema, so rollback does not require reversing the migration.

Verification after rollout:

- `/api/v1/ready` → `{"status":"ready","phase":"ready","checks":{"roster":"pass","storage":"pass"}}`
- API: `privilegeEnforcement: enforced`, `privilegeViolations: []`
- Worker: `privilegeEnforcement: enforced`, `privilegeViolations: []`, `aiLifecycle: enabled`
- Role enforcement, proven directly as `szronox_worker` in a rolled-back transaction:

```
update app.reels set script=...            ERROR permission denied for table reels
select from app.user_credentials           ERROR permission denied for table user_credentials
select from app.auth_sessions              ERROR permission denied for table auth_sessions
insert into app.programme_versions         ERROR permission denied for table programme_versions
update app.reels set version=version+1     UPDATE 7      (allowed, by design)
insert into app.reel_hooks                 INSERT 0 1    (allowed, additive hooks)
```

- LABEL-01 present in the deployed bundle (`Bez tytułu`, `titleIsDerived`, pluralised image counts)
- PWA preserved: `manifest.webmanifest` → `application/manifest+json`, `sw.js` → `application/javascript`

## 4. Development smoke tests through the real pipeline

Run inside a one-shot container against the live API, driving real HTTP with a real session. The
session was minted through the application's own session store for the existing NOXAVA identity and
revoked at the end; **no user credential was read, changed or printed.**

**20 of 26 assertions pass. All six failures are the single provider-quota gate in §5 — none is a
code failure.**

Verified end to end:

| Area | Evidence |
| --- | --- |
| Text capture | Created; title stays `''`; `originalInput` preserved verbatim |
| Image capture and upload lifecycle | Pending attachment → initiate → bytes → complete → `ready`; `Opracuj` correctly refuses with `UPLOAD_INCOMPLETE` while the upload is pending, without losing the capture |
| Meme library and ordering | Create-and-attach atomic; second attach appends with the first still primary; detach preserves remaining order and leaves the shared record intact |
| Programme fail-closed | `find_programme` → `422 INSUFFICIENT_EVIDENCE`, and **no run is enqueued at all** — no model memory, no web search, no `no_match` |
| Fact Check truthfulness under failure | Run ends `failed` with `PROVIDER_UNAVAILABLE`, `result` null — no fabricated claims, sources or evidence |
| Idempotency scope | Identical retry replays the same run; same id with a different payload → `IDEMPOTENCY_CONFLICT` |
| Authored content under a failed AI run | Script, description, hashtags, hooks and `scriptRevision` all unchanged |

Blocked by the provider gate, and therefore **UNVERIFIED end to end**: a successful `Opracuj` for
text, link and image; `Wygeneruj więcej` appending real hooks; explicit application of a generated
title, script and publication draft; the publication-collision branches against a real result;
`Sprawdź język` A/B and its `STALE_LANGUAGE_RESULT` guard; a real meme suggestion. Every one of
these paths has its assertions already written in the smoke script and needs only one successful
provider response to execute.

Smoke Reels left in DEV (labelled `SMOKE`, deletable from the UI):
`d85a3424-2e6e-4158-9d63-789379b6d6e4`, `080f8c0b-c7d2-4227-8e6d-f3ba3e950860`,
`22b5928f-cb73-4eb6-9219-53fd84aa9e5c` and three from the first pass. The four `SMOKE` memes were
removed from the shared library because the product deliberately has no library-delete action.

## 5. Provider quota — exact diagnosis

The DEV key is on the **free tier**, and the limit is per model per day:

```
HTTP 429 RESOURCE_EXHAUSTED
quotaMetric     generativelanguage.googleapis.com/generate_content_free_tier_requests
quotaId         GenerateRequestsPerDayPerProjectPerModel-FreeTier
quotaDimensions model=gemini-3.8-flash, location=global
quotaValue      20
```

**20 `generateContent` requests per day, per model, per project.** That is the same limit behind the
Google Search grounding 429 recorded earlier — grounding is not separately capped here, it simply
consumes the same 20. A `fact_check` run costs at least two requests, and a failed run retries up to
three times, so the daily allowance is consumed by roughly six to eight real runs.

Two further observations, so nothing is misread: `gemini-3.8-flash` also returned `503 UNAVAILABLE`
("high demand") at times today, which is transient overload rather than quota; and
`gemini-3.6-flash` returned `503` throughout. Egress, DNS and the mounted key are all healthy — the
worker reads the key file, reaches the API and receives well-formed provider errors.

Nothing about billing was changed and no resource was purchased.

## 6. Open gates

1. **Provider quota (external).** No successful provider response was obtainable today. The daily
   free-tier allowance resets on Google's schedule. The application reports this truthfully: the run
   ends `failed`, the workspace shows `Nie udało się ukończyć. Usługa jest chwilowo niedostępna.`
   with a retry, and nothing is fabricated.
2. **Approved programme corpus (operator input).** Still absent. `find_programme` fails closed. The
   import CLI is implemented and validates the document hash under the owner role.
3. **Browser and Android (distinct gates).** No browser or installed-Android evidence was produced
   here; VPS-07 owns those.

## 7. Recommendation, not a change made

Provider failures are recorded in `app.ai_runs.error` but are not logged by the worker, so
diagnosing today's failures required querying the database and running a separate probe. A single
structured log line on failure — code and HTTP status only, never the key — would pay for itself.
Out of scope for this task; raised for a later decision.

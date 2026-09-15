# VPS-04 — runtime assembly

Completed 2026-09-15 by user-launched Opus 5 (`claude-opus-5`), substituted for
`gpt-5.6-sol` on explicit user instruction ("Do this instead of Sol"). Worktree
`.worktrees/vps-04-runtime`, branch `codex/vps-04-runtime`, baseline `b478100`
(`codex/vps-reconcile`, containing VPS-integration-result.md). One scoped commit,
unmerged, no nested agents.

No VPS was contacted, no container was built or started, no deployment happened, no
credential was provisioned, no paid resource was used, no kDrive access occurred and no
AI call was made.

## What was assembled

The API and the worker now compose real dependencies and fail closed. Compose defines
four database identities with per-service secret mounts. An operator provisioning command
exists. The browser uploads, renews, completes and acknowledges attachments. The real-PG
race harness now proves its overlap instead of assuming it.

## Owned files

Created:

| File | Purpose |
| --- | --- |
| `apps/api/src/runtime/database.ts` | Bounded pools, password-from-file, identity/bounds parsing |
| `apps/api/src/runtime/privileges.ts` | Reads the connected role's real grants; API/worker refusal rules |
| `apps/api/src/runtime/readiness.ts` | Readiness phases, live roster and storage probes, scaffold tracker |
| `apps/api/src/runtime/logging.ts` | Redacting Fastify logger options; allow-listed request serialiser |
| `apps/api/src/runtime/api.ts` | `composeApiRuntime`: the ordered, fail-closed composition root |
| `apps/api/src/runtime/provision-cli.ts` | Operator command: bounded stdin, `--replace <NAME>` |
| `apps/api/src/runtime.test.ts` | 11 runtime assembly tests |
| `apps/api/test/postgres/overlap.mjs` | Transaction barrier and `pg_blocking_pids` overlap proof |
| `apps/worker/src/runtime.ts` | Worker pool, privilege refusal, read-only transactional probe |
| `apps/web/src/data/attachments.ts` | `AttachmentUploader`: initiate → PUT → renew → complete |
| `apps/web/src/data/attachment-recovery.ts` | Derived stable ids, per-attachment acknowledgement, reconciliation |
| `apps/web/src/data/tests/attachment-transport.test.ts` | 10 browser transport/recovery tests |
| `deploy/vps/postgres/initdb/10-runtime-roles.sh` | Creates `szronox_api` and `szronox_worker` once |
| `deploy/vps/postgres/grants.sql` | Per-identity table grants, rerun after each migration |

Modified:

| File | Change |
| --- | --- |
| `apps/api/src/index.ts` | Real composition, two explicit modes, dependency draining inside the existing shutdown contract |
| `apps/api/src/app.ts` | `readiness` and `logger` options; `GET /api/v1/ready` |
| `apps/api/src/auth/users.ts` | `provisionUsers`: atomic two-user provisioning, rerun-safe, mismatch-refusing |
| `apps/api/src/auth.test.ts` | One stale assertion corrected (see the baseline defect below) |
| `apps/api/test/postgres/real-pg-harness.mjs` | Both race cases now use proven overlap; third observer pool |
| `apps/worker/src/index.ts` | Real runtime, bounded ticks, repeat-safe shutdown with a deadline |
| `apps/web/src/data/api.ts` | Attachment methods and a raw same-origin upload through the existing funnel |
| `apps/web/src/drafts/queue.ts` | Stops deleting the capture draft before its images are uploaded |
| `apps/web/src/controllers/useAppController.ts` | Attachment resume after queue flush; progress reporting |
| `apps/web/src/app/App.tsx`, `main.tsx` | Compose and pass `AttachmentRecovery` |
| `deploy/vps/compose.yaml` | Four identities, four secrets, `grants` and `provision` jobs, readiness healthcheck |
| `deploy/vps/README.md` | Identity/secret/config tables, provisioning, readiness, corrected status |

## Baseline defect found and corrected

**CORRECTION NEEDED — resolved.** `npm test` was already failing on `b478100`. The
reconciliation raised the pinned address throttle to 20 attempts per 15 minutes but left
`apps/api/src/auth.test.ts` asserting `DEFAULT_ADDRESS_THROTTLE.limit === 10`. The
reconciliation report records that it ran only selected auth tests by name pattern, which
is why the mismatch was not observed.

The assertion is corrected to the approved pin (20 per address, 5 per account, both over
15 minutes) and the window values are now asserted too, so the next drift fails on the
value rather than on one half of it. No throttle behaviour was changed.
`apps/api/src/auth.test.ts` is outside VPS-04's allowed list; the change is one assertion,
made under the budget policy's "integration exposes a failure" retest trigger.

## Requirement-by-requirement

| Requirement | Where | Result |
| --- | --- | --- |
| API builds pool, session service, private storage | `runtime/api.ts`, `runtime/database.ts` | Done; parse → pool → `select 1` → privileges → `storage.initialize()` → roster, in that order |
| Awaits `storage.initialize()` before listening | `runtime/api.ts` | Done, before `listen`, not on first upload |
| Awaits exact two-user readiness before listening | `assertProvisioned` in `runtime/api.ts` | Done; ids compared, never written |
| Registers auth/core routes explicitly | `runtime/api.ts` → `BuildAppOptions` | Done; `buildApp` still registers auth before core |
| Applies secret redaction | `runtime/logging.ts`, wired in `index.ts` | Done; `remove: true`, allow-listed request fields, query string dropped |
| Fails closed on missing credentials/storage/roster | `index.ts`, `runtime/api.ts` | Done; exit 1 with the specific cause (four modes run, below) |
| Drains/closes dependencies on shutdown | `index.ts` | Done; HTTP closes first, then the pool, inside the existing deadline |
| Preserves accepted C01 shutdown behaviour | `index.ts` | Done; `shutdown.test.ts` unmodified and passing |
| Worker: independent bounded pool, readiness, shutdown | `apps/worker/src/**` | Done; `max` 2, read-only probe, repeat-safe deadline |
| Worker: no AI lifecycle, no T12/T16 | `apps/worker/src/runtime.ts` | Done; `aiLifecycle: 'not_implemented'` in the startup line |
| Separate migration/provisioning, API and worker identities | `initdb/10-runtime-roles.sh`, `grants.sql`, `compose.yaml` | Done; four identities |
| Runtime identities are not bootstrap superusers and cannot manage users/credentials/schema | `runtime/privileges.ts`, `worker/src/runtime.ts` | Done, and **enforced at startup**: each process reads its own grants and exits 1 if too wide |
| API/worker receive only the secrets they need | `compose.yaml` | Done; worker has no CSRF secret and no storage volume |
| Worker has no credential/session grants | `grants.sql` + worker refusal | Done; any access at all, including SELECT, is a refusal |
| Operator command: atomic, exactly two users | `provisionUsers` | Done; one transaction, advisory lock, final count check |
| Preserves existing ids/hashes on ordinary rerun | `provisionUsers` | Done; rerun needs no password and rotates nothing |
| Rejects mapping mismatches | `provisionUsers` | Done; both directions — wrong id for a name, and a name's id owned by the peer |
| Explicit replacement revokes affected sessions | `provisionUsers` | Done; only that account's, and `sessionsRevoked` is reported |
| No signup/reset/account-management UI | — | None added; provisioning cannot run from the browser |
| No real passwords in files/logs/argv | `provision-cli.ts` | Done; stdin only, 8 KiB cap, argv carries names only, output has no hash |
| Compose/runbook agree on the pinned variables | `compose.yaml`, `README.md` | Done; `APP_CSRF_SECRET_FILE`, `APP_SESSION_TTL_SECONDS`, `APP_ORIGIN`, `APP_STORAGE_ROOT`, separate DB secret mounts |
| Retains isolated networks/volumes and UID/GID | `compose.yaml` | Unchanged; `storage-init` still the only root container, still 1000:1000 mode 700 |
| Health distinguishes scaffold liveness from readiness | `app.ts`, `compose.yaml` | Done; `/health` unchanged, `/ready` added, healthcheck watches `/ready` |
| Browser raw upload on the existing response and generation boundary | `data/attachments.ts`, `data/api.ts` | Done; same funnel, CSRF, abort signal, stale-generation guard |
| Expired-ticket renewal | `AttachmentUploader.uploadOne` | Done; renewed once, same attachment and operation ids |
| Per-attachment acknowledgement; blobs kept until acknowledged | `attachment-recovery.ts`, `queue.ts` | Done; see the blob-reclamation limitation below |
| Reload/retry reuses the same capture/attachment/operation ids | `attachment-recovery.ts` | Done; ids are derived, so no new draft field was needed |
| Stale account responses cannot clear/rebind another partition | `attachment-recovery.ts` | Done; generation guard plus a re-read of the active account before every local write |
| No new draft model or product flow | — | `drafts/store.ts` untouched; no schema, no screen, no status |
| Harness proves both writers reached the conflicting boundary | `test/postgres/overlap.mjs` | Done in source; execution is VPS-06 |
| One focused local runtime assembly check | `apps/api/src/runtime.test.ts` | Done; 11 tests |
| Only changed-module compilation and targeted checks | below | Done; no unrelated suite rerun |

## Design decisions worth reviewing

**Two startup modes rather than one.** `index.ts` composes the full runtime when any
`DATABASE_*` variable is set, and starts scaffold-only when none is. The alternative —
always failing closed — would have broken the accepted `shutdown.test.ts`, which spawns
`dist/index.js` with no database configuration. Rather than edit accepted evidence, the
absence of configuration is treated as an explicit mode: announced on stderr, and
`/api/v1/ready` reports `runtime_not_configured`. `NODE_ENV=production` removes the mode
entirely, so a production image with no database exits 1.

**Readiness re-checks rather than caches.** `/api/v1/ready` runs a bounded roster query
and a storage-root access check on every call. A cached startup result would keep saying
ready after the volume was unmounted or a user was removed, which is the failure the
endpoint exists to catch. It deliberately does not call `storage.initialize()`, which
memoises.

**The processes police their own grants.** Grants live in `grants.sql`, but the
application refuses to run as an identity with more authority than its job needs. This is
the only check that catches "we pointed the API at the owner role because it was quicker",
and it is a refusal rather than a warning because a warning in a container log is how an
over-privileged API reaches production. `APP_ENFORCE_DB_PRIVILEGES=false` downgrades it
for a single-role local run, and the startup line then says `reported_only`.

**Attachment operation ids are derived, not stored.** Each attachment needs a stable
`operationId` for initiation and another for completion, identical across retries and
reloads. Adding fields to `CaptureDraft` would have been a draft-schema change, which
VPS-04 may not make. They are instead derived as
`SHA-256("szronox/attachment/<step>/<captureOperationId>/<attachmentId>")`, formatted as an
RFC 9562 **version 8** UUID — the version reserved for custom generation. Not v4: these
are not random, and labelling them as random would misrepresent how they are produced.

**The queue no longer deletes the capture draft after `create`.** It did, which orphaned
the local image blobs *before* any byte was uploaded and made recovery impossible. The
draft is now removed only when the server's own view of the Reel reports every one of the
capture's images as `ready` — authoritative reconciliation, not a local flag.

**A cross-origin upload URL propagates instead of being retried.** During implementation
the recovery loop silently swallowed it as a transient failure. That is wrong: a refusal to
send credentials off-origin is a security-relevant signal, and burying it in a retry
counter would hide a misconfigured or hostile transport URL. `AttachmentProgress` now also
carries a per-attachment `failures` list, so "waiting for the network" and "failing
permanently" are distinguishable. The URL must additionally be **absolute**: resolving an
unparseable value against the page would quietly turn any garbage into a same-origin path.

## Exact commands and results

Run from `/Users/kubabilski/Desktop/SzroNox/.worktrees/vps-04-runtime`.

```sh
npm ci --no-audit --no-fund                  # lockfile already in sync; 187 packages
npm run typecheck                            # PASS: contracts, web, api, worker
npm run build                                # PASS: vite build, api tsc, worker tsc
npm test                                     # PASS 114/114 (apps/api)
npx tsc -p apps/web/tsconfig.test.json
node --test 'apps/web/dist/test/apps/web/src/auth/tests/*.test.js' \
            'apps/web/dist/test/apps/web/src/data/tests/*.test.js'   # PASS 24/24
npm run test:t08 --workspace @szronox/web                            # PASS 1/1
node --experimental-strip-types --test apps/web/src/ui/frozen-copy.test.mjs   # PASS 8/8
node --check apps/api/test/postgres/real-pg-harness.mjs
node --check apps/api/test/postgres/overlap.mjs
node apps/api/test/postgres/real-pg-harness.mjs   # prints UNVERIFIED; claims nothing
git diff --check                                  # clean
```

API totals by file, all passing: `core` 45, `auth` 32, `runtime` 11 (new), `storage-routes`
6, `shutdown` 6, `health` 5, `storage-filesystem` 5, `storage-config` 2,
`vps-integration` 2 — **114**. Browser: 14 auth + 10 attachment (new) = **24**. Plus 8
frozen-copy and 1 publication.

The baseline `b478100` was 113 passing and 1 failing for the throttle reason above. VPS-04
adds 11 API tests and 10 browser tests and corrects that assertion.

### Startup modes, actually executed

| Invocation | Observed |
| --- | --- |
| `node apps/api/dist/index.js` (no DB) | starts; stderr names scaffold mode; `/health` 200 `{"status":"ok"}`; `/ready` 503 `runtime_not_configured`; SIGTERM → exit 0 |
| `NODE_ENV=production` (no DB) | `API runtime is not configured: DATABASE_* is required when NODE_ENV=production`, exit 1 |
| `DATABASE_HOST` only | `API runtime composition failed: APP_ALLOWLIST is required…`, exit 1 |
| full DB config, unreachable host | `API runtime composition failed: connect ECONNREFUSED 127.0.0.1:59999`, exit 1 |
| worker, no DB | idles, announces unconfigured, SIGTERM → exit 0 |
| worker, `NODE_ENV=production`, no DB | exit 1 with the specific cause |
| worker, unreachable host | exit 1, `connect ECONNREFUSED` |
| worker, `WORKER_POLL_MS=5` | exit 1, `must be an integer from 1000 to 3600000` |
| worker, both password sources | exit 1, `Set exactly one of DATABASE_PASSWORD_FILE or DATABASE_PASSWORD` |
| provision, no DB config | exit 2, `DATABASE_PASSWORD_FILE is required…` |
| provision, `{"ADMIN":"…"}` on stdin | exit 2, `unknown account name: ADMIN` |
| provision, `--password hunter2` | exit 2, `unknown argument: --password` |
| provision, 20 KiB on stdin | exit 2, `provisioning input exceeds 8192 bytes` — input not echoed |

## Limitations and UNVERIFIED gates

- **No container was built or started. Docker is not available in this environment.** The
  Linux/Node 22 image, Compose, the `initdb` role bootstrap, `grants.sql`, the volume
  UID/GID, the readiness healthcheck as Docker runs it, and backup/restore are **all
  unexecuted**. `deploy/vps/compose.yaml` and the two SQL/shell files were not validated by
  `docker compose config` either. VPS-05 gate.
- **No real PostgreSQL ran.** Everything database-side was exercised against PGlite: real
  PostgreSQL 18 in WASM, so the SQL, constraints, transactions and the advisory locks are
  genuine — but single-connection and single-role. It therefore cannot demonstrate a race,
  and it cannot demonstrate role separation: `runtime/privileges.ts` and the worker's
  equivalent are tested against **constructed `RoleFacts`**, not against real grants.
  Whether `grants.sql` actually produces the privileges the refusal rules expect is
  unverified. VPS-05/VPS-06 gate.
- **The strengthened harness has not run.** `overlap.mjs` is syntax-checked and reasoned
  about, not executed. Its `pg_blocking_pids` polling, its pause point matching and its
  interaction with `lock_timeout` are all unproven until VPS-06.
- **The provisioning CLI's database path is unexecuted.** Its argument parsing, stdin
  bounding and the `provisionUsers` transaction are tested (the latter against PGlite), but
  the `openDatabase` path it uses at runtime needs a server.
- **No browser ran.** `credentials: 'same-origin'`, the `__Host-` cookie, real streaming
  uploads, real image decode in the browser and the service worker are all VPS-07. The
  browser tests use a `fetch` recorder and an in-memory IndexedDB double; the double shows
  how `DraftStore` addresses records, not IndexedDB's transaction semantics.
- **Blob reclamation needs one shared change.** Local image blobs are correctly *retained*
  until acknowledgement, and the capture draft is now removed only after authoritative
  reconciliation — but `DraftStore` has no `deleteBlob`, so acknowledged blobs stay in
  IndexedDB indefinitely. Adding `deleteBlob(accountId, attachmentId)` is a one-method
  change to `apps/web/src/drafts/store.ts`, which is **outside VPS-04's allowed files**.
  This is strictly better than the previous behaviour (which orphaned blobs *before*
  upload) and errs toward never losing a user's image, but it is unbounded local growth.
  **Root should adjudicate.**
- **Worker/API runtime duplication.** `apps/worker/src/runtime.ts` re-implements the pool
  bounds, the password-file rule and the privilege questions that
  `apps/api/src/runtime/{database,privileges}.ts` own, because `@szronox/worker` does not
  depend on `@szronox/api` and adding that dependency is a workspace-manifest change VPS-04
  may not make. The two copies must stay in step until root either adds the dependency with
  subpath exports or extracts a `packages/runtime` workspace. **Root should adjudicate.**
- **`app.ts` logger default is unchanged (`false`).** The real process opts in with
  `LOG_LEVEL`, and Compose sets `info`. Redaction is therefore configured but has never
  been observed against a real log stream.
- **`expectedUid`/`expectedGid` default to 1000** in the filesystem adapter and are not
  passed by `runtime/api.ts`. That matches the `node` user in `node:22-bookworm-slim` and
  the `storage-init` chown, but the agreement is untested.
- **Unaffected agent evidence accepted as recorded**, per the budget policy: VPS-01 auth,
  VPS-02 storage and VPS-03 core suites were not re-audited or rerun beyond what `npm test`
  runs as a whole. No security audit was performed.

## Next boundary

Root performs a bounded integration review and adjudicates the two shared-change items
above. VPS-04 authorises no deployment, no DNS/TLS change, no VPS mutation, no paid
resource, no kDrive access and no AI execution. VPS-05 remains a separate approval.

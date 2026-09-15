# VPS-01–03 — bounded reconciliation

Root reconciliation on 2026-09-15, worktree `/Users/kubabilski/Desktop/SzroNox/.worktrees/vps-reconcile`, branch `codex/vps-reconcile`. This is the authorized one-time integration of completed tasks, not VPS-04 dispatch or a broad independent audit. Root master remains separate; original worktrees/commits and reports are preserved.

Inputs: VPS-01 Opus `b289569`; VPS-02 Sol `556869974a4f3da98dc6b144035842c08bfa4428`; VPS-03 Luna `d2b5e9c`; shared base `43fbd23`. Merge commits `6763bf5` and `49910e0` retain those histories. The final reconciliation commit is reported in the parent task; this report is included in that commit.

## Findings and disposition

| Classification | Finding | Disposition |
| --- | --- | --- |
| CORRECTION NEEDED — resolved | Auth used superseded migration reservation and `/auth/session` instead of the dispatch-approved `/me` | Unapplied auth migration is now `database/migrations/0003_vps_auth.sql`; storage remains `0004_vps_storage.sql`; auth owns the sole `/me` route and browser restore uses it |
| CORRECTION NEEDED — resolved | Shared core config merged incompatible auth/storage provider selections | Combine cookie auth with filesystem storage; remove obsolete Supabase configuration types and assertions |
| CORRECTION NEEDED — resolved | Auth environment names/lifetime bounds differed from shared deployment contract | `APP_CSRF_SECRET_FILE`, `APP_SESSION_TTL_SECONDS` (max 604800), one exact origin, hashing concurrency max two; secret fixture files isolated to test support |
| CORRECTION NEEDED — resolved | Login limits followed older defaults and unknown names bypassed dummy password work/account bucket | 20/IP/15 minutes, 5/account/15 minutes, one unknown bucket, count every attempt, dummy verification and 4096-byte route body limit |
| CORRECTION NEEDED — resolved | `/me` moved out of core but app factory had no auth registration seam | Add optional explicit `BuildAppOptions.auth`; register auth before core; no process startup activation |
| CORRECTION NEEDED — resolved | Real-PG harness assumed only two historical migrations | Update expected names/rerun results to all four combined migrations; syntax checked only |
| ACCEPTED / NO FURTHER TESTING NOW | Agent-tested storage validation/immutability, session expiry/revocation/partition logic and unaffected domain behavior | Accept bounded handoff evidence provisionally; no second isolated full suite or adversarial audit |
| ACCEPTED / NO FURTHER TESTING NOW | Historical migration relocation | Both historical files remain byte-identical; combined ledger applies/replays all four in targeted integration check |
| BLOCKER — to application startup, not to preserving this batch | API/worker entry points still need real dependency composition; Compose lacks separate runtime credentials and auth secret mounts | VPS-04 proposal; current scaffold health is not application readiness |
| CORRECTION NEEDED — VPS-04 | Provisioning currently sets a password for an existing user; approved atomic two-user creation/idempotent provisioning command is not yet complete | Complete operator command and credential-role separation before deployment; no real credentials created here |
| CORRECTION NEEDED — before VPS-06 evidence | Real-PG race harness launches promises but does not yet record controlled overlap at the conflicting transaction boundary | Strengthen the harness before meaningful real-PG execution; independent pools alone cannot prove overlap |
| OPEN REAL-WORLD GATE | Linux/Node 22 image, Compose permissions/restore, real PostgreSQL concurrency, actual browser/HTTPS and VPS | Deferred to meaningful environment milestones; no repeated early live attempts |

The auth handoff's migration explanation and old endpoint/config claims are preserved as historical agent evidence; the dispatch contract and this reconciliation supersede those claims. The two newly created auth/storage migration identities have not been applied to any deployed database. No applied SQL history was rewritten.

## Owned reconciliation changes

- `AGENTS.md`: user's complete testing/review budget policy (also committed on root as `8efe963`).
- `apps/api/src/core/config.ts`, `core/routes.ts`, `app.ts`: combine provider-neutral adapters and explicit auth registration.
- `apps/api/src/auth/{config,routes,service,throttle,test-support}.ts`: reconcile endpoint/config/security boundaries against approved pins.
- `apps/web/src/auth/transport.ts`: restore via `/me`.
- `database/migrations/0003_vps_auth.sql`: relocate/rename the previously unapplied auth migration without changing SQL bytes.
- `apps/api/src/{auth,core}.test.ts`, `apps/web/src/auth/tests/browser-auth.test.ts`: align affected endpoint/config expectations; no unrelated test rewrites.
- `apps/api/src/vps-integration.test.ts`: two focused combined-boundary tests.
- `apps/api/test/postgres/real-pg-harness.mjs`: four-migration expectations.
- `deploy/vps/README.md`: state incomplete runtime composition and deferred gates truthfully.
- This report, VPS-04 proposal and task status.

## Exact verification and budget

Commands from the reconciliation worktree:

```sh
npm ci --no-audit --no-fund
npm run build
npm run build --workspace @szronox/api
node --test apps/api/dist/vps-integration.test.js
node --test --test-name-pattern='reports the signed-in|buildApp registers|buildCoreDependencies|configuration requires' apps/api/dist/core.test.js
node --test --test-name-pattern='origin parsing|login throttling|account throttling|reload through|/me reports' apps/api/dist/auth.test.js
npx tsc -p apps/web/tsconfig.test.json
node --test --test-name-pattern='reload recovers|restore that cannot|every request is same-origin' apps/web/dist/test/apps/web/src/auth/tests/browser-auth.test.js
node --check apps/api/test/postgres/real-pg-harness.mjs
git diff --check
```

Initial combined full build reached web successfully but API test compilation exposed an integration-edit import typo (`./mes.js`); corrected to `./auth/sessions.js`. Only API compilation was repeated after affected API changes; it passed. Web test compilation passed. No full build/typecheck loop or full child-suite rerun occurred.

Results: combined integration 2/2; selected app/core seam checks 4/4; selected changed auth contract checks 5/5; selected browser transport tests 3/3. Total 14 targeted checks passed. Harness syntax and diff whitespace passed. Historical migration byte comparison passed via Python `Path.read_bytes()` against `git show 43fbd23:supabase/migrations/<filename>` for 0001/0002.

The combined test uses real app auth/attachment handlers with PGlite and an actual disposable filesystem: migration application/replay, login, `/me` metadata, Reel create, scoped image initiation, bad-CSRF rejection, raw upload, completion/replay, private read, logout/read refusal and unknown-account bucket. This is local interface evidence, not a real PostgreSQL race or real browser test. Selected browser checks use transport doubles.

Agent-recorded evidence retained without duplicate independent reruns: Opus server/browser auth tests; Sol 13 focused storage tests; Luna 55 core tests. Source reports distinguish their real-world gates. No separate reviewer launched and no finished child agent restarted.

## Next boundary

VPS-04 remains a proposal. No live VPS changes, credentials, deployment, AI, kDrive or production data access. Complete runtime assembly and the explicitly recorded preparation gaps before VPS-05. Execute real-PG concurrency at VPS-06 and actual HTTPS/browser acceptance at VPS-07.

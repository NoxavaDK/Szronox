# VPS-05 — deployment preparation, and why provisioning is blocked

Started 2026-09-15 by user-launched Opus 5 (`claude-opus-5`) on "Proceed with VPS-05".
Worktree `.worktrees/vps-05-deploy`, branch `codex/vps-05-deploy`, baseline `bc78fc1`
(`codex/vps-04-runtime`, after root's clarifications `77e33ba` and Sol's completion
`bc78fc1`). One scoped commit, unmerged, no nested agents.

No VPS was contacted, no container was built or started, no DNS or TLS was changed, no
credential was provisioned, no deployment happened.

## VPS-05 cannot be completed here. Three inputs are missing.

VPS-05 is "isolated dev provisioning / HTTPS". Two of its three parts cannot be executed in
this environment, and the third needs a value only you can supply. Stated up front so
nothing below reads as a completed deployment:

1. **No container runtime.** `docker`, `podman`, `colima`, `lima`, `nerdctl` and
   `docker-compose` are all absent, and Docker Desktop is not installed. Provisioning the
   isolated `szronox-dev` project — the core act of VPS-05 — cannot happen on this machine.
   Every Compose command in the runbook remains unexecuted.
2. **No hostname.** `APP_ORIGIN` must be the exact browser origin, because the session
   cookie's `__Host-` prefix means a browser will not accept it over plaintext. VPS-04's
   approval pinned "no invented hostname/default origin", so the deployment files
   deliberately refuse to guess: `compose.yaml` uses the required `${APP_ORIGIN:?...}`
   form. Nothing can be started until you provide it.
3. **No authorization or access to change the VPS.** Adding a Caddy site block, pointing
   DNS and issuing a certificate are mutations of a live host. Every standing instruction
   forbids that without explicit authorization, and no credentials were provided.

So this task did the work that does **not** depend on those three, and it found two real
defects in doing so — one of which would have broken the deployment and one of which would
have quietly degraded it.

## What was completed

### The deployment SQL now actually runs — and it is correct

VPS-04 left this open and said so: `grants.sql` and the `initdb` role script had never
executed, so whether they produce the privileges the API and worker *demand at startup* was
unknown. If they did not, both processes would refuse to start — the deployment would fail
at its last step, after the database was already provisioned.

PGlite turns out to support `CREATE ROLE`, `GRANT`, `REVOKE`, `pg_roles` and
`has_table_privilege(role, table, privilege)`. `apps/api/src/deploy-grants.test.ts`
therefore reads the committed deployment files from disk, executes them in the documented
order — roles, then the four migrations, then grants — and reads the resulting privilege
state back out of the catalog into the **production** refusal rules.

Result: **both roles come out exactly as required.** `szronox_api` gets `SELECT` on
`app.users` and `app.user_credentials` and full DML on sessions and domain tables, and
cannot write credentials or the roster. `szronox_worker` gets domain reads and **no access
at all** to credentials or sessions. Neither is a superuser and neither may `CREATE` in
`app`. `apiPrivilegeViolations` and `workerPrivilegeViolations` both return `[]`, so neither
process would refuse to start on grounds of grants.

The test also proves it is not vacuous (granting the API a credential write makes its own
rule reject it), that `grants.sql` is idempotent, that a table added by a future migration
is unreachable until grants are deliberately updated, and that every object `grants.sql`
names actually exists — which matters because `ON_ERROR_STOP` makes one missing object abort
the whole grants job.

**What this does not establish:** nothing connects *as* those roles. PGlite has no server
and no login path, so "`DATABASE_USER=szronox_api` with the mounted password authenticates"
is still a VPS-05 gate. The role SQL is also extracted from the shell script's heredoc, so
psql's `:'var'` quoting, the secret-file reads and Docker's `initdb.d` behaviour are
unexercised. And PGlite is PostgreSQL 18 while the deployment pins 17.6.

### CORRECTION NEEDED — resolved: proxy trust was never implemented

`trustProxy` appeared nowhere in the codebase. VPS-04's handoff listed it as a wiring item
for the composition root and then did not implement it — my own omission.

Behind Caddy this is not cosmetic. Fastify's `request.ip` is the socket address unless
`trustProxy` is configured, and `origin.ts` keys the login throttle on `request.ip`. So
every request would have carried the *proxy's* address, collapsing the per-address throttle
into a single global counter: twenty failed attempts from anyone would lock out both NOXAVA
and SZRON. The opposite mistake is worse — `trustProxy: true` lets any client send
`X-Forwarded-For` and choose its own bucket, removing the limit entirely.

`apps/api/src/runtime/proxy.ts` now parses `APP_TRUSTED_PROXIES` into an explicit list of
literal addresses or CIDR blocks and refuses every shape that means "everyone" (`true`,
`*`, `all`, `0.0.0.0/0`, `::/0`) and every hostname (proxy trust must not be re-decidable
by a DNS change). Absent configuration yields `false` — trust nothing — because that is the
safe failure, and the startup line says which mode is in effect rather than staying quiet.

`apps/api/src/proxy.test.ts` demonstrates both halves against real Fastify routing: a
forwarded address is believed from the configured proxy and ignored from anywhere else;
the throttle gives two clients behind one trusted proxy two separate buckets; and with the
setting absent the same traffic throttles every client at once. That last test asserts the
*cost of the safe default* explicitly, so it is on the record rather than discovered when
both users are locked out.

### CORRECTION NEEDED — resolved: `SZRONOX_RELEASE` was undocumented

`compose.yaml` resolves `szronox-dev:${SZRONOX_RELEASE:-local}` for every service, and the
runbook never mentioned it. Exporting it for `build` but not for `up` builds one tag and
starts another. Now documented with that failure mode named.

### A host preflight that reads and never mutates

`deploy/vps/preflight.mjs` runs on the host before anything is built. It reports `PASS`,
`FAIL` or `UNVERIFIED` per check and exits non-zero on any `FAIL`. `UNVERIFIED` is
deliberately not a pass: it means the check could not run here, and a preflight that printed
"ok" for things it never looked at would be worse than none.

It checks the container runtime and Compose v2, hands the file to `docker compose config`
(the only real validator of anchors, merge keys, secrets and interpolation), looks for
resource collisions and running project containers, and verifies each secret file's
existence, mode, length, mutual distinctness and that none live inside the repository. It
validates `APP_ORIGIN`, `APP_ALLOWLIST`, `APP_SESSION_TTL_SECONDS` and
`APP_TRUSTED_PROXIES`, confirms the deployment files exist with the initdb script
executable, and checks the published port and free disk space.

Run here with nothing configured it reports 10 PASS / 5 FAIL / 3 UNVERIFIED and exits 1;
with real secret files and an HTTPS origin, 15 PASS / 0 FAIL / 3 UNVERIFIED and exits 0.
The three UNVERIFIED are the Docker-dependent checks.

### Agreement between the deployment files and the code

`apps/api/src/deploy-config.test.ts` covers the drift class nobody catches by reading:
Compose sets `APP_SESSION_TTL_SECOND`, the code reads `APP_SESSION_TTL_SECONDS`, nothing
errors and the lifetime silently becomes the default. It asserts that every variable
Compose sets for a service is read by that service's source, that every `DATABASE_*` name
is one the parser knows, that each service mounts only its own secrets (the worker gets no
CSRF secret and no storage volume), that no runtime service connects as the owner, that
declared and mounted secrets match exactly, that the healthcheck watches `/api/v1/ready`
rather than liveness, that `APP_ORIGIN` has no default and no guessed hostname appears
anywhere, and that the runbook documents every host variable and the operator sequence in
order.

These are targeted string checks, not YAML parsing — no YAML parser is available in this
workspace and hand-rolling one would be a worse foundation than a narrow explicit check.
`docker compose config` remains the real validator and runs in preflight. One limitation
found and handled: a textual check cannot resolve a YAML merge key, so the owner-identity
assertion accepts either the literal role or the `<<: *owner_database` anchor, and
separately asserts the anchor is the owner.

### HTTPS documented to the edge of the missing input

The runbook now has an HTTPS section: the Caddy site block as a **new** block that edits
nothing existing, with `REPLACE_ME_HOSTNAME` left explicit rather than filled with a guess;
why TLS termination needs nothing from the application (origin checking compares the
browser's `Origin` against `APP_ORIGIN`, and the cookie carries `Secure` regardless of the
internal hop); and why DNS must resolve before starting.

## Owned files

Created:

| File | Purpose |
| --- | --- |
| `apps/api/src/runtime/proxy.ts` | `APP_TRUSTED_PROXIES` parsing; refuses "everyone" and hostnames |
| `apps/api/src/proxy.test.ts` | 6 tests: forwarded-address trust and its effect on the throttle |
| `apps/api/src/deploy-grants.test.ts` | 6 tests: executes the real role script and `grants.sql`, checks the matrix |
| `apps/api/src/deploy-config.test.ts` | 7 tests: Compose/code/runbook agreement |
| `deploy/vps/preflight.mjs` | Read-only host preflight |

Modified:

| File | Change |
| --- | --- |
| `apps/api/src/app.ts` | `trustProxy` option, passed to Fastify; never `true` |
| `apps/api/src/index.ts` | Parses `APP_TRUSTED_PROXIES`, fails closed on a malformed list, reports the mode |
| `apps/api/src/runtime/api.ts` | `ApiRuntimeEnv` extends `ProxyEnv` |
| `deploy/vps/compose.yaml` | `APP_TRUSTED_PROXIES` for the API, with the reasoning in place |
| `deploy/vps/README.md` | Preflight, HTTPS/Caddy, proxy-address discovery, `SZRONOX_RELEASE` |

## Exact commands and results

From `/Users/kubabilski/Desktop/SzroNox/.worktrees/vps-05-deploy`:

```sh
npm ci --no-audit --no-fund       # lockfile in sync; 187 packages
npm run typecheck                 # PASS: contracts, web, api, worker
npm run build                     # PASS
npm test                          # PASS 134/134
node --check deploy/vps/preflight.mjs
node deploy/vps/preflight.mjs                              # 10 PASS / 5 FAIL / 3 UNVERIFIED, exit 1
node deploy/vps/preflight.mjs   # with secrets + origin set: 15 PASS / 0 FAIL / 3 UNVERIFIED, exit 0
sh -n deploy/vps/postgres/initdb/10-runtime-roles.sh       # shell syntax
git diff --check                                           # clean
```

API tests by file: `core` 45, `auth` 32, `runtime` 12, `deploy-config` 7 (new),
`deploy-grants` 6 (new), `proxy` 6 (new), `storage-routes` 6, `shutdown` 6, `health` 5,
`storage-filesystem` 5, `storage-config` 2, `vps-integration` 2 — **134**. The baseline
`bc78fc1` was 115; VPS-05 adds 19.

Browser and web suites were not rerun: nothing in this task touches `apps/web`, and the
budget policy's re-test triggers are not met.

## Open provisioning questions — check these first when Docker exists

Neither can be answered without a running container runtime, and neither should be assumed:

1. **Does a published port work on an `internal: true` network?** The `api` service is
   attached only to `szronox-dev_private`, which is `internal: true`, and also publishes
   `127.0.0.1:3010`. It very likely works — the host is the bridge gateway, inside the
   subnet — but "likely" is not evidence, and if it does not, the API is unreachable and
   the fix is a second non-internal network for the API alone, not a change to the private
   one. **This is the first thing to verify**, because everything else depends on reaching
   the API.
2. **What source address does the container observe** for a request arriving through the
   published port? That is the value `APP_TRUSTED_PROXIES` needs. The runbook gives the
   discovery commands; the example `172.18.0.1` in it is labelled as an example.

## Limitations and UNVERIFIED gates

- **Provisioning did not run.** No image, no container, no volume, no network, no
  migration against a real server, no grants job, no provisioning command against a real
  database, no backup or restore. All VPS-05 once the three inputs exist.
- **`docker compose config` has never parsed `compose.yaml`.** Preflight will run it; it
  could not run here. YAML anchors, merge keys, the secrets block and interpolation are
  therefore still unvalidated by the tool that owns those semantics.
- **The initdb shell script has not executed as a script.** Its syntax parses (`sh -n`) and
  its SQL is executed by the grants test, but psql's variable quoting, the secret-file
  reads and the PostgreSQL entrypoint's handling of `initdb.d` are unexercised.
- **No login as a runtime role.** The grants are verified; authenticating as
  `szronox_api`/`szronox_worker` with the mounted passwords is not.
- **PostgreSQL 18 (PGlite) vs 17.6 (deployment).** Grant semantics are stable across both,
  but the versions differ.
- **No browser, no HTTPS, no certificate.** VPS-07.
- **The real-PG race harness still has not run.** VPS-06.
- **The two VPS-04 adjudication items are still open** and were deliberately not acted on:
  `DraftStore.deleteBlob` for blob reclamation, and the worker/API runtime duplication.
- **`apps/api/src/app.ts` and `index.ts` were modified**, which were VPS-04's scope rather
  than a VPS-05 allocation. The change is the `trustProxy` seam and its parsing; it was not
  deferrable, because proxy trust is precisely a VPS-05 concern and the alternative was
  shipping a global login throttle. Flagged rather than assumed.

## What I need from you to finish VPS-05

1. **The hostname** for `APP_ORIGIN` (e.g. `https://…`), and confirmation that DNS points
   at the VPS.
2. **Whether I may change the live VPS** — add a Caddy site block, run Compose, request a
   certificate — and how to reach it.
3. **A container runtime on whatever machine runs the provisioning.** If that is this
   machine, Docker needs installing first; if it is the VPS, the work happens there.

Until then the deployment is prepared and verified as far as it can be without them.

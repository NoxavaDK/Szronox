# VPS-01 — application-owned authentication

Completed 2026-09-15 by user-launched Opus 5 (`claude-opus-5`) in
`.worktrees/vps-01-auth`, branch `codex/vps-01-auth`, baseline `43fbd23`
(`codex/vps-batch-base`). One scoped commit, unmerged, no nested agents, no VPS
mutation, no deployment, no credential provisioned.

Supabase-specific authentication is gone from both halves of the application and
replaced by opaque, application-owned session cookies. No Supabase infrastructure was
reintroduced anywhere.

## Blocking item the lead must decide: the reserved migration filename

VPS-00 reserved `0002_vps_auth.sql` "conditional on those filenames remaining unused
after Opus integration", and required that "a collision goes to the lead before
dispatch".

**The collision is real.** The reconciled baseline already contains an applied
`supabase/migrations/0002_script_revision.sql` (from T05's `scriptRevision` work), so
`0002_vps_auth.sql` cannot be used without renumbering applied history — which VPS-00
forbids.

Resolution taken, so the task could be delivered rather than blocked: the migration is
committed as **`0004_vps_auth.sql`**. `0003` is deliberately left free so VPS-02 keeps
its reserved `0003_vps_storage.sql` and needs no re-brief. Auth and storage tables are
independent, so their relative order carries no meaning. The reasoning is also recorded
in the migration's own header comment.

If the lead prefers a different identifier, only the filename changes — no SQL, no
ledger entry and no applied migration is affected, because this migration has never
been applied to a deployed database.

## Owned files

Created:

| File | Purpose |
| --- | --- |
| `supabase/migrations/0004_vps_auth.sql` | `app.user_credentials`, `app.auth_sessions`, two indexes |
| `apps/api/src/auth/config.ts` | Cookie name, CSRF secret, lifetime, origins, password concurrency |
| `apps/api/src/auth/passwords.ts` | Argon2id hashing, bounded concurrency, dummy verification |
| `apps/api/src/auth/sessions.ts` | Secret generation, digest storage, CSRF derivation, revocation, pruning |
| `apps/api/src/auth/cookies.ts` | `__Host-` cookie emission and reading, `no-store` |
| `apps/api/src/auth/origin.ts` | Exact-Origin check, JSON-only check, limiter key |
| `apps/api/src/auth/throttle.ts` | Bounded in-memory address and account windows |
| `apps/api/src/auth/users.ts` | Roster, peer resolution, credential write, readiness check |
| `apps/api/src/auth/service.ts` | `login` / `bootstrap` / `logout` / `authenticate` |
| `apps/api/src/auth/routes.ts` | The three endpoints, `AUTH_LOG_REDACT_PATHS` |
| `apps/api/src/auth/compose.ts` | `buildAuthDependencies(db, env)` for startup |
| `apps/api/src/auth/provision.ts` | Operator password entry from a stream, never argv |
| `apps/api/src/auth/index.ts` | Public surface for the composition root |
| `apps/api/src/auth/test-support.ts` | Test-only session issuing; no production import |
| `apps/api/src/auth.test.ts` | 32 server auth tests |
| `apps/web/src/auth/transport.ts` | The three auth requests, `credentials: 'same-origin'` |
| `apps/web/src/auth/tests/browser-auth.test.ts` | 14 browser auth tests |
| `apps/web/tsconfig.test.json` | Emit-only config so `node --test` can run the above |

Deleted:

| File | Reason |
| --- | --- |
| `apps/api/src/auth/verify.ts` | HS256 JWT verifier and bearer parsing — VPS-00: "Do not preserve TokenVerifier/bearer parsing as a second production authorization path" |
| `apps/api/src/auth/jwks.ts` | RS256/ES256 JWKS verification; there is no external key set any more |

Modified:

| File | Change |
| --- | --- |
| `apps/web/src/auth/session.ts` | `SupabaseBrowserSession` → `BrowserSession`, memory-only, generation-aware |
| `apps/web/src/auth/Login.tsx` | Account choice instead of an e-mail field; Polish copy retained |
| `apps/web/src/data/api.ts` | Cookie transport, CSRF on unsafe methods, 204 support, stale-generation guard |
| `apps/web/src/data/errors.ts` | Polish `RATE_LIMITED`; `isAbandonedRequest` |
| `apps/web/src/controllers/useAppController.ts` | `restore()`-based recovery, abandoned-request guards, `signOut`/`signInAs` |
| `apps/web/src/app/App.tsx` | `BrowserSession` types, bootstrap state, unreachable notice |
| `apps/web/src/main.tsx` | Composition without `VITE_SUPABASE_*` |
| `apps/api/src/core/routes.ts` | `verifier: TokenVerifier` → `authenticate: RequestAuthenticator` (auth funnel only) |
| `apps/api/src/core/config.ts` | `buildVerifier` and the JWT env removed; auth seam composed |
| `apps/api/src/core.test.ts` | Session-based HTTP harness; JWT/JWKS tests removed |
| `apps/web/src/app/App.css` | Four rules for the account fieldset |

## Scope deviations, and why

VPS-00 assigned VPS-01 `apps/api/src/auth/**`, `apps/web/src/auth/**`,
`apps/web/src/data/api.ts`, auth-only changes to `main.tsx`, `app/App.tsx`,
`controllers/useAppController.ts`, the reserved migration, and scoped tests. Five files
outside that list were touched. Each is listed here rather than buried in the diff.

1. **`apps/api/src/core/routes.ts`** — VPS-00 reserves this for the lead "so VPS-01 does
   not collide with VPS-02's attachment sections". Leaving it untouched was not
   possible: it imported the deleted `TokenVerifier` and `bearerToken`, so the branch
   would not typecheck, and the second bearer authorization path VPS-00 forbids would
   have survived. The user's own VPS-01 brief also names `/me` and "authoritative server
   actor identity" as VPS-01 deliverables. The change is confined to the dependency
   field and the six-line `actorOf` funnel; no attachment, domain or error-handling
   section was touched, so a conflict with VPS-02 is textually possible but trivial.
2. **`apps/api/src/core/config.ts`** — unassigned, and it composed the deleted verifier.
   Only the JWT half was removed; storage composition is untouched for VPS-02.
3. **`apps/api/src/core.test.ts`** — the JWT and JWKS tests exercised deleted modules.
   They were removed with the code rather than left asserting behaviour nothing
   implements, and the HTTP harness now issues real sessions. Ten tests were removed and
   32 new ones added; the section comments say what went and where the replacement lives.
4. **`apps/web/src/app/App.css`** — four rules for the account radio group, alongside the
   existing `.auth-form` rules. No screen redesign.
5. **`apps/web/tsconfig.test.json`** — needed because Node cannot resolve a `.js`
   specifier to a `.ts` file, so the existing `--experimental-strip-types` pattern
   cannot load `session.ts` (which has relative imports). It is not a package manifest
   or the lockfile; **wiring it into `npm test` is root's call** and was deliberately
   not done. The exact command is below.
6. **`apps/web/src/data/errors.ts`** — the Polish `RATE_LIMITED` mapping VPS-00's own
   handoff assigned to VPS-01.

One pinned dependency choice was not followed as written: `@fastify/cookie` is
**installed but not registered**. Its exported `parse`/`serialize` are bound to a
registered instance and throw when called standalone — demonstrated during
implementation, which is what the first version of `cookies.ts` tried. Registering the
plugin from inside the auth module risks a duplicate-decorator collision with the
composition root VPS-01 does not own. `cookies.ts` therefore emits and reads the single
cookie itself, with a fixed attribute set. The dependency remains available to
VPS-02/VPS-04. `@fastify/rate-limit` is likewise unused for login: its key is computed
in `onRequest`, before the body is parsed, so it cannot key on the attempted account
name.

## Contract conformance

| VPS-00 clause | Implementation |
| --- | --- |
| `POST /auth/login` → 200 `AuthSessionResponse` + cookie | `auth/routes.ts`; `user`, `peer`, ISO `expiresAt`, `csrfToken`, never the secret |
| `GET /auth/session` → 200, 401 when invalid | Same; 401 also clears the unusable cookie |
| `POST /auth/logout` → 204, no JSON body | Revokes first, then clears; 204 with an empty body |
| `GET /me` shape unchanged | Untouched response shape; only the actor source changed |
| `__Host-szronox_session`; Secure; HttpOnly; SameSite=Lax; Path=/; no Domain | `cookies.ts`, fixed and not configurable |
| 32-byte random secret; PostgreSQL stores SHA-256 | `sessions.ts`; `token_hash` is the digest, CHECK-constrained to 64 hex chars |
| CSRF = HMAC-SHA-256(csrf secret, session secret), hash stored, recomputed on bootstrap | `sessions.ts`; rotation makes every stored digest unreachable |
| Absolute seven-day lifetime, configurable, no extension | `AUTH_SESSION_LIFETIME_SECONDS`, default 604800; `expires_at` fixed at login |
| Expiry, revocation and both-user provisioning checked per request | One statement in `sessions.resolve`, including `count(*) from app.users` |
| New login invalidates the supplied old session | `service.login` revokes the presented cookie before issuing |
| Argon2id 19456/2/1, per-password salt | `ARGON2ID_PARAMETERS`; PHC string carries salt and costs per row |
| Bounded concurrent verification and input size | FIFO semaphore (default 2); 1024-byte limit, rejected not truncated |
| Generic 401 for invalid account/password, dummy verification for unknown | One envelope for all three cases; `verifyDummy` spends the work |
| Bounded in-memory IP and account throttles; 429 + Retry-After; retryable | `throttle.ts`, `maxKeys` eviction; `RATE_LIMITED`, `retryable: true` |
| Unsafe requests need exact Origin and session-bound CSRF | Enforced inside `authenticate`, so one call site covers every route |
| Login accepts only JSON and exact Origin, no prior session | `service.login`; 415 for anything else |
| Proxy trust limited to the real proxy | `origin.ts` reads only `request.ip`; forwarded headers are never read |
| `Cache-Control: no-store` on all auth responses | `noStore` in the route funnel, failures included |
| Logs redact Cookie/Set-Cookie/password/CSRF/upload auth | `AUTH_LOG_REDACT_PATHS`, exported for startup to apply |
| `VerifiedActor { id, name }`, no client actor field | `RequestAuthenticator`; a body `createdBy`/`actorId` claim is ignored (tested) |
| `BrowserAuth` interface, memory-only state and CSRF | `BrowserSession`; nothing written to any browser store (tested two ways) |
| Restore failure ≠ confirmed anonymous | `AuthStatus` has both `anonymous` and `unreachable`; only 401 clears |
| No flush before confirmed identity | `CoreApiClient` refuses to dispatch when `actorId` is null |
| Auth generation, cancel and discard earlier generations | `AbortController` per generation; `StaleResponseError` on arrival |
| `credentials: 'same-origin'`, CSRF on unsafe, 204 without parsing | `CoreApiClient.request` |
| Polish login copy with an account name | `Login.tsx`; NOXAVA/SZRON radio group |
| No signup, reset, roles, admin UI, social login, third user | No such endpoint or code path exists; provisioning cannot create a user |
| Existing UUIDs preserved, never regenerated | `setPassword`/`provisionPassword` update by existing id; `assertProvisioned` refuses a mismatch |
| Draft/blob/queue partitions preserved | `DraftStore` keys untouched; partition isolation tested |

## Environment variables

New, required by the API:

- `APP_ORIGIN` — exact origin(s), comma-separated. HTTPS, except `localhost`/`127.0.0.1`.
- `AUTH_CSRF_SECRET` — environment-specific, at least 32 characters. Rotating it
  invalidates every live session.

New, optional:

- `AUTH_SESSION_LIFETIME_SECONDS` — default `604800`.
- `AUTH_PASSWORD_CONCURRENCY` — default `2`.

Removed: `SUPABASE_JWT_SECRET`, `SUPABASE_JWKS_URL`, `SUPABASE_JWT_ISSUER`,
`SUPABASE_JWT_AUDIENCE`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`. The web bundle
now carries no authentication configuration at all. `APP_ALLOWLIST` is retained: it is
the operator's statement of the two stable UUIDs, and `assertProvisioned` compares it
against the database rather than writing it.

No credential was provisioned and no secret value appears in this repository.

## Exact commands and results

Run from `/Users/kubabilski/Desktop/SzroNox/.worktrees/vps-01-auth`.

```sh
npm ci                      # lockfile already in sync; 187 packages, git clean afterwards
npm run typecheck           # PASS: contracts, web, api, worker
npm run build               # PASS: vite build, api tsc, worker tsc
npm test                    # PASS 88/88 (apps/api: 56 core + 32 auth)
npm run test:t08 --workspace @szronox/web                          # PASS 1/1
node --experimental-strip-types --test apps/web/src/ui/frozen-copy.test.mjs   # PASS 8/8
```

Browser auth tests, not yet wired into any npm script:

```sh
npx tsc -p apps/web/tsconfig.test.json
node --test apps/web/dist/test/apps/web/src/auth/tests/*.test.js   # PASS 14/14
```

Baseline before any change was **66/66** on `npm test`. Ten JWT/JWKS tests were removed
with the modules they exercised and 32 auth tests added, so 88/88 is the new total.

`apps/web/dist/test` is build output under the already-ignored `dist/`. A `vite build`
clears it; re-run the `tsc` line above before the test command.

## Acceptance

Every item the user pinned for VPS-01, with where it is demonstrated.

| # | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Valid login per account | PASS | `auth.test.ts`: both accounts log in, each gets its own identity, peer and cookie |
| 2 | Incorrect password rejected | PASS | 401, no cookie set, no session row written |
| 3 | Nonexistent user does not disclose existence | PASS | Unknown name, no-credential account and wrong password return byte-identical envelopes; unknown accounts still pay a verification |
| 4 | Forged session rejected | PASS | Random value, one-byte mutation, empty value, the stored digest itself, and a different cookie name — all 401 |
| 4 | Expired session rejected | PASS | Refused at the expiry instant; repeated use does not move `expiresAt` |
| 4 | Revoked session rejected | PASS | Post-logout replay of the same cookie is 401; also covered for CSRF-secret rotation and password change |
| 5 | Logout invalidates the server session | PASS | `revoked_at` set in PostgreSQL; cookie replay fails; a second logout reports 401 rather than claiming a revocation |
| 6 | Session recovered after reload | PASS | A fresh `BrowserSession` with no memory restores from the cookie alone and recomputes the CSRF token |
| 7 | `/me` confirms authoritative identity | PASS | Reports the session's user; a body `createdBy`/`actorId`/`userId` claim is ignored and the created Reel is attributed to the session user |
| 8 | No auth token in localStorage/IndexedDB | PASS | Storage traps record zero accesses across login → request → logout; a source scan also refuses the identifiers |
| 9 | CSRF/origin protection exercised | PASS | Missing, empty, wrong and another session's CSRF token all 403; foreign and missing Origin 403; all twelve unsafe routes refuse; CSRF alone gives 401; reads need no Origin |
| 10 | Login throttling exercised | PASS | Address and account windows both enforced with `Retry-After`; the correct password is still refused inside an open window; a different address and the other account are unaffected; windows expire |
| 11 | Account switching leaks no drafts | PASS | Both accounts hold their own draft for the same Reel; neither overwrites or reads the other's; deleting one leaves the other |
| 11 | No old in-flight result applied to the new account | PASS | A held request is aborted on switch and, when the server answers anyway, rejects with `StaleResponseError` instead of returning the previous account's data |

## Limitations and unverified gates

- **No browser ran.** `HttpOnly`, `Secure`, `SameSite=Lax`, the `__Host-` prefix and
  `credentials: 'same-origin'` are asserted as emitted headers and request options, not
  as enforced browser behaviour. The fifteen browser acceptance steps remain a VPS-07
  gate.
- **No real PostgreSQL server.** PGlite is real PostgreSQL 18 in WASM, so the migration,
  the CHECK constraints and the SQL all ran for real, but it is single-connection: two
  sessions racing on the same session row cannot be produced here. Revocation and login
  are written as single statements whose predicates carry the guard (`revoked_at is
  null and expires_at > now`), which is the property that makes the multi-session case
  safe, but demonstrating it is a VPS-06 gate.
- **Throttling is per-process.** A restart clears every counter and two API replicas
  would each enforce the limit separately. VPS-00 accepted this for one API process and
  requires a shared limiter before scaling out.
- **`__Host-` requires HTTPS.** There is no plaintext development mode, by design. Local
  development over `http://localhost` cannot receive the cookie; HTTPS provisioning is
  the VPS-05 gate.
- **Timing equality is bounded, not measured.** Unknown accounts run a comparable
  Argon2id verification, which removes the obvious signal; no statistical timing
  analysis was performed.
- **The operator provisioning command is not bound.** `provisionPasswordFromStream`
  reads the password from a stream and never from argv, but constructing a PostgreSQL
  pool belongs to `apps/api/src/db/**` (VPS-03). No executable entry point exists yet.
- **Not wired into startup.** `registerAuthRoutes`, `assertProvisioned`,
  `AUTH_LOG_REDACT_PATHS` and `trustProxy` are all exported or documented, none applied:
  API composition and startup are VPS-04's scope. The app therefore does not yet serve
  `/auth/*` in production, only in tests that compose it explicitly.
- **`SyncQueue` marks an account-switch-abandoned item `failed`.** `drafts/queue.ts` is
  outside VPS-01's scope and the behaviour is safe — the item stays in its own account's
  partition and is retried on the next flush — but `pending` would be more accurate.
- **Supabase storage is untouched and still `UNVERIFIED`.** That is VPS-02's work; only
  the JWT half of `core/config.ts` was changed.

## Handoff to the lead

Wiring VPS-04 needs, in order:

1. `const core = buildCoreDependencies(db, process.env)` — it now returns `auth` as well.
2. `registerAuthRoutes(app, { service: core.auth.service })` before the static plugins,
   next to `registerCoreRoutes`.
3. `await assertProvisioned(db, parseAllowlist(process.env.APP_ALLOWLIST))` at startup,
   so a half-provisioned deployment fails loudly instead of serving 401s.
4. Fastify logger options: `redact: [...AUTH_LOG_REDACT_PATHS]`. `app.ts` currently
   builds with `logger: false`, so nothing leaks today, but enabling a logger without
   this would write cookies and CSRF tokens.
5. `trustProxy` set to the actual Caddy address, not `true`. `origin.ts` reads only
   `request.ip`, so this is the single place that decides whether a forwarded address can
   influence the limiter key.
6. Decide the migration identifier (see the top of this document) and whether
   `apps/web/tsconfig.test.json` gets an `npm` script.

No merge was performed. No VPS, production data, deployment, paid resource or external
service was touched.

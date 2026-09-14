# VPS-00–03 — approved dispatch amendments

User approved this batch on 2026-09-14 with explicit model allocations and instructed "run agents". This document supersedes conflicting proposal-only status and interface text in the earlier VPS-00 report. Product T00 and written visual specifications remain authoritative. No VPS mutation, no nested agents, no VPS-04 automatic start.

## Baseline

Prepare one shared baseline from Opus's 0b2d6b0 T08 integrated correction commit (includes T05 1193be7 and T06 67f8a7d), plus the root VPS-00 contracts/dependencies and existing deploy/vps scaffold. Preserve branch history. No re-audit of accepted corrections. Each assigned worktree starts at that same prepared commit; the exact hash is recorded in VPS-dispatch-status.md and the manual Opus handoff before launch.

## Migration ownership — exact and exclusive

- VPS-01/Opus: database/migrations/0003_vps_auth.sql only.
- VPS-02/Sol: database/migrations/0004_vps_storage.sql only.
- VPS-03/Luna: move supabase/migrations/0001_core_schema.sql and 0002_script_revision.sql to database/migrations under identical filenames with byte-identical SQL. Preserve ledger names/semantics. No new numbered migration.
- Auth/storage tests may apply historical files from supabase/migrations in their isolated baseline plus their assigned new migration; do not copy/move historical migrations on those branches. Integration supplies the combined neutral directory.
- Root resolves any later migration collision; agents never renumber or rewrite history.

## Storage configuration — shared VPS-02/VPS-03 contract

- Logical root: private application attachment storage, outside the served web tree.
- Environment variable: APP_STORAGE_ROOT. Container value: /var/lib/szronox/storage. Application adapter accepts root: string supplied from this variable; no developer absolute path in source.
- Development Compose named volume: app_storage, scoped by project name szronox-dev (normally szronox-dev_app_storage). Mount read/write at /var/lib/szronox/storage in API only. Worker does not need this mount for the current milestone. Production later uses a different project/volume.
- Staging: <root>/staging. Validated immutable objects: <root>/objects. Both reside on the same filesystem for atomic publication.
- Application UID:GID 1000:1000 (node image user). Volume initialization is an explicit one-shot local Compose step restricted to that volume; do not run the API as root. Directories 0700, files 0600, umask 0077. Backups use their separately scoped read access. No broad host chown/chmod.
- At startup require an absolute configured root, reject symlink root/subdirectories, verify readable/writable ownership; fail closed if invalid. Tests use disposable temporary directories injected explicitly.
- VPS-02 exports filesystem adapter/config parsing; VPS-03 configures the same variable, mount and owner. API release wiring remains an integration concern, not permission to invent a second storage path.

## Authentication pins

- POST /api/v1/auth/login: LoginRequest {name,password}, JSON, exact configured APP_ORIGIN, generic 401 on invalid credentials.
- GET /api/v1/me: AuthSessionResponse {user,peer,expiresAt,csrfToken}, authoritative database identity; 401 for invalid/expired/revoked/missing session. No-store. Existing user/peer fields retained. This is the browser restore endpoint; do not add /auth/session.
- POST /api/v1/auth/logout: exact Origin + session CSRF; revoke server session before clearing cookie; 204 on success. Expired/missing session can return 401 and clear cookie. Network/database failure cannot report successful revocation.
- Cookie __Host-szronox_session: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. Opaque 32 random bytes; only SHA-256 digest stored server-side. Persistent Max-Age never exceeds server expiry.
- APP_SESSION_TTL_SECONDS default 604800, positive bounded maximum 604800; expires when now >= expiresAt. No indefinite rolling refresh. New login rotates/revokes supplied prior session. No token persistence in browser storage.
- APP_CSRF_SECRET_FILE: environment-specific server secret file. HMAC-SHA-256 derivation from session secret as pinned in VPS-00, X-CSRF-Token header on unsafe requests, exact APP_ORIGIN validation. Only login is exempt from prior-session CSRF; JSON/origin/throttle checks still apply. Session bootstrap token mismatch after secret rotation invalidates the session.
- Bound login to 5 attempts/account/15 minutes and 20 attempts/IP/15 minutes; bounded in-memory key storage, maximum two simultaneous Argon2 verifications, body <=4096 bytes. Account limiter uses only the two recognized account names plus one unknown-account bucket; generic failure responses. Return 429 RATE_LIMITED and Retry-After. Do not trust unconfigured proxy headers. Limits configurable downward/upward only with explicit bounded validation; no extra UI.
- Existing APP_ALLOWLIST mapping is authoritative and must exactly match provisioned app.users IDs/names. Never change IDs based on session/browser claims.
- Fresh disposable development default mapping: NOXAVA=11111111-1111-4111-8111-111111111111; SZRON=22222222-2222-4222-8222-222222222222 (the existing test fixture IDs). These are explicitly development identifiers, not an assertion about existing external accounts. If a database already has either user, retain its ID and require the configured mapping to match; reject mismatches instead of re-keying records or drafts. Production mapping is not guessed or provisioned here.
- Provisioning is an operator-only command using migration/provisioning credentials and protected stdin/secret files for passwords, not argv/logs. Atomic two-user creation; exactly two distinct names/IDs; rerun preserves IDs and existing password hashes unless an explicit credential-replacement flag is used. This flag is an operator recovery mechanism, not a reset endpoint/UI. Runtime may manage sessions but cannot create/remove/rename user or credential records.
- Argon2id minimum and browser generation/partition semantics remain VPS-00. Server actor is always {id,name} resolved from authenticated session; equal shared product access remains unchanged.

## Parallel ownership and interfaces

VPS-01 (manual Opus) owns apps/api/src/auth/**, browser auth/**, data/api.ts and data/errors.ts auth/rate-limit changes, auth-only wiring in main.tsx, app/App.tsx and controllers/useAppController.ts; core/config.ts authentication configuration sections only; core/routes.ts auth imports/CoreDependencies auth seam/actorOf and GET /me only; apps/api/src/auth*.test.ts and scoped browser auth tests; assigned migration and VPS-01-result.md. May update auth-only expectations in core.test.ts. No attachment sections or storage configuration edits.

VPS-02 (gpt-5.6-sol, high) owns apps/api/src/storage/**, core/storage.ts, attachment-only sections of core/routes.ts and core/repository.ts, storage-only sections of core/config.ts, apps/api/src/storage*.test.ts, assigned migration and VPS-02-result.md. No actorOf, GET /me or auth configuration edits. Use injected authenticate(request): Promise<{id,name}> for HTTP storage-route tests; it must validate session/origin/CSRF as appropriate in real composition, never a public stub. The storage plugin may declare this callback structurally so it compiles before Opus's module exists. Existing core route wrappers call actorOf; Opus replaces that implementation without changing attachment handler semantics.

VPS-03 (gpt-5.6-luna, high) owns deploy/vps/**, apps/api/src/db/**, apps/api/test/postgres/**, historical migration relocation only and VPS-03-result.md. No auth/storage migrations or application modules. Harness can use injected/isolated fixtures and existing CoreRepository, explicitly labeled live versus unexecuted. Do not mutate live VPS or borrow other projects' credentials/networks/volumes.

Shared file edits are confined to the named disjoint sections in separate worktrees; root reconciles once after all three finish. Root alone owns package manifests/lockfile, shared contracts and app/worker composition outside these scopes. No dependency edits by children; send required additions to root. Synthetic PostgreSQL/PGlite tests and local temporary filesystem work are allowed. Real credentials are not required to write tests; absent live PG/browser checks stay unverified.

All three stop with scoped commit, exact owned files, commands/results, limitations and unverified gates. Opus is manual-only: do not replace with Sol. Luna unavailability requires a Sonnet manual handoff, not another Sol allocation. After completion root reconciles once, prepares VPS-04 proposal and waits for user approval.

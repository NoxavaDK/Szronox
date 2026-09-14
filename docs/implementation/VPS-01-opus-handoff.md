# VPS-01 — standalone manual Opus prompt

User explicitly approved this task for manual Opus. Do not substitute Sol or spawn nested agents. The Codex root has already launched VPS-02/Sol and VPS-03/Luna in separate worktrees. Work only on VPS-01. Do not merge, deploy, mutate the VPS, access production credentials/data, or start VPS-04.

## Exact task/model/baseline

Task ID: VPS-01. Model: user-launched Opus 5 (`claude-opus-5`, the user's existing manual environment); verify actual selected Opus model in that environment and report it, no automatic substitution. Difficulty: high, because authentication crosses server sessions, CSRF, browser reload and account-switch isolation.

Replace Supabase authentication with application-owned authentication for exactly NOXAVA and SZRON while preserving browser/controller behavior and account-scoped local drafts.

Worktree: `/Users/kubabilski/Desktop/SzroNox/.worktrees/vps-01-auth`

Branch: `codex/vps-01-auth`

Exact baseline: `43fbd23dea48d8a593557bbc30558cf748f28ec4`

This prepared merge preserves Opus's integrated T08 `0b2d6b0`, T05 `1193be7`, T06 `67f8a7d` and root VPS-00 `5444ae0`, plus the existing scaffold deployment files. Do not reset to historical task heads. Verify HEAD/status first and preserve any later user changes. No repeat broad correction audit.

## Read first

Read these files inside your assigned worktree:

- `AGENTS.md`
- `docs/implementation/T00-contracts.md`
- `docs/implementation/tasks.md`
- `docs/implementation/VPS-00-contracts.md`
- `docs/implementation/VPS-batch-dispatch.md` — latest user-approved amendments take precedence over older proposal wording
- `packages/contracts/src/index.ts`
- Existing `docs/implementation/T05-result.md` and `T08-result.md` for handoff context only; do not reopen their accepted correction work.

## Allowed files — explicit ownership

- `apps/api/src/auth/**`
- `apps/api/src/auth*.test.ts`
- `apps/web/src/auth/**` (including scoped tests)
- `apps/web/src/data/api.ts`
- `apps/web/src/data/errors.ts` (auth/rate-limit mapping only)
- `apps/web/src/data/vite-env.d.ts` (remove obsolete auth variables only)
- Auth-only wiring in `apps/web/src/main.tsx`, `apps/web/src/app/App.tsx`, `apps/web/src/controllers/useAppController.ts`
- Authentication sections only of `apps/api/src/core/config.ts`
- Auth imports, auth dependency interface/seam, `actorOf` and `GET /me` only in `apps/api/src/core/routes.ts`
- Auth-only expectation updates in `apps/api/src/core.test.ts`
- Exactly `database/migrations/0003_vps_auth.sql`
- `docs/implementation/VPS-01-result.md`

No package manifests/lockfile, shared contract edits, historical migrations, storage/attachment sections, deployment files, worker implementation, screen redesign, draft schema/model or unrelated controller changes. Root owns dependency additions; request any missing dependency rather than editing a manifest. `argon2`, `pg`, `@fastify/cookie`, `@fastify/rate-limit`, and `@types/pg` are already pinned. PGlite remains available for local tests.

VPS-02 edits storage sections of core/config.ts, attachment sections of core/routes.ts/repository.ts and its own modules. Keep disjoint edits so root reconciles once. It tests HTTP routes with an injected authenticate(request) callback. You own the real callback/session authority. Preserve domain repository actor signatures. App process startup/full deployment composition belongs to later work; export your registration/factory seam so tests compose actual auth and core routes without modifying entry points outside your allowlist.

## Pinned behavior — implement, do not redesign

POST `/api/v1/auth/login` accepts `{name,password}`, application/json, exact APP_ORIGIN and bounded throttling. Generic 401 UNAUTHENTICATED for nonexistent user or wrong password, including dummy hash verification. Successful 200 AuthSessionResponse and session cookie.

GET `/api/v1/me` is the browser reload/session bootstrap endpoint. Return `{user,peer,expiresAt,csrfToken}` from the authoritative session/database, no-store. Preserve user/peer fields. Invalid, forged, missing, expired or revoked session returns 401. Do not create `/auth/session`.

POST `/api/v1/auth/logout` validates Origin and CSRF, revokes current session server-side before clearing cookie, returns 204 without JSON. Expired/missing sessions may return 401 and clear cookie. Network/database failures cannot report successful server revocation.

Cookie `__Host-szronox_session`: opaque 32 cryptographically random bytes, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain. Only token SHA-256 hashes stored server-side. APP_SESSION_TTL_SECONDS defaults to 604800, maximum 604800; expire at `now >= expiresAt`. No indefinite rolling extension. New login rotates/revokes the supplied old session.

Argon2id salted hashes: minimum 19456 KiB, timeCost 2, parallelism 1. Password inputs bounded, never silently trimmed/truncated. Bound active hashing to two concurrent verifications. Login limits: 5 attempts/account/15 minutes and 20/IP/15 minutes; bounded key storage and one shared unknown-account bucket. Body max 4096 bytes. Return 429 RATE_LIMITED plus Retry-After with Polish client mapping. Do not trust arbitrary forwarded headers.

APP_CSRF_SECRET_FILE contains the environment-specific secret. Derive CSRF token through HMAC-SHA-256 over the opaque session secret, retain its hash server-side; bootstrap recomputes it. Secret rotation invalidates existing sessions. Unsafe authenticated requests require exact APP_ORIGIN and X-CSRF-Token. Only login lacks a prior session and uses strict JSON/origin protection instead. No credentialed cross-origin CORS. Read-only GET does not mutate product data.

Exactly two equal users. Existing APP_ALLOWLIST and provisioned user rows must match. Fresh disposable development IDs are NOXAVA `11111111-1111-4111-8111-111111111111` and SZRON `22222222-2222-4222-8222-222222222222` (existing fixture IDs). Existing database IDs take precedence: mismatched configured IDs fail rather than rewriting rows/draft partitions. No guess about production identities.

Operator-only provisioning uses protected stdin/files and dedicated provisioning DB credentials, never password arguments or logged secrets. Create the pair atomically, validate exactly two distinct allowed names/IDs, rerun without changing IDs/password hashes unless explicit operator credential-replacement is requested. No signup/reset endpoint/role management/admin UI/social login/third account. Runtime role can manage sessions, not create/rename/delete users or credentials. Implement schema and provisioning contract; actual user credential provisioning is not authorized here.

Browser session state is cookie-backed with memory-only metadata/CSRF. No access/refresh token or session secret in localStorage/IndexedDB. Restore via `/me` before opening/flushing account drafts. Distinguish network failure from confirmed unauthenticated state; preserve recoverable local work. Logout/account switching invalidates old request generations, cancels when possible and rejects stale callbacks. Never apply an old response to a newly active account or rebind queued work/blobs. Both users still share product Reels/Memes; local drafts stay account-scoped.

Remove GoTrue calls, Supabase browser auth variables/token persistence and obsolete server JWKS production paths. If old fixtures need a test-only token helper during scoped transition, isolate it as test-only and prove production cannot select it. Do not retain a bearer fallback that bypasses sessions. Shared error payloads/operation IDs/expectedVersion/Reel payloads remain unchanged.

## Migration coordination

Create only `database/migrations/0003_vps_auth.sql`. VPS-03 moves historical `0001_core_schema.sql` and `0002_script_revision.sql` byte-for-byte; VPS-02 owns `0004_vps_storage.sql`. Do not copy/move/rename historical migrations yourself. Your isolated tests can apply current `supabase/migrations` historical files followed by your assigned new file until integration supplies the combined neutral directory. Preserve ledger semantics.

## Acceptance and verification

Cover both valid accounts; wrong password and nonexistent account generic failure; forged/expired/revoked cookies; server logout invalidation; exact expiry boundary; `/me` server identity; CSRF/origin failure/success; bounded throttling and hashing; reload session recovery; no token persistence; account-switch in-flight results and draft isolation. Use focused auth integration tests against the actual route seam, and event/deferred-response tests for browser generation handling. Do not label mocks/PGlite as real PostgreSQL/browser evidence. If actual browser or configured live PostgreSQL is unavailable, explicitly list that gate as unverified.

Begin with `npm ci --no-audit --no-fund` in your own worktree if needed; do not rely on ancestor node_modules workspace symlinks. Then build contracts before dependent workspaces. Standard checks: `npm run build`, `npm run typecheck`, focused auth test commands and `git diff --check`. Existing API test script picks up compiled top-level `auth*.test.ts`. Record all exact commands, not just "tests passed". Loopback tests may need sandbox permission; no VPS fallback.

## Required finish

Write VPS-01-result.md with actual model, baseline, exact changed files, contract acceptance matrix, exact commands/results, limitations and unverified gates. Make a scoped commit in codex/vps-01-auth (including only your changes), report its ID, stop. Do not merge, dispatch more tasks, re-audit the entire correction batch or mutate the live VPS. Root integrates/reconciles after all three approved tasks finish, then prepares VPS-04 for user approval.

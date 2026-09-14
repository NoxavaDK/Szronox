# VPS-00 — infrastructure contracts and ownership

Status: approved infrastructure direction; root-only VPS-00 authorized by "go for T0" and "go now" on 2026-09-14. The latter explicitly permits this work before Opus's integrated baseline. VPS-01–03 are now explicitly approved with the amendments in VPS-batch-dispatch.md; VPS-04 onward remain gated. This document changes infrastructure, not frozen product behavior.

## Baseline and integration

Root at start: f0e8e9b. Observed feature heads: T05 fc3207d, T06 951a0ea, T08 c131987. These are provenance, not instructions to reset or merge. Opus owns the ongoing correction integration; do not repeat its review. Reconcile its final changes with these additive contracts and dependency additions at integration, preserving accepted functionality. No claim that root currently runs T05/T06/T08 end-to-end.

Architecture: React/Vite PWA → existing Caddy HTTPS → same-origin Fastify serving built web assets and API. API and a separate worker process use the same release and real PostgreSQL. Private bounded files live outside the web root on a persistent VPS volume. kDrive remains a separate production-media integration. No Supabase platform dependency, SQLite, Redis, S3 or extra identity platform.

## Identity and authentication

Exactly two provisioned app.users rows: NOXAVA and SZRON, equal product users. Preserve their existing UUIDs and all references; never generate replacement UUIDs during deployment or login. Existing unique name plus two-value CHECK and primary key constrain the table to at most two rows; provisioning/readiness verifies both exist. Runtime roles cannot insert/delete/rename users. Operator provisioning supplies stable IDs and passwords through protected input, never command arguments, logs or committed fixtures. No signup, reset endpoint, social login, roles or admin UI.

Add private app.user_credentials (user_id primary key/FK, password_hash) and app.auth_sessions (token_hash primary key, user_id FK, csrf_token_hash, created_at, expires_at, revoked_at). Session/credential records never appear in domain responses or worker grants. Derive the CSRF token using HMAC-SHA-256 with a separate environment-specific CSRF secret and the opaque session secret supplied in the cookie. Store its hash at login and recompute the token on bootstrap; rotating the CSRF secret invalidates existing sessions. Do not expose session token hashes either.

Argon2id with per-password random salt. Initial parameters: memoryCost=19456 KiB, timeCost=2, parallelism=1; benchmark on the target before increasing them. Bound concurrent password verification and login input size. Never silently truncate/trim passwords. Generic 401 UNAUTHENTICATED for invalid account/password, with dummy verification for unknown accounts. In-memory bounded IP and account throttles are adequate for one API process; document restart reset and require a shared limiter before scaling replicas. Return 429 RATE_LIMITED with Retry-After, retryable=true.

Generate a fresh 32-byte cryptographically random opaque session secret at login. PostgreSQL stores its SHA-256 digest, not the secret. Cookie: __Host-szronox_session; Secure; HttpOnly; SameSite=Lax; Path=/; no Domain; persistent Max-Age limited by server expiry. Initial absolute lifetime is seven days (configurable, no automatic indefinite extension). Server checks expiry/revocation and both-user provisioning on every authenticated request. Local metadata is never identity proof. New login invalidates the supplied old session when valid; logout revokes the current session before clearing the cookie. No JWT/JWKS or refresh token is needed.

Unsafe requests require exact configured Origin and a session-bound X-CSRF-Token, compared safely against the stored hash/derivation. Login has no prior session requirement: accept only application/json and exact Origin, with cross-origin CORS disabled and login throttling. GET/HEAD never mutate application state. Missing/foreign origins fail closed on unsafe browser endpoints. Proxy trust must be limited to the actual reverse proxy; arbitrary forwarded headers cannot choose identity, origin or limiter key.

All auth responses: Cache-Control: no-store. Logs redact Cookie, Set-Cookie, password, X-CSRF-Token and upload authorization. Password/session secrets never enter localStorage, IndexedDB or the service-worker cache.

### HTTP and browser seam

All paths below have /api/v1 prefix. GET /me preserves user/peer fields and adds expiresAt and csrfToken (AuthSessionResponse); it is the single browser reload/session recovery endpoint. This user-approved amendment supersedes the earlier separate /auth/session proposal.

| Method/path | Request | Successful response |
| --- | --- | --- |
| POST /auth/login | LoginRequest { name, password } | 200 AuthSessionResponse plus session cookie |
| GET /me | Session cookie | 200 AuthSessionResponse; invalid session returns 401 |
| POST /auth/logout | Session cookie, Origin, CSRF header | 204, revoke session and clear cookie; no JSON body |

AuthSessionResponse contains user, peer, ISO expiresAt and csrfToken, never the session secret. CSRF tokens alone cannot authenticate. A missing/expired session during logout may return 401 and clear the cookie; it must not claim a live session was revoked on network/database failure. Public liveness may remain non-sensitive; domain data always requires authentication.

The provider-neutral browser interface is BrowserAuth: current(): AuthSessionResponse|null; subscribe(listener): unsubscribe; restore(): Promise<void>; signIn(name: User['name'], password: string): Promise<void>; signOut(): Promise<void>. Auth state and CSRF tokens are memory-only. A restore network failure differs from confirmed anonymous state; preserve local drafts and expose recoverable connection failure. Do not open account drafts or flush until server identity is confirmed. On logout/account switch, increment an auth generation, cancel active requests where possible and discard responses from earlier generations. Capture identity at request dispatch, never rebind old work to the next logged-in user.

CoreApiClient retains typed domain methods. Its centralized transport uses credentials='same-origin', adds CSRF on unsafe methods, and supports 204 without parsing JSON. Upload transport uses the same confirmed-session/generation boundary. Browser Login copy remains Polish with account name rather than a Supabase email credential assumption. No screen redesign.

The backend request-authentication seam returns VerifiedActor { id, name } after resolving cookie/session, not a client actor field. Domain repository signatures remain unchanged. The auth module exports a request-authentication function/plugin for integration; the lead wires it into core/routes.ts and app startup. Storage routes consume this seam. Do not preserve TokenVerifier/bearer parsing as a second production authorization path.

Account separation applies to draft/blob/queue partitions and request identity. Both users still see shared Reels and Memes. Quarantined pre-login capture needs explicit account binding. Changing HTTPS origin does not migrate IndexedDB: retain the old origin's drafts; never claim they moved or clear them. Preserve the existing account-ID namespace and blob keys.

## PostgreSQL and migrations

Separate Compose projects, PostgreSQL instances, networks and volumes for dev/prod. Provision only development in this milestone. Databases: szronox_dev and later szronox_prod. Do not use cutroom-postgres-1. No public PostgreSQL port. Routine tooling receives only development connection material; privileged host deployment access is a distinct capability.

Per environment: migration/owner identity for DDL, API identity for required domain/session DML, worker identity for its explicitly needed database operations. No runtime superuser/CREATEDB/CREATEROLE or cross-environment grants. Revoke default PUBLIC access as appropriate, pin search_path, and test grants. Worker does not get credential/session table access. Small independent pools, bounded connection/statement/lock timeouts and graceful pool shutdown; never share one client across overlapping transactions.

Keep Database, Queryable and pgPoolDatabase. PGlite remains local test infrastructure; only synchronized multi-connection real-PG runs prove races. API and worker do not migrate on startup. A one-shot migration job holds a PostgreSQL advisory lock on the same dedicated connection for ledger check and application; each migration and ledger insert is atomic. Move existing SQL to database/migrations without renaming or changing already-applied files or ledger entries. Add new migrations; never edit deployed history.

Assign exactly database/migrations/0003_vps_auth.sql to VPS-01 and database/migrations/0004_vps_storage.sql to VPS-02. Opus baseline 0b2d6b0 contains historical 0001_core_schema.sql and 0002_script_revision.sql; both identities and byte contents are preserved. No agent creates any other migration. VPS-03 moves only those two historical files. Storage migration is unnecessary if equivalent durable metadata exists. VPS-03 owns moving existing migrations and the runner, not the reserved new files.

Daily development pg_dump custom archive plus coordinated immutable-file backup; initially seven daily copies. Pause writes and worker briefly during the coordinated snapshot if needed; retain an exact matching database/files pair and manifest. Restore into disposable development targets and verify references, not only archive readability. Production needs separately approved recovery objectives and encrypted off-host copies; never give production backups to development tooling. Container rollback does not undo migrations.

## Private attachment transport

Keep AttachmentReference, stable IDs, original capture fields, declared descriptors, initiate/complete operations and per-attachment local recovery. Domain wire types are unchanged; additive transport types in packages/contracts/src/index.ts describe the corrected T05 response shape.

| Method/path | Contract |
| --- | --- |
| POST /reels/:id/attachments/initiate | InitiateAttachmentRequest → 201 InitiateAttachmentResponse |
| PUT /reels/:id/attachments/:attachmentId/content | Raw bytes, authenticated session, Origin, CSRF and X-Upload-Token → 204; not completion |
| POST /reels/:id/attachments/:attachmentId/complete | CompleteAttachmentRequest → 200 AttachmentReference after validation |
| POST /reels/:id/attachments/:attachmentId/upload-authorization | Empty JSON body; authenticated Origin/CSRF → 200 RenewAttachmentUploadResponse |
| GET /reels/:id/attachments/:attachmentId/content | Authenticated authorized ready attachment → private binary response |

UploadTransport retains uploadUrl, method, headers and Unix-seconds expiresAt. VPS uses a same-origin absolute URL and PUT. headers carries X-Upload-Token only, not cookies or privileged keys; client adds its current CSRF token. Refuse unexpected cross-origin transport URLs before attaching credentials. Storage keys remain opaque logical identifiers; never accept a browser filesystem path.

Initiation replay returns its original outcome, including possibly expired authorization. The new upload-authorization endpoint renews only transport for the same existing pending attachment and unchanged declared metadata; it creates no attachment and changes no domain operation/version history. It issues a short-lived ticket, is rate-limited and refuses ready/deleted/unavailable targets. Transport retries do not need an operation ID. Existing operation IDs remain unchanged for initiate/complete. Expired upload tickets return UPLOAD_INCOMPLETE with details.reason='upload_authorization_expired'; the client renews authorization, never repeats capture with new IDs.

Tickets bind actorId, reelId, attachmentId, storageKey, MIME/size and expiry. Store only ticket digests in private upload metadata. Session authentication plus the matching actor and ticket is required to upload; tickets alone are insufficient. The adapter's createSignedUpload options gain an explicit scope { actorId, reelId, attachmentId }; keep statObject(storageKey) and the existing return shape. Memory tests implement the same interface. Reads are shared between the two users, while upload tickets belong to the initiating actor.

Stream to a unique staging file under a server-controlled root; bound bytes even without Content-Length. Validate actual decodable image type, dimensions/pixel count and size using sharp; configured formats must match the existing supported capture set. No new file types or conversion policy. Preserve original bytes; filename is metadata only. Never follow symlinks or accept traversal; a completed object is immutable and cannot be overwritten by simultaneous PUTs. Size-only validation is insufficient. statObject must describe the validated immutable object used by complete, not an untrusted staging file.

Filesystem/SQL cannot commit atomically together. Flush and atomically publish the validated object before acknowledging ready in PostgreSQL. Stable immutable keys plus serialized completion make retries safe. Crash between publication and DB commit may leave a recoverable orphan; it must never leave acknowledged ready metadata without durable bytes. Failed/partial upload retains the local blob. Release that blob only after the individual complete response or authoritative ready reconciliation for that same attachment. Old idempotency aggregate responses never overwrite newer cache state.

Downloads resolve IDs server-side, authenticate both users, set private/no-store and nosniff, and use the validated MIME; no static directory exposure or service-worker file caching. Soft delete retains files and existing shared/external semantics; it never triggers physical purge. Staging cleanup can remove expired unreferenced temporary files only after a grace period and active-upload check; no automatic deletion of ready assets or local browser blobs.

## Dependency and file ownership

Root alone owns manifests, lockfile and shared wire types. Runtime libraries selected for VPS work: pg in API/worker, argon2, @fastify/cookie, @fastify/rate-limit and sharp in API; @types/pg for API/worker development. Use node:crypto for random values and digests. No Supabase SDK, JWT library, ORM or storage service dependency is introduced. PGlite already used by T05 must survive its later integration. This dependency installation does not activate a runtime feature.

| Task | Exclusive edit scope after separate approval |
| --- | --- |
| VPS-00/root | AGENTS.md; docs/implementation; packages/contracts/src; workspace manifests and root lockfile |
| VPS-01/auth | apps/api/src/auth/**; apps/web/src/auth/**; apps/web/src/data/api.ts; auth-only changes to main.tsx, app/App.tsx, controllers/useAppController.ts; reserved auth migration; scoped tests/report |
| VPS-02/storage | apps/api/src/storage/**; core/storage.ts; attachment-only sections of core/routes.ts and core/repository.ts; reserved storage migration; scoped tests/report |
| VPS-03/environment | deploy/vps/**; apps/api/src/db/**; apps/api/test/postgres/**; relocation of existing migrations only; scoped runbook/report |
| VPS-04/later lead integration | API composition/auth hook in core/routes.ts, API startup, worker runtime, browser upload wiring and dependency reconciliation; requires a later proposal |

VPS-01/02/03 may run in parallel only after individual task/model approval, on isolated worktrees based on the reconciled baseline. Root integration owns auth wiring in core/routes.ts so VPS-01 does not collide with VPS-02's attachment sections. No child edits another scope or spawns nested agents. Every handoff provides owned files, exact checks, outcomes/limitations and commit ID; no self-merge.

## Milestone gates

VPS-04 integration → VPS-05 isolated dev provisioning/HTTPS → VPS-06 real-PG races, migrations and API/worker evidence → VPS-07 all fifteen requested browser acceptance steps. No automatic dispatch or VPS modification. Intended hostname/DNS and backup destination remain deployment inputs.

Worker milestone scope is an independent pool/readiness/shutdown and explicitly development-only transactional probe; no T12 AI lifecycle dispatch. Real-PG tests use distinct connections and a barrier for overlapping version and idempotency writes, plus rollback, migration rerun and pool restart cases. Test evidence must identify real PostgreSQL versus PGlite/doubles. Shared API/worker access alone does not prove AI job claims or exactly-once work.

Frozen Reel states, editor/verification rules, hooks, feed cover, Publication copy, original input, account drafts, delete/restore, kDrive and unfinished AI gates remain unchanged. No correction re-review, deployment, paid provisioning, production data access or external messages are authorized by VPS-00.

## References used for dependency/security decisions

- [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP private upload handling](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- [PostgreSQL pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)
- [Fastify cookie compatibility](https://github.com/fastify/fastify-cookie)
- [Fastify rate-limit compatibility](https://github.com/fastify/fastify-rate-limit)
- [sharp runtime prerequisites](https://sharp.pixelplumbing.com/install/)

## Approved dispatch amendments

See VPS-batch-dispatch.md for authoritative model allocation, storage mount, development identity provisioning and split ownership. Those amendments take precedence over earlier proposal-only statuses and reserved-file caveats here. No live VPS changes.

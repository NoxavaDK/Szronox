# VPS-02 — private filesystem storage result

Status: implemented and committed on the assigned `codex/vps-02-storage` branch; not merged or deployed.

## Owned implementation

- `apps/api/src/storage/filesystem.ts` implements the private filesystem adapter. It requires an absolute pre-created root with `staging` and `objects` directories, rejects symlink/ownership/mode/device violations, expects UID:GID `1000:1000`, and exposes one cached asynchronous `initialize()` gate. Every operation awaits that same gate.
- Raw uploads stream to a unique `0600` staging file with a byte bound independent of `Content-Length`. Sharp performs a full decode and verifies JPEG/PNG/WebP type, dimensions and total pixels. Publication uses an atomic hard link into immutable object storage, so competing content cannot overwrite an object. Identical retries reconcile safely and original encoded bytes remain unchanged.
- `apps/api/src/storage/routes.ts` implements initiate, raw PUT, completion, transport renewal and private GET through a required injected `authenticate(request)` callback. The production callback is responsible for session authentication and Origin/CSRF validation on unsafe requests. Renewal is bounded and rate-limited. Reads use private/no-store and nosniff headers.
- Attachment repository changes bind upload authorization to actor, Reel, attachment, storage key, MIME, size and expiry; store only the SHA-256 ticket digest in attachment upload metadata; keep initiate/complete operation IDs; and leave renewal outside domain operation/version history. Completion locks the attachment and requires a validated immutable object before recording `ready`.
- `database/migrations/0004_vps_storage.sql` adds upload authorization and decoded-image validation metadata plus all-or-none checks and unique non-null storage keys. Historical migrations were not moved or edited.
- `core/config.ts` selects the filesystem adapter from `APP_STORAGE_ROOT` and `APP_ORIGIN`, with a 1–900 second `APP_UPLOAD_TICKET_TTL_SECONDS` bound. Memory storage remains an explicit test/development selection. The historical Supabase adapter export remains only so the accepted pre-VPS test source compiles; configuration no longer selects it.

## Acceptance evidence

The focused suite uses real temporary filesystem I/O, real Sharp decoding, Fastify injection, and PGlite with the historical migrations plus `0004_vps_storage.sql`. It verifies:

- missing/wrong root configuration, symlink rejection, private directory ownership/modes and same-origin scoped tickets;
- unauthorized actor, missing unsafe-request CSRF, expired ticket reason, old-ticket rejection after renewal and peer authenticated reads;
- corrupt image, MIME mismatch, declared/actual size mismatch, maximum bytes, dimensions and pixel count;
- interrupted upload cleanup, exact original-byte readback, identical retry, different-byte no-overwrite and competing concurrent publication;
- initiation replay returning its original ticket, renewal changing transport only, no renewal operation record, renewal rate limiting and refusal after ready;
- durable-object publication before database metadata as a recoverable orphan that cannot complete until the same PUT is reconciled;
- completion replay and migration rerun safety.

Commands and results:

```text
npm ci
PASS — 187 packages installed from the pinned lockfile; no manifest/lockfile edits.

cd apps/api && npm run typecheck
PASS

npm run build
PASS — contracts, web, API and worker production builds.

cd apps/api && node --test dist/storage-config.test.js dist/storage-filesystem.test.js dist/storage-routes.test.js
PASS — 13 tests, 0 failures.

npm test
PARTIAL — 68 tests passed, 11 failed in this restricted worktree.
```

Five broad-suite failures are expected integration deltas: four historical `core.test.ts` attachment fixtures use VPS-03's not-yet-integrated migration runner and therefore do not apply `0004`; one historical assertion still expects Supabase storage configuration. Six shutdown tests cannot bind `127.0.0.1` in the sandbox (`EPERM`). The focused Fastify storage tests do not bind a socket and all pass. The web build was produced before the broad run, so unrelated static-serving tests pass.

## Integration requirements and unverified gates

- VPS-04 must await `storage.initialize()` before `listen`; operations also fail closed through the same initialization promise.
- Root must reconcile the route authentication seam with VPS-01's session authenticator. The current baseline `actorOf` wrapper is retained only because VPS-01 owns its replacement; it does not yet supply the approved Origin/CSRF behavior.
- VPS-03's neutral migration directory/runner must apply historical migrations and `0004` before attachment routes run. Existing storage-specific tests apply that exact combination explicitly.
- Real multi-connection PostgreSQL completion races, runtime grants, a real browser/session flow, Compose volume ownership, backup/restore pairing and live VPS behavior remain unverified later gates. PGlite proves SQL constraints and single-connection transactions; the temporary local filesystem proves actual concurrent immutable publication.
- No VPS resources, production credentials/data, deployment, browser files, shared contracts, dependencies or lockfiles were changed.

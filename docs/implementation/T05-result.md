# T05 — persistence, authentication and minimum non-AI API

Base: integrated root baseline **`d9e062b`** (accepted C01 `5cae797`, C02 `da223c3`,
C03 `a01e650`). New isolated worktree `.worktrees/t05-core`, branch `agents/t05-core`.
Not merged.

Agent: user-launched **Opus 5, `claude-opus-5`** — verified against this environment's
reported identifier, as item 3 required. Manual handoff, no substitute, no subagents.

## Approved deviation: how the database evidence was obtained

The proposal lists "available local Postgres/Supabase or designated development project"
as a dependency. **This environment has none** — no `psql`, `postgres`, Docker, Podman or
Supabase CLI, and nothing listening on 5432 or 54322. With your explicit approval, T05 uses
**PGlite** (`@electric-sql/pglite`, added to `apps/api/package.json` only): PostgreSQL 18.3
compiled to WASM, running in-process.

That makes the following **real database evidence**, not doubles: the committed migration
genuinely applies, CHECK constraints genuinely fire, transactions genuinely roll back, and
every query is executed by a real Postgres planner.

**Two consequences, stated plainly:**

1. `npm install` rewrote the **root `package-lock.json`**, which the proposal reserves for
   the lead. That change is **left uncommitted** in the worktree for your reconciliation.
   Only `apps/api/package.json` is committed.
2. PGlite serialises everything on one connection, so **a genuine race between two database
   sessions cannot be produced here**. See "Concurrency: what is and is not proven" below.

## Delivered

| Area | Module |
| --- | --- |
| Private schema and migration | `supabase/migrations/0001_core_schema.sql` |
| Driver-agnostic DB boundary, PGlite + node-postgres adapters | `apps/api/src/db/client.ts` |
| Migration runner and user provisioning | `apps/api/src/db/migrate.ts` |
| Token verification and allowlist | `apps/api/src/auth/verify.ts` |
| Error envelope | `apps/api/src/core/errors.ts` |
| Row → wire mapping, derived verification state | `apps/api/src/core/mapping.ts` |
| Repositories, idempotency, compare-and-update | `apps/api/src/core/repository.ts` |
| `registerCoreRoutes(app, dependencies)` | `apps/api/src/core/routes.ts` |
| Tests | `apps/api/src/core.test.ts` |

`app.ts`, `index.ts` and the shutdown path are **untouched**, as required. The route module
is exported for the lead to register; it composes nothing global and takes every collaborator
through `CoreDependencies`.

## Endpoint contract coverage

All under `/api/v1`. Every route requires a verified, allowlisted actor.

| Route | Implemented | Notes |
| --- | --- | --- |
| `GET /me` | yes | signed-in user plus peer identity |
| `GET /reels` | yes | status filter, `overdue` flag, keyset cursor pagination |
| `GET /reels/:id` | yes | aggregate with hooks, attachments, meme ids, derived verification |
| `POST /reels` | yes | 201; atomic capture, all images, optional initial hook |
| `PATCH /reels/:id` | yes | version-checked scalar allowlist only |
| `POST /reels/:id/delete`, `/restore` | yes | version-checked soft delete |
| `POST /reels/:id/hooks` | yes | 201; transactional position allocation |
| `PATCH`, `DELETE /reels/:id/hooks/:hookId` | yes | individual, version-checked |
| `POST /reels/:id/current-export` | yes | increments the application-owned revision |
| `POST /reels/:id/verification` | yes | editor + peer-actor + revision checks |
| `POST /reels/:id/attachments/initiate` | yes | 201; bounded type and size |
| `POST /reels/:id/attachments/:attachmentId/complete` | yes | server-validated |

**Deliberately not implemented** (outside T05): `GET/POST /memes`, meme attach/detach,
kDrive folder routes, `/ai-runs/*`, programme search. Their *storage* exists
(`app.reel_memes`, `app.memes`, `programme_*`, `kdrive_folder`) so an already-defined
association round-trips, but no behaviour was added.

## T00 rules implemented, with the evidence

- **Atomic capture.** One Reel, every supported image as `pending`, and the optional initial
  hook in one transaction. A duplicate `attachmentId` mid-transaction rolls the whole thing
  back: the test asserts zero reels *and* zero attachments survive.
- **Idempotency.** The ledger is written in the same transaction as the domain change. The
  same operation and payload replays the **recorded** result — the test edits the Reel in
  between and still gets the original, proving it is not a fresh read. A reused id with a
  changed payload is `IDEMPOTENCY_CONFLICT`. A replayed patch does not bump the version twice.
- **Compare-and-update.** The guard is in the UPDATE's own `WHERE version = $expected`, and
  the version bumps in the same statement. A stale write returns 409 with `currentVersion`,
  and the winner's value survives.
- **Feed cover gate.** Evaluated on the *effective* updated Reel, so one patch may complete
  the cover and publish together. A refused publish makes **no partial write and no version
  bump**. `editing` and `ready` are unaffected.
- **Editing period.** Stamped on entry from another status; unchanged by re-saving editing,
  priority or editor changes; cleared on leaving; a new timestamp on re-entry. Attention
  thresholds 24/96/168h, and `overdue` counts only Reels *currently* in editing.
- **Export and verification.** Replacement increments the revision even for an identical URL.
  Verification requires a selected editor (`EDITOR_REQUIRED` 422), refuses the editor as
  their own verifier (`FORBIDDEN` 403), and refuses a stale revision (`EXPORT_CHANGED` 409).
  The historical record is retained so `outdated` stays derivable. No export ⇒
  `verificationState === null`, not `not_verified`.
- **Hooks.** Individually persistent with distinct ids, dense positions, mid-list insertion
  via a deferred unique constraint, and gap closure on removal. Editing wording leaves
  `source` and `createdAt` untouched. No singular hook field and no use-hook route exist.
- **Patch allowlist.** `hooks`, `verification`, `originalInput`, `version`, `currentExport`
  and `memeIds` are **refused** with `VALIDATION_ERROR`, not silently dropped.
- **Upload completion.** Validated against a server-side probe: absent object ⇒
  `UPLOAD_INCOMPLETE`; present but wrong size ⇒ `UPLOAD_INCOMPLETE`. A client assertion alone
  never reaches `ready`.
- **Nonexposed schema.** Everything lives in `app`; the test asserts the table list. No
  grants to `anon`/`authenticated`, and no privileged key is involved in a browser path.

## Authentication: implemented and not implemented

**Implemented and tested:** HS256 verification using `node:crypto` only — signature, issuer,
audience, `exp`, `nbf`, subject presence, and two-user allowlist membership. `alg: none`,
`RS256` and `HS512` are refused outright rather than verified with the wrong key material. A
correctly signed token for a third subject is still refused. Failure reasons are never echoed
to clients; every route answers `401 UNAUTHENTICATED` with the shared envelope.

**Not implemented — open gate:** asymmetric verification via a Supabase **JWKS** endpoint. A
project configured for RS256/ES256 needs its JWKS URL plus key-rotation handling, which I
cannot obtain or test here. `TokenVerifier` is an interface precisely so a JWKS verifier drops
in without touching route code. **If the target project uses asymmetric keys, T05's verifier
must be extended before it is deployed.**

**No account was created, no invitation sent, and no hosted auth setting altered.** The
`signHs256` helper is a local test/fixture utility; it issues nothing for production.

## Concurrency: what is and is not proven

The acceptance item is "concurrent expectedVersion writes cannot both overwrite".

**Proven here, against real Postgres:** two writes using the same `expectedVersion` — the
first UPDATE matches one row and bumps the version; the second matches **zero rows** and
changes nothing. The test asserts both, plus that the winner's value survives and exactly one
version bump occurred. Because the guard is inside the UPDATE's `WHERE`, this is a property of
the statement, not of application-level sequencing.

**Not proven here:** two genuinely concurrent *sessions* racing that row. PGlite has one
connection. The `pgPoolDatabase` adapter gives each transaction its own connection so the
multi-session case works by construction, but **it has not been executed** — there is no
server to execute it against. This stays **UNVERIFIED** and needs a real Postgres.

## Implementation choice the lead should confirm

T00 says the list uses "fixed product sorting" without pinning the order. I implemented
**urgent → normal → evergreen, then newest first, then id** for determinism, with keyset
pagination over that exact tuple. This is an implementation choice, not an inferred product
decision — please confirm or correct it.

One bug worth recording because a test caught it: my first keyset predicate used a row
comparison `(rank, created_at, id) < (...)`, which is wrong for a *mixed*-direction sort and
made the first row repeat on page two. Each tie level is now compared in its own direction,
and the test walks two pages asserting no repeats or gaps.

## Commands

```sh
cd .worktrees/t05-core
npm install            # adds @electric-sql/pglite; rewrites the ROOT lockfile (left uncommitted)
npm run build          # clean
npm run typecheck      # clean, all four workspaces
npm test               # 46/46 pass (11 pre-existing C01 + 35 new T05)
```

The 35 T05 tests cover migrations and idempotent re-application, schema constraints, the auth
boundary, atomic capture and rollback, idempotent replay and conflict, optimistic
concurrency, the publish gate, the editing period, the patch allowlist, hooks, export and
verification, attachment validation, soft delete, list ordering/filtering/pagination, and the
HTTP surface including the unauthenticated envelope for all 14 routes.

## Limitations and open gates

- **Root `package-lock.json` is modified and uncommitted.** Yours to reconcile; I did not
  commit it.
- **No hosted Supabase was contacted.** Auth is proven against locally signed tokens, not
  against a real Supabase-issued JWT. Issuer and audience are configuration inputs.
- **JWKS/asymmetric verification is absent** (above).
- **Supabase Storage was not exercised.** `StorageProbe` is injected and mocked in tests; the
  real bucket, its private ACL and signed-upload flow are unverified.
- **Multi-session concurrency unverified** (above).
- **`registerCoreRoutes` is not wired into `app.ts`** — deliberately the lead's step.
- **No production migration or deployment.** Migrations ran only against disposable
  in-process databases.
- Environment additions T08/the lead will need, proposed not applied: `SUPABASE_JWT_SECRET`,
  `SUPABASE_JWT_ISSUER`, `SUPABASE_JWT_AUDIENCE`, `DATABASE_URL`, and the two allowlisted user
  UUIDs. I did not touch `.env.example` — it is outside my allowlist.

Stopping at this handoff. No other task started, nothing merged, no next batch dispatched.


---

# T05 follow-up — T08 blockers resolved (2026-09-14)

Base: T05 `ea81fae`. Requested after T08 reported five missing backend capabilities.
Agent: user-launched Opus 5 (`claude-opus-5`).

## The five blockers

| # | Blocker | Status |
| --- | --- | --- |
| 1 | Core routes not registered in `app.ts` | **Done.** `buildApp({ core })` registers them before the static plugins and not-found handler, so a core route is matched by its own handler instead of falling through to the SPA fallback. Omitting `core` yields the static/health-only app, so routes are never half-registered against a missing database — C01's shutdown and SPA tests are unaffected and still pass. |
| 2 | `GET /reels?visibility=deleted` did nothing | **Done.** `visibility` is `active` (default) or `deleted`; an unknown value is refused with `VALIDATION_ERROR` rather than silently returning the wrong set. `GET /reels/:id?includeDeleted=true` lets the restore surface load a deleted Reel while an ordinary detail request still 404s. |
| 3 | Attachment initiation returned no upload target | **Done in code, live UNVERIFIED.** `initiateAttachment` now mints a signed upload inside the idempotent body, so a replay returns the original URL instead of issuing a second one. The response carries `{ uploadUrl, method, headers, expiresAt }`. |
| 4 | No asymmetric Supabase JWKS verification | **Done, with real evidence.** `src/auth/jwks.ts` verifies RS256 and ES256 against a JWKS document, with caching, rotation on unknown `kid`, and a refetch floor. |
| 5 | No real Storage adapter/configuration | **Done in code, live UNVERIFIED.** `src/core/storage.ts` has a Supabase adapter and an in-memory one; `src/core/config.ts` selects them from environment. |

## What is real evidence, and what is not

**Real.** The JWKS path is exercised with genuinely generated RSA and EC keypairs, a
served JWKS document and real signatures — `node:crypto` does the signing and
verification, so no part of the crypto is stubbed. Tests cover: valid RS256, valid
ES256 (raw `r||s`, which if mishandled rejects every valid EC token), tampered
payload, foreign key with the same `kid`, algorithm confusion (`HS256`/`none`/`RS512`
refused against a public key), a key published for one algorithm refusing another,
issuer/audience/expiry/`nbf`/subject/allowlist enforcement, rotation pickup, and that
repeated unknown-`kid` tokens cannot be used as a JWKS fetch amplifier.

`visibility=deleted`, `includeDeleted`, the signed-upload response shape, replay
behaviour and `app.ts` registration are all verified against real PostgreSQL via
PGlite and real Fastify injection.

**Not real.** No Supabase project exists, so the Supabase Storage adapter has never
run against one. Its request shapes follow the documented signed-upload flow and are
unit-tested against an injected transport, including that a sizeless info response is
an error rather than a silent zero — a zero would make the size-mismatch check pass by
accident. **Treat those endpoint shapes as unverified configuration.** Likewise, JWKS
verification has never met a specific project's key set; issuer, audience and the
JWKS URL are configuration inputs.

## Configuration required

`src/core/config.ts` refuses ambiguous or partial configuration rather than
degrading quietly:

- `SUPABASE_JWT_ISSUER`, `SUPABASE_JWT_AUDIENCE` — both mandatory.
- Exactly one of `SUPABASE_JWKS_URL` or `SUPABASE_JWT_SECRET`. Both is an error,
  because accepting either signature type widens the trust boundary invisibly.
- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_STORAGE_BUCKET`, all three
  or none. A partial set is an error: it would make uploads appear to work while
  storing nothing. `STORAGE_DRIVER=memory` is the explicit development opt-in.
- `APP_ALLOWLIST` as `NOXAVA:<uuid>,SZRON:<uuid>` — exactly two distinct users.

`describeConfig()` reports what is configured without printing any value.

The database driver is deliberately NOT chosen here: `Database` is injected, so `pg`
stays out of this package and the composition root keeps that decision. C01's
shutdown path is untouched.

## Verification

```sh
cd .worktrees/t05-core
npm run typecheck   # clean
npm test            # 65/65 pass (11 pre-existing C01 + 54 T05)
```

## Still open

- **Root `package-lock.json` remains modified and uncommitted** (pglite from the
  original T05). Still the lead's to reconcile.
- Supabase Storage and project JWKS remain live-UNVERIFIED, as above.
- Multi-session concurrency still needs a real Postgres server; PGlite is
  single-connection.

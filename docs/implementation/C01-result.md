# C01 — scaffold corrections: result

Base: T01 `ce107c3` (branch `agents/t01-scaffold`). Agent: Claude (Sonnet 5) in Claude Code, substituted for the originally named `gpt-5.6-luna` with the user's explicit approval (that model/agent is not available in this environment). Scope: R01 findings F2–F5 only. No feature routes, authentication, worker job lifecycle, or shared health-schema were added.

## F2 — non-GET/unknown-method API errors

`apps/api/src/app.ts`: replaced the GET-only `app.get('/*', ...)` catch-all with `app.setNotFoundHandler`, which Fastify invokes for any unmatched method/path. Any request under `/api` or `/api/*` that doesn't match a real route now returns the shared `ErrorResponse` envelope (`{ error: { code: 'NOT_FOUND', message, retryable: false } }`) with status 404, for every method (GET/POST/PATCH/DELETE/OPTIONS/HEAD). HEAD responses send no body, matching HTTP semantics.

Regression test: `apps/api/src/health.test.ts` — `unknown API paths return the shared error envelope for every method (F2)`.

## F3 — missing build assets vs. SPA navigation

Previously, any non-API path — including a request for a missing hashed JS/CSS file — fell through to `reply.sendFile('index.html')` and returned 200 HTML.

Fix: Vite emits hashed build output under `/assets/`. A second `@fastify/static` registration is scoped to that prefix (`root: <webRoot>/assets`, `prefix: '/assets/'`, `decorateReply: false` to avoid a duplicate-decorator conflict with the root registration). Real files under `/assets/*` are served with their correct MIME type and 200; when the file doesn't exist, `@fastify/static` calls `reply.callNotFound()`, which lands in the same `setNotFoundHandler` and is answered with a plain 404 (no HTML). Everything else that isn't `/api*` or `/assets/*` still falls through to the SPA `index.html`, so real navigation (e.g. `/reels/example`) is unaffected. Deliberately avoided a "does the path contain a dot" heuristic (per the lead's R01 note) — using the actual build output directory boundary instead, which can't misclassify a legitimate future navigation path.

Non-GET/HEAD requests to non-API, non-asset paths now also 404 rather than being handed `index.html`, since only browser navigation should receive the SPA shell.

Regression test: `apps/api/src/health.test.ts` — `missing hashed build assets 404 while real assets serve with correct MIME (F3)`.

## F4 — bounded, repeat-safe API shutdown

`apps/api/src/index.ts`: added `SIGTERM`/`SIGINT` handlers that call `app.close()`.

- **Repeat-safe**: a `shuttingDown` boolean guard makes a second/third signal a no-op instead of re-entering `close()` (which would otherwise throw or race).
- **Bounded**: a `setTimeout` (default 10s, override via `SHUTDOWN_TIMEOUT_MS`) force-exits with code 1 if `close()` doesn't resolve in time; it's `unref()`'d so it never keeps the process alive on its own and is cleared as soon as `close()` settles.
- **In-flight requests**: `app.close()` stops the listener from accepting new connections but lets already-accepted sockets finish; an already-established connection completes and receives its response before the process exits.
- **Close errors**: a rejected `close()` is caught, logged, and exits with code 1 instead of throwing an unhandled rejection.

Regression tests (new file `apps/api/src/shutdown.test.ts`, spawns the real compiled `dist/index.js` as a child process — this is the only way to exercise actual OS signal delivery):
- `SIGTERM finishes an already-accepted in-flight request, tolerates repeated signals, and exits within the bounded deadline (F4)` — opens a raw TCP socket, waits for the connect callback and writes the HTTP request line *before* returning, so the request is provably already accepted by the time three back-to-back `SIGTERM`s are sent; asserts the response is a valid 200, the process exits 0, and wall-clock elapsed stays under the configured deadline.
- `a connection attempt after shutdown has begun is refused, not silently accepted` — confirms new connections are rejected once shutdown starts (i.e. stop-accepting-new-work is real).
- `SIGINT triggers the same bounded, repeat-safe shutdown path` — same guard/path via the other signal, with two back-to-back signals.

Honesty note: the "exceeds-deadline → forced exit" branch is implemented (see above) but not integration-tested — doing so would require an artificial hang inside the app, which would be a feature addition outside C01's bounded scope. It was reviewed by inspection only.

## F5 — real contract-consumer dependency

- `apps/api/package.json`: added `"@szronox/contracts": "0.1.0"` to `dependencies` (was previously imported nowhere and undeclared).
- `apps/api/src/app.ts`: the error-envelope helper is now typed against the real `ApiError`/`ErrorResponse` types imported from `@szronox/contracts` (type-only import; no invented parallel type).
- `apps/web`: the dependency was already declared in `package.json` but nothing in `apps/web/src` actually imported from it. Added `apps/web/src/contracts-check.ts`, a narrowly scoped file (one type-only import, one type guard function) whose only purpose is to fail `tsc` if `@szronox/contracts` stops resolving via its real published export. It is included in the existing `apps/web/tsconfig.json` glob (`src/**/*.ts`) — no new build wiring needed.
- `package-lock.json`: regenerated via `npm install` at the repo root; the API workspace entry now lists `@szronox/contracts`, resolved to the existing `packages/contracts` workspace symlink (`node_modules/@szronox/contracts -> ../../packages/contracts`) — i.e. both API and web consume the package via its real `exports` field, not a relative source-path workaround.
- No worker contract consumption was added (explicitly deferred per the lead's direction — worker can wait for actual job types).

## Commands run and results

All from the repo root of this worktree, after a clean `rm -rf apps/*/dist packages/contracts/dist`:

```
npm install
# up to date, audited 152 packages; lockfile diff: +1 line (@szronox/contracts under apps/api)

npm run build
# @szronox/contracts, @szronox/web (vite build), @szronox/api, @szronox/worker all succeed

npm run typecheck
# @szronox/contracts, @szronox/web, @szronox/api, @szronox/worker all pass with zero errors

npm test
# node --test dist/*.test.js
# tests 8, pass 8, fail 0 (health.test.js x5, shutdown.test.js x3)
```

Test suite ran green across 4 repeated invocations to check for flakiness in the new shutdown tests (raw-socket approach is deterministic — no reliance on undici keep-alive pooling, which was tried first and found to open a fresh connection per call, racing shutdown nondeterministically; that approach was discarded).

No remote CI was run (none exists in this repo yet; not part of C01's file allowlist). No live browser/Android/device verification — out of scope for this backend-only correction batch.

## Changed files

- `apps/api/package.json` — added `@szronox/contracts` dependency; test script now globs `dist/*.test.js`.
- `apps/api/src/app.ts` — F2/F3/F5 fix (see above).
- `apps/api/src/index.ts` — F4 fix (see above).
- `apps/api/src/health.test.ts` — F2/F3 regression tests added.
- `apps/api/src/shutdown.test.ts` — new file, F4 regression tests.
- `apps/web/src/contracts-check.ts` — new file, F5 narrow type-consumption check.
- `package-lock.json` — regenerated (1 line added).
- `docs/implementation/C01-result.md` — this report.

Not touched: shared contract source (`packages/contracts/src/**`), worker code, root scripts/config, design assets, other task reports/spikes, `AGENTS.md` (a pre-existing uncommitted modification to `AGENTS.md` was already present in this worktree before this session started; it was left untouched and is not part of this commit).

## Handoff

Unmerged, on `agents/t01-scaffold`. Awaiting lead review. Commit ID reported below after creation.

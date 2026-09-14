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

Honesty note (original): the "exceeds-deadline → forced exit" branch is implemented but not
integration-tested — doing so would require an artificial hang inside the app.

**Closed by C04 (2026-09-14):** the branch is now integration-tested through an env-gated
test-only seam (`API_TEST_SEAM`, `apps/api/src/test-seam.ts`), which nothing in production
sets and which registers nothing when absent. Both the deadline branch and the close-error
branch are exercised and assert their reported stderr output. See the C04 section below.

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

**Corrected by C04 (2026-09-14):** CI **is** configured — `.github/workflows/ci.yml` exists
(added in T01 `b3e39d8`) and runs `npm ci`, `build`, `typecheck`, `test` on push and pull
request. The original statement that "none exists in this repo yet" was wrong. What is true
is that **remote CI execution remains unverified**: the workflow has never been observed
running, and C04 did not trigger it. No live browser/Android/device verification — out of scope for this backend-only correction batch.

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


---

# C04 follow-up (2026-09-14)

Base: **`75451f5`**. Agent: user-launched Opus 5 (`claude-opus-5`), manual handoff, approved
as a substitute for this pass. C01 itself was implemented by an approved Sonnet 5 substitute
for the originally named `gpt-5.6-luna`; that attribution is unchanged.

Input: the C04 runthrough items 1–5 for C01. Scope stayed inside `apps/api/src/**`,
`apps/web/src/contracts-check.ts` and this file.

## 1. Reproduced C01's claims independently

All verified against `75451f5` before changing anything: clean `build`/`typecheck`, 8/8
tests, unknown-API-method envelopes across GET/POST/PATCH/PUT/DELETE/OPTIONS/HEAD (plus
method-mismatch on an existing route), missing `/assets/*` 404 with real assets keeping their
MIME, SPA navigation intact including dotted paths, and contracts resolving through the real
package `exports` map with no `paths`/`baseUrl` alias. Hiding
`packages/contracts/dist/index.d.ts` makes both `apps/api` and `apps/web` fail `tsc`
(TS7016) and restoring it makes them pass, so the consumption check is load-bearing.

## 2. Shutdown evidence strengthened

The previous suite equated a client TCP connect+write with server handler entry. It does not:
the bytes can sit in a socket buffer while the signal arrives first.

- **Handler entry is now proven.** The test-only seam writes
  `TEST_SEAM_HANDLER_ENTERED` to stdout *from inside the handler*; the test waits for that
  marker before signalling.
- **Refusal is asserted during shutdown, not after exit.** With a held request keeping
  shutdown open, the test asserts `exitCode === null` and that a brand-new TCP connection is
  refused. The old test waited for exit first, so it only showed that an exited process
  refuses connections.
- **Draining is asserted on the same request**, which returns 200 after the signal.

## 3. Harness bounded

- Exit is observed from spawn, so nothing depends on attaching a listener before or after a
  signal, and an already-exited child resolves immediately.
- Every wait (`freePort`, readiness, stdout marker, response, exit) is bounded; a regression
  fails instead of hanging the suite.
- Every child is reaped in `finally`, including on assertion failure. Four consecutive runs:
  11/11 with no leaked `dist/index.js` processes.
- The deadline and close-error branches are driven through the env-gated seam, not a
  production endpoint. A test asserts the seam is absent unless enabled.

## 4. Unsound type guard removed

`contracts-check.ts` exported `isErrorResponse`, which accepted `{ error: null }` as an
`ErrorResponse` although `ApiError` is not nullable. Nothing consumed it — it existed to force
an import — so an unsound validator sat in the source waiting to be believed. It is replaced
by type-level assertions (`ErrorResponse['error']` is exactly `ApiError`; `ApiError['code']`
is exactly `ErrorCode`) plus one concrete typed value. These fail `tsc` for exactly the
intended reason and ship no runtime validator that lies.

## 5. Failure paths are no longer silent

The app is built with `logger: false`, so `app.log.error(...)` was a no-op and **both**
shutdown failure branches produced no output — leaving exit code 1 as the only signal,
ambiguous between a hung close and a close error. Both now also write to `process.stderr`,
and the tests assert the specific message.

## New finding for the lead — keep-alive in-flight shutdown

Discovered while building the handler-entry test, and **pinned in a test rather than
silently changed**.

When a request is still in flight as SIGTERM arrives over a **keep-alive** connection (Node's
`fetch` default), the socket returns to the keep-alive pool *after* `close()` has begun and is
not reclaimed. Shutdown therefore waits out the full deadline and exits **1**. The request
itself completes normally — draining works.

Measured directly against Fastify 5.12.4:

| `forceCloseConnections` | `close()` | in-flight request |
| --- | --- | --- |
| unset (current) | hangs past 2s | **completes (200)** |
| `'idle'` | hangs past 2s | **completes (200)** |
| `true` | returns in ~5ms | **aborted** |

So no single Fastify option gives drain-then-reclaim. The current behaviour is the safe side
of the trade-off: it never cuts off an in-flight response. The costs are a non-zero exit and a
full deadline wait whenever a deploy catches a keep-alive request mid-flight, which an
orchestrator may read as a crash.

Choosing a drain-then-reclaim strategy (for example polling
`server.closeIdleConnections()` after draining) is a shutdown-design decision with real risk
of cutting requests off, so it is **left to the lead** rather than taken here. A test now
documents the current behaviour so it cannot regress unnoticed.

## Commands

```sh
npm run build        # clean
npm run typecheck    # clean
npm test             # 11/11 pass (was 8), stable across 4 runs, no leaked children
```

## Status

| Item | Status |
| --- | --- |
| 1 Reproduce C01's claims | **PASS**, independently verified |
| 2 Shutdown evidence (handler entry, drain, refusal during shutdown) | **corrected** |
| 3 Bounded harness, seam-driven branches, child cleanup | **corrected** |
| 4 Misleading type guard | **removed**, replaced by compile-time assertions |
| 5 CI report | **corrected**: configured, remote execution unverified |
| Deadline branch (previously untested) | **now integration-tested** |
| Close-error branch | **now integration-tested** |
| Keep-alive in-flight shutdown | **new finding**, pinned in a test, decision left to the lead |
| Remote CI execution | **UNVERIFIED** — not triggered |

# R01 — bounded technical review of T00–T02

Report only. No source, contract, dependency or baseline file was modified. The single
file written is this one, per R01 item 7.

## Scope decision (read first)

R01 as written covers T00–T03. **The user explicitly narrowed this run to T00, T01 and
T02, excluding T03.** Reason: T03 commit `cb41abd` was authored by this same Opus session,
and R01 item 4 already records that "Opus reviewing its own T03 changes is not independent
acceptance." Reviewing it here would have produced self-acceptance wearing a reviewer's
hat.

Consequently **R01 review priority 5 — verification of T03's Gemini documentation claims
against official Google sources — was also not performed**, because it is entirely T03
scoped. T03 remains at the status the lead already recorded: delivered, not lead-accepted.
It needs an independent reviewer. This is the single largest gap in this report and is not
a finding about T03's quality either way.

## Reviewed revisions and environment

| Item | Value |
| --- | --- |
| Review date | 2026-09-14 |
| Reviewer | User-selected Opus session. Interface-reported identifier: **Opus 5 (`claude-opus-5`)** |
| Root | `/Users/kubabilski/Desktop/SzroNox`, branch `master`, HEAD `2c411e5` |
| Root dirty (at end of review) | `AGENTS.md`, `docs/implementation/T00-contracts.md`, `docs/implementation/tasks.md`, `packages/contracts/src/index.ts` modified; `R01-opus-review-handoff.md`, `T03-opus-handoff.md` untracked |
| T01 | `.worktrees/t01-scaffold`, branch `agents/t01-scaffold`, HEAD **`ce107c3`** (expected `ce107c3` ✓), dirty: `AGENTS.md` only |
| T02 | `.worktrees/t02-android-share`, branch `agents/t02-android-share`, HEAD **`bafffec`** (expected `bafffec` ✓), dirty: `AGENTS.md` only |
| T03 | `.worktrees/t03-gemini`, branch `agents/t03-gemini`, HEAD **`cb41abd`** (expected `cb41abd` ✓), dirty: `AGENTS.md` only — **not reviewed** |
| Node | v25.9.0 |

All three worktrees were present and matched their expected commits exactly. The only dirty
path in each is the lead-owned `AGENTS.md`, which R01 states is intentional.

**Authoritative-source note.** The root working copies of `T00-contracts.md`, `tasks.md` and
`packages/contracts/src/index.ts` are **uncommitted**. Per R01 those root files are
authoritative, so this review reads the working copy, not `HEAD`. Worktree copies of T00 are
older snapshots and were ignored, per the `tasks.md` line that current authorization
supersedes worktree snapshots.

**The root contracts changed during this review.** At the start of the session, root showed
only `AGENTS.md`, `T00-contracts.md` and `tasks.md` as modified. By the end,
`packages/contracts/src/index.ts` was also modified, and `T00-contracts.md` had gained an
entire new section — the frozen feed-cover amendment (lines 22–36) — that was not present
when I first diffed it. I re-read the authoritative T00 in full and re-verified every T00
finding against the current text before finalising. All line references below are to the
current working copy. One finding (F8) was *strengthened* by the re-read; none were
invalidated.

**Recommendation: commit these root files.** A review — and any agent reading T00 — currently
depends on uncommitted working-copy state that is changing underneath it. This is a process
risk independent of any finding in this report.

---

## Findings

Severity ordered. Confirmed defects first, then questions and future hardening.

### Confirmed defects

---

#### F1 — Android installability is at risk: manifest has no 192×512 raster icon
**Severity: high** · T02 · `spikes/android-share/manifest.webmanifest:10-12`

**Trigger.** Install the diagnostic PWA on Android Chrome, which is step 1 of the README's
required procedure and a precondition for every later step.

**Detail.** The manifest declares exactly one icon:

```json
{ "src": "icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable" }
```

Chromium's documented installability criteria require "an `icons` property that includes a
**192x192 px and a 512x512 px** icon"
([installable-manifest](https://developer.chrome.com/docs/lighthouse/pwa/installable-manifest),
accessed 2026-09-14). There is also a filed Chromium issue reporting that **installation
fails when an SVG asset has `sizes` set to `"any"`**
([issue 40925759](https://issues.chromium.org/issues/40925759)).

**Impact.** If the PWA will not install, it never appears in the Android share sheet, and
the entire T02 acceptance gate — which is already UNVERIFIED — fails for a reason unrelated
to the capture logic being tested. The device session would burn on a manifest problem
rather than on the behaviour under test.

**Evidence.** Documentation-backed plus local inspection. `icon.svg` is 212 bytes; a
programmatic check confirms no icon entry declares a 192 or 512 size. Not reproduced on a
device — no Android hardware available here.

**Uncertainty, stated honestly.** Chromium does support SVG icons, and the docs specify
pixel dimensions without explicitly rejecting `sizes: "any"`. I could not determine from
primary documentation alone whether this specific manifest installs on current Chrome. The
risk is real and cheap to eliminate; I am not asserting certain failure.

**Smallest correction.** Add two raster icons and keep the SVG:

```json
"icons": [
  { "src": "icon-192.png", "sizes": "192x192", "type": "image/png" },
  { "src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" },
  { "src": "icon.svg", "sizes": "any", "type": "image/svg+xml" }
]
```

---

#### F2 — Non-GET 404s bypass the T00 error envelope
**Severity: medium** · T01 · `apps/api/src/app.ts:14-18`

**Trigger.** Any request to an unknown route with a method other than GET.

**Detail.** The T00 envelope is produced only inside the `app.get('/*')` handler. Every
other method falls through to Fastify's default not-found handler. Observed directly:

```
GET    /api/v1/missing  -> {"error":{"code":"NOT_FOUND","message":"Route not found","retryable":false}}
POST   /api/v1/missing  -> {"message":"Route POST:/api/v1/missing not found","error":"Not Found","statusCode":404}
DELETE /api/v1/reels/1  -> {"message":"Route DELETE:/api/v1/reels/1 not found","error":"Not Found","statusCode":404}
```

**Impact.** `T00-contracts.md:91` mandates `{ error: { code, message, retryable, … } }` and states the
web client "maps machine codes to Polish". A client reading `error.code` gets `undefined`
for every non-GET 404. This is the *common* case, not an edge case: of the T00 route
surface, the large majority are POST/PATCH/DELETE. The scaffold therefore encodes the
envelope for the minority of routes and silently breaks it for the rest.

**Evidence.** Observed, via `app.inject` against the built `apps/api/dist/app.js`.

**Smallest correction.** Move the envelope into `app.setNotFoundHandler`, and restrict the
SPA fallback to GET/HEAD navigations rather than using a catch-all route to express it.

---

#### F3 — Missing static assets are served the SPA shell with HTTP 200
**Severity: medium** · T01 · `apps/api/src/app.ts:13-18`

**Trigger.** Request any non-API path that does not exist on disk.

**Detail.** `@fastify/static` is registered with `wildcard: false`, and the `GET /*` handler
unconditionally returns `index.html` for every non-`/api/` path. Observed:

```
GET /assets/does-not-exist.js  -> 200 text/html
GET /favicon.ico               -> 200 text/html
GET /assets/index-B--SE5qN.js  -> 200 application/javascript   (real asset, correct)
```

**Impact.** This is the classic stale-deploy failure. After a release, a browser holding a
cached `index.html` requests an old hashed chunk; instead of a clean 404 it receives HTML
with `content-type: text/html`, and the module load fails with a MIME-type error that gives
no indication the real cause is a stale document. It also masks genuine asset-pipeline
breakage during development.

**Evidence.** Observed, via `app.inject`.

**Smallest correction.** In the fallback, return the 404 envelope when the pathname has a
file extension or sits under the build's asset directory; serve `index.html` only for
extensionless navigation paths.

---

#### F4 — The API has no graceful shutdown; the worker does
**Severity: medium** · T01 · `apps/api/src/index.ts:1-12` (worker: `apps/worker/src/index.ts:4`)

**Trigger.** Send SIGTERM to the API process, as any container orchestrator does on deploy
or restart.

**Detail.** `apps/api/src/index.ts` calls `app.listen` and installs no signal handler.
`app.close()` is never called outside tests. The worker, by contrast, does handle SIGTERM.
The asymmetry suggests the API case was simply missed — R01's own briefing mentions worker
shutdown verification but not the API's.

**Impact.** On every deploy, in-flight HTTP requests are terminated rather than drained.
T00's mutation contract is built on atomic compare-and-update with persisted operation IDs,
so the database should not be left inconsistent; the cost is failed client requests during
routine restarts, which the client cannot distinguish from a genuine error. The risk grows
once real mutation routes exist.

**Evidence.** Observed by inspection; confirmed by grep that the only `app.close()` call
sites are in `health.test.ts`.

**Smallest correction.**

```ts
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => { void app.close().then(() => process.exit(0)); });
}
```

---

#### F5 — `@szronox/contracts` has no consumer, so "typecheck shared types" is only trivially satisfied
**Severity: medium** · T01 · `apps/api/package.json:12-19`, `apps/worker/package.json:7`, `apps/web/package.json:7`

**Trigger.** `npm run typecheck` passes while nothing anywhere imports the contracts package.

**Detail.** Confirmed by grep: no `.ts`/`.tsx` file in the workspace imports
`@szronox/contracts`. `apps/web` declares it as a dependency but never imports it;
`apps/api` and `apps/worker` do not declare it at all. It nonetheless resolves from
`apps/api` — but only because npm workspaces symlink every package into root
`node_modules`:

```
node_modules/@szronox/contracts -> ../../packages/contracts
```

**Impact.** T00's acceptance criterion is "T01 must typecheck shared types"
(`T00-contracts.md:128`). Today `typecheck` proves only that `packages/contracts` compiles
in isolation. It does not prove the package is *consumable*: a broken `exports` map, a
missing build output, or a NodeNext resolution failure in a consumer would all pass CI. The
API — the component that actually implements the wire contract — has no compile-time tie to
it, so server/client drift cannot be caught by the type system. Resolution working via
hoisting rather than declaration is exactly the kind of accident that breaks when the
package layout changes.

**Evidence.** Observed. `node -e "import('@szronox/contracts')"` from `apps/api` resolves
and reports 0 runtime exports — correct for a types-only package, and equally consistent
with the package being entirely unexercised.

**Smallest correction.** Declare `"@szronox/contracts": "0.1.0"` in `apps/api` (and
`apps/worker` when it gains job types), and have the health route's return type reference a
contracts type so the dependency is load-bearing rather than decorative. A one-line type
import is enough to make CI prove resolvability.

---

#### F6 — The transaction double does not serialize, so concurrent promotion safety is inherited, not demonstrated
**Severity: medium** · T02 · `spikes/android-share/test/storage.test.js:5-36`, `storage.js:30-48`

**Trigger.** Two promotions of the same capture ID overlapping — two tabs, or a reload
racing the initial promotion.

**Detail.** `promoteRaw` performs a read-modify-write inside a single `readwrite`
transaction, which is the correct design: real IndexedDB serializes overlapping `readwrite`
transactions on the same object store, making the promotion idempotent. The tests, however,
run against `controlledDb`, a hand-written double that models commit-on-completion but
**not** scope serialization. I ran the *unmodified* `promoteRaw` against that double with
two concurrent promotions:

```
concurrent readwrite transactions opened by the double: 2
final accountId after both committed: B
```

Both promotions read the raw record and both wrote; the second clobbered the first. Real
IndexedDB would not permit this interleaving — so the double is *weaker* than the real
implementation, and no test exercises concurrency at all.

**Credit where due.** The suite is not merely decorative. I applied an atomicity-only
regression — splitting the read and the write into two separate transactions, keeping the
synchronous `CAPTURE_ID_CHANGED` throw intact — and 2 of the 12 tests failed. The suite does
pin the single-transaction structure. The README also already labels this row "Deterministic
IndexedDB transaction double".

**Impact.** The concurrency guarantee rests entirely on IndexedDB's documented semantics.
That reasoning is sound, but it is unverified against any real implementation, and the
double cannot be strengthened into evidence without modelling scope locking. This must not
be reported as a passing concurrency check.

**Evidence.** Observed, in a scratchpad copy; the worktree was not modified.

**Smallest correction.** No code change required. Add one line to the README evidence table
making explicit that *concurrent* promotion is unverified, distinct from the reopen/replay
row that the double does cover, and move it to the browser-verified gate.

---

#### F7 — Service-worker registration failure is reported as an offline problem, not as share capture being unavailable
**Severity: medium** · T02 · `spikes/android-share/app.js:58`

**Trigger.** Any browser where `navigator.serviceWorker.register(…, { type: "module" })`
rejects.

**Detail.** Registration failure sets the status text to "Nie udało się uruchomić obsługi
offline." The manifest continues to advertise `share_target`, and the page's own capture
form keeps working, so the app presents as functional. ES modules in service workers are
Chrome/Edge 91+ and Safari 16.4+; Firefox support is not established
([web.dev, ES modules in service workers](https://web.dev/articles/es-modules-in-sw),
accessed 2026-09-14).

**Impact.** Share capture depends *entirely* on the service worker: it is what intercepts
`POST /share-target`. If registration fails, a share silently leaves the app — the POST
reaches the network and 404s (see F8). The user sees a message about offline support while
the actually-broken capability is the one the spike exists to test. This is the "explicit
offline gate" R01 asks about: the failure is detected but not gated.

**Evidence.** Observed by inspection plus documentation. Not reproduced in a browser — no
browser verification was possible here.

**Smallest correction.** On registration failure, set a message naming the real consequence
(share capture unavailable in this browser) and disable the share-dependent affordances,
rather than describing it as an offline-support problem.

---

### Cross-task contract drift

---

#### F8 — `CaptureInput` models one image; T02 captures many
**Severity: medium** · T00 ↔ T02 · `packages/contracts/src/index.ts:93-96` and
`T00-contracts.md:103` vs `spikes/android-share/share-contract.js:31-52`,
`manifest.webmanifest:21-23`, `index.html:8`

**Detail.** T00's capture contract is a single-image discriminated union:

```ts
| { kind: 'image'; attachmentId: Id; fileName: string; mimeType: string; byteSize: number; text?: string }
```

The prose agrees and is singular throughout — `T00-contracts.md:103`: "the client supplies
**an attachment UUID and descriptor** in CreateReelRequest. The server atomically creates the
Reel plus **a pending attachment record**". So this is not a type that merely lags the
document; both state one image.

T02 is built throughout for *N* images: the manifest declares a `files` entry, the form
input carries `multiple`, `sw.js:15` allocates `attachmentIds: images.map(...)`, and
`normalizeShare` produces `capture.attachments` as an array. T02's README states "each
supported image descriptor supplies the attachment UUID for atomic Reel plus
pending-attachment creation" — plural. `T00-contracts.md:99` separately requires "Preserve
mixed supported inputs", which T02 reasonably read as including multiple images.

**Impact.** These cannot both be right. A multi-image Android share either loses every
attachment after the first, or requires a contract change. This is exactly the cross-task
drift R01 asked for, and it is a contract decision the lead owns — T02 cannot resolve it
unilaterally, and neither should I.

**Evidence.** Observed by inspection of both sides.

**Smallest correction — lead's decision, two options.** Either widen `CaptureInput`'s image
variant to carry an array of attachment descriptors, or constrain T02 to accept a single
image and classify the rest as an explicit rejection reason. I recommend the former:
`T00-contracts.md:103` already describes an atomic "Reel plus pending attachment" creation
that generalises to N with no new concepts, and Android genuinely sends multi-image shares.

---

### Questions for the lead — not defects

---

#### Q1 — Expected verifier is undefined when `editorId` is null
T00 · `T00-contracts.md:14-16`, `packages/contracts/src/index.ts:71,76-77`

T00 says "The verifier is the other user relative to `editorId`" and, separately, "Editor
may be null before editing." `Reel.editorId` is `Id | null`. With a null editor there is no
defined "other user", yet `verification` requires "the actual signed-in expected verifier".
Nothing states that having a `currentExport` implies a non-null `editorId`. Either the
implication should be stated, or the null-editor case needs a defined verifier rule. Low
practical risk today; it will become a real branch when verification is implemented.

---

#### Q2 — The three-hook-addition cap exists only in prose
T00 · `T00-contracts.md:44` vs `packages/contracts/src/index.ts:134,171`

`DevelopResult.hookAdditions` and `AiResultMap.generate_hooks` are both `string[]` with no
expressed bound, while T00 prose (line 44) caps additions at three per successful call. Every consumer
must re-derive the limit from the document, and nothing stops a handler from appending more.
I hit this concretely in T03: the inherited implementation had the bound set to 5, which I
corrected to 3 against the T00 text. Consider exporting a named constant from
`packages/contracts` so the bound has one definition.

---

#### Q3 — Opracuj auto-appends hooks while every other field needs explicit apply
T00 · `T00-contracts.md:45,89`

`POST /ai-runs/:id/apply` is explicit and selective and "excludes hooks", while a successful
run "appends its hook additions once" server-side. Per `T00-contracts.md:45` this is intentional —
clicking Opracuj *is* the authorization. Flagging only to confirm the asymmetry is
deliberate, since it means hook text reaches the Reel without a review step that every other
generated field requires. I am not proposing a redesign.

---

#### Q4 — `POST /share-target` 404s at the server when the worker is inactive
T01 ↔ T02 · `apps/api/src/app.ts:14-18`

Confirmed observation: `POST /share-target` against the T01 API returns a 404 JSON body.
In normal operation the service worker intercepts this and the request never reaches the
server, so this is correct today. It becomes relevant on first visit before activation, and
in the F7 registration-failure case. Worth an explicit decision when the share target moves
from spike to product — not a defect in either task as scoped.

---

### Future hardening — low severity

| ID | Task | Location | Note |
| --- | --- | --- | --- |
| H1 | T02 | `sw.js:6-7` | `activate` never deletes superseded caches. `SHELL` is already at `v2`, so a `v1` cache persists indefinitely. Add a cache-name sweep in `activate`. |
| H2 | T02 | `sw.js:6` | No `skipWaiting()`. After an update the previous worker keeps serving share POSTs until every client closes. Acceptable for a spike; state it. |
| H3 | T02 | `sw.js:30` | `url.pathname.endsWith("/share-target")` also matches e.g. `/anything/share-target`. Harmless in scope; an exact comparison against the resolved action URL is stricter. |
| H4 | T02 | `sw.js:13-15` | `crypto.randomUUID()` is called unguarded, while `share-contract.js:5-8` guards it with `UUID_UNAVAILABLE`. A capability failure would surface as `LOCAL_STORE_FAILED`, misreporting the cause. Service workers require a secure context, so this is unlikely to fire. |
| H5 | T02 | `share-contract.js:10-12` | `nonEmpty` tests `value.trim()` but returns the untrimmed value, so `"  x  "` is stored with surrounding whitespace. |
| H6 | T01 | `apps/api/tsconfig.json:4` | `include: ["src/**/*.ts"]` compiles `health.test.ts` into `dist/`, shipping test code in the production artifact. |
| H7 | T01 | `apps/web/vite.config.ts:4` | No dev proxy for `/api`, so same-origin API calls do not work under `vite dev`. Production is fine; local development is not. |
| H8 | T01 | `apps/worker/src/index.ts:4` | SIGTERM calls `process.exit(0)` immediately with no drain, and SIGINT is unhandled. Harmless now; it sets the pattern for a worker that will hold job leases, where abandoning without release is a real cost. |
| H9 | T01 | `.env.example` | `WORKER_POLL_MS` is read by the worker but absent from the example env file. |

---

### Checked and found sound

R01 asks for important negative findings, so these were verified rather than assumed:

- **Commit-before-redirect (T02).** `sw.js:33-34` awaits `putRecord` before issuing the 303.
  `putRecord` resolves on `transaction.oncomplete`, not on the `put` request, so the redirect
  genuinely follows durability. This is the property `bafffec` set out to fix, and it holds.
- **Storage failure never reports success (T02).** The `catch` at `sw.js:35` redirects with
  `captureError=LOCAL_STORE_FAILED`, and `app.js:26-30` clears prior output. Matches
  `T00-contracts.md:95` ("Storage failure prevents `Zapisano lokalnie`").
- **Stable identity through promotion (T02).** The raw record carries `id`, `operationId`
  and `attachmentIds`; `normalizeShare` reuses each when present rather than reallocating;
  `promoteRaw` refuses a changed id via `CAPTURE_ID_CHANGED`. Verified by test and by reading
  both sides.
- **Idempotent re-promotion (T02).** A record already at `recordType: "capture-draft"` is
  returned untouched, so a reload cannot downgrade a bound draft back to quarantine.
- **`server.js` path traversal (T02).** `server.js:6` resolves through `new URL().pathname`
  and `path.normalize`. Percent-encoded traversal is not decoded by either, and leading `..`
  segments are dropped above root. Bound to `127.0.0.1`. Adequately guarded for a local
  diagnostic; no change needed.
- **Static root resolution (T01).** `path.resolve(here, '../../web/dist')` resolves correctly
  from both `src/` and the compiled `dist/`, since both sit one level under `apps/api`.
- **API namespace guard (T01).** `/api`, `/api/…` and `/apifoo` are each classified
  correctly; only the method coverage is wrong (F2).
- **Feed-cover amendment is internally consistent (T00).** The amendment added during this
  review (`T00-contracts.md:22-36`) is correctly reflected in the contracts: `Reel.feedCoverDone`,
  `feedCoverDone` added to `ReelPatchRequest.changes`, and a `FEED_COVER_REQUIRED` error code.
  The prose specifies HTTP 422, `retryable: false` and the Polish client message, and routes the
  change through the existing scalar PATCH rather than a new endpoint or workflow state —
  consistent with the five-status invariant and the mutation contract. No defect found. T02 is
  unaffected: creation defaults to false "including offline/share capture", which the server owns.
- **T02 evidence table honesty.** The README's status table correctly labels simulated vs
  unverified, names the transaction double, and states that production must additionally key
  IndexedDB access by authenticated account. It does not overclaim.

---

## Acceptance matrix

Evidence types: **observed** (I ran it here), **simulated** (passes against a local double or
fixture), **documentation** (official source, dated), **unverified** (no evidence available).

### T00 — contracts

| Criterion | Result | Evidence |
| --- | --- | --- |
| Persistent additive hooks; no singular hook field, no per-hook use action | PASS | observed — `ReelHook` shape and route surface both conform |
| Existing-meme FK suggestion, at most one, never invented | PASS | observed — `MemeSuggestion` is a single object or null |
| Run self-invalidation rule present | PASS | observed — new paragraph in the working copy |
| No final editorial prompts; T16 blocked | PASS | observed |
| Capture contract covers T02's actual output | **FAIL** | observed — F8, single vs multiple attachments |
| Expected verifier defined in all states | **UNVERIFIED** | Q1, null-editor case undefined |
| Hook-addition bound expressed in contracts | PARTIAL | Q2, prose only |
| Root contract files committed | **FAIL** | observed — authoritative T00/tasks are uncommitted |

### T01 — scaffold

| Criterion | Result | Evidence |
| --- | --- | --- |
| Clean install / build / typecheck | PASS | observed — both exit 0, reproduced here |
| Tests | PASS | observed — 3/3 pass |
| Health endpoint under API namespace | PASS | observed |
| Same-origin static web + API boundary | PARTIAL | observed — correct for GET; F2 and F3 |
| T00 error envelope | **FAIL** | observed — F2, non-GET bypasses it |
| Shared-types typecheck (T00 line 111) | **FAIL in substance** | observed — F5, no consumer exists |
| Worker entry and shutdown | PASS | observed — SIGTERM handled |
| API shutdown | **FAIL** | observed — F4, no handler |
| CI configured | PASS | observed — `.github/workflows/ci.yml` builds, typechecks, tests |
| CI executed remotely | **UNVERIFIED** | never run; unchanged from the lead's note |
| Production dependency audit | not re-run | lead reported clean after the `@fastify/static` upgrade; accepted, not reproduced |

### T02 — Android Share Target

| Criterion | Result | Evidence |
| --- | --- | --- |
| URL/text/image/mixed normalize to one draft shape | PASS | simulated — 12/12 tests, reproduced here |
| Original input preserved distinctly from derived fields | PASS | simulated |
| Unsupported/empty payloads explicitly classified | PASS | simulated |
| Quarantine before identity; explicit binding; no rebinding | PASS | simulated |
| Stable capture/operation/attachment IDs through promotion | PASS | simulated |
| Commit before redirect | PASS | observed by inspection |
| Storage failure never reports success | PASS | observed by inspection |
| Reopen/replay without duplicate capture | PASS | simulated |
| **Concurrent** promotion safety | **UNVERIFIED** | F6 — double does not serialize; no concurrent test |
| Service-worker receiver in a real browser | **UNVERIFIED** | gate open; CDP navigation did not complete in this environment |
| PWA installs on Android | **UNVERIFIED, at risk** | F1 — manifest lacks required raster icons |
| Android share-sheet registration, cold launch, offline share | **UNVERIFIED — gate open** | no device, emulator or adb available |
| Account-scoped IndexedDB reads | **NOT DEMONSTRATED** | acknowledged in README as a production requirement |

### T03 — Gemini

**NOT REVIEWED.** Excluded by user decision to avoid self-review; see the scope section.
Status is unchanged from `tasks.md`: delivered at `cb41abd`, 85 local tests reported, live
capabilities BLOCKED on credentials, **not lead-accepted**. Priority 5 documentation
verification is outstanding and should go to an independent reviewer.

---

## Code worth retaining

- **T02's whole capture-contract module.** `share-contract.js` is the strongest artifact in
  this review: pure functions, injected clock and UUID source, original input kept distinct
  from derived fields, explicit rejection reasons, and blobs stripped from display output.
  It maps cleanly onto T00 without importing shared contracts.
- **T02's single-transaction `promoteRaw`.** The read-modify-write design is correct. The
  problem is the evidence, not the code.
- **T02's evidence table discipline.** Simulated and unverified rows are labelled honestly
  and should be the template for other spikes.
- **T01's SPA/API boundary tests.** The three tests cover the right idea, including the
  `/api?probe=1` query-string case. They need extending to non-GET methods, not replacing.
- **T01's workspace layout, `tsconfig.base.json` and CI.** `noEmitOnError`, strict mode and
  the build→typecheck→test ordering are all sound.

## Corrections required before acceptance or integration

Blocking, in order:

1. **F8** — resolve the single vs multiple attachment contract. Lead decision; blocks both
   T00 and T02.
2. **F1** — add raster icons before any Android session, or that session is wasted.
3. **F2** — error envelope for all methods.
4. **F5** — make the contracts dependency load-bearing so CI proves consumability.
5. **F4** — API graceful shutdown.
6. **F3** — stop serving HTML for missing assets.
7. **F7** — gate share capture on registration success.
8. **F6** — correct the README evidence row; no code change.
9. Commit the root `T00-contracts.md` and `tasks.md`.

## External and manual gates still open

| Gate | Blocker | Notes |
| --- | --- | --- |
| Android share-sheet registration and cold launch | No device, emulator or adb | Fix F1 first. README steps 1–7 are a good procedure; follow them as written |
| Desktop browser SW/IndexedDB integration | CDP navigation to localhost did not complete here | `npm run test:browser` exists and is the right harness |
| Concurrent promotion in real IndexedDB | Needs a browser | F6 |
| Remote CI | Never executed | Configuration looks correct; only a real run proves it |
| Credentialed Gemini live probes | No API key | T03; out of scope for this review |
| Independent T03 review | This session authored T03 | Needs a different reviewer |

## Recommended next bounded batch — recommendation only, nothing dispatched

I am not launching any of this. T04 remains unauthorized.

1. **R02 — independent T03 review.** Highest value, because T03 is the one deliverable with
   no independent assessment. Must be a different agent. Include R01 priority 5.
2. **C01 — T01 corrections** (F2, F3, F4, F5). Small, mechanical, well-specified, confined
   to `apps/api` plus two `package.json` files. Natural fit for the existing T01 agent.
3. **Lead decision on F8**, then **C02 — T02 corrections** (F1, F7, F6's README line, plus
   H1–H5). C02 depends on the F8 outcome; sequence them.
4. **Android device session** for T02, only after F1 lands.

Dependencies: F8 gates C02. R02 is independent of everything and can go first or in
parallel. None of this should start without explicit approval.

## Commands run

All read-only or scratchpad-only. No worktree file was modified.

```sh
# revisions
git -C .worktrees/<each> log --oneline -1 / branch --show-current / status --short
git diff docs/implementation/T00-contracts.md docs/implementation/tasks.md

# T01 (in .worktrees/t01-scaffold)
npm run typecheck                 # exit 0
npm run build                     # exit 0
npm test                          # 3/3 pass
git ls-files | grep dist/         # 0 tracked build artifacts
node -e "import('@szronox/contracts')"   # resolves via hoisting, 0 runtime exports
node --input-type=module -e "<app.inject probes>"   # F2/F3 evidence

# T02 (in .worktrees/t02-android-share/spikes/android-share)
npm test                          # 12/12 pass
node --check {app,sw,storage,share-contract,server}.js   # all ok
node -e "JSON.parse(manifest)"    # no 192/512 icon
# scratchpad copies only, worktree untouched:
#   atomicity regression -> 2 of 12 tests fail (suite does pin single-transaction)
#   concurrency probe    -> double opens 2 overlapping transactions, lost update
```

## Limitations

- **T03 was not reviewed**, by user decision, and neither was R01 priority 5. This is the
  largest gap in the report.
- **No browser and no Android device.** Every T02 runtime gate remains unverified. Nothing
  in this report claims otherwise, and no browser-dependent row was upgraded from code
  inspection.
- **F1's severity rests on documentation plus a filed Chromium issue**, not on an observed
  install failure. I have stated that uncertainty rather than resolving it.
- **The production dependency audit was not re-run.** I accepted the lead's reported clean
  result rather than reproducing it.
- **Remote CI was not executed**; the workflow was read, not run.
- **Root contract files are uncommitted**, so this review is pinned to working-copy state
  that could change without a commit.
- No live provider call, installation, device configuration or persistent server was
  created. The two temporary Node processes used for `app.inject` probes exited on their own.

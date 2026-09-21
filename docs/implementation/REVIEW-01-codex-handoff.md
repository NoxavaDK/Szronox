# REVIEW-01 — bounded review and repair pass

Reviewer: manual Opus 5, one agent, no nested agents, no coding agent dispatched.
Branch `codex/review-repair-01`, worktree `.claude/worktrees/agent-a140176cbd7c5a945`. **Not merged. Not deployed.**

---

## 1. Baseline

| | |
| --- | --- |
| Source tip in the repository | `codex/corpus-01` = `902a2fa` (CORPUS-01, unmerged, explicitly **not** deployed) |
| **Deployed DEV release** | **`d3c5910`** |
| **My base** | **`d3c5910`** — the deployed release, not the repository tip |
| Implementation commit | **`25a0db8`** |
| Deployed SHA after this task | unchanged — `d3c5910`. I did not deploy. |

### How the deployed SHA was established, not assumed

`ssh ubuntu@51.195.103.79 'docker ps'` reports `szronox-dev-api-1` and `szronox-dev-worker-1` both on image
`szronox-dev:d3c5910`, up 3 days. The two commits after it on `codex/gemini-02-impl` are documentation and a
smoke script only (`213ea41` → `GEMINI-02-integration-result.md`; `c13f7a1` → `deploy/vps/ai-smoke.mjs`).

Confirmed independently by build provenance. The live site serves
`/assets/index-BOxrWM4y.js` and `/assets/index-D-bjVDeC.css`. Building the **unmodified** `d3c5910`
reproduces exactly those two hashes. That pins the deployed web bundle to `d3c5910` byte-for-byte.

After my change the CSS hash is still `index-D-bjVDeC.css` and only the JS hash moves to
`index-CFmoMUT8.js` — i.e. **no style, token or layout change**; the frozen visual language is untouched.

### Preserved work

`master` untracked files (`deploy/`, `docs/product/`, the GEMINI/PWA documents) and every sibling worktree
were left exactly as found. `codex/corpus-01` is newer than my base and is **not** included in my branch —
deliberately, so that deploying this repair cannot smuggle unreviewed corpus code, migration `0006` or the
archive-route work into DEV.

## 2. How the app was actually driven

The Claude-in-Chrome extension is not connected in this session, so there was **no browser**. Instead I
composed the *real* `buildApp()` — real auth routes, real core routes, real repository, real migrations —
against PGlite on `127.0.0.1:4173`, provisioned a disposable password, and drove it over HTTP.

- Nothing on the VPS was touched beyond one read-only `docker ps` / directory listing.
- The DEV database, DEV storage and all user-authored records were **never** written to.
- Fixtures (`ZZTEST …`) lived only in the in-memory PGlite instance and vanished when the process was
  killed. Nothing needed soft-deleting, because nothing durable was created.
- The disposable harness (`apps/api/dist/local-dev.js`, gitignored) was deleted. It is not in the diff.

Verified working end to end over the real routes: login, `/me`, capture from text, capture from link,
capture rejection when a capture carries nothing usable (`422 VALIDATION_ERROR`), list, detail,
`PATCH` of title + `publicationDescription` + `publicationHashtags` with `expectedVersion`, and hook append.

## 3. Defects found and fixed

### D1 — Accompanying text from Quick Add was captured, persisted and then never shown

**Reproduction.** Capture a link (or an image) and type accompanying text in the *Dodatkowy tekst* field.
Save, reopen the Reel, expand ŹRÓDŁA. The **DODATKOWY TEKST** block is absent.

**Cause.** `App.tsx` read the value out of the wrong place:

```ts
additionalText: reel.originalInput.originalShare?.fields.find((f) => f.name === 'additionalText')?.value ?? null,
```

`additionalText` is a first-class `CaptureInput` field — the contract calls it "Separate Quick Add context
entered alongside URL/image; immutable after capture" — and Quick Add writes it there directly.
`originalShare.fields` holds only the scalars a *sending app* supplied, and `share/receive.ts:224` states
outright that "`additionalText` is deliberately absent: it belongs to the user, not the sender." So the
lookup could never match, from either the Quick Add path or the share path. `detail-sections.tsx:253`
renders the block as `{additionalText ? … }`, so a permanent `null` hid it entirely.

**Evidence** (live, against the local composition of the deployed code):

```
create -> 201
persisted originalInput: {"url":"https://example.org/artykul","images":[],
                          "additionalText":"ZZTEST dodatkowy kontekst wpisany w Quick Add"}

App.tsx CURRENT expression -> null                                      renders: false
Corrected expression       -> "ZZTEST dodatkowy kontekst wpisany w…"    renders: true
```

The server had stored the text correctly all along; only the read was wrong. **No data was lost** — every
affected existing Reel will simply start displaying text it already holds.

**Fix.** Read `reel.originalInput.additionalText ?? null`. An empty string stays falsy, so an unused field
still renders nothing.

**User-visible result.** The DODATKOWY TEKST block appears for any Reel that has accompanying text,
including Reels captured before this fix.

---

### D2 — Detail navigation changed route before it had the Reel

**Reproduction A (wrong record on screen).** Open Reel A. Go back. Open Reel B. For the whole duration of
B's fetch the screen shows **A's** title, script and hooks while the route is B. On a phone network this
window is plainly visible.

**Reproduction B (dead route).** Open any Reel while the API is unreachable. The read fails; the list is
shown again. Now tap a different status tab: the tab highlights, and the list content does not change.

**Cause.** `openDetail` did `setRoute({name:'detail', reelId})` *first* and only then awaited the read.

- `current` still held the previous Reel for the whole round trip, and `App.tsx` renders the detail screen
  from `c.current`. Worse than cosmetic: `changeReel` writes through `currentRef.current`, so an edit made
  in that window would have been **patched onto Reel A** while the user believed they were editing B.
- On failure, route stayed `detail` with `current` null. `App.tsx` requires `route.name === 'detail' && c.current`,
  so it fell through and rendered the list — but the list's loader is guarded by
  `useEffect(… if (route.name === 'list') void loadList(), [loadList, route.name])`. With the route stuck on
  `detail`, changing `status` re-created `loadList` but the guard refused to run it. The tabs went on
  highlighting a status whose Reels were never fetched.

**Fix.** Fetch first; set `current`, `currentRef`, `saveState`, `loadState` and `route` together once the
Reel is in hand. A failure leaves the user on the list, whose existing frozen states already say
"Wczytywanie…" and "Nie udało się wczytać / Spróbuj ponownie".

**User-visible result.** Tapping a row shows the list's existing loading banner, then the correct Reel —
never a stale one. A failed open no longer strands the app on a route that silently stops working.
No new UI was introduced; both states already existed in `ReelListScreen`.

---

### D3 — AI workspace and meme picker outlived the Reel that opened them

**Reproduction.** Open Reel A → open Opracowanie. An Android share arrives; the controller routes to Quick
Add. Save that capture with the plain save (not Opracuj) → back to the list. Open Reel B → **B opens
directly into the AI workspace**, which finds no saved run for B and starts a fresh provider call nobody
requested.

**Cause.** `aiView` and `memeOpen` were unscoped (`{view, autoStart}` and a bare boolean). They are cleared
on sign-out only. Nothing tied them to the Reel that opened them, and `App.tsx` consulted them for whatever
Reel happened to be current.

**Fix.** Both now carry the Reel id (`aiView.reelId`, `memeReelId`) and are honoured only when it matches
the rendered Reel. Deliberately **scoped state rather than a reset effect**: the `Opracuj` path sets the new
route inside `submitCapture` and `aiView` in a later `.then` microtask, so a passive effect keyed on the
route would run after both and wipe the workspace the user explicitly asked for.

**User-visible result.** The AI workspace and the meme picker belong to one Reel. Opening another Reel lands
on its detail screen. Closes an unrequested-provider-call path.

*Honest scope note:* D3 was found by inspection and its reachability depends on a share arriving while the
workspace is open. I did not reproduce it on a device. The fix is unconditional and costs nothing.

## 4. Exact changed files

```
apps/web/src/app/App.tsx                       (D1, D3)
apps/web/src/controllers/useAppController.ts   (D2)
```

Two files, +53 −13. No API, worker, contract, migration, dependency, lockfile, style or deployment file was
touched. `packages/contracts/src/index.ts` unchanged.

## 5. Verification

### New checks run for this task

| Command | Result |
| --- | --- |
| `npm run typecheck` | clean, all four workspaces |
| `npm run build` | clean, all four workspaces |
| `npm run test:t08 --workspace @szronox/web` | 16/16 pass |
| `npm run test:share --workspace @szronox/web` | 21/21 pass |
| `node --experimental-strip-types --test apps/web/src/ui/frozen-copy.test.mjs` | 8/8 pass |
| Live workflow over real routes (local composition) | login, `/me`, text capture 201, link capture 201, empty capture 422, list, detail, publication PATCH, hook append 201 — all as specified |
| D1 reproduction script | current expression `null`, corrected expression returns the stored text |
| Static/PWA serving on the rebuilt bundle | `/` 200 `text/html`; `/sw.js` 200 `application/javascript`; `/manifest.webmanifest` 200 `application/manifest+json` |
| Build provenance | unmodified `d3c5910` → `index-BOxrWM4y.js` + `index-D-bjVDeC.css` = exactly what DEV serves |
| Style impact | CSS hash unchanged after the fix (`index-D-bjVDeC.css`) |

### Deliberately NOT rerun (reused evidence, per the testing budget)

- The full `npm test --workspace @szronox/api` suite (163 tests). My diff touches no API code. CORPUS-01
  §7 already records its state, **including two pre-existing failures in `deploy-config.test.ts`** that are
  GEMINI-02 deployment drift, reproduce on the unmodified base, and are not mine.
- Gemini pipeline acceptance, Fact Check, Sprawdź język, image-input Opracuj, hooks, duplicate protection,
  explicit application — all previously accepted and untouched by this diff.

### Live provider calls

**None.** No Gemini call was made, by me or by the local harness (`AI_ENABLED` was set, but no run was
started). No quota was consumed.

## 6. Deployment

**Not deployed.** DEV remains on `d3c5910`, healthy: `GET /api/v1/health` → `{"status":"ok"}`, HTTP/2 200
via Caddy. Nothing was changed on the VPS; my only VPS access was a read-only `docker ps` and a directory
listing. Task Tracker (8000/3001), the 3010 scaffold, `szronox-app-1`, `app-api-1`, `app-web-1`,
`cutroom-postgres-1` and all Caddy routes were untouched, and `szronox.zieloni.tech` was never configured.

I stopped short of deploying deliberately: all three fixes are user-interface behaviour, and with no browser
in this session I can verify compilation and logic but **cannot visually confirm the rendered result**.
Shipping an unverifiable UI change over a healthy release is the wrong trade. See §8.

Rollback, if Astra does deploy: the current image `szronox-dev:d3c5910` is live and `/opt/szronox-dev`
retains `app.402193c`, `app.758d780` and `app.a248baf` alongside `app`.

## 7. Remaining findings

### BLOCKER
None.

### CORRECTION NEEDED
- **`deploy-config.test.ts`, 2 failing assertions.** Pre-existing GEMINI-02 drift, not from this task:
  `compose.yaml` reads `AI_ENABLED` which `deploy/vps/README.md` never documents, and the worker now
  genuinely handles attachment bytes while the security assertion still says it must not mount the storage
  volume. Both live in files owned by the VPS batch (`deploy/vps/compose.yaml`, `deploy/vps/README.md`), so
  I left them alone rather than edit another owner's files. They need a decision, not just a test edit:
  the worker's storage mount is a real security-boundary question.

### OPEN REAL-WORLD GATE
- **Browser and mobile-layout verification.** The Claude-in-Chrome extension is not connected, so I could
  not open the app at phone size. I therefore make **no claim** about mobile layout or touch interaction —
  I neither confirm nor deny problems there. The three fixes above are logic and data-flow defects
  established from code and live API behaviour, not from rendering.
- **Installed Android Share Target.** Untested. No device. D3's trigger path runs through it.
- **Live Gemini behaviour.** Not exercised; no provider call made.
- **Sprawdź postulat.** Still blocked on the approved programme corpus, as recorded. Not tested, no corpus
  invented.
- **CORPUS-01 (`902a2fa`).** Unreviewed by me and not deployed; migration `0006`, grants rerun and archive
  wiring all remain separately authorized steps.

### ACCEPTED / NO FURTHER TESTING NOW
- Capture validation, list/detail/patch/hook persistence, `expectedVersion` handling, publication fields,
  feed-cover gating copy, soft delete/restore, auth/session/CSRF — exercised this pass, behaved as specified.
- `reel-label.ts` (LABEL-01) — read closely while investigating D1; correct, and its 16 tests pass.
- Everything in the two prior acceptance passes.

### Observed but deliberately NOT changed
Reported so Astra can see them without rediscovering them; none is clearly a defect, and changing them
would be redesign or product decisions:

1. `AiWorkspace.tsx:176` says "Wynik będzie dostępny po ponownym otwarciu" while the component in fact
   polls every 2.5 s and updates in place. The copy undersells the behaviour.
2. `AiWorkspace.tsx:222` disables *Użyj korekty* for a stale claim but still labels it "Użyj korekty" with
   no reason shown. `errors.ts` already carries approved copy (`STALE_FACT_CLAIM`). Per-claim stale
   detection was accepted in the prior pass, so I did not reopen it.
3. `App.tsx` hardcodes `isOverdue: false`, `elapsedLabel: null` and `memeName: null` on every list row, so
   those row affordances can never appear. Consistent with unimplemented surfaces rather than a bug.
4. `composePublicationText` treats a whitespace-only description as present, so `Kopiuj opis` would emit
   `"   \n\n#tags"`. T00 says "exactly two newlines only when both are present"; whether blank-but-not-empty
   counts as present is a wording call, not a clear violation.
5. `counts` only ever populates the selected status; the other tabs show no count by construction.

## 8. Decision Astra must make

**Whether to deploy `25a0db8` to DEV, and who verifies it in a browser first.**

My recommendation: deploy it, but only after someone opens `https://dev.szronox.zieloni.tech` at phone size
and confirms three things, none of which needs a provider call or a device:

1. A Reel captured with a link *plus* accompanying text shows the **DODATKOWY TEKST** block (D1). Existing
   Reels that already have the field will start showing it — worth a glance that nothing looks wrong.
2. Opening Reel B straight after Reel A never flashes A's content (D2).
3. Opening a Reel then leaving and opening another does not land in the AI workspace (D3).

The fixes are two files against the exact deployed release, with no style, contract, schema or dependency
change, so the deploy is as small as one can get. The alternative — folding this into a later rollout that
also carries CORPUS-01 — mixes a tiny verified delta with a large unreviewed one, and I would advise against
it.

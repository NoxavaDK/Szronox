# UI-02 + PUBLICATION-02 v3 — result and DEV deployment

Date: 2026-09-28. Operator-authorized task: implement Astra's live UI re-audit (with the operator's
amendments and the radial quick-action amendment), test, merge, deploy to DEV only, and run a bounded
live acceptance.

- Implementation: `267ff4c` (branch `ui-02-publication-02`).
- Merge: `a86a057`.
- Live-script fix: the follow-up commit that adds this file.
- Release on DEV: image `szronox-dev:a86a057`, ID `sha256:c1d972b9bdf37b7301d071fd8ad7abdf9848df03be4feceb32efa4abca4a05a8`.

No migration, no new dependency, no Task Tracker or production change, no programme-corpus change.

## What changed

### UI (web)

**Semantic colour roles.** `ui/tokens.css` defines action, complete, attention and danger roles, each with a tint. There is also a reference-text colour (about 10:1 contrast) and desktop nav/editor surfaces.
- One `ActionButton` primitive: primary, attention, danger or quiet.
- Colour always comes with wording or a symbol.

**Primary-action rules** (`data/detail-actions.ts`). An explicit, ordered and tested rule table:
- A deleted Reel gets `Przywróć rolkę`, and Detail becomes read-only: no AI row, no hook edit or delete, no meme or overflow, no production or publication editing.
- A published Reel gets no CTA.
- An empty script gets `Opracuj`, or `Napisz skrypt` when AI is unavailable.
- In Montaż:
  - no export → `Dodaj eksport`;
  - stale verification → amber `Eksport zmieniony · Sprawdź ponownie`.
- In Gotowe:
  - no description → `Wygeneruj opis` (or `Uzupełnij opis`);
  - no cover → amber `Brak okładki do feedu`.
- Copy without a date → `Zaplanuj`. A planned Reel shows a quiet `Termin · Zmień termin`.
- `Wybierz hook` is a quiet shortcut, shown only in Pomysł or Do nagrania.

**Hooks.** The whole row is still the selection target. It now shows a radio-style mark (an empty ring, or a filled check) plus `WYBRANY`. `WŁASNY` stays provenance only.
- Edit and delete remain sibling buttons.
- One instruction, `Stuknij hook, aby go wybrać`, replaces the second `Wybierz hook` button.
- The unreset `ul` indent (40 px, also present in production) is removed.

**Detail hierarchy.**
- Tighter gaps, with 44 px targets kept.
- A 19/21 px title with `Nadaj tytuł` / `Edytuj tytuł`.
- Darker section labels.
- `PRODUKCJA` and `PUBLIKACJA` are separated as groups.
- Sources are readable and no longer faded by opacity.
- Programme: an attached programme shows a check; `brak dopasowania` is neutral.

**Publication.**
- With no description, `Wygeneruj opis` is primary and `Kopiuj opis` is quiet.
- Once there is copy, `Kopiuj opis` is primary.
- A quiet `✓ gotowy` mark shows readiness.
- The collapsed summary uses a check for complete and an amber `!` for a missing prerequisite in Gotowe.
- The proposal view shows a `ŹRÓDŁA` block, built from the returned provenance only.

**Identity** (`data/reel-label.ts`).
- Opaque platform codes (`h7v9vwm`, `azIr67Xq2v`, `live`) are rejected and fall back to `Materiał z <host>`.
- The saved script's first sentence is preferred over link or file fallbacks.
- Readable long slugs are no longer rejected.
- Nothing is fetched and `originalInput` is untouched.

**Other Astra fixes.**
- The final delete button is red in both Detail and the list sheet.
- Polish meme file control (`Wybierz zdjęcie` / `Nie wybrano pliku`), in the action colour instead of completion green.
- The AI workspace uses the action colour.
- The Usunięte screen and the list header `⋮` are styled.
- A visible `⋯` quick-actions button on each row.
- Planner:
  - DZIŚ gets an edge and tint;
  - accurate NIEZAPLANOWANE empty-state wording;
  - overdue gets `!`.
- List:
  - `✓ Opublikowane` / `✓ Gotowe` in the complete colour;
  - `◷ Sprawdź ponownie` in amber;
  - the redundant urgent `!` glyph is dropped;
  - the plan date is neutral metadata.
- Desktop nav surface and pane boundary.

**Structure kept.** The two-pane, Plan switch and focus layout is unchanged; the grid CSS is asserted by a test.

### Radial quick-action menu

`ui/radial-menu.ts` holds the pure layout and action rules; `RadialQuickMenu` is in `ReelQuickActions.tsx`.
- **Opening.** A touch long-press opens it at the finger. The click is suppressed, so Detail does not open. Mouse, pen, right-click and the ContextMenu key keep opening the full sheet.
- **Actions.**
  - `Zmień status`;
  - `Zaplanuj`, or `Zmień termin` when planned (omitted when published);
  - `Przypisz`;
  - `Więcej`, which opens the full sheet.
- **No direct mutations.** Each action opens the existing sheet, whose explicit choice performs the existing mutation.
- **Placement.** The menu flips below the finger at the top edge and shifts or shrinks so it is never clipped. This is tested at 360, 390 and 1100 px.
- **Closing.** Tapping outside or pressing Escape closes it; arrow keys move focus.
- **Not included:** `Archiwizuj` and `Duplikuj`. SzroNox has no archive state and no duplicate contract, and a radial action must not map to a delete. This is an operator decision if wanted.

### PUBLICATION-02 v3

Changes are in `apps/worker/src/ai/actions.ts`, `apps/api/src/ai/service.ts` and `packages/contracts`.
- **New runs** snapshot `publicationContextVersion: 3`, prompt `gemini-02-publication-provisional-v3`, and completed, validated capture images. A pending image is neither snapshotted nor a blocker.
- **Source precedence:**
  1. saved text (a bare URL string is not grounding);
  2. the readable linked source (fetched through the existing SSRF-guarded reader);
  3. saved images.
- **Grounded call.** When any of these exists, one call returns the copy and `addsSupportedContext`.
- **Search fallback.** It runs only when there is no material, or when the material adds nothing beyond the script.
  - One `googleSearch` call, whose context is the saved script plus the selected hook.
  - Up to 4 `groundingChunks` URIs, each retrieved by the worker.
  - A generation call that must quote each added fact exactly (whitespace-normalised) from a retained excerpt.
  - With no retained sources or no verified quote, the result is script-only (the material-based copy when one exists), with the warning `Nie znaleziono wiarygodnych materiałów uzupełniających…`.
  - Model-written URLs are never evidence.
- **Result fields:** `publicationGrounding` (`saved_material`, `web_search` or `script_only`) and `publicationSources` (the saved link or provider results only).
- **Provenance** is stored on the run: `searchRan`, `linkedSourceFailure`, `groundingReferences`, and `retainedSources` with sha256.
- **Freshness** is identical to v2: script text and revision, selected hook ID and text, and eligible saved text. Unrelated metadata does not stale a proposal. Legacy v2 and unmarked runs keep their meaning.
- **Unchanged:** explicit per-field apply, replacement confirmation, `EDIT_CONFLICT` and idempotency.

## Verification

```sh
npm run typecheck && npm run build                                   # PASS
npm run test:t08 --workspace @szronox/web      # 60/60 (includes new ui-02.test.mjs 17/17)
npm run test:share --workspace @szronox/web    # 21/21
npm run test:list-01 --workspace @szronox/web  # 17/17
node --experimental-strip-types --test apps/web/src/{controllers,drafts}/tests/*.test.mjs   # 11/11
npx tsc -p apps/web/tsconfig.test.json && node --test apps/web/dist/test/apps/web/src/{auth,data}/tests/*.test.js  # 24/24
node --test apps/worker/dist/ai/*.test.js apps/api/dist/ai/service.test.js apps/api/dist/hooks-selection.test.js  # 52/52
npm test   # API: 224/227
```

The three API failures are unrelated to this change:
- `deploy-config.test` has two pre-existing failures: the worker storage mount and `AI_ENABLED` missing from the README. `compose.yaml` and `README` are not touched here.
- The combined `runtime.test` failed only under full-suite load and passes alone.

Local headless Chrome ran a fixture harness at 360 and 390 px (temporary, not committed). It rendered these states:
- Detail: idea, selected hook, published, deleted, ready, ready with copy, stale verification;
- the list, the radial menu, the delete confirmation, Usunięte and an empty Plan.

It found and fixed the hook-list indent and the header `⋮` default styling.

## DEV deployment (`a86a057`)

- **Archive:** `git archive a86a057 | gzip -n`, SHA-256 `970f356b365e90fcaabaf710db5dd1e9a9472dde7b86d269233a4077c3a688c3`, identical after transfer.
- **Backup** in `backups/pre-a86a057/`:
  - a 681,928-byte dump (20 TABLE DATA);
  - `runtime.env` (release `5e2d022`) and `dc-gemini.sh`;
  - neighbour, container and migration state (12 migrations);
  - `SHA256SUMS` and the build log.
- **Before rollout:** 0 queued or running AI runs.
- **Rollout:**
  - `app` → `app.pre-a86a057`;
  - only `SZRONOX_RELEASE` changed (diffed);
  - migrate checked 12 files and applied 0;
  - grants exit 0;
  - only the DEV api and worker were recreated, with 0 restarts.
- **Checks:**
  - Ready on loopback 3011 and HTTPS.
  - `/`, `/sw.js` and `/manifest.webmanifest` return 200.
  - The bundle `index-CuofwqRw.js` contains the new UI strings.
  - The worker enforces privileges with no violations.
  - Neighbours' StartedAt, Caddy MainPID 170439 and the Caddyfile hash are unchanged.

### Live acceptance (`deploy/vps/publication-live.mjs`): 20/20

It used 3 Gemini calls in total: 1 generation for P1, and 1 `googleSearch` plus 1 generation for P2.

An earlier attempt made no provider call. It stopped on a script bug (the add-hook response shape); its SMOKE Reel was soft-deleted.

**P1 (saved source for the fictional town Testowo):**
- `saved_material`, and `searchRan=false`.
- The description added 129 zł, 64,50 zł, the date and the student-ticket exclusion, none of which is in the script. It did not repeat the hook, and had no CTA or emoji.
- Generation wrote nothing to the Reel.
- Priority and editing notes did not stale the proposal.
- Clearing the hook staled it, and restoring the hook made it fresh again.
- A script edit staled it, and apply then returned 409 `STALE_PUBLICATION_RESULT`.

**P2 (unreachable `.invalid` link, no other material):**
- The linked-source failure was recorded (`SOURCE_UNSUPPORTED`) and search ran: 4 grounding references, 1 retained, grounding `web_search`.
- The single source (`climate.ec.europa.eu`, `groundingChunks:3`) is a provider result that was actually retrieved.
- Explicit apply wrote OPIS only.
- A stale `replaceCurrentValue` returned 409 `EDIT_CONFLICT`.

The 3 SMOKE Reels are soft-deleted and restorable. The session was revoked.

**Quality note:** P2's description is sourced and factual but tangential. It covers the 2025–2029 fleet target, not the script's 2035 rule. The search and quote rules guarantee provenance, not topical relevance; the prompt remains provisional.

## Rollback (code only)

1. Restore `app.pre-a86a057` as `app`.
2. Restore `backups/pre-a86a057/runtime.env` (release `5e2d022`).
3. Run `config/dc-gemini.sh up -d --no-deps api worker`.

No migration is involved. v3 runs stay readable by `5e2d022`, which applies v2 freshness only to `publicationContextVersion === 2`, so under the rollback v3 proposals use script-only freshness. Do not restore the dump for a code rollback.

## Open manual gates

- Operator browser pass on DEV:
  - phone at 360 and 390 px;
  - desktop at 1100 and 1440 px;
  - the ŹRÓDŁA block in a real proposal.
- Physical Android long-press, covering:
  - the radial menu at the finger, including near screen edges;
  - no Detail opening afterwards;
  - swipe and scroll unaffected;
  - that the haptic still fires.
- Populated-planner DZIŚ, a real verified or stale export, and an attached programme on real data. These are covered by fixtures and tests only.
- Screen-reader pass: hook `aria-pressed` rows and the radial `menu`/`menuitem`.

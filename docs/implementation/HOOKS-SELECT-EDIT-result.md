# HOOKS-SELECT-EDIT: result

Date: 2026-09-23. This was a manual Claude Code session on model **Opus 5.5 (`claude-opus-5-5`)**, with no nested agents. Handoff: `HOOKS-SELECT-EDIT-opus-handoff.md`.

| | |
| --- | --- |
| Branch / worktree | `codex/hooks-select-edit` / `.worktrees/hooks-select-edit`, from `284b5bf` |
| Implementation commit | `0e18420` |
| Merge commit on master | `4f7cfbb` (no conflicts; master had not moved) |
| **Deployed** | `szronox-dev:4f7cfbb`, image `sha256:b11a98f62597…`. API and worker both run it with 0 restarts |
| Previous live | `szronox-dev:d82cefc` |

## Decision: ACCEPTED / NO FURTHER TESTING NOW, with one OPEN REAL-WORLD GATE (browser UI)

## What changed

- **Schema (`0010_selected_hook.sql`, additive).** Adds `app.reels.selected_hook_id uuid null default null` and `unique (reel_id, id)` on `app.reel_hooks`. It also adds a composite FK `(id, selected_hook_id) → reel_hooks (reel_id, id) ON DELETE SET NULL (selected_hook_id)`.
  - The schema itself rejects a hook from another Reel, a deleted hook or an invented ID (23503).
  - Deleting the selected hook clears the reference in the same DELETE statement, so it happens inside the existing versioned `removeHook` transaction. No replacement is guessed.
  - The FK is MATCH SIMPLE, so a null selection is never checked. There is no backfill: historical Reels stay null.
- **API.** New `PUT /api/v1/reels/:id/selected-hook` with body `{operationId, expectedVersion, hookId: uuid | null}`. It returns the authoritative Reel.
  - Order inside the request: bump the Reel version (the row lock serialises it with hook delete/edit), then check the hook belongs to this Reel (404 otherwise), then write the ID. A late FK violation also maps to 404.
  - It uses the existing idempotency ledger. Script, `scriptRevision` and hook provenance are unchanged.
  - A missing `hookId` returns 422, and a malformed one also returns 422.
  - Hook edit still uses the existing `PATCH /reels/:id/hooks/:hookId`.
  - `Reel.selectedHookId: Id | null` is added to contracts, and T00's endpoint table has the new row.
- **Grants.** No change. The API already has table-level UPDATE on `app.reels`. The worker keeps UPDATE on `version, updated_at` only and no DELETE on hooks.
- **HOOKI in Reel Detail:**
  - Each row's text area is one `<button aria-pressed>` with a full 44 px touch target. It works with pointer, touch and keyboard (Enter/Space).
  - Selected state: a thin cobalt inset edge and a faint tint, plus the visible `✓ WYBRANY` label. There is no text highlighting and `user-select: none`, so the state never depends on browser text selection.
  - `WŁASNY` depends only on `source === 'user'`, so a selected own hook shows both labels.
  - The compact `✎` and `×` controls are siblings of the select button, not children, so they cannot trigger selection.
  - Tapping the selected row again clears the selection (explicit null).
  - Selection is not optimistic and not queued offline. On failure the UI states in Polish that the choice was not saved. After 409/404 it re-reads the Reel.
- **Inline edit:**
  - The editor has an auto-sizing field, `Gotowe` (or Enter) and `Anuluj` (or Escape).
  - Drafts live in controller state, keyed by hook ID and separate from the Reel. They survive a 409, a network failure, later Reel refreshes and navigation.
  - A draft is removed only after the server confirms the save.
  - If another device changed the same hook, the message quotes the current server text before an informed re-save.
  - A draft whose hook was deleted elsewhere stays visible with only `Zamknij`, so the text is never silently lost.
- **Unsent scalar edits.** Hook mutations no longer overwrite unsent debounced scalar edits on screen: `acceptServerReel` overlays pending changes. It rebases the pending patch only when this client's own hook mutation was the single intervening version, so a genuine concurrent change still raises the ordinary conflict. `removeHook` uses the same path.
- **AI:**
  - Run snapshots record `selectedHookId` (optional in `AiInputSnapshot`, so older runs stay readable).
  - `develop` is the only action with a notion of a current hook. Its prompt receives `selectedHook: {id, text} | null`, resolved against the run's own snapshotted shortlist and never guessed. The full hook list is still passed.
  - Fact check, `generate_hooks`, language, programme and publication inputs are unchanged. Fact check still covers all hooks.
  - Staleness (`relevant`) is unchanged, so choosing a different hook after Opracuj does not disable `Zastosuj`.
  - `PROMPT_ID` changes from v2 to `gemini-02-development-provisional-v3`, so new develop runs are distinguishable. Other actions' prompt text is unchanged.

Changed files:
- `packages/contracts/src/index.ts`
- `database/migrations/0010_selected_hook.sql`
- `apps/api/src/core/{mapping,repository,routes}.ts`
- `apps/api/src/ai/{service,service.test}.ts`
- new `apps/api/src/hooks-selection.test.ts`
- `apps/worker/src/ai/{actions,actions.test}.ts`
- `apps/web/src/{app/App.tsx, controllers/useAppController.ts, data/api.ts, screens/ReelDetailScreen.tsx, screens/ReelDetailScreen.module.css, ui/screen-contracts.ts}`
- new `apps/web/src/data/tests/hook-selection.test.mjs`
- `docs/implementation/{T00-contracts,tasks}.md`

Outside the explicit list: `apps/web/src/screens/preview/DevPreview.tsx`. It is the Reel Detail preview fixture and would not typecheck without the new required props; it has local state only. `service.test.ts`'s 0009 migration test now stages exactly 0001–0009, because it had assumed 0009 was the last file. No dependency, lockfile, grants, AiWorkspace, publication or corpus change.

## Local checks (worktree, macOS, `npm ci` from lockfile)

```sh
npm run typecheck && npm run build                          # PASS (integrated, all workspaces)
node --test apps/api/dist/hooks-selection.test.js apps/api/dist/core.test.js \
  apps/api/dist/ai/service.test.js apps/api/dist/deploy-grants.test.js      # 78/78 (11 new)
node --test apps/worker/dist/ai/actions.test.js                             # 11/11 (3 new)
(cd apps/web && npm run test:t08 && npm run test:list-01 && npm run test:share)   # 25/25 (6 new), 17/17, 21/21
```

API tests run on PGlite, so they are **simulated** against real PostgreSQL 18 semantics on a single connection. They cover:
- no auto-selection on capture or add, and null with 0 or many hooks
- select, switch and clear, read back from detail and list
- selection does not change `scriptRevision` or hooks
- unknown, deleted and cross-Reel IDs return 404 and roll back fully
- raw SQL is refused by the FK
- stale version returns 409 with `currentVersion`
- replay returns the original result after later changes, and a reused ID with another payload returns `IDEMPOTENCY_CONFLICT`
- a deleted Reel returns 404
- unselected delete keeps the selection; selected delete clears it in the same version bump
- select/delete interleavings in both orders, plus a raw hook delete, leave no dangling ID
- editing selected and unselected hooks keeps ID, source, createdAt, position and selection, and a stale edit returns 409
- a worker-style append keeps the selection
- develop and fact-check snapshots, no staleness from selection, and a legacy run without `selectedHookId` stays readable
- migration 0010 on a 0001–0009 database with an existing hooked Reel leaves it null
- over HTTP: 401, 422 for missing or malformed `hookId`, 404, 200 with detail read-back, and 409

Worker tests: develop gets the selected hook plus all hooks. Develop with null, absent or foreign selection gets `selectedHook: null`. `generate_hooks` and fact check get every hook and no `selectedHook`.

Web tests are static source assertions, because there is no DOM harness. They cover route and method, a single hook-edit endpoint, row structure and sibling controls, independent labels, the selected CSS, the draft lifecycle, no offline claim, and `+ Wygeneruj więcej` unchanged.

## DEV rollout (live)

```sh
# pre-state + verified backup (640 KB custom format, 20 TABLE DATA entries; 0 queued/running AI runs)
/opt/szronox-dev/backups/pre-4f7cfbb/{database.dump,runtime.env,schema_migrations.before.txt,containers.before.txt,neighbours.before.txt,build-4f7cfbb.log}
git archive 4f7cfbb | gzip -n    # sha256 36b1d1895c161d92…, identical after scp
docker build -f /opt/szronox-dev/config/Dockerfile.deploy -t szronox-dev:4f7cfbb /opt/szronox-dev/app.4f7cfbb
mv app app.pre-4f7cfbb && cp -a app.4f7cfbb app          # app.pre-4f7cfbb == d82cefc source
sed SZRONOX_RELEASE=d82cefc -> 4f7cfbb                    # only key changed (diffed)
config/dc-gemini.sh run --rm --no-deps migrate            # 10 files checked; 1 applied
config/dc-gemini.sh run --rm --no-deps grants             # exit 0 (file unchanged, rerun per order)
config/dc-gemini.sh up -d --no-deps api worker
```

- `/api/v1/ready` reports ready on both loopback 3011 and HTTPS. API and worker both show `privilegeEnforcement: enforced` with `privilegeViolations: []`, and the worker shows `aiLifecycle: enabled`.
- Live schema:
  - the column is a nullable uuid with no default
  - `reels_selected_hook_fk` = `FOREIGN KEY (id, selected_hook_id) REFERENCES app.reel_hooks(reel_id, id) ON DELETE SET NULL (selected_hook_id)`
  - 10 migrations are applied
  - all 19 existing Reels have null selection
  - counts before and after the migration: reels 19, hooks 22, ai_runs 25, operations 94
- Role probes in rolled-back transactions:
  - worker: denied `selected_hook_id` update and hook delete; allowed version update
  - API: allowed `selected_hook_id` update; denied `ALTER` (not owner)
- `/sw.js` and `/manifest.webmanifest` return 200 with the correct MIME type and `max-age=0`. The served bundle `index-8FcplYkQ.js` contains `✓ WYBRANY`, `Edytuj hook`, `selected-hook` and the Polish refusal copy.
- Neighbours `app-api-1`, `app-web-1`, `cutroom-postgres-1`, `szronox-app-1` and `szronox-dev-postgres-1` have identical StartedAt values before and after. Caddy MainPID is 170439 and the Caddyfile sha256 `c672bd75…` is unchanged. No Caddy, DNS, production or kDrive changes.

### Live API acceptance: 17/17 over the real HTTP API, 1 Gemini call

Host script: `/opt/szronox-dev/config/hooks-live-20260923.mjs`. It mints and revokes a session through the app's own store, like `ai-smoke.mjs`, and reads no credentials. Results:
- Capture with an initial hook, and two added hooks, left the selection null.
- Selecting the second hook returned 200: version +1, `scriptRevision` unchanged, persisted on detail reload.
- Replay returned the original result. A reused operation ID with another hook returned 409 `IDEMPOTENCY_CONFLICT`. A stale version returned 409 `EDIT_CONFLICT` with `currentVersion`.
- Cross-Reel 404, unknown 404, malformed 422, and a missing CSRF token 403. None of them changed the version.
- Editing the selected hook kept ID, source, createdAt, position and selection. A stale edit returned 409.
- Deleting an unselected hook kept the selection.
- Opracuj snapshotted `selectedHookId` plus both hooks with prompt v3 and succeeded on the live worker. It appended 2 AI hooks and the selection was unchanged.
- Deleting the selected hook cleared the selection with no replacement.
- Disposable Reels `b2920091-…` and `12ef2558-…` were soft-deleted and can be restored from Usunięte.

## Rollback (retained, not executed)

Retained: previous source `app.pre-4f7cfbb` (= `d82cefc`), previous image `szronox-dev:d82cefc`, and backup `backups/pre-4f7cfbb/`.

**Migration 0010 stays in place.** It is additive, and `d82cefc` stays compatible with it:
- It selects explicit column lists, so it never reads `selected_hook_id`.
- New Reels get the null default.
- Its hook delete still works: the FK action clears a stored selection, and the API role has UPDATE on `app.reels`.
- The worker never writes that column.

Selections stored under 4f7cfbb stay in the database, invisible to the old UI, and reappear on roll-forward.

Steps:
1. Optional quiescence: `select count(*) from app.ai_runs where state in ('queued','running') and prompt_id like '%-v3'`. An old worker would process such a develop run without the selected-hook context under a v3 label.
2. Restore `app.pre-4f7cfbb` as `app`.
3. Restore `backups/pre-4f7cfbb/runtime.env`.
4. Run `config/dc-gemini.sh up -d --no-deps api worker`.

Do not restore the database dump for a code rollback: it would discard later user activity.

## Findings

- **OPEN REAL-WORLD GATE (manual browser check).** No authenticated browser session was used, so the HOOKI rows have not been clicked through on DEV. This covers row tap and keyboard selection, the `✓ WYBRANY`/`WŁASNY` rendering and density at 360 px, `✎` → `Gotowe`/`Anuluj`, conflict and offline draft retention, and that `✎`/`×` do not select. The evidence so far is the served bundle, typecheck/build, source-level assertions and the live API behaviour behind every control. One human pass on a disposable Reel closes this gate.
- **ACCEPTED (decisions):**
  - Tapping the selected row clears the selection.
  - Selection and hook drafts are not queued offline. They report truthfully instead.
  - Hook drafts are in memory for the session and do not survive an app reload.
  - Selection does not stale an Opracuj run.
  - The `PROMPT_ID` label moved to v3 for every action.
  - The Opracowanie workspace (a frozen surface) does not show `✓ WYBRANY`.
- **ACCEPTED:** Real concurrent PostgreSQL sessions were not exercised (PGlite is single-connection, and the live checks are sequential). Correctness under overlap rests on the Reel-row version lock that both select and delete take first, plus the database-enforced FK. The real-PG concurrency gate remains VPS-06's.
- **ACCEPTED:** The develop prompt remains provisional development wording.

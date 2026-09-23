# PUBLICATION-01 — result: separate publication generation from Opracuj

Date: 2026-09-23. Manual Claude Code session, model **Opus 5.5 (`claude-opus-5-5`)**. No nested agents.
Handoff: `PUBLICATION-01-opus-handoff.md` (root, untracked user file; deliberately not committed so the merge could not collide with it).

| | |
| --- | --- |
| Branch / worktree | `codex/publication-01` / `.worktrees/publication-01`, from `fbf3e58` |
| Implementation commits | `2f88810` (split), `cd7d176` (prompt id v2) |
| Merge commits on master | `8d3b827`, `d82cefc` (no conflicts; master had not moved) |
| **Deployed** | `szronox-dev:d82cefc`, image `sha256:983fae81cc89…`, API and worker both, 0 restarts |
| Previous live | `szronox-dev:6b9032f` (`25bd7a84e771`) |

## Decision: ACCEPTED / NO FURTHER TESTING NOW — with one OPEN REAL-WORLD GATE (browser UI)

## What changed

- `develop` prompt, schema and result no longer contain publication description/hashtags. Script proposal applies only through `Zastosuj` (label changed from `Użyj scenariusza`). Develop staleness no longer depends on publication fields.
- New typed action `generate_publication` (contracts, API allowlist, `latest` filter, worker schema/branch, UI maps). Server snapshots the saved script with `scriptRevision`; empty/whitespace script refused before any run (`VALIDATION_ERROR`, `reason=script_required`); image upload gate and image/source reading skipped for this action only.
- Result `PublicationResult`: separate `OPIS` / `HASHTAGI`. Completion writes nothing. Per-field apply keeps `expectedVersion`, `replaceCurrentValue`, `confirmReplacement`, idempotency; new `STALE_PUBLICATION_RESULT` when script text or revision changed. Applying from `develop` runs is refused (`reason=wrong_action`); recorded replays still return their original outcome.
- UI: `Wygeneruj opis` in PUBLIKACJA; refused with Polish explanation while any edit is unsaved (edits kept, not saved/discarded) or the saved script is empty. Publication view: editable proposals, saved value shown, `Zastosuj` on empty target, confirm/`Zachowaj` on filled target, `Wygeneruj ponownie`. A stale latest proposal is regenerated rather than reopened.
- `PROMPT_ID` → `gemini-02-development-provisional-v2`, so historical v1 runs keep their provenance. Stage stays `development_provisional`.
- Migration `0009_generate_publication_action.sql` (additive check-constraint replacement).
- `ClientApiError` rewritten without TS parameter properties (identical behaviour) so Node's type-stripping test runner can load `errors.ts`.

Changed files: `packages/contracts/src/index.ts`; `apps/api/src/ai/{service,routes,service.test}.ts`; `apps/worker/src/ai/{actions,actions.test}.ts` (`jobs.ts` unchanged); `apps/web/src/{app/App.tsx, controllers/useAppController.ts, data/errors.ts, screens/AiWorkspace.tsx, screens/PublicationSection.tsx, ui/screen-contracts.ts}`; new `apps/web/src/data/tests/publication-generation.test.mjs`; `database/migrations/0009_generate_publication_action.sql`; `deploy/vps/ai-smoke.mjs`; `docs/implementation/{T00-contracts,tasks}.md`. No dependency or lockfile change.

## Local checks (worktree, macOS, `npm ci` from lockfile)

```sh
npm run build --workspace @szronox/contracts --workspace @szronox/api --workspace @szronox/worker   # PASS
npm run typecheck --workspace @szronox/web && npm run build --workspace @szronox/web             # PASS
node --test apps/api/dist/ai/service.test.js          # 14/14 (9 new/changed)
node --test apps/worker/dist/ai/actions.test.js apps/worker/dist/ai/source.test.js   # 14/14
(cd apps/web && npm run test:t08 && npm run test:share && npm run test:list-01)       # 19/19, 21/21, 17/17
```

API cases (PGlite, **simulated**): snapshot/upload gate; empty and whitespace script (no run row); nothing persisted on completion; each field alone, both sequentially with refreshed version; unconfirmed replacement; cross-action script/title refused; intervening target edit; script change and edit-and-revert; unrelated metadata change is not stale; duplicate replay and payload mismatch on apply and enqueue; legacy develop readable, not applicable, recorded replay preserved; migration applied on an 0001–0008 database with a historical develop row unchanged, new action accepted, invented action rejected, exactly one action check. Worker: develop prompt/schema/result has no publication fields; publication prompt contains only the script (no materials, images or source fetch); empty description rejected; finalization does not touch hooks or the Reel (fake pool).

## DEV rollout (live)

```sh
# backup (verified: 630 KB custom-format, 20 TABLE DATA entries)
/opt/szronox-dev/backups/pre-d82cefc/{database.dump,runtime.env,schema_migrations.before.txt,containers.before.txt}
git archive d82cefc | gzip   # sha256 f914f033…900b5d, identical after scp
docker build -f /opt/szronox-dev/config/Dockerfile.deploy -t szronox-dev:d82cefc /opt/szronox-dev/app.d82cefc
mv app app.pre-d82cefc && cp -a app.d82cefc app
sed SZRONOX_RELEASE=6b9032f -> d82cefc   # only key changed (diffed)
# 0 queued/running AI jobs checked before migration and before rollout
config/dc-gemini.sh run --rm --no-deps migrate   # 9 files checked; 1 applied
config/dc-gemini.sh run --rm --no-deps grants    # exit 0
config/dc-gemini.sh up -d --no-deps api worker
```

- `/api/v1/ready` ready (loopback 3011 and HTTPS); API and worker `privilegeEnforcement: enforced`, `privilegeViolations: []`, worker `aiLifecycle: enabled`.
- Live constraint now includes `generate_publication`; 9 migrations; historical run counts unchanged; 1,423 active corpus proposals unchanged.
- Role probes in rolled-back transactions: worker denied script update, `user_credentials`, `auth_sessions`, `programme_versions` insert, allowed `version` update; API role denied `programme_versions` insert and `ALTER` on `ai_runs` (not owner).
- `/sw.js`, `/manifest.webmanifest` 200, correct MIME, `max-age=0`. Served bundle contains `Wygeneruj opis`, not `Użyj scenariusza` / `OPIS DO PUBLIKACJI`.
- Neighbours `app-api-1`, `app-web-1`, `cutroom-postgres-1`, `szronox-app-1`, and `szronox-dev-postgres-1` have the same StartedAt values before and after. Caddy MainPID 170439, Caddyfile sha256 `c672bd75…a9a03` unchanged. No Caddy/DNS/production edits.

## Live provider acceptance: 17/17 through the real HTTP API, 2 Gemini calls

Host script `/opt/szronox-dev/config/publication-live-20260923.mjs` (session minted and revoked like `ai-smoke.mjs`; no credential read). Opracuj succeeded with prompt v2, returned no publication keys, and left script/description/hashtags/revision unchanged. Publication apply from that run was refused with `422 wrong_action`. `Zastosuj` applied the script. `Wygeneruj opis` succeeded: two separate proposals (244-char description; hashtags `#komunikacjamiejska #tramwaje #cenybiletow #nowetrasy`), snapshot = saved script, nothing persisted, version unchanged. A wrong baseline got 409 `EDIT_CONFLICT`. Confirmed OPIS replacement worked, then HASHTAGI from the same run at the refreshed version. A later script edit gave 409 `STALE_PUBLICATION_RESULT`. An empty-script Reel was refused (422, no run row). Both disposable Reels (`70a035fc-…`, `608892ed-…`) were soft-deleted and can be restored from Usunięte.

## Rollback (retained, not executed)

Previous source `app.pre-d82cefc` (= 6b9032f), previous image `szronox-dev:6b9032f`, backup `backups/pre-d82cefc/`. Migration 0009 stays in place: it is additive, and 6b9032f only writes the five older actions. 6b9032f's API reads `generate_publication` rows without crashing (the default relevance branch), its UI never requests that action, and its apply path refuses publication selections on non-develop runs. **Quiescence step before downgrading the worker:** `select count(*) from app.ai_runs where action='generate_publication' and state in ('queued','running')` must be 0. Otherwise let the jobs finish, or mark them `failed` with `PROVIDER_UNAVAILABLE`. Old workers would fail them as `INVALID_AI_RESULT`, which is truthful but misleading. Then restore `app.pre-d82cefc` as `app`, restore `backups/pre-d82cefc/runtime.env`, and run `dc-gemini.sh up -d --no-deps api worker`. Do not restore the database dump for a code rollback.

## Findings

- **OPEN REAL-WORLD GATE:** No authenticated browser session was available, because browser tooling was declined. The UI path has not been clicked through on DEV: the Opracowanie `Zastosuj` label, PUBLIKACJA `Wygeneruj opis`, the unsaved-edit refusal message, the publication proposal view, and confirm/`Zachowaj` with existing copy retained. Evidence covers the served bundle, typecheck/build, source-level tests and the live API behaviour behind every button. A human check on one disposable Reel closes this.
- **ACCEPTED:** Web component behaviour has no DOM test harness in this repo. UI wiring checks are static source assertions, stated as such.
- **ACCEPTED:** The publication prompt remains provisional development wording. The editorial style is not frozen.

# CAPTURE-SCRIPT-01 implementation result

Status: implemented in the assigned worktree; ready for root review and integration. DEV deployment was not performed.

## Changed files

- `apps/web/src/screens/QuickAddScreen.tsx`, `apps/web/src/ui/screen-contracts.ts`, `apps/web/src/app/App.tsx`, and `apps/web/src/screens/preview/DevPreview.tsx`: compact `Pomysł` / `Gotowy skrypt` tabs beside the main text field; controlled choice is preserved while toggling and the text is unchanged.
- `apps/web/src/drafts/store.ts` and `apps/web/src/drafts/create-request.ts`: optional persisted mode defaults legacy drafts to `Pomysł`; create payload captures exact nonblank script intent alongside the unchanged mixed input.
- `apps/web/src/controllers/useAppController.ts`: stores the request payload with the create queue item before flushing. The queue's existing pass-through replay retains that exact payload through offline recovery.
- `apps/api/src/core/routes.ts` and `apps/api/src/core/repository.ts`: validates `initialScript` as a string exactly equal to nonblank `input.text`; creates `script`, `scriptRevision=0`, and verbatim `originalInput` within the existing idempotent transaction. Direct-script mode leaves `inputNote` empty; omitted `initialScript` keeps existing idea behavior.
- `apps/api/src/core.test.ts` and `apps/web/src/drafts/tests/create-request.test.mjs`: focused API and queued-request regression coverage.

## Verification

- `npm ci --include=dev` — PASS; installed the existing lockfile dependencies. No lockfile change.
- `npm run build --workspace @szronox/contracts` — PASS.
- `npm --workspace @szronox/api run build` — PASS.
- `node --test --test-name-pattern='direct-script capture' apps/api/dist/core.test.js` — PASS, 2 tests: exact script/input persistence with revision 0, empty input note, replay; blank/mismatch rejection without a partial Reel.
- `node --experimental-strip-types --test apps/web/src/drafts/tests/create-request.test.mjs` — PASS, 2 tests: exact mixed input and script survive queued snapshot while later toggles/edits do not reinterpret it; legacy/empty script semantics.
- `npm --workspace @szronox/web run typecheck` — PASS (app and service worker TypeScript).
- `git diff --check` — PASS.

## Limits

No browser/device acceptance, real offline network interruption, provider, or DEV deployment gate was run. Queue recovery coverage verifies the exact serialized request mapping and relies on the existing IndexedDB queue's tested persistence/pass-through behavior. The API tests use the repository's PGlite test database, not a live PostgreSQL server.

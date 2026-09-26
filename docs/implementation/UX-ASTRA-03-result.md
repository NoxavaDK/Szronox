# UX-ASTRA-03 — Luna implementation result

Status: bounded implementation complete; awaiting root review and the agreed Opus/Astra verification. No merge or deployment.

## Baseline and scope

- Rebased implementation baseline: `011b628` (`Implement publication context and workspace UX`), with latest approved source-collapse pin `37d687e` (`Apply latest Astra collapsed-source default`). Root pin: `ad31cc8`.
- Changed only the dispatch allowlist: App workspace/drawer, controller draft/save behavior and tests, Reel labels and tests, Detail/List/Publication surfaces, shared UI primitives/sections/contracts/tokens. No shared root contracts, migrations, API/worker code, dependencies or lockfiles changed.
- Implemented A1–A7: serialized per-Reel scalar sends and durable switching; per-Reel conflict/save/draft state; current-Reel unsaved-hook prerequisite; selection and hook affordances; readable source identity; 600–760px Detail; intermediate drawer and modal keyboard lifecycle; contextual action hierarchy; informative section summaries; restrained priority/metadata colors and contrast; reserved logout; mobile status choices.

## Verification

- `node --experimental-strip-types --test apps/web/src/controllers/tests/draft-switch.test.mjs` — PASS, 9/9. Covers immediate switch after durable local retention, server latency, failed local write, current-Reel unsaved hook edits, queued delete/save ordering, latest conflict choice, and blocked-Reel switching.
- `node --experimental-strip-types --test apps/web/src/data/tests/reel-label.test.mjs` — PASS, 17/17. Covers authored-title preservation, saved-share preference, URL/path labels, tracking and opaque IDs, images, fallbacks, and no source mutation.
- `npm run typecheck --workspace @szronox/web` — PASS (`tsc` app and service-worker configs).
- `npm run build --workspace @szronox/web` — PASS (Vite app and service-worker builds).
- `git diff --check` — PASS.
- `node /private/tmp/luna-uxastra03/ux-verify2.mjs` — PASS, 17/17 synthetic browser checks. Covered 1.5s scalar-save latency without self-conflict, a real concurrent conflict and explicit latest-local choice, per-Reel conflict retention, and unsaved hook edit retention/publication blocking.
- `node /private/tmp/luna-uxastra03/ux-astra03-check.mjs` — PASS, 15/15 synthetic browser checks. Confirmed 1440px two-pane/760px Detail; 1100px two-pane/Plan on demand; drawer focus, Shift+Tab, Escape and focus restoration; no horizontal overflow and discoverable statuses at 390/360/320px; hook and Sources defaults; unselected-hook action; collapsed Publication summary; no page exceptions. The duplicate-Detail candidate check executed schedule cancel → Back → waited for the list row to be ready → switch, then counted exactly one visible title, Back control and script field (`Pusty pomysł`).
- Harness: isolated local browser against synthetic PGlite fixtures and the test session harness; no production/DEV product data or live provider calls.

Representative screenshots from that browser pass:

- Desktop (1440px): `/private/tmp/luna-uxastra03/astra-1440.png`
- Mobile (390px): `/private/tmp/luna-uxastra03/astra-390.png`
- Drawer (800px): `/private/tmp/luna-uxastra03/astra-800.png`

## Findings and limits

- **BLOCKER:** none known.
- **CORRECTION NEEDED:** none known from this bounded pass.
- **ACCEPTED / NO FURTHER TESTING NOW:** the reported duplicate Detail was not reproduced on the candidate after schedule cancel, Back/list readiness, and Reel switch; the sequence and visible counts are recorded above. No speculative navigation rewrite was made.
- **OPEN REAL-WORLD GATE:** no enlarged-text/actual browser zoom pass was available in the harness; widths were measured in CSS pixels. Live provider output quality remains unverified. Root's requested Opus/Astra review remains pending.

## Changed files

- `apps/web/src/app/App.css`, `apps/web/src/app/App.tsx`
- `apps/web/src/controllers/draft-switch.ts`, `apps/web/src/controllers/tests/draft-switch.test.mjs`, `apps/web/src/controllers/useAppController.ts`
- `apps/web/src/data/reel-label.ts`, `apps/web/src/data/tests/reel-label.test.mjs`
- `apps/web/src/screens/PublicationSection.module.css`, `apps/web/src/screens/PublicationSection.tsx`, `apps/web/src/screens/ReelDetailScreen.module.css`, `apps/web/src/screens/ReelDetailScreen.tsx`, `apps/web/src/screens/ReelListScreen.module.css`, `apps/web/src/screens/ReelListScreen.tsx`
- `apps/web/src/ui/detail-sections.module.css`, `apps/web/src/ui/detail-sections.tsx`, `apps/web/src/ui/primitives.module.css`, `apps/web/src/ui/primitives.tsx`, `apps/web/src/ui/screen-contracts.ts`, `apps/web/src/ui/tokens.ts`
- `docs/implementation/UX-ASTRA-03-result.md`

Commit: `b26118b` (`Implement Astra usability corrections`).

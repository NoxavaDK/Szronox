# UX-ASTRA-03 — approved Astra usability corrections

Status: explicitly approved by the operator on 2026-09-26, including launch/resumption of Luna. One bounded continuation of the pending UX implementation. No merge or deployment.

## Exact task and ownership

- **Task:** implement the remaining actionable corrections from Astra's latest live DEV review, preserving the existing UX-PUBLICATION-02 implementation, and fix the concrete navigation/draft/accessibility defects identified by Opus's verification.
- **Model:** `gpt-6-luna`, high reasoning. Suitability: continuation of its existing UI/controller implementation with root-owned behavioral pins. Difficulty: high because visual changes meet navigation, local drafts and versioned scalar saves.
- **Worktree/branch:** `/Users/kubabilski/Desktop/SzroNox/.worktrees/ux-publication-02`, `codex/ux-publication-02`. Starting implementation: `3425bc90b33e259dc107decd12c63b5284b7d08b`. Rebase onto the root dispatch-pin commit before editing; root has advanced with documentation and Opus's report only. Record the rebased implementation baseline and new correction commit.
- **Dependencies:** current root T00, this dispatch, UX-PUBLICATION-02 dispatch, `UX-PUBLICATION-02-opus-review.md`, the two frozen written visual specifications, existing selected-hook records, current publication slots, existing local draft store and scalar mutation/version contracts. No new schema or API contract is assigned.
- **Lead:** root owns shared contracts, review and integration. Luna may not spawn nested agents or edit root master.

Luna's editable files:

- `apps/web/src/app/App.tsx`, `App.css`.
- `apps/web/src/controllers/useAppController.ts`, `draft-switch.ts`, optional new bounded `scalar-save-queue.ts`, and adjacent tests in `apps/web/src/controllers/tests/` for these behaviors.
- `apps/web/src/data/reel-label.ts`, `apps/web/src/data/tests/reel-label.test.mjs`, and adjacent publication-generation tests only if their current-Reel prerequisite assertions need updating.
- `apps/web/src/screens/ReelDetailScreen.tsx`, `ReelDetailScreen.module.css`, `ReelListScreen.tsx`, `ReelListScreen.module.css`, `PublicationSection.tsx`, `PublicationSection.module.css`, `PlannerPane.tsx`, `PlannerPane.module.css`, `ScheduleSheet.tsx`, `ScheduleSheet.module.css`, and adjacent tests for these named surfaces.
- `apps/web/src/ui/primitives.tsx`, `primitives.module.css`, `detail-sections.tsx`, `detail-sections.module.css`, `screen-contracts.ts`, `tokens.ts`, `tokens.css`, `workspace-layout.ts`, `StatusSelector.tsx`, `StatusSelector.module.css`, and adjacent tests for these named files.
- New handoff only: `docs/implementation/UX-ASTRA-03-result.md`.

Root-owned/read-only: AGENTS.md, other implementation/product/design documents, `packages/contracts/**`, API/worker code, migrations, dependencies and lockfiles. Ask the lead before editing anything outside the list. Browser harness scripts and generated evidence may live in `/private/tmp`; never commit credentials/session tokens.

## Baseline adjudication

Astra inspected live DEV, which still showed the earlier three-pane workspace, status tabs and publication ordering. The pending `3425bc9` implementation already supplies two-pane default, optional three/focus, intermediate drawer, compact Status filter with Wszystkie, selected-hook alternatives, contextual section defaults, publication generation before fields, cover focus and PUBLICATION-02. Preserve those implementations; close remaining presentation gaps and test their composition. Do not rebuild them or reverse the approved default to mandatory three panes.

Astra's duplicate-Detail observation is a real reported defect, but its cause is unassigned. Reproduce scheduling cancellation followed by switching Reels on the candidate code. Count visible Detail surfaces, Back controls and script fields; hidden selector/plan copies retained for browsing context are not a duplicate Detail. Fix a reproduced cause and add a regression. If the candidate already prevents it, record the exact checked sequence and evidence without inventing a fix.

## Concrete action points

### A1 — reliable switching and scalar saves (highest priority)

Apply Opus's confirmed corrections from `UX-PUBLICATION-02-opus-review.md`:

1. A durably retained draft on a conflict-blocked Reel must permit switching without requiring a network send. Keep its conflict attached to that Reel. Further typing during a conflict cannot trap navigation or produce a misleading network error. A failed local draft write still keeps the current Reel open with the true storage error.
2. Serialize scalar PATCH sends per Reel. A second patch typed while the first is in flight waits, then uses the version returned by the first when no external conflict intervened. Prevent the client's own save from causing a false 409. Keep late responses, queued/offline data, conflict choices and save feedback attached to the originating Reel. Older responses must not clear newer drafts. An actual concurrent edit still requires explicit conflict resolution.
3. Investigate and cover Astra's mobile cancel-schedule/switch duplication sequence. Never show an old Reel's editable content under a new identity/URL. Preserve per-Reel section choices and appropriate reading/scroll position; avoid carrying one Reel's arbitrary scroll offset into another.
4. Drawer: `aria-modal`, focus on open, contained Tab/Shift+Tab, Escape closes and restores focus to its trigger. Hidden views must remain hidden/inert to keyboard users. Reuse the existing sheet interaction pattern where practical.
5. Contextual AI shortcuts must respect the same capability and current-Reel prerequisites as the existing AI row and publication action. Disabled/unavailable AI cannot open a dead workspace through the primary shortcut.

### A2 — unmistakable Reel and hook selection

- Pass the selected Reel identity into Rolki/Plan presentation. Use a pale existing-accent selection surface, a clear marker and a programmatic current-state signal. Urgency remains red and distinguishable from selection.
- Keep the explicitly selected hook first and alternatives behind `Pozostałe hooki (n)`. Strengthen selected treatment with check/text and clear selection affordance. If candidates exist and none is selected, show `Wybierz hook` at the hook section even when the contextual primary action must prioritize production/publication work.
- Make hook editing discoverable with a clear visible/accessibility label; keep deletion secondary and separate. Preserve explicit selection, additive generation, IDs/order/provenance and unsaved hook edits. No per-hook Użyj action or automatic selection.

### A3 — readable identity, two-line titles and source domain

- Authored titles remain exact and always win. Derived display labels may prefer a saved non-URL original-share title and meaningful saved capture text/additionalText before a bare URL. Avoid letting a URL-only first field obscure available human-readable context.
- For URL-only captures, derive a conservative label from a readable decoded path when available, ignoring tracking and obvious opaque/numeric IDs; otherwise use an honest `Materiał z <domain>` fallback. Show the source domain separately as secondary information. Do not fetch a page, invent a topic, use AI, persist a guessed title, or rewrite/truncate original input.
- List titles may wrap to two lines rather than being aggressively truncated on the first line. Detail's editable title/derived placeholder must remain readable at 360–390px, with domain below. Keep the main field editable and distinguish authored/derived values.
- Search continues to match authored or displayed derived labels. Image/empty captures retain truthful fallbacks and stable provenance.

### A4 — desktop space and Plan

- Keep Rolki/Plan plus editor as the default and retain Reels plus editor on smaller laptops. Plan remains available on demand; optional three-pane Plan can collapse without closing or changing the current Reel.
- Let the desktop Detail use approximately 600–760px when space permits, with readable script/source text measure rather than a phone-width outer container. Conceptual side widths: Plan 240–280px, Reels 300–360px; choose actual widths from fit, including enlarged text.
- Empty Plan should have compact content and a useful empty state, not dominate the default working view. Preserve selected Reel, filter/search/scroll, layout preference, agenda grouping, overdue state, date/slot validation and accessible rescheduling. No calendar grid/new event object.

### A5 — primary action and publication hierarchy

- One relevant contextual primary action uses the existing accent with a compact filled treatment. Supporting checks (`Fakty`, `Język`) stay quieter. `Opracuj` must be recognizable as the writing action; avoid two competing filled primaries when it is also the contextual action.
- Preserve generation before description/hashtags. With empty copy, `Wygeneruj opis` and its prerequisites are clear; with copy present, `Kopiuj opis` becomes easier to identify near the existing text. Description/hashtags remain separate fields; copy composition/failure behavior and explicit per-field AI apply are unchanged.
- Preserve no silent save/apply/status advance. Contextual AI availability and unsaved current-Reel hook/scalar prerequisites are enforced consistently.

### A6 — informative supporting sections

- Closed Materials communicates `Brak eksportu` or current export/verification state; publication communicates relevant `Brak opisu`, `Okładka niegotowa`, existing copy or published summary. Nonempty editing notes and captured sources have concise truthful summaries.
- Keep empty-script input visible as approved; after a saved script exists, sources start collapsed. Materials and Publication open according to existing stage/explicit-entry defaults, with manual overrides per Reel.
- All expansion indicators and `aria-expanded` agree with the visible content, including Sources and Publication. Closed sections must not all look like identical unexplained links.

### A7 — restrained semantic color, contrast and consistency

- Existing accent: primary action/current Reel/hook selection. Green plus check/text: completion/ready where meaningful. Amber plus explanation: relevant missing prerequisites/attention. Red plus label/icon: exceptional urgency/destructive actions. Neutral: ordinary content/metadata/unavailable controls. Do not color every status.
- Make normal priority neutral, including its metadata/selector treatment. Keep hook provenance, secondary metadata and logout quieter while maintaining legibility.
- Increase original source-text and unavailable kDrive explanation contrast. Strengthen empty editable-field affordance with subtle neutral field treatment/focus state, preserving flat editorial style.
- Style `+ Mem` and hook controls consistently with the existing components. Destructive controls stay secondary/in overflow.
- Move logout into a reserved, quiet layout position so it never overlaps the toolbar, mobile overflow or avatar. Tighten mobile header spacing without clipping targets.
- The compact Status select already replaces the overflowing tabs: retain it and confirm all choices, including Gotowe, are discoverable at 320/360px. Do not reintroduce horizontal tabs.

## Acceptance and verification budget

Implementation agent owns focused tests and one changed-boundary browser pass. Use synthetic local fixtures or already configured development test access; no production/DEV product data mutation, provider calls or deployment.

- Draft/controller regressions: conflict plus further typing then switch; failed local retention; two scalar edits at simulated ~1.5s latency without self-conflict; genuine concurrent conflict; latest local choice; late save from another Reel; unsaved hook selection/edit retained.
- Navigation/browser: cancel schedule then switch repeatedly; exactly one visible Detail/Back/script; drawer keyboard lifecycle; unavailable AI shortcuts; selected row signal; remembered section/layout/search context.
- Presentation at 1440, 1100, an intermediate drawer width, 390, 360 and 320 CSS px, plus enlarged text/zoom where the harness supports it: no overflow/overlap, readable title/domain, useful editor width, Plan collapse, hook hierarchy, primary action, section summaries, chevrons, source/kDrive readability and editable affordances. Record actual browser zoom versus width approximation honestly.
- Label fixtures: authored title wins unchanged, saved share title, bare URL plus meaningful accompanying text, readable/opaque URL path, tracking, images, empty fallback and no persistence/source mutation.
- Run one web build/typecheck after implementation plus targeted changed tests. Do not rerun accepted PUBLICATION-02 API/worker suites or the full existing planner acceptance. No second reviewer/full suite for independent confirmation.

Handoff: exact changed files, task baseline/new commit ID, commands/results, browser evidence, known limitations and explicit UNVERIFIED gates, with findings classified BLOCKER / CORRECTION NEEDED / OPEN REAL-WORLD GATE / ACCEPTED. No merge. Root performs bounded diff/integration review and prepares the result for the agreed Opus/Astra verification sequence.

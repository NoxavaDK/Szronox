# T06 — visual primitives and controlled non-AI screens: result

Base: integrated root baseline `master` @ `d9e062b` ("Record accepted integration and propose non-AI implementation batch"), which already contains accepted C01 `5cae797`, C02 `da223c3` and C03 `a01e650`. New isolated worktree `agents/t06-screens`, branched fresh from that commit (not from any other task's worktree). Agent: Claude (Sonnet 5) in Claude Code, substituted for the originally proposed `gpt-5.6-luna` with the user's explicit approval ("Do T6 instead of Luna"), mirroring the earlier C01 substitution — that model/agent is not available in this environment.

Scope: exactly the T06 entry in `docs/implementation/next-non-ai-batch.md` — tokens, small reusable controls, and controlled screen components for Rolki (list), Nowy pomysł (quick add), Reel Detail and inline PUBLIKACJA, per `design/frozen-visual-spec.md` sections 1, 2, 3, 4 and 6. No network, persistence, routing, or AI-result composition. Sections 5/7/8/9 (Opracowanie, Sprawdź postulat, attached proposition, Sprawdź fakty) are AI-result surfaces outside T06 and were not touched.

## What was built

All new files, entirely inside the allowed `apps/web/src/ui/**` and `apps/web/src/screens/**`:

- **Tokens**: `ui/tokens.css` (CSS custom properties: colours, typography scale, spacing, touch target, row heights, reference/reflow widths) and `ui/tokens.ts` (the JS-side mirror needed for a few colour/label lookups — priority colour and Polish label per `Priority`).
- **Contracts**: `ui/screen-contracts.ts` — the props/intent surface for all four screens, built by deriving view types (`Pick`/unions) from the real `@szronox/contracts` wire types (`Id`, `Priority`, `ReelStatus`, `ReelHook`, `User`, `VerificationState`). Nothing here forks or weakens a canonical wire type. Load state (`LoadState`) and per-mutation feedback (`SaveState`) are kept as separate unions since a list load and a field save are different things.
- **Primitives** (`ui/primitives.tsx` + `.module.css`, `ui/StatusSelector.tsx` + `.module.css`, `ui/icons.tsx`): `Avatar`, `TextAction`, `Button`, `PriorityGlyph`/`PrioritySelector` (the frozen "! Pilne ● Normalne ∞ Evergreen" row — not generic radio circles), `CoverIndicator` (the feed-cover pictogram, neutral vs. pictogram+check, accessible name "Okładka do feedu"), `SectionRow` (chevron row), `FloatingAddButton`, `StatusBanner` (empty/loading/offline/error/conflict presentation), `AttentionStrip`, `CompactTabs`, `StatusSelector` (the Rolki status tabs with counts and cobalt underline). Icons are small hand-written inline SVGs (chevron, back arrow, plus, overflow, external link, check, close, cover pictogram, warning) — no icon library dependency, since none was already present and package/lockfiles are outside T06's allowlist.
- **Screens**: `screens/ReelListScreen.tsx`, `screens/QuickAddScreen.tsx`, `screens/ReelDetailScreen.tsx`, `screens/PublicationSection.tsx` (each with a co-located `.module.css`).
- **Dev fixtures/preview**: `screens/fixtures.ts` (realistic sample data — multi-word titles, a null editor, a null verification state, an outdated one, a verified one) and `screens/preview/DevPreview.tsx` (a stateful wrapper around all four screens with a screen picker and a 360/320/400px width picker, for local visual inspection — see "Verification" below for how it was actually used and its limits).
- `ui/css-modules.d.ts`: an ambient `declare module '*.module.css'` — needed because Vite's own `vite/client` CSS-module typings aren't referenced anywhere in this project (plain `.css` side-effect imports happen to typecheck without it, but `.module.css` default-export imports do not); without this, every component would fail `tsc`.

## Key spec/architecture decisions and why

- **No status chip in list rows.** The list is always filtered to exactly one status (there is no "all" tab), so a row's own status always equals the selected tab's status. Per the spec ("do not repeat Reel status in a row when the list is already filtered by that status"), the row never renders one at all — not even conditionally on a prop — since that condition is always true in this product.
- **Feed-cover indicator in the list is conditional on `selectedStatus`, not a caller prop.** The spec says it "may be surfaced where operationally useful, especially Montaż/Gotowe" but must not be forced into every row/status. Since `ReelListScreen` already receives `selectedStatus`, I treated "which statuses show it" as a presentational rule belonging here (`editing` and `ready`) rather than pushing a new boolean prop onto every list item. This is a judgment call the lead can override without a contract change — it's a one-line condition in `ReelListScreen.tsx`.
- **Kopiuj opis is intent-only.** The exact two-newline join, empty-field rule and truthful clipboard-failure handling are explicitly T08's acceptance criteria (T08 §8 in `next-non-ai-batch.md`), not T06's. `PublicationSectionProps.onCopyDescription` is a bare `() => void`; T06 does not compute the joined string or touch `navigator.clipboard`.
- **Hook order and "Twój hook" tag.** Hooks render sorted by `position` (T00: "position provides stable order; do not implement a primary-hook selector"). The `TWÓJ HOOK` tag on `source === 'user'` hooks is specified for the Opracowanie workspace (§5, out of T06's scope) but applies to the same `ReelHook.source` field shown in Reel Detail §4's "central content, not form cards" hooks — reusing that established convention here is applying a already-frozen rule to the same data, not inventing new design.
- **AI action row is genuinely inert**, not just visually muted: the three buttons (`Fakty`, `Aa Język`, `✦ Opracuj`) are real `disabled` HTML buttons with no click handlers, matching "capability-disabled treatment is permitted for this partial milestone" and "compact AI row stays nonfunctional for this milestone."
- **Detected-share compact chip vs. full type selector** (`QuickAddScreen`) is local component state (`selectorRevealed`), not a prop — it's a pure reveal toggle that never touches domain data, seeded from `detectedKind !== null` and flipped by the "Zmień" action. Everything it reveals (the actual `CompactTabs` selector) is still fully controlled by `selectedKind`/`onChangeKind` props.
- **Width-pressure information priority** (list row: title → urgency/elapsed → editor → verification → programme → meme) is implemented with CSS container queries (`container-type: inline-size` on each row) rather than viewport media queries, since row width is what actually varies, and rather than a JS-measured heuristic. Meme drops before programme, per spec.

## Verification

Commands run, from a clean `rm -rf apps/*/dist packages/contracts/dist`, in this worktree:

```
npm run build      # contracts, web (vite build), api, worker all succeed
npm run typecheck  # contracts, web, api, worker all pass with zero errors — this is
                    # the check that actually exercises the new files, since they are
                    # not yet imported by main.tsx (T08's job) and vite build's module
                    # graph doesn't reach them
npm test           # apps/api's own suite (11/11), unaffected by this change
```

**Structural/runtime check beyond typecheck**: `vite build` alone doesn't prove the new components render without error, since nothing in `main.tsx` imports them yet. Two things were done to actually exercise them:

1. Temporarily pointed `apps/web/src/main.tsx` at `DevPreview` and ran `vite build` — 44 modules transformed (up from 26), confirming Vite's CSS-module handling and the full import graph resolve cleanly. **Reverted before committing** — `git diff` shows `main.tsx` untouched in the final state, since it's outside T06's file allowlist.
2. Wrote a throwaway Node script (not part of this commit, run from a scratch directory) that used `esbuild` to bundle `screen-contracts`-driven fixture data into each of the four components and rendered them with `react-dom/server`'s `renderToStaticMarkup`, with `.module.css`/`.css` imports stubbed (esbuild can't process real CSS for a Node target). This is a real React render, not a guess: it caught nothing broken, and the output was inspected to confirm, concretely: no "Nie sprawdzone" text is emitted anywhere `verificationState` is `null` (both list and detail); the urgent rail/priority glyph/AI-row-disabled/hook-`TWÓJ HOOK`-tagging/chevron-only-on-secondary-rows logic all match the spec branch-by-branch; and the compiled CSS's `var(--sz-*)` usages all resolve against `tokens.css`'s definitions (checked by inspection of the built stylesheet).

**What was not done, honestly**: there is no headless browser (Playwright/Puppeteer) anywhere in this repo, and adding one would mean touching `package.json`/lockfiles, which are outside T06's file allowlist. So there is **no actual pixel-rendered/visual screenshot check at 360px or 320px** — the 360/320 reflow claim rests on the CSS itself (container queries with the thresholds described above, `max-width` content constraints, `overflow-x: auto` on the horizontally-scrollable status selector) and on the structural SSR check, not on having looked at rendered pixels. Per the spec's own instruction to "report actual inspection, not screenshot assumptions," I am reporting exactly that limitation rather than claiming a visual pass. `DevPreview` is left in place specifically so a session with real browser access (or T08, once it wires a real entry point) can do that check quickly.

Keyboard/focus: every interactive element is a real `<button>`/`<input>`/`<textarea>` (no `div onClick`), so native tab order and Enter/Space activation work without extra code; `:focus-visible` outlines are defined for every interactive primitive in `primitives.module.css`. This was checked by reading the DOM output above (every clickable thing is a real focusable element with an `aria-label` where its content isn't already text), not by an actual keyboard walkthrough in a browser — same limitation as above.

## Changed files

All new (nothing pre-existing was modified except the temporary, reverted `main.tsx` probe described above):

- `apps/web/src/ui/tokens.css`, `apps/web/src/ui/tokens.ts`
- `apps/web/src/ui/screen-contracts.ts`
- `apps/web/src/ui/css-modules.d.ts`
- `apps/web/src/ui/icons.tsx`
- `apps/web/src/ui/primitives.tsx`, `apps/web/src/ui/primitives.module.css`
- `apps/web/src/ui/StatusSelector.tsx`, `apps/web/src/ui/StatusSelector.module.css`
- `apps/web/src/screens/ReelListScreen.tsx`, `.module.css`
- `apps/web/src/screens/QuickAddScreen.tsx`, `.module.css`
- `apps/web/src/screens/ReelDetailScreen.tsx`, `.module.css`
- `apps/web/src/screens/PublicationSection.tsx`, `.module.css`
- `apps/web/src/screens/fixtures.ts`
- `apps/web/src/screens/preview/DevPreview.tsx`, `.module.css`
- `docs/implementation/T06-result.md` (this report)

Not touched: `apps/web/src/main.tsx`, any API/auth/IndexedDB/controller code, existing spike files, package/lockfiles, `packages/contracts/src/**`, or any other task's worktree.

## Component interface summary

- `ReelListScreen(props: ReelListScreenProps)` — current user, status tabs + selection, optional attention count, load state, `ReelListItemView[]`, open/add/retry intents.
- `QuickAddScreen(props: QuickAddScreenProps)` — detected/selected capture kind, url/images/text fields with reveal-gated accompanying-text and hook fields, priority, save gating/state, save/opracuj intents.
- `ReelDetailScreen(props: ReelDetailScreenProps)` — title, metadata cluster, hooks with removal intent, script, inert AI row, three chevron sections + a toggleable inline `PublicationSection`, save state.
- `PublicationSection(props: PublicationSectionProps)` — exported both standalone and used inline by `ReelDetailScreen`; feed-cover completion (independent of asset presence), description/hashtags, copy intent (join logic deferred to T08), publication date/links.

All four are pure functions of props — no internal data fetching, no persistence, no domain-timer logic. The one piece of local component state (`QuickAddScreen`'s selector-reveal toggle) does not represent domain data and resets are driven entirely by the `detectedKind` prop identity, not by any effect.

## Handoff

Unmerged, on `agents/t06-screens` (new worktree, base `master@d9e062b`). Awaiting lead review. Real browser/device visual verification at 360/320px and any T00/AGENTS.md open gates (Android, live Gemini, browser concurrency) remain outside this task's scope and were not touched.

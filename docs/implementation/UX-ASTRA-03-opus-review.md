# UX-ASTRA-03 — Opus verification

Reviewer: Opus 5.5, manual, at the operator's direction. Target: `codex/ux-publication-02` at `eefa9df` (implementation `8105b21` plus `6e4a8dc`). Method: diff review of the controller/switch changes, `npm run build` and `npm run typecheck` (PASS), targeted web tests, and my earlier headless-Chrome suites. Those ran against the candidate's built API and web on local PGlite with synthetic data, with selectors updated for the new two-line title field.

## Results

- **Web tests:** controller, label and planner tests 37/37.
- **Capture and switching suite:** 17/17.
  - Conflict followed by further typing then a switch now moves selection, and the conflict stays with its Reel.
  - A failed local draft write keeps the Reel open with the true storage error.
  - Two edits at about 1.5s latency no longer self-conflict (with and without switching).
  - A genuine concurrent edit still needs `Zachowaj moją wersję`, which saves the newest text.
  - An unfinished hook edit survives switching and blocks generation.
- **Layout, Detail and drawer suite:** 62/62. D3's text check was stale: a collapsed UWAGI now shows its summary by design (A6). A focused re-check confirmed the manual collapse persists per Reel (`aria-expanded=false`, editor hidden).
  - The drawer is modal: focus moves in, Tab is contained, and Escape restores the opener.
  - AI shortcuts are hidden when AI is unavailable.
  - Wyloguj no longer overlaps the toolbar.
- **Controller design (ACCEPTED):** per-Reel pending, timer, flush and in-flight maps; local save/delete operations serialized per Reel; only the durably retained revision is sent; navigation no longer waits for the network.

## Classification

**CORRECTION NEEDED (root-owned, pre-existing since CONTENT-PLANNER-01, also on master and DEV):** on the single-pane layout (≤679px), the Detail screen (`key={reel.id}`) and the Zaplanuj sheet (`key={scheduleReel.id}`) render as siblings of one fragment with the same key.
- Repro at 390px: open a Reel → Zaplanuj / Zmień termin → Anuluj. Two identical Detail screens are then visible; after Wstecz, a stale Detail remains over the list; repeating stacks them.
- Desktop is unaffected (the Detail sits in `<main>`).
- This is Astra's reported duplicate-Detail defect. Luna did not reproduce it because it needs the sheet opened from Detail on mobile.
- Fix: give the sheet a namespaced key. Applied by root during integration, with a regression check.

**OPEN REAL-WORLD GATE:** actual browser zoom/enlarged text, real devices and provider semantic quality (unchanged).

**Not run:** the Astra final UI check. The operator directed integration after this Opus review.

**ACCEPTED / NO FURTHER TESTING NOW:** everything else in the handoff's focus list.

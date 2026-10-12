# VOICE-01 — give the AI the team's own voice and past Rolki

Status: **proposal by root, 2026-10-11.** The operator reported (2026-10-11) that the AI "often has
too little context" and asked that it learn from the existing Rolki, especially hooks. Prompt
wording and the Style Profile are not frozen (AGENTS.md). Decisions §9.1–9.2 of
`docs/product/gemini-prompt-pack.md` belong to the operator. This proposal asks for them.

## Finding

- The live `develop` instruction (`apps/worker/src/ai/actions.ts:132`) is a one-line generic
  prompt. `SZRONOX-VOICE` (prompt pack §2) is **not sent by any action**; a grep of
  `apps/worker` and `apps/api` finds no reference to it.
- No past Reel ever reaches the model. Every Opracuj starts from zero: the capture, the current
  script and the hooks of *this* Reel only.
- The voice profile itself was inferred from **one** caption. It describes the caption, not the
  spoken hooks.

## Proposal

**A. Send the voice, as two registers** (revised after §C, see `docs/product/voice-hook-patterns.md`).
The *spoken* voice (patterns doc §5) goes to `develop` (hooks + script) and `generate_hooks`.
A *caption* voice (`SZRONOX-VOICE` corrected per patterns doc §4a) goes to `generate_publication`.
Prompt IDs are bumped and the stage stays `development_provisional`.

**B. The team's own Rolki as examples (automatic, no UI).** The API adds `styleExamples` to the
run snapshot: up to **8** of the newest Reels that are non-deleted, have status ≥ `to_record` and a
non-empty script, excluding the current Reel. Each example carries:
- its hook: the **selected hook**, else the single **team-written** hook when there is exactly
  one, else none;
- the first 600 characters of the script;
- the publication description, when present.

(Corrected after §C: only 7 Reels have a selected hook, so a selected-only rule would starve the
examples.) Examples are recorded in the snapshot for provenance and are **excluded from the
input hash and staleness**, so editing another Reel never makes this run stale. The prompt says
plainly: "examples of this team's past Reels: imitate structure, length and register, never reuse
facts or wording".

**C. Hook patterns from real data (root work, Opus) — DONE 2026-10-11:** `docs/product/voice-hook-patterns.md`. Before B ships, the root reads the DEV
Reels **read-only** (titles, selected and unselected hooks, scripts, statuses; no writes, nothing
copied off the server except an anonymised summary in this repo) and writes a `HOOK PATTERNS`
section for `SZRONOX-VOICE`:
- typical openings and length;
- what the chosen hooks do that the rejected ones don't;
- banned patterns observed in AI hooks the team never selected.

The operator reviews that section before it's used.

**Later, only if B proves too implicit:** a `Wzór` toggle to pin a Reel as an always-included
example. This is a new UI element, so it needs a visual delta and is not part of this task.

## Task package (for approval)

**Task ID:** VOICE-01. **Model:** Claude Sonnet 5, `.worktrees/voice-01`, branch
`claude/voice-01`. The root pins the snapshot contract and writes section C first.
**Difficulty:** medium. The snapshot/hash exclusion is the delicate part.
**Dependencies:** C (DEV read access approved by the operator). Run it after CAPTURE-DRAFT-01,
so the auto draft immediately benefits; the two touch `ai/service.ts` in different functions.
**Editable files:** `apps/worker/src/ai/actions.ts` (+ a new `apps/worker/src/ai/voice.ts`
holding the profile text), `apps/api/src/ai/service.ts` (example selection into the snapshot),
`AiInputSnapshot` (root-pinned additive field), tests in the worker/API, and
`docs/implementation/VOICE-01-result.md`.
**Acceptance:**
1. Each of the three actions' prompts contains the voice and, when available, the examples (prompt
   snapshot tests).
2. The selection rule is exact (status ≥ `to_record`, non-empty script, hook fallback, not
   deleted, not self, newest 8, bounded lengths).
3. The examples do not affect `inputHash`/`isStale`; existing staleness tests still pass.
4. Legacy snapshots without `styleExamples` still run.
5. No change to the result schemas, the apply rules or hook-selection rules.

**Open real-world gate:** live Gemini quality comparison: the same 5 real captures, Opracuj
before and after, judged by the operator (AI gate on DEV).

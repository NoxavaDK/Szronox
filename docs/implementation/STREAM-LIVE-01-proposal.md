# Proposal: live contributions from SzroNox to StreamControl

Status: **proposal for operator approval, 11 October 2026.** Written from the StreamControl side.
Nothing in SzroNox has been changed. SzroNox's `AGENTS.md` applies: its root agent presents task,
model, files and acceptance for explicit approval and pins the T00 amendment and migration first.

## Goal

During the weekly stream, Szron (and Kuba) can, from the SzroNox app they already use:

1. **Send a quote** (text ≤ 400, source ≤ 120) to StreamControl's quote queue. Kuba shows it with
   one click, or it goes on screen directly if Kuba has ticked "Szron może pokazywać cytaty od razu".
2. **Signal Kuba** with one of two buttons, shown to Kuba only as a dot in his panel:
   - **Pilne** — "I really urgently want to say something" (red, pulsing),
   - **Gdy będzie chwila** — "when there is a moment, I want to say something" (yellow),
   - plus **Anuluj**. A new signal replaces the previous one; Kuba clicking the dot clears it.
3. See the status of what they sent: *w kolejce*, *na ekranie*, *odrzucone*, *Kuba zobaczył*.

StreamControl stays the live tool on the streaming PC; SzroNox stays the preparation tool. The
streaming PC only makes **outbound** HTTPS requests to SzroNox; nothing on it is exposed.

## Already built in StreamControl (this repository)

- Queue, signals and per-person direct showing in the shared state; panel tabs
  *Tematy / Cytaty / Komentarze*; signal dots in the panel header; `/signal` dock with large dots.
- `Store.receive(message)` accepts, idempotently on `id` for quotes:
  - `{type: 'quote', id, by, text, source}`
  - `{type: 'signal', by, level: 'urgent' | 'moment'}`
  - `{type: 'signal-cancel', by}`
- Local test entry point `POST /api/inbox` (loopback only) with the same messages.
- Reset ("Wyzeruj postęp") clears the queue and signals for the next broadcast.

## Proposed SzroNox tasks

### STREAM-LIVE-01 — "Na żywo" screen and live messages

- A phone-first screen **Na żywo** (Polish UI) available to both users:
  quote field + source field + **Wyślij na stream**; buttons **Pilnie chcę coś powiedzieć**,
  **Gdy będzie chwila**, **Anuluj sygnał**; the user's own recent messages with status.
  Optional later: "Wyślij na stream" from a Reel/stream topic, prefilled with its Źródło line.
- Migration (next free number): `app.live_messages(id uuid pk, author_id uuid fk users,
  type text check in ('quote','signal','signal_cancel'), text text, source text,
  level text check in ('urgent','moment'), created_at timestamptz, status text check in
  ('sent','waiting','shown','dismissed','seen'), status_at timestamptz)`, with length checks
  matching the limits above. Both users can create; each sees their own messages.
- Normal session + CSRF rules for the browser endpoints. No AI involvement.

### STREAM-LIVE-02 — device access for the streaming PC

- One revocable **device credential** for the streaming PC, created by operator provisioning
  (never in Git or logs; stored only as a hash). Scope: read live messages and write their status,
  nothing else — no domain data, no Reels.
- `GET /api/v1/live/feed?after=<cursor>` → `{items: [{id, type, by, text, source, level,
  createdAt}], cursor}`, where `by` is the user's name (`NOXAVA` / `SZRON`).
- `POST /api/v1/live/status` `{id, status}` with `waiting | shown | dismissed | seen`.
- **Conflict to resolve in T00:** VPS-00 forbids a second bearer-token path for *user*
  authentication. This is a separate, narrowly scoped *device* principal; it needs an explicit
  T00 amendment saying so, or an alternative the SzroNox root prefers.

### Later — stream topics into the agenda (after STREAM-01)

An explicit **Importuj tematy** in StreamControl pulls a SzroNox stream's topic titles into the
agenda (max 8, 180 characters). Never automatic, never overwrites without confirmation.

## StreamControl side once SzroNox is ready

- A background poller in `server.py` (every ~2 s): `feed` → `Store.receive`; on panel actions it
  posts `status` back (shown/dismissed; `seen` when the dot is clicked).
- Configuration in `obs-topics/data/szronox.json` (URL + device credential), Git-ignored.
- If SzroNox or the internet is unavailable, the poller retries quietly and the panel shows
  "SzroNox: brak połączenia"; topics, quotes typed by Kuba and overlays keep working.

## Open questions for the operator

1. ~~Kuba sending from SzroNox~~ — decided: yes.
2. Future guests beyond the two SzroNox users — deferred ("maybe in the future"): extend SzroNox's frozen two-user model, or give
   guests a StreamControl-only link later?
3. ~~Signal expiry~~ — decided: a signal clears itself after 10 minutes (built in StreamControl).
4. Decided 11 Oct: Kuba also sends quotes from his own SzroNox account (they enter the queue like any other). Future guests: later.

---

## Task proposal for approval (format required by SzroNox `AGENTS.md`)

**Task ID:** STREAM-LIVE-01 (combines the two tasks above; the device feed is what makes the
screen useful, and both share one migration and one T00 amendment).

**Exact task:** live messages in SzroNox — the "Na żywo" screen for both users (quote with source,
two signals, cancel, own message statuses), the `live_messages` table, and a narrowly scoped
device credential for the streaming PC to read the feed and report statuses. No AI, no change to
Reels, streams, auth/session code or existing routes.

**Exact model:** Claude Opus 5.5 (`claude-opus-5-5`) in this Claude Code session, manual
implementation, no nested agents.

**Suitability / difficulty:** medium–high. Security-sensitive (a second principal next to the two
users) and cross-layer (migration, grants, API, web), which suits a high-reasoning model.

**Order of work (each step stops for operator approval where marked):**
1. Pin, before any code: T00 amendment STREAM-LIVE-01 (incl. the device principal as an explicit
   exception to VPS-00's "no second bearer path", scoped to two routes), additive contract types,
   migration number. **Operator approves.**
2. Visual delta spec `design/live-delta-spec.md` for the "Na żywo" screen (Polish copy, layout,
   states), following the frozen visual language. **Operator approves** — no UI is invented
   beyond it.
3. Implementation in its own worktree `.worktrees/stream-live-01`, branch `claude/stream-live-01`.
4. Handoff with commands, results, limitations, UNVERIFIED gates and commit ID. **No merge, no DEV
   migration, no deployment** without separate approval.

**Dependencies:** none on STREAM-01 (live messages are not tied to a stream). Migration number:
`0016` is reserved for STREAM-01 in `OCT-2026-plan.md`, which is not dispatched; proposal: take
`0016_live_messages.sql` and renumber STREAM-01/02 to 0017/0018 in the plan (migrations apply in
filename order). Possible text conflict in `App.tsx` with unmerged UI branches (UI-04, UX-ASTRA-03);
resolved at integration.

**Editable files:**
- `docs/implementation/T00-contracts.md` (new section), `OCT-2026-plan.md` (renumbering only),
  `tasks.md` (status row), `STREAM-LIVE-01-proposal.md`, `STREAM-LIVE-01-result.md`
- `design/live-delta-spec.md` (new)
- `packages/contracts/src/index.ts` (additive types only)
- `database/migrations/0016_live_messages.sql`
- `deploy/vps/postgres/grants.sql`, `apps/api/src/deploy-grants.test.ts`
- `apps/api/src/live/` (new: repository, routes, device credential, provisioning CLI),
  `apps/api/src/live.test.ts`
- `apps/api/src/app.ts` (one registration line)
- `apps/web/src/screens/LiveScreen.tsx` + `.module.css`, `apps/web/src/data/live.ts`,
  `apps/web/src/app/App.tsx` (one navigation entry)

**Acceptance criteria:**
- Both users create quote / signal / signal-cancel; quote 1–400 chars, source ≤ 120, level
  `urgent|moment`; each user lists only their own recent messages with status. Browser writes
  require session, exact Origin and CSRF like every other unsafe route.
- Device credential: created by an operator CLI reading the secret from protected input, stored
  only as a SHA-256 digest, revocable, compared in constant time, rate-limited; accepted **only** on
  `GET /api/v1/live/feed` and `POST /api/v1/live/status`; rejected (401) everywhere else; cannot read
  Reels or any domain data; never logged.
- Feed: cursor-based, ordered, idempotent ids; status transitions validated
  (`sent → waiting|shown|dismissed|seen`), visible to the author.
- Migration additive; API role gets only the DML it needs; worker gets nothing on the new table;
  grants test updated.
- API tests in the existing style, contracts/API build and web typecheck pass.
- **OPEN REAL-WORLD GATES** (not in this task): DEV migration/deployment, real phone use, the
  StreamControl poller against DEV.

## Operator approval — 2026-10-11

Approved by the operator: task STREAM-LIVE-01 on Claude Opus 5.5 (manual, this Claude Code
session, worktree `.worktrees/stream-live-01`, branch `claude/stream-live-01`); the device-key
exception to VPS-00, with keys designed as named, scoped records so future per-person keys can be
added by a later amendment; migration 0016 with STREAM-01/02 renumbered to 0017/0018. Steps 1
(contracts) and 2 (visual delta) still stop for the operator's review. No merge, DEV migration or
deployment is authorized.

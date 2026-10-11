-- STREAM-LIVE-01: live messages during a broadcast, and narrowly scoped access keys.
--
-- Filename note: OCT-2026-plan.md had reserved 0016 for STREAM-01, which was never dispatched.
-- The operator approved (2026-10-11) taking 0016 here and renumbering STREAM-01/02 to 0017/0018.
--
-- Both users send quotes and "I want to say something" signals from the "Na żywo" screen.
-- The streaming PC (StreamControl) reads them through a device key and reports what happened
-- to each one. Nothing here touches Reels, streams, users, credentials or sessions.
--
-- Roles and grants live in deploy/vps/postgres/grants.sql, as for every table.

-- ── Live messages ────────────────────────────────────────────────────────────
-- One row per message. `seq` is the feed cursor: identity values only grow, so a reader that
-- remembers the last `seq` it saw never misses or repeats a row.
--
-- The shape is checked per kind, so a quote can never carry a level and a signal can never
-- carry text, whatever the application does.
--
-- Status lifecycle (validated in the API, recorded here only as the allowed set):
--   sent       created, not yet picked up by the streaming PC
--   delivered  the PC received it (signal_cancel stops here)
--   waiting    quote is in the host's queue
--   shown      quote went on screen
--   dismissed  host rejected the quote
--   seen       host clicked the signal dot
--   expired    signal cleared itself (StreamControl: 10 minutes)
--   replaced   signal superseded by a newer signal or a cancel from the same author
create table if not exists app.live_messages (
  id          uuid primary key,
  seq         bigint generated always as identity unique,
  author_id   uuid not null references app.users (id),
  kind        text not null check (kind in ('quote', 'signal', 'signal_cancel')),
  text        text,
  source      text,
  level       text check (level in ('urgent', 'moment')),
  status      text not null default 'sent'
              check (status in ('sent', 'delivered', 'waiting', 'shown', 'dismissed', 'seen', 'expired', 'replaced')),
  status_at   timestamptz,
  created_at  timestamptz not null default now(),
  constraint live_messages_quote_shape check (
    kind <> 'quote' or (
      text is not null and char_length(btrim(text)) between 1 and 400 and char_length(text) <= 400
      and (source is null or char_length(source) <= 120)
      and level is null)),
  constraint live_messages_signal_shape check (
    kind <> 'signal' or (level is not null and text is null and source is null)),
  constraint live_messages_cancel_shape check (
    kind <> 'signal_cancel' or (level is null and text is null and source is null)),
  constraint live_messages_status_time check ((status = 'sent') = (status_at is null))
);

-- "My recent messages" on the Na żywo screen.
create index if not exists live_messages_author_recent_idx
  on app.live_messages (author_id, created_at desc);

-- ── Access keys ──────────────────────────────────────────────────────────────
-- Named keys for non-browser clients. STREAM-LIVE-01 defines one scope, `live_feed`: read the
-- live feed and report statuses — nothing else. The scope set is deliberately a CHECK so a
-- later, separately approved amendment (e.g. a guest key that may send quotes) has to change
-- this table on purpose.
--
-- As with sessions, the secret itself is never stored: `token_hash` is the SHA-256 digest of
-- the 32 random bytes handed to the operator once. Keys are created and revoked by an operator
-- command running as the owner; the API can only resolve them and stamp `last_used_at`.
create table if not exists app.access_keys (
  id            uuid primary key,
  label         text not null check (char_length(btrim(label)) between 1 and 80),
  scope         text not null check (scope in ('live_feed')),
  token_hash    text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  last_used_at  timestamptz
);

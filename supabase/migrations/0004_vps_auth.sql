-- VPS-01 application-owned authentication.
--
-- Filename note: VPS-00 reserved `0002_vps_auth.sql` "conditional on those
-- filenames remaining unused after Opus integration". The reconciled baseline
-- already contains an applied `0002_script_revision.sql`, and `0003` stays
-- reserved for VPS-02, so this migration takes the next free identifier instead
-- of renumbering applied history. Auth and storage tables are independent, so
-- their relative order carries no meaning.
--
-- Two tables, both private. Neither is ever read by the domain mapping layer and
-- neither appears in a wire response: sessions and credentials leave this schema
-- only as a resolved VerifiedActor.
--
-- Roles and grants are deliberately absent. VPS-03 owns per-environment identity
-- (migration/API/worker), including the requirement that the worker role gets no
-- access to these two tables.

-- ── Password credentials ─────────────────────────────────────────────────────
-- One row per provisioned user, keyed by the user's existing UUID. There is no
-- `id` of its own and no email: the two product users are provisioned, never
-- self-registered, and their identity already exists in app.users. The foreign
-- key means a credential cannot exist for an unprovisioned identity.
--
-- `password_hash` holds a complete Argon2id PHC string, which carries its own
-- random salt and cost parameters. Parameters are therefore per-row, so raising
-- them later does not invalidate existing rows.
create table if not exists app.user_credentials (
  user_id        uuid primary key references app.users (id) on delete cascade,
  password_hash  text not null check (password_hash like '$argon2id$%'),
  updated_at     timestamptz not null default now()
);

-- ── Opaque sessions ──────────────────────────────────────────────────────────
-- The session secret itself is never stored. `token_hash` is the SHA-256 digest
-- of the 32 random bytes handed to the browser in the cookie, so a database
-- reader cannot mint a cookie from this table.
--
-- `csrf_token_hash` is the digest of a token derived as
-- HMAC-SHA-256(csrf secret, session secret). Storing the digest rather than the
-- token means a database reader cannot produce a usable CSRF header either, and
-- rotating the CSRF secret makes every stored digest unreachable — which is how
-- rotation invalidates existing sessions.
--
-- Expiry is absolute: `expires_at` is fixed at login and never extended, so a
-- session cannot be kept alive indefinitely by activity. Revocation is recorded
-- rather than deleted, so logout can be distinguished from an unknown cookie.
create table if not exists app.auth_sessions (
  token_hash       text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id          uuid not null references app.users (id) on delete cascade,
  csrf_token_hash  text not null check (csrf_token_hash ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  constraint auth_sessions_expiry_after_creation check (expires_at > created_at)
);

-- Revoking every live session for one account (account switch, credential
-- change) reads by user; expiry sweeps read by expiry.
create index if not exists auth_sessions_live_by_user_idx
  on app.auth_sessions (user_id) where revoked_at is null;
create index if not exists auth_sessions_expires_at_idx
  on app.auth_sessions (expires_at);

-- Runtime grants, applied by the `grants` one-shot job after migrations.
--
-- Separate from the role bootstrap because table grants need the tables to exist, and
-- separate from `database/migrations/` because grants are environment-specific while
-- migrations are shared applied history.
--
-- Idempotent: every statement is a GRANT or REVOKE, so rerunning after a new migration
-- is the intended way to keep privileges in step with the schema.
--
-- The shape of the split, and the reasoning:
--
--   szronox_api     reads the two users to answer /me, reads credential hashes to verify
--                   a password, and reads/writes/expires sessions. It reads and writes
--                   domain data. It cannot add, rename or remove a user, and it cannot
--                   write a credential — so a compromised API cannot create an identity,
--                   change a password, or lock either account out.
--   szronox_worker  reads domain data. It has no access whatsoever to credentials or
--                   sessions, so compromising background processing does not hand over
--                   either account's login.
--
-- Neither role owns anything, neither may CREATE in `app`, and both are refused at
-- startup by the application if these grants are ever widened.

-- Usage only. CREATE stays with the owner, so no runtime role can add a table that would
-- then inherit default privileges.
grant usage on schema app to szronox_api, szronox_worker;
revoke create on schema app from szronox_api, szronox_worker;

-- ── Domain tables ───────────────────────────────────────────────────────────────
-- Both processes work with the shared Reel data. The API writes it; the worker reads it,
-- because nothing in VPS-04 gives the worker a write path — T12/T16 are not implemented,
-- and granting writes for work that does not exist would be granting them on faith.
grant select, insert, update, delete on
  app.reels, app.reel_hooks, app.attachments, app.reel_memes, app.operations
  to szronox_api;
grant select, insert, update, delete on app.memes to szronox_api;
grant select on
  app.reels, app.reel_hooks, app.attachments, app.reel_memes, app.memes, app.operations
  to szronox_worker;

-- ── Roster ──────────────────────────────────────────────────────────────────────
-- Read-only for both. The roster is an operator decision applied by the provisioning
-- command under the owner role.
grant select on app.users to szronox_api, szronox_worker;
revoke insert, update, delete on app.users from szronox_api, szronox_worker;

-- ── Credentials ─────────────────────────────────────────────────────────────────
-- The API must read the hash to verify a password, and must not be able to write one.
grant select on app.user_credentials to szronox_api;
revoke insert, update, delete on app.user_credentials from szronox_api;
revoke all on app.user_credentials from szronox_worker;

-- ── Sessions ────────────────────────────────────────────────────────────────────
-- Issue (insert), resolve (select) and revoke (update). DELETE is granted because
-- pruning expired and revoked rows is a maintenance operation the API offers; the rows
-- it can remove carry no live capability.
grant select, insert, update, delete on app.auth_sessions to szronox_api;
revoke all on app.auth_sessions from szronox_worker;

-- ── Migration ledger ────────────────────────────────────────────────────────────
-- Neither runtime role reads or writes it; migrations run as the owner in a separate
-- one-shot job, and the API and worker never migrate on startup.
revoke all on public.schema_migrations from szronox_api, szronox_worker;

-- ── Future tables ───────────────────────────────────────────────────────────────
-- Without this, a table added by a later migration would carry whatever the owner's
-- default privileges happen to be. Set to nothing, so a new table is unreachable until
-- this file is updated deliberately and rerun.
alter default privileges in schema app revoke all on tables from szronox_api, szronox_worker;
alter default privileges in schema app revoke all on sequences from szronox_api, szronox_worker;

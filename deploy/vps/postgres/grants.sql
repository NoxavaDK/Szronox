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
--   szronox_worker  reads domain data and writes only fenced AI jobs, additive hooks
--                   and Reel version bumps. It has no access to credentials or sessions.
--
-- Neither role owns anything, neither may CREATE in `app`, and both are refused at
-- startup by the application if these grants are ever widened.

-- Usage only. CREATE stays with the owner, so no runtime role can add a table that would
-- then inherit default privileges.
grant usage on schema app to szronox_api, szronox_worker;
revoke create on schema app from szronox_api, szronox_worker;

-- ── Domain tables ───────────────────────────────────────────────────────────────
-- Both processes work with shared Reel data. The API owns ordinary edits; GEMINI-02
-- gives the worker only the narrow writes listed below.
grant select, insert, update, delete on
  app.reels, app.reel_hooks, app.attachments, app.reel_memes, app.operations
  to szronox_api;
grant select, insert, update, delete on app.memes to szronox_api;
grant select on
  app.reels, app.reel_hooks, app.attachments, app.reel_memes, app.memes, app.operations
  to szronox_worker;

-- STREAM-01: the API owns every topic write (absorb/link/new, edit, reorder, Odłącz/remove).
-- STREAM-02 is what will give the worker any access here; until then it has none.
grant select, insert, update, delete on app.stream_topics to szronox_api;
revoke all on app.stream_topics from szronox_worker;

-- KDRIVE-02: resumable provider session state is API-only. The worker has no
-- kDrive credentials and cannot observe or mutate upload sessions.
grant select, insert, update, delete on app.kdrive_uploads to szronox_api;
revoke all on app.kdrive_uploads from szronox_worker;

-- GEMINI-02: worker writes only its job lifecycle and additive hooks. It can
-- advance the Reel version after hook append, but cannot edit any Reel content.
grant select, insert, update on app.ai_runs to szronox_api;
grant select on app.ai_runs to szronox_worker;
grant update (state, lease_token, lease_expires_at, attempt_count, next_attempt_at,
  result, provenance, warnings, error, applied_hook_ids, completed_at)
  on app.ai_runs to szronox_worker;
grant insert (id, reel_id, text, source, position) on app.reel_hooks to szronox_worker;
grant update (version, updated_at) on app.reels to szronox_worker;
-- CORPUS-01: the corpus is read-only to both runtime processes. It is written by the
-- operator command running as the owner, which is what makes "the model ranks, the server
-- cites, and only a named human publishes" a property of the database rather than of the
-- application's good intentions. Migration 0006 additionally refuses UPDATE and DELETE on
-- indexed content from every role, owner included.
grant select on
  app.programme_releases, app.programme_documents, app.programme_versions,
  app.programme_release_versions, app.programme_vocabulary_entries,
  app.programme_sections, app.programme_proposals, app.programme_chunks
  to szronox_api, szronox_worker;
revoke insert, update, delete on
  app.programme_releases, app.programme_documents, app.programme_versions,
  app.programme_release_versions, app.programme_vocabulary_entries,
  app.programme_sections, app.programme_proposals, app.programme_chunks
  from szronox_api, szronox_worker;

-- STREAM-LIVE-01: live messages are API-only. Users create them and the device routes update
-- their status; nothing deletes them. Access keys are minted and revoked by the operator command
-- running as the owner; the API only resolves them and stamps last_used_at (column grant), so a
-- compromised API can neither create a key nor un-revoke one. The worker sees neither table.
grant select, insert, update on app.live_messages to szronox_api;
revoke delete on app.live_messages from szronox_api;
revoke all on app.live_messages from szronox_worker;
grant select on app.access_keys to szronox_api;
revoke insert, update, delete on app.access_keys from szronox_api;
grant update (last_used_at) on app.access_keys to szronox_api;
revoke all on app.access_keys from szronox_worker;

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

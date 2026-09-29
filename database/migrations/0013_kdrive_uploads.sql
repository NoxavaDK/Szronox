-- KDRIVE-02: bounded, resumable API-relayed uploads to the Reel's own kDrive folder.
-- Provider session credentials remain server-side and are never part of a wire contract.

alter table app.reels
  add column feed_cover_asset jsonb;

alter table app.memes
  add column kdrive_file jsonb,
  add column kdrive_copy_state text not null default 'pending'
    check (kdrive_copy_state in ('pending', 'copied', 'failed', 'not_configured')),
  add column kdrive_copy_attempts integer not null default 0
    check (kdrive_copy_attempts >= 0),
  add column kdrive_copy_error jsonb;

create table app.kdrive_uploads (
  id uuid primary key,
  reel_id uuid not null references app.reels (id) on delete cascade,
  purpose text not null check (purpose in ('video', 'cover')),
  requested_by uuid not null references app.users (id),
  file_name text not null,
  mime_type text not null,
  byte_size bigint not null check (byte_size > 0),
  chunk_size integer not null check (chunk_size > 0),
  total_chunks integer not null check (total_chunks > 0),
  received_chunks integer[] not null default '{}',
  -- One lowercase SHA-256 hex digest per chunk, in chunk-number order. Retained
  -- across restarts to form kDrive's total_chunk_hash without rereading the file.
  chunk_hashes text[] not null default '{}',
  chunk0_sha256 text,
  kdrive_session_token text,
  kdrive_upload_host text,
  folder_id text not null,
  state text not null check (state in ('open', 'finished', 'attached', 'cancelled', 'expired', 'failed')),
  kdrive_file_id text,
  final_name text,
  error jsonb,
  start_operation_id uuid not null unique,
  attach_operation_id uuid unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index kdrive_uploads_reel_state_idx
  on app.kdrive_uploads (reel_id, state, created_at desc);
create index kdrive_uploads_idle_idx
  on app.kdrive_uploads (updated_at)
  where state = 'open';
create index kdrive_uploads_requester_state_idx
  on app.kdrive_uploads (requested_by, state, created_at desc);

-- GEMINI-02: durable AI work and a versioned, operator-owned programme index.
-- Input snapshots are immutable even to a runtime role with UPDATE on the row.

-- A Reel lock serializes attachments, and this position records that order even
-- when transactions began in the opposite order before taking the lock.
alter table app.reel_memes add column if not exists position integer;
with ordered as (
  select reel_id, meme_id,
         row_number() over (partition by reel_id order by attached_at, meme_id) - 1 as ordinal
    from app.reel_memes
)
update app.reel_memes rm set position=ordered.ordinal
  from ordered where rm.reel_id=ordered.reel_id and rm.meme_id=ordered.meme_id;
alter table app.reel_memes alter column position set not null;
alter table app.reel_memes add constraint reel_memes_order_unique
  unique (reel_id, position) deferrable initially immediate;

create table if not exists app.ai_runs (
  id uuid primary key,
  reel_id uuid not null references app.reels (id),
  requested_by uuid not null references app.users (id),
  action text not null check (action in ('develop', 'generate_hooks', 'fact_check', 'language_check', 'find_programme')),
  state text not null default 'queued' check (state in ('queued', 'running', 'succeeded', 'failed')),
  input_snapshot jsonb not null,
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  model text not null,
  prompt_id text not null,
  prompt_stage text not null check (prompt_stage in ('diagnostic', 'development_provisional', 'editorial_approved')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  lease_token uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  result jsonb,
  provenance jsonb not null default '{}'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  error jsonb,
  applied_hook_ids uuid[] not null default '{}',
  -- Application-owned deterministic script edits made from this run. Never model output.
  application_history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint ai_runs_lease_consistent check (
    (state = 'running' and lease_token is not null and lease_expires_at is not null)
    or (state <> 'running' and lease_token is null and lease_expires_at is null)
  ),
  constraint ai_runs_result_consistent check (
    (state = 'succeeded' and result is not null and error is null and completed_at is not null)
    or (state = 'failed' and result is null and error is not null and completed_at is not null)
    or (state in ('queued', 'running') and result is null and completed_at is null)
  )
);

create index if not exists ai_runs_claim_idx
  on app.ai_runs (next_attempt_at, created_at, id)
  where state in ('queued', 'running');
create index if not exists ai_runs_reel_idx on app.ai_runs (reel_id, created_at desc);

create or replace function app.guard_ai_run_snapshot() returns trigger
language plpgsql as $$
begin
  if new.reel_id is distinct from old.reel_id
    or new.requested_by is distinct from old.requested_by
    or new.action is distinct from old.action
    or new.input_snapshot is distinct from old.input_snapshot
    or new.input_hash is distinct from old.input_hash
    or new.model is distinct from old.model
    or new.prompt_id is distinct from old.prompt_id
    or new.prompt_stage is distinct from old.prompt_stage
    or new.created_at is distinct from old.created_at then
    raise exception 'AI run input is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists ai_runs_immutable_input on app.ai_runs;
create trigger ai_runs_immutable_input before update on app.ai_runs
  for each row execute function app.guard_ai_run_snapshot();

-- Programme content is loaded only by the migration/operator identity. Runtime
-- roles may read approved versions; they cannot publish, edit or invent evidence.
create table if not exists app.programme_versions (
  id uuid primary key,
  title text not null,
  source_url text not null,
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  approved_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists programme_one_approved_version_idx
  on app.programme_versions ((approved_at is not null)) where approved_at is not null;

create table if not exists app.programme_proposals (
  id uuid primary key,
  document_version_id uuid not null references app.programme_versions (id),
  category text not null,
  title text not null,
  chapter text not null,
  subchapter text,
  search_text text not null
);
create index if not exists programme_proposals_version_idx
  on app.programme_proposals (document_version_id);

create table if not exists app.programme_chunks (
  id uuid primary key,
  proposal_id uuid not null references app.programme_proposals (id),
  excerpt text not null,
  pdf_page integer not null check (pdf_page > 0),
  printed_page text,
  search_vector tsvector generated always as (to_tsvector('simple', excerpt)) stored
);
create index if not exists programme_chunks_search_idx
  on app.programme_chunks using gin (search_vector);
create index if not exists programme_chunks_proposal_idx
  on app.programme_chunks (proposal_id);

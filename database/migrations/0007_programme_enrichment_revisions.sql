-- CORPUS-02 (ETAP 3B): a narrow, audited path to revise proposal enrichment.
--
-- Migration 0006 made every column of an indexed proposal immutable, including primary_tag,
-- secondary_tags and keywords — correct for content, wrong for operator-maintained tagging,
-- which legitimately improves after import (tag false-positive cleanup, better keywords).
-- This migration replaces the blanket UPDATE guard on app.programme_proposals with one that
-- allows exactly six enrichment columns to change and nothing else, and records every change
-- in an append-only revision log.
--
-- Deliberately excluded from the allowed set: `category`. Category is resolved once at
-- import time from the pinned per-release vocabulary and stored as a plain column; a later
-- tag correction must never retroactively change what a historical citation's category was.
-- Also excluded: id, document_version_id, title, chapter, subchapter, search_text,
-- section_id, external_id, order_index, exact_text, pdf_pages, printed_pages, char_start,
-- char_end — identity, text, structure, pages and provenance stay exactly as immutable as
-- migration 0006 made them. DELETE on a proposal remains fully blocked.
--
-- This path is reached only through `apps.ai.corpus.repository.reviseProposalEnrichment`,
-- run as the schema owner from the operator CLI — the same shape as import/approve/activate.
-- Runtime API and worker roles are not granted UPDATE on this table (deploy/vps/postgres/
-- grants.sql), so this migration does not widen what either running service can do.

-- ── Revision log ────────────────────────────────────────────────────────────────
create table if not exists app.programme_proposal_enrichment_revisions (
  id uuid primary key,
  proposal_id uuid not null references app.programme_proposals (id),
  revision_number integer not null check (revision_number > 0),
  operator text not null check (length(operator) between 1 and 200),
  revised_at timestamptz not null default now(),
  previous_primary_tag text,
  previous_secondary_tags text[] not null default '{}',
  previous_keywords text[] not null default '{}',
  previous_keywords_raw text[] not null default '{}',
  new_primary_tag text not null,
  new_secondary_tags text[] not null default '{}',
  new_keywords text[] not null default '{}',
  new_keywords_raw text[] not null default '{}',
  -- SHA-256 of the new enrichment payload (primary tag, secondary tags, keywords, in a
  -- fixed order), so a later reader can prove which revision produced which stored values
  -- without trusting the row's own text columns.
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  notes text,
  unique (proposal_id, revision_number)
);
create index if not exists programme_proposal_enrichment_revisions_proposal_idx
  on app.programme_proposal_enrichment_revisions (proposal_id, revision_number);

-- The log is itself immutable: a correction is a new revision row, never an edit of one
-- already written.
create or replace function app.guard_enrichment_revision() returns trigger
language plpgsql as $$
begin
  raise exception 'Proposal enrichment revisions are append-only; write a new revision instead'
    using errcode = '23514';
end;
$$;

drop trigger if exists programme_proposal_enrichment_revisions_immutable
  on app.programme_proposal_enrichment_revisions;
create trigger programme_proposal_enrichment_revisions_immutable
  before update or delete on app.programme_proposal_enrichment_revisions
  for each row execute function app.guard_enrichment_revision();

-- ── Narrow the proposal guard ───────────────────────────────────────────────────
-- Migration 0006's single trigger blocked UPDATE and DELETE alike. DELETE keeps exactly that
-- behaviour; UPDATE is replaced by a column-level check.
drop trigger if exists programme_proposals_immutable on app.programme_proposals;

create trigger programme_proposals_immutable_delete before delete on app.programme_proposals
  for each row execute function app.guard_programme_content();

create or replace function app.guard_programme_proposal_enrichment() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id
    or new.document_version_id is distinct from old.document_version_id
    or new.category is distinct from old.category
    or new.title is distinct from old.title
    or new.chapter is distinct from old.chapter
    or new.subchapter is distinct from old.subchapter
    or new.search_text is distinct from old.search_text
    or new.section_id is distinct from old.section_id
    or new.external_id is distinct from old.external_id
    or new.order_index is distinct from old.order_index
    or new.exact_text is distinct from old.exact_text
    or new.pdf_pages is distinct from old.pdf_pages
    or new.printed_pages is distinct from old.printed_pages
    or new.char_start is distinct from old.char_start
    or new.char_end is distinct from old.char_end then
    raise exception
      'Only proposal enrichment (primary_tag, secondary_tags, keywords, keywords_raw) may be revised; every other field is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists programme_proposals_enrichment_only on app.programme_proposals;
create trigger programme_proposals_enrichment_only before update on app.programme_proposals
  for each row execute function app.guard_programme_proposal_enrichment();

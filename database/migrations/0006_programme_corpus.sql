-- CORPUS-01: the approved programme corpus — releases, documents, sections and
-- version-owned proposal enrichment.
--
-- Additive. Every table and column GEMINI-02 created stays, keeps its identifiers and
-- keeps its meaning; a Reel attachment pinned before this migration still resolves.
--
-- Three things change shape, and each is a correction the corpus specification requires:
--
--   1. Approval and activation become separate acts on separate rows. GEMINI-02 approved
--      a version the instant it was imported and un-approved whatever came before, so a
--      half-reviewed import was searchable before anyone had read the report. Import now
--      writes an inactive release; a named human approves it; activation is a third step
--      that re-checks hashes and completeness. `programme_one_approved_version_idx` is
--      therefore replaced by one active release per corpus.
--   2. A chunk carries every physical page its text touches, not one page. Existing rows
--      are backfilled to single-element arrays and a CHECK keeps the legacy scalar columns
--      in step, so both readers see the same pages.
--   3. Indexed content is immutable in the database, not only by convention. Any UPDATE or
--      DELETE on a section, proposal or chunk is refused; changed source text produces a
--      new document version.
--
-- Legacy rows imported by the GEMINI-02 importer keep their UUIDs and remain readable, but
-- they carry none of the provenance below. A trigger refuses to admit such a version to a
-- release, so nothing incomplete can become active.

-- ── Documents ───────────────────────────────────────────────────────────────────
-- A stable work across editions (§2.2). Admission is recorded here because "why is this
-- authoritative programme content" is a property of the document, not of one file.
create table if not exists app.programme_documents (
  id uuid primary key,
  document_slug text not null unique check (document_slug ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
  title text not null check (length(title) between 1 and 300),
  document_type text not null check (document_type in ('programme', 'resolution', 'programme_annex')),
  issuing_body text not null check (length(issuing_body) between 1 and 300),
  admission_rationale text not null check (length(admission_rationale) between 1 and 2000),
  -- Non-null only when an operator admitted content the specification excludes by default
  -- (an unadopted draft, above all). Recording the amendment on the document is what makes
  -- a later reader able to see that the exclusion was waived deliberately and by whom.
  admission_amendment jsonb,
  created_at timestamptz not null default now()
);

-- ── Releases ────────────────────────────────────────────────────────────────────
-- The unit the operator approves and the app pins (§2.1).
create table if not exists app.programme_releases (
  id uuid primary key,
  corpus_id text not null check (corpus_id ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
  release_slug text not null unique check (release_slug ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
  label text not null check (length(label) between 1 and 300),
  state text not null default 'draft' check (state in ('draft', 'approved', 'active', 'superseded', 'withdrawn')),
  category_vocabulary_id text not null check (category_vocabulary_id ~ '^[a-z0-9][a-z0-9._-]{2,119}$'),
  imported_by text not null check (length(imported_by) between 1 and 200),
  imported_at timestamptz not null default now(),
  -- The report the operator must read before approving, and the ledger that proves every
  -- physical page and native section was either indexed or excluded on the record.
  validation_report jsonb not null,
  coverage_ledger jsonb not null,
  approved_by text check (length(approved_by) between 1 and 200),
  approved_at timestamptz,
  activated_at timestamptz,
  superseded_by uuid references app.programme_releases (id),
  superseded_at timestamptz,
  withdrawn_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  -- Approval fields stay null until approval; activation cannot precede approval.
  constraint programme_releases_lifecycle check (
    (state = 'draft' and approved_by is null and approved_at is null and activated_at is null)
    or (state <> 'draft' and approved_by is not null and approved_at is not null)
  ),
  constraint programme_releases_activation check (
    (state in ('draft', 'approved') and activated_at is null)
    or (state in ('active', 'superseded') and activated_at is not null)
    or state = 'withdrawn'
  ),
  constraint programme_releases_supersession check (
    (state = 'superseded' and superseded_by is not null and superseded_at is not null)
    or (state <> 'superseded' and superseded_by is null and superseded_at is null)
  ),
  constraint programme_releases_withdrawal check (
    (state = 'withdrawn' and withdrawn_at is not null)
    or (state <> 'withdrawn' and withdrawn_at is null)
  )
);

-- Replaces `programme_one_approved_version_idx`: exactly one searchable release per corpus.
-- Superseded and withdrawn releases stay, so an older attachment still resolves.
drop index if exists app.programme_one_approved_version_idx;
create unique index if not exists programme_one_active_release_idx
  on app.programme_releases (corpus_id) where state = 'active';
create index if not exists programme_releases_corpus_idx on app.programme_releases (corpus_id, created_at desc);

-- ── Document versions ───────────────────────────────────────────────────────────
-- One immutable source file plus its ingestion result (§2.3, §6). GEMINI-02 kept title,
-- source_url and the PDF hash; everything a citation has to be re-derivable from is added
-- here. `approved_at` is retained so an existing row keeps its shape, but it no longer
-- decides what is searchable — release state does.
alter table app.programme_versions add column if not exists document_id uuid references app.programme_documents (id);
alter table app.programme_versions add column if not exists version_slug text;
alter table app.programme_versions add column if not exists source_title text;
alter table app.programme_versions add column if not exists edition text;
alter table app.programme_versions add column if not exists adopted_at date;
alter table app.programme_versions add column if not exists language text;
alter table app.programme_versions add column if not exists source_file_name text;
alter table app.programme_versions add column if not exists source_format text;
alter table app.programme_versions add column if not exists source_byte_size bigint;
alter table app.programme_versions add column if not exists retrieved_at timestamptz;
alter table app.programme_versions add column if not exists page_count integer;
-- Printed labels for every physical page, in page order. An unlabelled page is an empty
-- string in its position — never omitted, never back-filled with the physical number.
alter table app.programme_versions add column if not exists printed_page_labels text[];
alter table app.programme_versions add column if not exists structure_coverage text;
-- Archived bytes. `archive_key` is a path relative to the private archive root; the PDF is
-- authoritative, the DOCX is a structural aid, and the dataset is what the operator handed over.
alter table app.programme_versions add column if not exists archive_key text;
alter table app.programme_versions add column if not exists structure_file_name text;
alter table app.programme_versions add column if not exists structure_sha256 text;
alter table app.programme_versions add column if not exists structure_archive_key text;
alter table app.programme_versions add column if not exists dataset_file_name text;
alter table app.programme_versions add column if not exists dataset_sha256 text;
alter table app.programme_versions add column if not exists dataset_archive_key text;
-- The normalized document text every offset and page mapping is resolved against. The hash
-- lets a later reader prove the extraction that produced the index is the one they have.
alter table app.programme_versions add column if not exists normalized_text_sha256 text;
alter table app.programme_versions add column if not exists normalized_length integer;
alter table app.programme_versions add column if not exists ingestion jsonb;
alter table app.programme_versions add column if not exists state text not null default 'draft';
alter table app.programme_versions add column if not exists imported_at timestamptz not null default now();

do $$ begin
  alter table app.programme_versions add constraint programme_versions_state
    check (state in ('draft', 'approved', 'superseded', 'withdrawn'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table app.programme_versions add constraint programme_versions_bounds check (
    (language is null or language = 'pl')
    and (source_format is null or source_format = 'pdf')
    and (structure_coverage is null or structure_coverage in ('full', 'partial'))
    and (page_count is null or page_count > 0)
    and (source_byte_size is null or source_byte_size > 0)
    and (structure_sha256 is null or structure_sha256 ~ '^[0-9a-f]{64}$')
    and (dataset_sha256 is null or dataset_sha256 ~ '^[0-9a-f]{64}$')
    and (normalized_text_sha256 is null or normalized_text_sha256 ~ '^[0-9a-f]{64}$')
    and (printed_page_labels is null or page_count is null or array_length(printed_page_labels, 1) = page_count)
  );
exception when duplicate_object then null; end $$;
create unique index if not exists programme_versions_slug_idx on app.programme_versions (version_slug)
  where version_slug is not null;
create index if not exists programme_versions_document_idx on app.programme_versions (document_id);

-- ── Release membership ──────────────────────────────────────────────────────────
create table if not exists app.programme_release_versions (
  release_id uuid not null references app.programme_releases (id),
  document_version_id uuid not null references app.programme_versions (id),
  position integer not null check (position >= 0),
  primary key (release_id, document_version_id),
  unique (release_id, position)
);

-- A version with no provenance cannot join a release, so a row imported by the GEMINI-02
-- importer can never become searchable without being re-imported through validation.
create or replace function app.assert_programme_version_complete() returns trigger
language plpgsql as $$
declare complete boolean;
begin
  select v.document_id is not null and v.version_slug is not null and v.source_title is not null
     and v.edition is not null and v.adopted_at is not null and v.language is not null
     and v.source_file_name is not null and v.source_format is not null
     and v.source_byte_size is not null and v.retrieved_at is not null
     and v.page_count is not null and v.printed_page_labels is not null
     and v.structure_coverage is not null and v.archive_key is not null
     and v.normalized_text_sha256 is not null and v.normalized_length is not null
     and v.ingestion is not null
    into complete
    from app.programme_versions v where v.id = new.document_version_id;
  if complete is null then
    raise exception 'Programme version % does not exist', new.document_version_id using errcode = '23503';
  end if;
  if not complete then
    raise exception 'Programme version % lacks validated corpus provenance', new.document_version_id using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists programme_release_versions_complete on app.programme_release_versions;
create trigger programme_release_versions_complete before insert or update on app.programme_release_versions
  for each row execute function app.assert_programme_version_complete();

-- ── Category vocabulary snapshot ────────────────────────────────────────────────
-- Pinned per release (§5). A later release may drop an entry; this snapshot is what the
-- release was validated against, so an existing attachment keeps its meaning.
create table if not exists app.programme_vocabulary_entries (
  release_id uuid not null references app.programme_releases (id),
  entry_id text not null check (entry_id ~ '^[a-z0-9][a-z0-9._-]{1,119}$'),
  label text not null check (length(label) between 1 and 200),
  definition text not null check (length(definition) between 1 and 1000),
  position integer not null check (position >= 0),
  primary key (release_id, entry_id),
  unique (release_id, position)
);

-- ── Sections ────────────────────────────────────────────────────────────────────
-- Chapter / optional subchapter (§2.4). A source without a subchapter stores NULL; the
-- importer refuses a record that leaves the field merely absent.
create table if not exists app.programme_sections (
  id uuid primary key,
  document_version_id uuid not null references app.programme_versions (id),
  section_slug text not null check (length(section_slug) between 1 and 200),
  chapter text not null check (length(chapter) between 1 and 500),
  subchapter text check (length(subchapter) between 1 and 500),
  order_index integer not null check (order_index >= 0),
  start_pdf_page integer not null check (start_pdf_page > 0),
  end_pdf_page integer not null check (end_pdf_page > 0),
  constraint programme_sections_page_span check (end_pdf_page >= start_pdf_page),
  unique (document_version_id, section_slug),
  unique (document_version_id, order_index)
);

-- ── Proposal enrichment ─────────────────────────────────────────────────────────
-- `title` keeps its GEMINI-02 meaning: the verbatim postulat title or lead. `exact_text`
-- is the full verbatim passage, kept separately so a long proposal never overwrites the
-- short string the Reel Detail attachment displays.
alter table app.programme_proposals add column if not exists section_id uuid references app.programme_sections (id);
alter table app.programme_proposals add column if not exists external_id text;
alter table app.programme_proposals add column if not exists order_index integer;
alter table app.programme_proposals add column if not exists exact_text text;
alter table app.programme_proposals add column if not exists primary_tag text;
alter table app.programme_proposals add column if not exists secondary_tags text[] not null default '{}';
-- Normalized keywords are what retrieval ranks; the raw input is retained beside them so
-- the operator's own spelling survives NFC, trimming and de-duplication.
alter table app.programme_proposals add column if not exists keywords text[] not null default '{}';
alter table app.programme_proposals add column if not exists keywords_raw text[] not null default '{}';
alter table app.programme_proposals add column if not exists pdf_pages integer[];
alter table app.programme_proposals add column if not exists printed_pages text[];
alter table app.programme_proposals add column if not exists char_start integer;
alter table app.programme_proposals add column if not exists char_end integer;

do $$ begin
  alter table app.programme_proposals add constraint programme_proposals_enrichment check (
    (order_index is null or order_index >= 0)
    and (char_start is null or char_start >= 0)
    and (char_end is null or char_start is null or char_end > char_start)
    and (pdf_pages is null or array_length(pdf_pages, 1) >= 1)
    and (printed_pages is null or pdf_pages is null
         or array_length(printed_pages, 1) = array_length(pdf_pages, 1))
  );
exception when duplicate_object then null; end $$;
create unique index if not exists programme_proposals_external_idx
  on app.programme_proposals (document_version_id, external_id) where external_id is not null;
create unique index if not exists programme_proposals_section_order_idx
  on app.programme_proposals (section_id, order_index) where section_id is not null;

-- Ranking input. Weighted so a title or an operator keyword outranks an incidental body
-- match, and deterministic because every term comes from persisted operator content.
--
-- The tags and keywords are indexed from flat text columns rather than from the arrays
-- beside them, because `array_to_string` is only STABLE and a generated column must be
-- IMMUTABLE. The importer writes both from one normalized value in the same statement, and
-- `corpus.test.ts` asserts they agree.
alter table app.programme_proposals add column if not exists keywords_text text not null default '';
alter table app.programme_proposals add column if not exists tags_text text not null default '';
alter table app.programme_proposals add column if not exists enrichment_vector tsvector
  generated always as (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A')
    || setweight(to_tsvector('simple', keywords_text), 'A')
    || setweight(to_tsvector('simple', tags_text), 'B')
    || setweight(to_tsvector('simple', coalesce(chapter, '') || ' ' || coalesce(subchapter, '')), 'C')
    || setweight(to_tsvector('simple', coalesce(exact_text, search_text)), 'D')
  ) stored;
create index if not exists programme_proposals_enrichment_idx
  on app.programme_proposals using gin (enrichment_vector);

-- ── Chunk page arrays ───────────────────────────────────────────────────────────
alter table app.programme_chunks add column if not exists document_version_id uuid references app.programme_versions (id);
alter table app.programme_chunks add column if not exists section_id uuid references app.programme_sections (id);
alter table app.programme_chunks add column if not exists external_id text;
alter table app.programme_chunks add column if not exists order_index integer;
alter table app.programme_chunks add column if not exists char_start integer;
alter table app.programme_chunks add column if not exists char_end integer;
alter table app.programme_chunks add column if not exists pdf_pages integer[];
alter table app.programme_chunks add column if not exists printed_pages text[];
alter table app.programme_chunks add column if not exists token_estimate integer;

update app.programme_chunks
   set pdf_pages = array[pdf_page],
       printed_pages = array[coalesce(printed_page, '')]
 where pdf_pages is null;

alter table app.programme_chunks alter column pdf_pages set not null;
alter table app.programme_chunks alter column printed_pages set not null;

do $$ begin
  alter table app.programme_chunks add constraint programme_chunks_pages check (
    array_length(pdf_pages, 1) >= 1
    and array_length(printed_pages, 1) = array_length(pdf_pages, 1)
    -- The legacy scalar columns stay truthful rather than becoming a stale second answer.
    and pdf_page = pdf_pages[1]
    and coalesce(printed_page, '') = printed_pages[1]
    and (char_end is null or char_start is null or char_end > char_start)
    and (order_index is null or order_index >= 0)
  );
exception when duplicate_object then null; end $$;
create unique index if not exists programme_chunks_external_idx
  on app.programme_chunks (document_version_id, external_id) where external_id is not null;
create unique index if not exists programme_chunks_order_idx
  on app.programme_chunks (document_version_id, order_index) where document_version_id is not null;

-- ── Immutability ────────────────────────────────────────────────────────────────
-- Indexed text, chunk boundaries and identifiers are never edited in place (§1.5). A failed
-- import rolls back rather than deleting, so refusing UPDATE and DELETE costs nothing the
-- importer needs and removes the only path by which a citation could change under a pinned
-- attachment.
create or replace function app.guard_programme_content() returns trigger
language plpgsql as $$
begin
  raise exception 'Indexed programme content is immutable; import a new document version'
    using errcode = '23514';
end;
$$;

drop trigger if exists programme_sections_immutable on app.programme_sections;
create trigger programme_sections_immutable before update or delete on app.programme_sections
  for each row execute function app.guard_programme_content();
drop trigger if exists programme_proposals_immutable on app.programme_proposals;
create trigger programme_proposals_immutable before update or delete on app.programme_proposals
  for each row execute function app.guard_programme_content();
drop trigger if exists programme_chunks_immutable on app.programme_chunks;
create trigger programme_chunks_immutable before update or delete on app.programme_chunks
  for each row execute function app.guard_programme_content();

-- A version's source identity and extraction provenance are equally fixed; only its
-- lifecycle state and the retained `approved_at` marker may move afterwards.
create or replace function app.guard_programme_version() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id
    or new.title is distinct from old.title
    or new.source_url is distinct from old.source_url
    or new.document_sha256 is distinct from old.document_sha256
    or new.document_id is distinct from old.document_id
    or new.version_slug is distinct from old.version_slug
    or new.source_title is distinct from old.source_title
    or new.edition is distinct from old.edition
    or new.adopted_at is distinct from old.adopted_at
    or new.source_file_name is distinct from old.source_file_name
    or new.source_byte_size is distinct from old.source_byte_size
    or new.page_count is distinct from old.page_count
    or new.printed_page_labels is distinct from old.printed_page_labels
    or new.archive_key is distinct from old.archive_key
    or new.dataset_sha256 is distinct from old.dataset_sha256
    or new.structure_sha256 is distinct from old.structure_sha256
    or new.normalized_text_sha256 is distinct from old.normalized_text_sha256
    or new.normalized_length is distinct from old.normalized_length
    or new.ingestion is distinct from old.ingestion
    or new.created_at is distinct from old.created_at then
    raise exception 'Programme version provenance is immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists programme_versions_immutable on app.programme_versions;
create trigger programme_versions_immutable before update on app.programme_versions
  for each row execute function app.guard_programme_version();

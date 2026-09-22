-- CORPUS-05: fix the completeness trigger to honor the admission_amendment waiver.
--
-- Migration 0006's assert_programme_version_complete() required v.adopted_at IS NOT NULL
-- unconditionally, with no exception for a document whose admission_amendment waives formal
-- adoption. That waiver is the entire purpose of admission_amendment
-- (programme-corpus-spec.md §2.2/§2.3, the operator bundle's §2.1 "Admission" section): an
-- unadopted draft is admissible only when a named human explicitly waives the adoption
-- requirement, and the importer's own validation (validate.ts) already enforces exactly that
-- condition at the file level. The database trigger never learned the same exception, so any
-- release built from a waived, unadopted draft failed at import with "lacks validated corpus
-- provenance" — discovered live during the first real `import` run against a database with
-- an actual unadopted-draft bundle. Every prior test fixture used a real adopted_at date, and
-- `validate` never reaches this trigger, so the gap was never exercised before now.
--
-- Fixed by joining app.programme_documents (LEFT JOIN, so a version with no document_id at
-- all still correctly fails completeness rather than being dropped by the join) and accepting
-- either a real adopted_at or a recorded admission_amendment.
create or replace function app.assert_programme_version_complete() returns trigger
language plpgsql as $$
declare complete boolean;
begin
  select v.document_id is not null and v.version_slug is not null and v.source_title is not null
     and v.edition is not null and (v.adopted_at is not null or d.admission_amendment is not null)
     and v.language is not null
     and v.source_file_name is not null and v.source_format is not null
     and v.source_byte_size is not null and v.retrieved_at is not null
     and v.page_count is not null and v.printed_page_labels is not null
     and v.structure_coverage is not null and v.archive_key is not null
     and v.normalized_text_sha256 is not null and v.normalized_length is not null
     and v.ingestion is not null
    into complete
    from app.programme_versions v
    left join app.programme_documents d on d.id = v.document_id
    where v.id = new.document_version_id;
  if complete is null then
    raise exception 'Programme version % does not exist', new.document_version_id using errcode = '23503';
  end if;
  if not complete then
    raise exception 'Programme version % lacks validated corpus provenance', new.document_version_id using errcode = '23514';
  end if;
  return new;
end;
$$;

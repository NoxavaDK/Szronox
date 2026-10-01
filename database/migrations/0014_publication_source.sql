alter table app.reels
  add column publication_source text
    check (publication_source is null or char_length(publication_source) <= 1000),
  add column source_metadata jsonb;

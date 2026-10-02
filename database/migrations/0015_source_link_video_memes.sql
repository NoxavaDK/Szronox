-- SOURCE-02: an article URL may be added after image/text capture.
alter table app.reels
  add column source_link text
    check (source_link is null or
      (char_length(source_link) <= 2048 and source_link ~* '^https?://'));

-- MEME-VIDEO-01: media attachments are private Meme uploads, not capture inputs.
alter table app.attachments
  drop constraint if exists attachments_purpose_check,
  add constraint attachments_purpose_check
    check (purpose in ('input', 'source', 'material', 'meme')),
  drop constraint if exists attachments_kind_check,
  add constraint attachments_kind_check
    check (kind in ('url', 'image', 'video')),
  drop constraint if exists attachments_video_meme_only,
  add constraint attachments_video_meme_only
    check (kind <> 'video' or purpose = 'meme'),
  drop constraint if exists attachments_validated_metadata_complete,
  add constraint attachments_validated_metadata_complete check (
    (validated_mime_type is null and validated_width is null and validated_height is null
      and validated_pixel_count is null and validated_at is null)
    or (kind = 'image'
      and validated_mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
      and validated_width > 0 and validated_height > 0 and validated_pixel_count > 0
      and validated_pixel_count >= validated_width::bigint * validated_height::bigint
      and validated_at is not null)
    or (kind = 'video' and purpose = 'meme'
      and validated_mime_type like 'video/%'
      and validated_width is null and validated_height is null and validated_pixel_count is null
      and validated_at is not null)
  );

alter table app.memes
  add column media_kind text not null default 'image'
    check (media_kind in ('image', 'video')),
  add column mime_type text,
  add column poster_ref text;

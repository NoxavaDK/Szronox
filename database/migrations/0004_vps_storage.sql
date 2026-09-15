-- Private VPS filesystem upload authorization and validation metadata.
-- The object bytes remain outside PostgreSQL under APP_STORAGE_ROOT; only opaque
-- logical keys, ticket digests and server-observed validation facts are stored.

alter table app.attachments
  add column if not exists upload_actor_id uuid references app.users (id) on delete restrict,
  add column if not exists upload_token_digest text,
  add column if not exists upload_token_expires_at timestamptz,
  add column if not exists upload_authorized_at timestamptz,
  add column if not exists validated_mime_type text,
  add column if not exists validated_width integer,
  add column if not exists validated_height integer,
  add column if not exists validated_pixel_count bigint,
  add column if not exists validated_at timestamptz;

create unique index if not exists attachments_storage_key_unique
  on app.attachments (storage_key)
  where storage_key is not null;

alter table app.attachments
  drop constraint if exists attachments_upload_authorization_complete,
  add constraint attachments_upload_authorization_complete check (
    (upload_actor_id is null and upload_token_digest is null and upload_token_expires_at is null and upload_authorized_at is null)
    or
    (upload_actor_id is not null and upload_token_digest is not null and length(upload_token_digest) = 64
      and upload_token_expires_at is not null and upload_authorized_at is not null and storage_key is not null)
  ),
  drop constraint if exists attachments_validated_metadata_complete,
  add constraint attachments_validated_metadata_complete check (
    (validated_mime_type is null and validated_width is null and validated_height is null
      and validated_pixel_count is null and validated_at is null)
    or
    (validated_mime_type in ('image/jpeg', 'image/png', 'image/webp')
      and validated_width > 0 and validated_height > 0 and validated_pixel_count > 0
      and validated_pixel_count >= validated_width::bigint * validated_height::bigint
      and validated_at is not null)
  );

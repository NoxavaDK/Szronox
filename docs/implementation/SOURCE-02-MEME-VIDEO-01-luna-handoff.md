# Luna dispatch — SOURCE-02 and MEME-VIDEO-01

Status: **OPERATOR-APPROVED — dispatched from root pin `b0ff4a6`.** The approved task/model matrix
below is authoritative for these two implementations.

Operator decisions (2026-10-02):
- SOURCE-02: an article link can be added later to a Reel captured without one (image/text only),
  and the AI uses it like a captured link.
- MEME-VIDEO-01: memes may be videos; any video format; 25 MB limit; muted preview only. Several
  memes per Reel already exist (`+ kolejny mem`) and are unchanged.

Read first: `AGENTS.md`, `T00-contracts.md` (incl. the pinned SOURCE-02 / MEME-VIDEO-01 sections),
`design/frozen-visual-spec.md` §1, `design/oct-2026-delta-spec.md` §A, §G, §H.

Two independent tasks, two worktrees. Luna does not merge, deploy, run migrations on DEV, call live
sites or kDrive, send messages or spawn agents.

| | SOURCE-02 | MEME-VIDEO-01 |
| --- | --- | --- |
| Model | `gpt-6-luna`, medium reasoning | `gpt-6-luna`, high reasoning |
| Suitability | bounded field + existing source pipeline + one AI input field | upload validation of untrusted media, streaming route, UI |
| Difficulty | low–medium | medium |
| Branch | `codex/source-02` | `codex/meme-video-01` |
| Base | `b0ff4a6` | `b0ff4a6` |

---

## 0. Root pin commit (read-only for Luna)

- T00: SOURCE-02 and MEME-VIDEO-01 sections; `AGENTS.md` authorization line; delta spec §G–H
  linked from the authority addendum.
- `database/migrations/0015_source_link_video_memes.sql`:
  ```sql
  alter table app.reels
    add column source_link text
      check (source_link is null or (char_length(source_link) <= 2048 and source_link ~* '^https?://'));
  alter table app.attachments drop constraint attachments_kind_check;
  alter table app.attachments add constraint attachments_kind_check check (kind in ('url', 'image', 'video'));
  alter table app.attachments drop constraint attachments_purpose_check;
  alter table app.attachments add constraint attachments_purpose_check check (purpose in ('input', 'source', 'material', 'meme'));
  alter table app.attachments add constraint attachments_video_meme_only check (kind <> 'video' or purpose = 'meme');
  -- Validated metadata: images keep dimensions (now incl. GIF); videos carry only a video/* MIME type.
  alter table app.attachments drop constraint attachments_validated_metadata_complete;
  alter table app.attachments add constraint attachments_validated_metadata_complete check (
    (validated_mime_type is null and validated_width is null and validated_height is null
      and validated_pixel_count is null and validated_at is null)
    or (kind = 'image' and validated_mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')
      and validated_width > 0 and validated_height > 0 and validated_pixel_count > 0
      and validated_pixel_count >= validated_width::bigint * validated_height::bigint and validated_at is not null)
    or (kind = 'video' and validated_mime_type like 'video/%' and validated_width is null
      and validated_height is null and validated_pixel_count is null and validated_at is not null));
  alter table app.memes
    add column media_kind text not null default 'image' check (media_kind in ('image', 'video')),
    add column mime_type text,
    add column poster_ref text;
  ```
  Constraint names confirmed on DEV 2026-10-02 (`attachments_kind_check`,
  `attachments_validated_metadata_complete`). No grant change.
- Contracts:
  ```ts
  // Reel gains
  sourceLink: string | null;            // only when the capture has no link; PATCHable, version-checked
  // ReelPatchRequest gains sourceLink?: string | null
  // Meme gains
  mediaKind: 'image' | 'video';
  mimeType: string | null;              // null on rows created before MEME-VIDEO-01
  // thumbnailRef: poster (video) or image; null for a video without a poster
  // assetRef: '/api/v1/memes/:id/media'  (the old /image route stays as an alias)
  // CreateMemeRequest: exactly one of
  imageAssetId?: Id;
  videoAssetId?: Id;  posterAssetId?: Id; // poster is an ordinary validated image attachment, optional
  // Attachment initiation gains purpose: 'meme' and kind: 'image' | 'video' (default 'image').
  // New Meme media and poster uploads use purpose='meme', outside captured input/material.
  ```

---

## 1. SOURCE-02 — `Link do artykułu`

### Behaviour (T00 SOURCE-02, delta spec §G)
- `captureUrl = deriveSourceUrl(originalInput)` (existing). `effectiveSourceUrl = captureUrl ?? sourceLink`.
- PATCH `sourceLink`:
  - string (trimmed, `http(s)://`, ≤ 2048, must parse as a URL) or `null`;
  - refused with `422 VALIDATION_ERROR { reason: 'capture_has_link' }` when `captureUrl` is not null.
- **Same write**: when `sourceLink` changes, set `source_metadata` to a fresh value from the
  existing `initialSourceMetadata` logic over the effective URL: a new `requestId`; `pending` with
  the host line, or `no_url` when cleared. After commit, enqueue the fetch (same queue,
  `requestId` compare-and-set). `publicationSource` (a manual Źródło) is never touched.
- `deriveSourceUrl` callers (create, refresh, sweep) use the effective URL, so `Odśwież`/`Pobierz`
  work for an added link.
- **AI:**
  - the API snapshot builder (`apps/api/src/ai/service.ts`) adds `sourceLink` to every action
    input that carries `originalInput`;
  - the worker (`apps/worker/src/ai/actions.ts`) uses `input.originalInput.url ?? input.sourceLink`
    exactly where it uses `input.originalInput.url` today (develop/generate_hooks retrieval,
    generate_publication). Snapshots without the field behave as today.
  - No prompt wording change.

### Web
- `SourcesSection` (`ui/detail-sections.tsx`): the §G row, field, validation, `Otwórz` / `Zmień` /
  `Usuń` with `Cofnij`. Saved through the existing debounced field path (immediate on `Zapisz`).
  `Cofnij` re-saves the previous link.
- `PublicationSection`: the `no_url` row gains `Dodaj link`. It expands `ŹRÓDŁA / WEJŚCIE` and
  focuses the URL field (controller/App wiring).

### Allowlist
`apps/api/src/core/{repository,mapping}.ts` (sourceLink patch + metadata reset only),
`apps/api/src/source/metadata.ts`, `apps/api/src/core/routes.ts` (enqueue after PATCH only),
`apps/api/src/ai/service.ts` (snapshot field only), `apps/worker/src/ai/actions.ts` (URL fallback
only), `apps/api/src/source-metadata.test.ts`, new `apps/api/src/source-link.test.ts`,
`apps/web/src/ui/detail-sections*`, `apps/web/src/screens/PublicationSection*`,
`apps/web/src/app/App.tsx`, `apps/web/src/controllers/useAppController.ts`,
`apps/web/src/ui/screen-contracts.ts`, `apps/web/src/screens/preview/DevPreview.tsx`, adjacent
web tests.

### Acceptance
- API:
  - set a link on an image-only Reel → version +1, `source_metadata` pending with the host line and
    a new requestId, fetch enqueued; the fetch then fills `found`;
  - change → a new requestId, and the old fetch can't overwrite;
  - clear → `no_url`;
  - a manual `publicationSource` is untouched in all three;
  - a Reel with a captured URL (in `url` or in text) → 422 `capture_has_link`;
  - an invalid URL / `javascript:` / over 2048 chars → 422;
  - stale version → 409;
  - refresh uses the added link.
- Worker: develop and generate_publication fetch `sourceLink` when `originalInput.url` is absent;
  the captured URL wins when both exist (defensive); old snapshots are unchanged.
- Web:
  - the row is shown only without a captured link;
  - validation copy; `Zapisz` disabled until valid;
  - `Usuń` + `Cofnij` restores the exact previous link;
  - `Dodaj link` from PUBLIKACJA opens and focuses the field;
  - a failed save keeps the text.
- One build + typecheck; targeted suites; local Chrome at 320/360/1100 px.

---

## 2. MEME-VIDEO-01 — video memes

### Upload and validation
- Attachment initiation accepts `kind: 'video'`:
  - any declared `video/*` MIME type, ≤ 25 MiB (`422 too_large` above);
  - images keep their 8 MiB limit and JPEG/PNG/WebP, plus `image/gif` (validated by sharp,
    first frame).
  - Video attachments are only usable as meme media: a capture (`POST /reels`) referencing a
    video attachment is refused (`422 unsupported_type`).
- Content validation for video (no decoding, no ffmpeg) sniffs the container from the first bytes
  and must match a known video container:
  - ISO-BMFF (`ftyp` at offset 4: mp4/mov/m4v/3gp);
  - EBML `1A 45 DF A3` (webm/mkv);
  - RIFF…`AVI ` (avi);
  - `OggS`;
  - `FLV`;
  - MPEG-TS (`0x47` sync at 0 and 188);
  - MPEG-PS `00 00 01 BA`;
  - ASF/WMV GUID.
  An unknown container → `422 content_mismatch`. The stored MIME is the declared one when it is
  `video/*`, else derived from the container.
- Storage: the same private filesystem storage, modes and atomic write as images; byte size
  enforced while streaming.

### Meme create and serving
- `POST /memes` with `videoAssetId` (+ optional `posterAssetId`, an ordinary validated image
  attachment); exactly one of `imageAssetId`/`videoAssetId`.
  - The insert sets `media_kind`, `mime_type`, `asset_ref`, and `poster_ref`/`thumbnail_ref`.
  - The existing atomic create-and-attach, operation dedup and draft retention are unchanged.
- `GET /api/v1/memes/:id/media`: authenticated, streams the asset with its MIME type and
  `Accept-Ranges: bytes`.
  - Single `Range: bytes=a-b` / `a-` / `-n` requests are answered with `206` and `Content-Range`;
    an unsatisfiable range → `416`. Safari requires ranges for `<video>`.
  - `/image` stays as an alias for image memes. `GET /api/v1/memes/:id/thumbnail` serves the
    poster or image; no poster → `404`.
- kDrive copy (`kdrive/meme-copy.ts`): unchanged flow. The extension comes from the stored MIME
  (common video types mapped, else `.bin`), name `MEM - <name>.<ext>`, direct upload (≤ 25 MiB fits).
- AI meme candidates: unchanged fields. A video meme is a valid candidate.

### Web (delta spec §H)
- `MemePicker`:
  - the file input `accept="image/*,video/*"`; type/size checks before upload;
  - for a video, extract the first frame client-side (`<video muted playsinline preload="metadata">`
    → seek to `min(0.1, duration/2)` → canvas → `image/webp` (or `image/jpeg` fallback) ≤ 1280 px)
    and upload it as the poster image attachment. A decode failure or 5 s timeout → no poster
    (neutral pictogram); never block saving;
  - the upload goes through the shared `AttachmentTransport` path with the real `Content-Type`
    (MEME-UPLOAD rule).
- Rows: the poster + ▶; a thumbnail tap toggles inline `muted loop playsInline autoPlay` playback
  of `/media` (no `controls`, never unmuted). One playing at a time; it stops on picker close.
  Row text keeps select/attach.
- Reel Detail meme metadata and the AI workspace `MEM` row: ▶ for video memes.

### Allowlist
`apps/api/src/storage/{filesystem,routes}.ts`, `apps/api/src/core/storage.ts`,
`apps/api/src/core/repository.ts` (attachment initiation kind/limits and the capture refusal only),
`apps/api/src/ai/library.ts`, `apps/api/src/kdrive/meme-copy.ts`, new
`apps/api/src/meme-video*.test.ts`, `apps/api/src/kdrive-meme-*.test.ts`,
`apps/web/src/screens/MemePicker*`, `apps/web/src/screens/ReelDetailScreen*` (▶ only),
`apps/web/src/screens/AiWorkspace*` (▶ only), `apps/web/src/data/{api,attachments}.ts`, new
`apps/web/src/data/video-poster.ts`, `apps/web/src/ui/screen-contracts.ts`,
`apps/web/src/screens/preview/DevPreview.tsx`, adjacent web tests.

### Acceptance
- API:
  - mp4, mov, webm, mkv and avi fixtures accepted;
  - a PNG declared as `video/mp4`, a text file and an unknown container refused;
  - 25 MiB + 1 refused, and streaming overrun refused;
  - GIF accepted as an image;
  - a capture with a video attachment refused;
  - create with video + poster, with video and no poster, and image as before;
  - both ids, or neither → 422;
  - create-and-attach retry dedups;
  - `/media` 200 full, 206 for each range form, 416 out of range, 401 without a session;
  - `/thumbnail` 404 without a poster;
  - kDrive copy name/extension for mp4/webm/unknown; the copy failure never fails create.
- Web:
  - accept attribute; size refusal copy;
  - poster extraction success → poster upload; failure/timeout → saved without a poster;
  - ▶ marker and accessible name `wideo`;
  - thumbnail tap plays muted+looped, a second tap stops, another row stops the first, close stops;
  - row text still attaches;
  - the upload carries the real `Content-Type`.
- Local Chrome at 360/1100 px with a small mp4 and a webm fixture; note Safari/iOS as an open gate.

---

## 3. Handoff (each task)

Owned files; exact commands and results; acceptance item by item; known limitations; UNVERIFIED
gates (Safari/iOS playback, Android picker, live kDrive copy of a video, real DEV); commit id. Do
not merge. The root integrates SOURCE-02 first (it touches `repository.ts` near the PATCH path),
then MEME-VIDEO-01.

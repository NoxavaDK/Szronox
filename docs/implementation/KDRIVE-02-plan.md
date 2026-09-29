# KDRIVE-02 — browser uploads to kDrive (feed cover, video export) + MEME-UPLOAD fix

Status: **operator decisions recorded 2026-09-29 (§8)**. Implementation by Luna; root (Opus)
reviews, integrates, deploys to DEV only and runs live acceptance. Before dispatch the root pins the
§1 amendment, the §5 contracts/migration and runs the §4 probe (GATE 1).

## 0. What the operator asked for

1. Add the **Okładka do feedu** image directly from the browser; it goes into the Reel's kDrive folder.
2. Add the **video file** directly from the browser; it goes into the Reel's kDrive folder and
   becomes the Reel's current export.
3. (Reported during planning) **Adding a meme image does not work** — fix it, and **copy every meme
   image into a dedicated kDrive meme folder** (§2a).

## 1. Scope amendment this plan needs (root-owned, before dispatch)

Current rules forbid parts of this. The operator's request is the authority to change them; the root
records the amendment in `AGENTS.md` and `docs/implementation/T00-contracts.md` before dispatch.

- `AGENTS.md` "no … large-file uploader" → amended: **one bounded, resumable relay upload into the
  Reel's own kDrive folder**, for exactly two purposes (feed cover image, video export). It is still
  not a general file manager: no browsing, no deleting, no renaming, no arbitrary destinations.
- T00 feed cover "No asset reference required for completion, no cover-management module" →
  amended: a Reel may carry **one optional cover file reference**, and a successful cover upload
  **also sets `feedCoverDone = true`** in the same version-checked write (operator decision 2). The
  control stays; the user can untick it. Completion is still never inferred from anything else
  (export, attachments). A cover upload on a published Reel is allowed and keeps it published.
  Still no cover gallery, no versions list, no image editing.
- KDRIVE-01 "folder creation is explicit" → amended: the **one explicit combined action**
  `Utwórz folder i wgraj` may create the Reel's folder and then upload (operator decision 1). No
  other path creates a folder implicitly.
- Memes → amended: SzroNox also writes each meme image into one **kDrive meme folder** (operator
  decision 4). SzroNox storage stays the source for the in-app library; kDrive holds a copy.
- T00 MATERIAŁY "Existing production export reference selection is not a large-file uploader" →
  amended: an uploaded video is recorded through the **existing export-replacement contract**
  (new revision each time, verification becomes `Nieaktualne` exactly as today). Pasting an export
  link remains available.

## 2. MEME-UPLOAD — bug fix (do first; small, independent)

**Observed on DEV** (API logs, 2026-09-28): every meme image upload fails at
`PUT /api/v1/reels/:id/attachments/:attachmentId/content` → **400 `FST_ERR_CTP_INVALID_CONTENT_LENGTH`**
("Request body size did not match Content-Length"). Present since `afd53d1`, not a UI-02 regression.

**Root cause.** `apps/web/src/screens/MemePicker.tsx` calls `api.uploadAttachmentContent` with
`initiated.upload.headers` only — no `Content-Type`. `CoreApiClient.request` then defaults the
request to `application/json`, Fastify's JSON parser reads the binary body as a UTF-8 string, and its
length check against `Content-Length` fails. Quick Add images work because
`AttachmentTransport.putContent` (`data/attachments.ts`) sends `ticketHeaders(upload)` plus the real
`Content-Type`.

**Fix.**
- MemePicker uploads through the shared `AttachmentTransport` path (same-origin check, ticket
  header only, `Content-Type: file.type`), including its one expired-ticket renewal.
- Reject a file with an empty or unsupported `file.type` before initiating (`Wybierz zdjęcie JPG,
  PNG lub WebP.`).
- Show upload progress state (`Wysyłanie…`) and a truthful Polish error; the name and chosen file
  stay in the form on failure.
- Server hardening (small): the content route must not be reachable by the JSON parser — register
  it so any `Content-Type` other than the attachment's declared MIME type is refused with a clear
  `422 VALIDATION_ERROR { reason: 'content_type_mismatch' }` instead of a parser 400.

**Acceptance.** Unit test that MemePicker's upload call carries `Content-Type` equal to the file's
MIME type and only the ticket header; API test that a JSON-typed PUT is refused with the new reason;
live DEV: create one SMOKE meme with a small PNG, attached to a SMOKE Reel, then soft-delete the Reel.

## 2a. Meme images copied to kDrive (operator decision 4)

- **Folder:** one folder `SzroNox Memy` directly under the configured base folder
  (`KDRIVE_ROOT_FOLDER_ID`; on DEV `1349`). Optional `KDRIVE_MEME_FOLDER_ID` overrides it. Found by
  exact name first, created once when missing (same lookup-before-create and ambiguous-create
  reconciliation as Reel folders); its id is cached in memory, never assumed.
- **When:** after a meme is created (its image is already validated in SzroNox storage), the API
  enqueues a copy. The copy runs **server-side** from SzroNox storage — the browser uploads once.
  Small files → kDrive direct/single-session upload, `conflict=rename`.
- **Name:** `MEM - <meme name>.<ext>` (decision 5), cleaned with the Reel-folder rules.
- **Failure never fails the meme:** the meme is created and attached as today; its kDrive copy
  state is `pending | copied | failed` with a bounded retry (3 attempts, backoff, then `failed`).
  kDrive not configured → state `not_configured`, no outbound call.
- **Record:** `memes.kdrive_file jsonb null` (`{ driveId, fileId, name, copiedAt }`) plus
  `kdrive_copy_state text`. Nothing in the UI depends on it beyond a quiet `Kopia w kDrive` /
  `Kopia w kDrive nie powiodła się · Ponów` line in the meme picker row details.
- **Existing memes:** a one-off operator CLI `copy-memes-to-kdrive` (idempotent: skips `copied`),
  run on DEV only with approval. Deleting a meme never deletes its kDrive copy.
- Where the retry runs: the API process (small bounded in-process queue woken on create and every
  5 min for `pending`/retryable `failed` rows). The worker keeps no kDrive access.

## 3. Architecture for kDrive uploads

**The token never reaches the browser.** kDrive's upload endpoints require the bearer token, so
the browser cannot talk to kDrive directly. Uploads are **relayed**: the browser sends chunks to the
SzroNox API; the API forwards each chunk to a kDrive upload session. Nothing is written to the VPS
disk and each chunk is held in memory only while it is forwarded.

```
browser ──(16 MiB chunks, session + CSRF, per-upload ticket)──▶ SzroNox API ──(bearer token)──▶ kDrive
         ◀──────── progress, resume point, final file ref ─────────  │
                                                                    └─ app.kdrive_uploads (state)
```

Flow for one file:

1. `POST /api/v1/reels/:id/kdrive-uploads` `{ operationId, purpose: 'video'|'cover', fileName,
   byteSize, mimeType, createFolder? }` → validates, requires the Reel's linked **available** kDrive
   folder (or, with `createFolder: true`, ensures and links it first — see Folder rule),
   starts a kDrive upload session into that folder with `conflict=rename` (never overwrite) and the
   prefixed name `EKSPORT - <file name>` or `OKLADKA - <file name>` (decision 5; original
   extension kept, unsafe characters cleaned, prefix not doubled if the name already has it),
   stores an upload row, returns `{ uploadId, chunkSize, totalChunks, receivedChunks: [] }`.
   Idempotent on `operationId`.
2. `PUT /api/v1/kdrive-uploads/:uploadId/chunks/:n` (raw body, `Content-Type:
   application/octet-stream`, `Content-Length` = exact chunk size) → API checks ownership, index,
   exact size; for chunk 0 also sniffs magic bytes against `purpose`/`mimeType`; computes sha256,
   forwards to kDrive with the hash; records the chunk as received. Re-sending an already received
   chunk returns 204 without calling kDrive.
3. `POST /api/v1/kdrive-uploads/:uploadId/finish` → all chunks received → kDrive finish → stores
   the resulting `fileId`/final name → returns the file reference. Idempotent.
4. `POST /api/v1/kdrive-uploads/:uploadId/attach` `{ operationId, expectedVersion }` →
   version-checked Reel write in one transaction:
   - `video` → the **existing** export replacement: `currentExport = { url: <kDrive web URL>,
     label: <final file name>, driveId, fileId }`, revision + 1, verification history kept.
   - `cover` → `feedCoverAsset = { driveId, fileId, name, byteSize, uploadedAt, uploadedBy }` and
     `feedCoverDone = true` in the same write (decision 2).
   A 409 leaves the kDrive file and the upload row intact; the client refreshes and retries attach.
5. `DELETE /api/v1/kdrive-uploads/:uploadId` → cancels an unfinished kDrive session. A finished
   file is never deleted by SzroNox.
6. `GET /api/v1/reels/:id/kdrive-uploads?state=open` → unfinished uploads for resume.

Why finish and attach are separate: the file then exists in kDrive exactly once whatever happens to
the Reel meanwhile, and the Reel write stays a normal optimistic-concurrency mutation.

**Limits (config, with defaults):** chunk 16 MiB; video ≤ 4 GiB, `video/mp4` or `video/quicktime`
(sniffed `ftyp` box); cover ≤ 25 MiB, JPEG/PNG/WebP (sniffed). Max 2 open uploads per Reel, 4 per
user. Upload rows expire (kDrive session cancelled) after 24 h without a chunk.

**Folder rule (decision 1).** With a linked, `available` folder the button is `Wgraj …`. With no
folder it is the single explicit `Utwórz folder i wgraj`: start is called with `createFolder: true`,
the API runs the existing KDRIVE-01 ensure-folder logic (lookup by tag first, never a duplicate),
records `kdriveFolder` on the Reel (version-checked, same as today's create) and then opens the
upload session — all under the start `operationId`, so a replay neither creates a second folder
nor a second session. Without `createFolder: true` a missing folder is refused
(`folder_required`). A linked but missing/denied folder is **never** silently replaced: the upload
is refused and the existing `Połącz ponownie` path applies. The destination is always the Reel's
folder id, re-resolved at start.

**Resume.** The browser keeps the `File` handle only while the page is open. If the tab reloads or
the connection drops, the Reel shows `Wysyłanie przerwane — wybierz ten sam plik, aby wznowić`;
picking a file with the same name and size resumes from the first missing chunk (hash of chunk 0
must match what was recorded). Otherwise `Anuluj wysyłanie`.

## 4. kDrive API facts — GATE 1 PASSED (2026-09-29)

Confirmed live in `docs/implementation/KDRIVE-02-probe.md`. Build on these; do not re-probe.
- **Start** `POST https://api.infomaniak.com/3/drive/{drive}/upload/session/start` with
  `{ conflict: 'rename', directory_id, file_name, total_chunks, total_size }` →
  `data.token`, `data.upload_url` (per-session host) and `data.file.{id,name}`. The final name
  after rename is known at start: store it.
- **Chunk** `POST {upload_url}/3/drive/{drive}/upload/session/{token}/chunk?chunk_number=N&chunk_size=B&chunk_hash=sha256:<hex>`
  with a raw body. A wrong hash is refused. **Non-final chunks must be ≥ ~1 MB** (512 KiB was
  refused); 16 MiB is used.
- **Finish** `POST https://api.infomaniak.com/3/drive/{drive}/upload/session/{token}/finish`
  with `{ total_chunk_hash: 'sha256:' + sha256(concatenated hex chunk hashes) }` →
  `data.file.{id,name,size,status}`. It is **not idempotent**: a replay after success returns
  `invalid_upload_token_error`. Record the result before answering, and reconcile an ambiguous
  finish by `GET /3/drive/{drive}/files/{id}` on the id known from start.
- **Cancel** `DELETE https://api.infomaniak.com/3/drive/{drive}/upload/session/{token}`; later
  chunks then return `upload_token_canceled`. An unfinished session leaves no visible file.
- **Direct** `POST https://api.infomaniak.com/3/drive/{drive}/upload?directory_id=&file_name=&total_size=&conflict=rename`
  with a raw body → the file. Use it for covers and meme copies (≤ 25 MiB).
- `conflict=rename` produces `<name> (1).<ext>`; nothing is overwritten. The existing token scope
  permits uploads. Outbound HTTPS to `*.upload.kdrive.infomaniak.com` works from the DEV API
  container.
- Still unverified: server-side session expiry (not reported) and the browser URL of a single
  file. Until that URL is confirmed in a signed-in browser, `Otwórz` opens the Reel's folder.

## 5. Data and contracts (root pins before dispatch)

- Migration `0013_kdrive_uploads.sql`:
  - `app.kdrive_uploads(id uuid pk, reel_id uuid fk, purpose text check in ('video','cover'),
    requested_by uuid, file_name text, mime_type text, byte_size bigint, chunk_size int,
    total_chunks int, received_chunks int[] not null default '{}', chunk0_sha256 text,
    kdrive_session_token text, kdrive_upload_host text, folder_id text, state text check in
    ('open','finished','attached','cancelled','expired','failed'), kdrive_file_id text,
    final_name text, error jsonb, created_at, updated_at, operation ids)`.
    The session token is provider state, not a user credential; it is never returned to the browser.
  - `app.reels.feed_cover_asset jsonb null`.
  - `app.memes.kdrive_file jsonb null`, `app.memes.kdrive_copy_state text not null default
    'pending'` (check in `pending`,`copied`,`failed`,`not_configured`), `kdrive_copy_attempts int`,
    `kdrive_copy_error jsonb`. Existing rows start `pending`; nothing copies them until the
    operator CLI runs or they are retried.
  - Grants: API role read/write on `kdrive_uploads`; worker none.
- Contracts: `Meme.kdriveCopy: { state, name?, webUrl? }`; start request gains `createFolder?: boolean`;
  `Reel.feedCoverAsset: { driveId, fileId, name, byteSize, uploadedAt, uploadedBy } | null`;
  `KdriveUploadStartRequest/Response`, `KdriveUploadState`, `AttachKdriveUploadRequest`; reuse
  `ExportReference` (already has `driveId`/`fileId`). No new status; `feedCoverDone` is set only
  by the explicit toggle or a successful cover attach.
- Error codes: reuse `PROVIDER_*`, `VALIDATION_ERROR` (reasons: `folder_required`, `too_large`,
  `unsupported_type`, `content_mismatch`, `chunk_out_of_range`, `chunk_size_mismatch`,
  `upload_not_open`), `EDIT_CONFLICT`, `RATE_LIMITED`.

## 6. Web UI (Polish copy, UI-02 semantic system)

- **MATERIAŁY → AKTUALNY EKSPORT:** `Wgraj wideo` (action) next to the existing link path, renamed
  `Wklej link`. During upload: file name, `x z y MB`, progress bar, `Anuluj`. On success: the export
  row shows the new file with `Otwórz` (kDrive) and verification becomes `Eksport zmieniony ·
  Sprawdź ponownie` exactly as a pasted replacement does. Montaż primary action `Dodaj eksport`
  opens the same choice.
- **PUBLIKACJA → Okładka do feedu:** the existing `+ Dodaj` / `Zmień` / `Otwórz` controls become
  real (today they show "not yet available"). A successful upload ticks `Gotowa` (the pictogram
  turns complete-green) and shows a quiet `Okładka wgrana i oznaczona jako gotowa.`; the toggle can
  still untick it. In Gotowe, the `Brak okładki do feedu` primary action becomes
  `Wgraj okładkę` (opens the picker; combined folder creation when needed).
- **Meme picker:** after `Zapisz mem`, the row shows the quiet kDrive copy state (§2a).
- Leaving/closing while uploading: `beforeunload` warning; the upload survives switching Reels
  inside the app (kept in the controller, keyed by Reel), not a reload.
- No kDrive folder: the upload button reads `Utwórz folder i wgraj` (one click, explicit);
  kDrive not configured: controls hidden with the existing truthful note.
- Screen Wake Lock while a video uploads, where supported; nothing else platform-specific.

## 7. Delivery

- **Model:** `gpt-6-luna`, high reasoning. Difficulty: high (resumable relay, provider state,
  concurrency). One milestone, two commits: `MEME-UPLOAD` fix first, then `KDRIVE-02`.
- **Base:** master after the root's amendment/contract/migration pin commit.
- **Worktree:** `codex/kdrive-02`. Luna does not merge, deploy, provision, call live kDrive except
  the approved probe, send messages, or spawn agents.
- **Root-owned, read-only for Luna:** `AGENTS.md`, `T00-contracts.md`, this plan,
  `packages/contracts/src/index.ts`, `database/migrations/**`, `database/grants.sql`, root
  dependencies/lockfiles, `deploy/vps/compose.yaml`.
- **Luna allowlist:** `apps/api/src/kdrive/**` (+ new `uploads.ts`, `upload-routes.ts`),
  `apps/api/src/core/{repository,routes,config}.ts` (Reel mapping of `feedCoverAsset`, attach
  writes only), `apps/api/src/storage/routes.ts` (MEME-UPLOAD content-type guard only),
  `apps/api/src/app.ts`, `apps/api/src/runtime/api.ts`, `apps/api/src/kdrive*.test.ts`,
  `apps/api/src/ai/library.ts` (meme create hook for the kDrive copy only), new
  `apps/api/src/kdrive/{meme-copy,copy-memes-cli}.ts`,
  `apps/web/src/screens/{MemePicker,PublicationSection}*`, `apps/web/src/ui/detail-sections*`,
  `apps/web/src/ui/screen-contracts.ts`, `apps/web/src/app/App.tsx`,
  `apps/web/src/controllers/useAppController.ts`, new `apps/web/src/data/kdrive-upload.ts`,
  `apps/web/src/data/{api,kdrive,attachments}.ts`, adjacent web tests, new
  `deploy/vps/kdrive-upload-live.mjs`. Anything else: ask the root.

### Acceptance (Luna, before handoff)

API with an in-memory kDrive session fake:
- start without a folder: refused unless `createFolder: true`; with it, exactly one folder is
  created (or found by tag) and linked, and a replay creates neither a second folder nor session;
  a linked missing/denied folder is refused, never replaced; unconfigured → no outbound call.
- names: `EKSPORT - ` / `OKLADKA - ` / `MEM - ` prefixes, extension kept, prefix never doubled.
- meme copy: meme creation succeeds when kDrive fails; retry bounded; `copied` rows skipped; meme
  folder found-or-created once under the base folder; CLI idempotent.
- exact chunk size/count/range enforced; `Content-Type` other than octet-stream refused.
- chunk 0 magic bytes: a PNG declared as video, and an MP4 declared as cover, are refused.
- duplicate chunk → 204, no provider call; out-of-order chunks accepted; finish refused until all
  received; finish and attach idempotent on replay.
- ambiguous finish (timeout) reconciled by one status/lookup, never a second file.
- attach `video` increments export revision and turns verification `outdated`; attach `cover` sets
  `feedCoverAsset` **and** `feedCoverDone = true` in one write; stale version → 409 with file kept.
- cancel only while open; expiry job cancels the kDrive session; SzroNox never deletes a finished file.
- the token and session token never appear in any response or log line.
- limits: size, type, open uploads per Reel/user.

Web:
- MEME-UPLOAD content-type test; memory: chunks sliced lazily (`File.slice`), never the whole file.
- progress/cancel/resume state machine incl. same-file check; no upload offered without folder.
- cover upload ticks completion and the toggle can still untick it; video success shows the new
  export and stale verification; `Utwórz folder i wgraj` shown only without a folder.
- one build/typecheck pass; targeted suites; a local Chrome run at 360/390/1100 px with the fake.

### Root review, integration, DEV deployment

Root reviews the diff and boundaries, runs targeted checks only on concrete risk, merges, applies
migration 0013 on DEV with backup, and runs `deploy/vps/kdrive-upload-live.mjs`: one SMOKE Reel with
a folder under `1349`, a ~40 MB generated MP4 (3 chunks) and a small cover image uploaded, attached
and confirmed through kDrive metadata; a resumed upload after a simulated drop; cancel; the
token-leak check; the combined folder+upload on a Reel with no folder; the cover auto-tick; SMOKE
Reel soft-deleted, kDrive test files left in `1349` by design. Also the MEME-UPLOAD live check (§2)
and its copy appearing as `MEM - …` in `SzroNox Memy` under `1349`.

Open manual gates after deploy: a real phone upload of a real Reel-sized video over mobile data;
opening the uploaded file from the app as NOXAVA and as SZRON; tab-switch/background behaviour on
Android.

## 8. Operator decisions (2026-09-29)

1. **No folder yet:** one combined, explicit `Utwórz folder i wgraj` action (§3).
2. **Cover completion:** a successful cover upload ticks `Gotowa` automatically; untick stays possible.
3. **Video size cap:** 4 GiB.
4. **Meme images:** fix the upload **and** copy every meme image into a dedicated kDrive meme
   folder (`SzroNox Memy` under the base folder) (§2a).
5. **File names in kDrive:** prefixes `EKSPORT - `, `OKLADKA - `, `MEM - `; original name and
   extension kept after the prefix; kDrive renames on collision, nothing is overwritten.

Still to confirm at GATE 1 (not a product decision): the live upload API shape (§4). On production
the base folder and therefore the meme folder location will be a separate operator choice.

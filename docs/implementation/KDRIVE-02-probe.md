# KDRIVE-02 GATE 1 — live kDrive upload probe

Date: 2026-09-29. Operator: "make the quick test". Run on the DEV VPS inside the API image with
the existing API-only token secret (never printed). Scripts: `deploy/vps/kdrive-upload-probe.mjs`
and a follow-up run (finish hash and minimum chunk size). Full log (session tokens shortened):
`/opt/szronox-dev/backups/kdrive-upload-probe-20260929.log`.

Scope: one new probe folder **`1398` (`KDRIVE-02 probe 2026-09-29T15-36-33-537Z`) inside base
folder `1349`**, generated random bytes and one 1×1 PNG only. Nothing existing was read beyond
metadata or modified. The folder and its test files are left in place by design.

## Confirmed facts

| # | Fact | Evidence |
|---|---|---|
| 1 | The existing token's scope permits uploads. | Every start/chunk/finish/direct call succeeded with it. |
| 2 | `POST https://api.infomaniak.com/3/drive/{drive}/upload/session/start`, JSON `{ conflict, directory_id, file_name, total_chunks, total_size }` → `data.token` (36 chars), `data.upload_url` (a per-session host, e.g. `https://1-52-v3-12.upload.kdrive.infomaniak.com`), and `data.file` already carrying the **final id and final name** (status `uploading`, size 0). | P2/P3 |
| 3 | Chunks: `POST {upload_url}/3/drive/{drive}/upload/session/{token}/chunk?chunk_number=N&chunk_size=B&chunk_hash=sha256:<hex>` with a raw body. Response `{ number, status: 'ok', size, hash }`. 16 MiB chunks took ~1.2 s each from the VPS. | P2 |
| 4 | A wrong `chunk_hash` is rejected: 400 `upload_failed_error` "upload hash mismatch". The session stays open for other chunks. | P4 |
| 5 | **Minimum non-final chunk size is between 512 KiB (rejected, `chunk_size_limit_error`) and ~1000 KiB (accepted).** The last chunk may be smaller (10 KiB was accepted). Our 16 MiB chunks are fine. | P6, M |
| 6 | Finish: `POST https://api.infomaniak.com/3/drive/{drive}/upload/session/{token}/finish` → `data.file` with the final `id`, `name`, `size`, `status: 'ok'`. `total_chunk_hash` is **optional**. When sent it must be `sha256:` + sha256 of the **concatenated hex chunk hashes** (as text). A whole-file sha256, raw digests or prefixed strings are rejected with `total_chunk_hash_is_not_valid`. | P2, F1–F4 |
| 7 | Finish is **not idempotent**. A replay after success returns 400 `invalid_upload_token_error`. The upload row must record the result before responding, and an ambiguous finish is reconciled by reading the file id already known from start (fact 2) — `GET /3/drive/{drive}/files/{id}` → `status: 'ok'` and the expected size. | P3 |
| 8 | Finishing before all chunks are ok → 400 `upload_not_terminated_error`. | P4, P6 |
| 9 | Cancel: `DELETE /3/drive/{drive}/upload/session/{token}` → `data: true`. Later chunks → 400 `upload_error` `upload_token_canceled`. | P5 |
| 10 | `conflict: 'rename'` renames at **start**: a second `EKSPORT - probe.mp4` became `EKSPORT - probe (1).mp4`. Nothing was overwritten. | P3 |
| 11 | Direct upload: `POST /3/drive/{drive}/upload?directory_id=&file_name=&total_size=&conflict=rename` with a raw body → `data` is the file (`id`, `name`, `size`, `status: 'ok'`). This suits meme copies and covers. | P7 |
| 12 | kDrive derives `mime_type` and `extension_type` from the name (`video/mp4` for `.mp4`); `scan_status` becomes `to_be_scan` after finish. | P2–P7 |
| 13 | A started session that is never finished leaves no visible file: listings show only `status: ok` files, and the `uploading` placeholders (ids 1399, 1401–1403) are absent. | P9 |

## Plan consequences (applied to `KDRIVE-02-plan.md`)

- Chunk size 16 MiB is kept. The minimum ~1 MB applies to non-final chunks only; files up to one
  chunk use a single chunk.
- The API sends `chunk_hash=sha256:<hex>` per chunk (already computed for its own record). At
  finish it sends `total_chunk_hash` = sha256 of the concatenated hex hashes.
- The kDrive file id and final name come from **start**, so they are stored in the upload row
  immediately.
- A replayed finish is never forwarded; ambiguous finishes are reconciled by `GET` on that id.
- Chunks go to the session `upload_url` host. Start, finish and cancel go to `api.infomaniak.com`.
  The relay must allow outbound HTTPS to `*.upload.kdrive.infomaniak.com` (it worked from the DEV
  API container).
- Covers and meme copies (≤ 25 MiB) may use direct upload. Video always uses sessions.

## Still unverified

- Session expiry time: there is no expiry field in the start response. The plan's 24 h
  cancel-on-idle stays our own policy; a session that expires server-side surfaces as a chunk
  error and is marked `expired`.
- The browser URL that opens a single file (rather than its folder). The folder web URL is known
  (`…/drive/{drive}/files/{folderId}`); until a file URL is confirmed in a signed-in browser,
  `Otwórz` opens the Reel's folder.
- 403/429/5xx behaviour on the upload host (none observed).

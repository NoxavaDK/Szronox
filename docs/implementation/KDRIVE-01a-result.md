# KDRIVE-01a result — kDrive folder API

Operator-authorized 2026-09-26. Scope: API, configuration, tests and DEV deployment only. The web wiring (`KDRIVE_ENABLED`, the MATERIAŁY and list actions) is KDRIVE-01b, after UX-ASTRA-03 is integrated.

## Changed files

- `apps/api/src/kdrive/client.ts`: Infomaniak transport ported from the live-verified T04 spike.
  - v3 metadata, listing and create; `{result,data}` / `{error:{code}}` envelopes.
  - Reads retry 429, 5xx and transport failures (with bounded backoff and `Retry-After`); create is a single attempt.
  - Listing follows `has_more`/`cursor`.
  - The token appears only in the Authorization header.
- `apps/api/src/kdrive/service.ts`: explicit create, link and resolve.
  - Folder name is `<title or first capture line> [<8 hex of Reel id>]`.
  - Lookup by tag comes before create; an ambiguous or duplicate create is reconciled by lookup.
  - A name collision with a non-live item gets one ` (2)` name.
  - A read never clears the stored reference.
- `apps/api/src/kdrive/config.ts`: `KDRIVE_DRIVE_ID`, `KDRIVE_ROOT_FOLDER_ID`, `KDRIVE_TOKEN_FILE`, all or none.
- `apps/api/src/kdrive/routes.ts`: `POST|GET /api/v1/reels/:id/kdrive-folder`.
- `apps/api/src/core/{repository,config,routes}.ts`, `apps/api/src/app.ts`, `apps/api/src/runtime/api.ts`:
  - ledger replay lookup and the version-checked, idempotent `kdrive_folder` write;
  - configuration wiring;
  - IDs-only startup description.
- `packages/contracts/src/index.ts`: `KdriveFolderRequest`, `KdriveFolderState`, `KdriveFolderResponse`. No new error codes.
- `apps/api/src/kdrive.test.ts`: 14 tests against an in-memory kDrive that reproduces the spike's live observations.
- `deploy/vps/kdrive-live.mjs`: DEV live acceptance.
- `docs/implementation/T00-contracts.md`: KDRIVE-01a amendment.

No migration (existing `kdrive_folder` column), dependency or lockfile change. No web change.

## Verification

- `npm run build`, `npm run typecheck`: PASS.
- `node --test apps/api/dist/kdrive.test.js`: 14/14. Coverage:
  - configuration, including that the token never appears in errors;
  - transport retry rules;
  - pagination and naming;
  - resolve → create → resolve;
  - ledger replay with no provider call;
  - ambiguous create reconciled;
  - orphan reused after a title change;
  - duplicate name;
  - already linked and stale version;
  - link/relink, missing id and a file id;
  - missing, denied and unavailable resolve states with the reference retained;
  - provider errors in the envelope with no token;
  - session and CSRF;
  - unconfigured with no outbound call.
- Full API suite:
  - 210/219 without `shutdown`; the 6 PWA-serving failures in that run needed the web build and pass 6/6 after `npm run build`.
  - `shutdown.test.js` run alone: 6/6.
  - The remaining 3 failures (`deploy-config` ×2, `vps-integration` migration inventory) are pre-existing on master.

## DEV configuration (host side, not in the image)

- `/opt/szronox-dev/secrets/kdrive_token`: the existing T04 token, copied file-to-file from the laptop spike `.env`. Mode 0600, owner `ubuntu` (uid 1000 = container `node`), fingerprint `303e56f0dad8`.
- `config/runtime.env`: `KDRIVE_DRIVE_ID=1990403`, `KDRIVE_ROOT_FOLDER_ID=1349`.
- `config/compose.kdrive-secret.yaml`:

  ```yaml
  secrets:
    kdrive_token:
      file: /opt/szronox-dev/secrets/kdrive_token
  services:
    api:
      environment:
        KDRIVE_DRIVE_ID: ${KDRIVE_DRIVE_ID:-}
        KDRIVE_ROOT_FOLDER_ID: ${KDRIVE_ROOT_FOLDER_ID:-}
        KDRIVE_TOKEN_FILE: /run/secrets/kdrive_token
      secrets:
        - source: kdrive_token
          target: kdrive_token
  ```

- `config/dc-gemini.sh`: adds `-f /opt/szronox-dev/config/compose.kdrive-secret.yaml`.

## Limits

- 403, 429 and 5xx shapes are still not observed live; they are classified and unit-tested only.
- Opening `webUrl` in a signed-in browser for NOXAVA and SZRON is an operator check. The operator confirmed both have access to base folder `1349`.

## DEV deployment (2026-09-26)

Merge `8f5e48c` (implementation `97ff69d`) runs as image `szronox-dev:8f5e48c`, ID `sha256:e7b1b3306a60caa5a85279fee14ba2db64971ef865c221a9016ccf99b444a04d`. Archive SHA-256 `889d545cb8598f82e20cda1c63415073e96f9dfeabe3f06d20b162cccf436ddb`, identical after transfer.

- **Backup:** `backups/pre-8f5e48c/` holds a 671,719-byte dump (20 TABLE DATA), `runtime.env` (release `650c581`), `dc-gemini.sh` and state files. The AI queue was empty.
- **Token:** copied file-to-file from the laptop spike `.env` to `/opt/szronox-dev/secrets/kdrive_token` (0600, `ubuntu`, 80 bytes, fingerprint `303e56f0dad8`), never printed.
- **Host config:**
  - `compose.kdrive-secret.yaml` added.
  - `runtime.env` gained `KDRIVE_DRIVE_ID=1990403` and `KDRIVE_ROOT_FOLDER_ID=1349`.
  - `dc-gemini.sh` gained one `-f` line.
  - Each was diffed against the backup.
- **Rollout:** migrate checked 12 files and applied 0; grants exit 0; only the DEV API and worker were recreated (0 restarts).
- **Checks:**
  - Ready on loopback and HTTPS; `/`, `/sw.js` and `/manifest.webmanifest` return 200.
  - The token file is readable in the API container only (absent from the worker), and the token does not appear in the API logs.
  - `GET /kdrive-folder` without a session now returns 401 (it returned 404 before).
  - Neighbours' StartedAt, Caddy MainPID 170439 and the Caddyfile hash are unchanged.
- **Live acceptance** (`deploy/vps/kdrive-live.mjs`, real kDrive): 14/14.
  - Resolve returned `none` (configured).
  - Create returned folder `1381`, `SMOKE KDRIVE-01 [3d025dcd]`, with the Reel at version +1 and its status unchanged.
  - A replay returned the same folder, and a second create was refused (`already_linked`).
  - Resolve then returned `available` with the same folder and web reference `https://ksuite.infomaniak.com/kdrive/app/drive/1990403/files/1381`.
  - kDrive's own metadata confirms a directory whose parent is `1349`.
  - The web link answers 302 to login.
  - No response contained the token; the routes require a session and CSRF.
  - The SMOKE Reel was soft-deleted.
  - Folder `1381` was left in `1349` by design, and nothing existing in kDrive was modified.

**Rollback (code only):** restore `app.pre-8f5e48c` as `app` and `backups/pre-8f5e48c/runtime.env` (release `650c581`, no KDRIVE_* keys), optionally restore `backups/pre-8f5e48c/dc-gemini.sh`, then run `config/dc-gemini.sh up -d --no-deps api worker`. No migration is involved. Stored folder references stay in `kdrive_folder` and are ignored by `650c581`.

**Open operator gate:** open a folder link in a signed-in browser as NOXAVA and as SZRON. That becomes clickable in the app with KDRIVE-01b; until then, test link: `https://ksuite.infomaniak.com/kdrive/app/drive/1990403/files/1381`.

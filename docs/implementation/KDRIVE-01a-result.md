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

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

## KDRIVE-01b — web wiring (2026-09-26)

Built on master after UX-PUBLICATION-02/UX-ASTRA-03 integration (`86d9b8e`).

- **`apps/web/src/data/kdrive.ts`:**
  - web-link builder;
  - relink input parser (numeric id, or a kDrive folder link on an `infomaniak.com` host);
  - the Materials view per resolved state;
  - Polish command messages.
- **`apps/web/src/data/api.ts`:** `kdriveFolder` and `commandKdriveFolder`.
- **`apps/web/src/app/App.tsx`:**
  - The hard-coded `KDRIVE_ENABLED = false` is removed.
  - Opening a Reel resolves its folder (keyed per Reel; re-resolved only when the stored reference changes).
  - MATERIAŁY: `+ Utwórz folder kDrive` (create), `Otwórz kDrive` (opens `webUrl`), and `Połącz ponownie` (prompt for a pasted kDrive link or number, then link).
  - The list sheet's `Otwórz kDrive` opens the stored reference directly.
  - A command is refused with an explanation while an edit of the Reel is still saving, so it never conflicts with the author's own edit.
  - "Not configured" is taken only from an unambiguous `none` answer; a temporary outage never disables the actions.
  - The collapsed Materials summary mentions a linked folder.
- **`apps/web/src/ui/{detail-sections.tsx,screen-contracts.ts}`:** optional one-line `note` (checking / deleted / no access / temporarily unavailable), and truthful "nie jest skonfigurowana" wording.
- **Duplicate-Detail fix (root correction from the UX-ASTRA-03 Opus review):** the Zaplanuj sheet key is now `schedule:<reelId>`, no longer equal to the Detail's `reelId` key. That shared key left a stale Detail behind on mobile after cancelling the sheet. It had been present since CONTENT-PLANNER-01 and is live on DEV until this deploys.

**Verification:**
- `npm run build`, `npm run typecheck`: PASS.
- New `data/tests/kdrive.test.mjs`: 5/5, including source guards for the removed switch-off and the namespaced sheet key.
- Existing web suites plus controller tests: 92/92, after correcting one stale test expectation. `publication-generation.test.mjs` still expected the pre-PUBLICATION-02 STALE_PUBLICATION_RESULT copy. UX-PUBLICATION-02 had deliberately changed that copy to cover script, hook and source changes, but not the test; this failure came in with the Luna merge (`86d9b8e`). I first merged `7a68ef0` before reading that result; the expectation is corrected in the follow-up commit.
- Browser auth and attachment transport: 24/24.
- Local real-Chrome run against this build (kDrive faked in-process, no real calls): 17/17.
  - Mobile: create, name with tag, open link, list open.
  - A folder deleted at kDrive shows as unavailable with the reference kept, and relink by pasted link works.
  - Desktop: create is refused while an edit is saving, then works with the edit kept.
  - Three rounds of Zaplanuj → Anuluj → Wstecz leave no duplicate or stale Detail.

## DEV deployment of `5e2d022` (2026-09-27) — KDRIVE-01b plus UX-PUBLICATION-02 / UX-ASTRA-03

Operator: "deploy to DEV". Image `szronox-dev:5e2d022`, ID `sha256:8f60e97c270932ea6bdd16c27d3ed8d20a30a5decd5e0564d888c9d0b8c818be`. Archive SHA-256 `f30e8df9b3e39f76afd4b7dcd8d63f8ae746549e9420854cac7ee711695a05be`, identical after transfer.

- **Backup:** `backups/pre-5e2d022/` holds a 672,520-byte dump (20 TABLE DATA), `runtime.env` (release `8f5e48c`), `dc-gemini.sh` and state files. The AI queue was empty.
- **Rollout:** only `SZRONOX_RELEASE` changed (diffed). Migrate checked 12 files and applied 0; grants exit 0; only the DEV API and worker were recreated (0 restarts).
- **Checks:**
  - Ready on loopback and HTTPS; `/`, `/sw.js` and `/manifest.webmanifest` return 200.
  - The kDrive token is still readable by the API only and absent from its logs.
  - The served bundle `index-Zk6QzR7o.js` contains the kDrive actions, the namespaced schedule-sheet key, the `Wszystkie` status filter and the `Dwa panele` workspace.
  - Neighbours' StartedAt, Caddy MainPID 170439 and the Caddyfile hash are unchanged.
- **kDrive live acceptance** (`deploy/vps/kdrive-live.mjs`): 14/14 on the new release. A SMOKE Reel got folder `1382` in `1349` (left in place by design), and the SMOKE Reel was soft-deleted.
- **Not run:** Astra's UI check. Live provider quality of the PUBLICATION-02 prompt is UNVERIFIED (no Gemini call was made in this deployment).

**Rollback (code only):** restore `app.pre-5e2d022` as `app` and `backups/pre-5e2d022/runtime.env` (release `8f5e48c`), then run `config/dc-gemini.sh up -d --no-deps api worker`. No migration is involved.

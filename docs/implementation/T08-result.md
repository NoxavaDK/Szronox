# T08 — drafts, synchronization and functional wiring

Branch: `agents/t08-sync`, prepared at root `f0e8e9b` with T05 `ea81fae` and T06
`6b52050`. Agent: approved `gpt-5.6-sol`. Nothing was merged or deployed.

## Delivered in the T08 allowlist

- `apps/web/src/auth/**`: a browser Supabase GoTrue email/password session adapter with
  persisted session recovery, single-flight token refresh, local sign-out and no signup or
  privileged credential path; a minimal Polish login surface.
- `apps/web/src/data/**`: typed `/api/v1` client, safe error envelopes and Polish domain
  error mapping; exact Publication text composition.
- `apps/web/src/drafts/**`: IndexedDB stores for account-scoped capture/Reel drafts, stable
  image blobs, operation queue and quarantined pre-login share payloads. Quarantine binding
  moves the payload and blobs into exactly one explicitly selected account transactionally.
- `apps/web/src/controllers/**`: session recovery, list/detail navigation, local-first capture,
  create replay, coalesced version-checked scalar edits, individual hook removal, soft delete,
  restore, reconnect queue handling and conflict retention. Queue processing stops on 401 or
  409 and selects work only for the current account.
- `apps/web/src/app/**` and `main.tsx`: real T06 screen composition for login, active lists,
  manual text/URL/multiple-image capture, Detail editing and Publication fields/copy. kDrive,
  AI and cover-asset controls remain honestly unavailable.

All supported image descriptors receive stable UUIDs before persistence. Their `Blob`s are
committed in the same IndexedDB transaction as the capture draft before any create request.
Create retries reuse the same `operationId` and `reelId`. Existing Reel drafts retain the
server version used for their patch. A 409 leaves the draft and queue item intact and never
updates the rendered authoritative version as if it succeeded. Storage exceptions surface
`Nie zapisano lokalnie`/a Polish error and never report cloud success.

`Kopiuj opis` reads the current controlled values, inserts exactly `"\n\n"` only when both
fields are nonempty, performs no mutation, and reports success only after `writeText` resolves.
Empty input and clipboard unavailable/rejected paths are truthful; the latter exposes the
exact selectable fallback text in the notice.

## Dependency mismatches reported to the lead

The merged T06 interface predates the current Reel Detail delta. It has no controlled
status/priority/editor selection callbacks; no editors for `inputNote`, `editingNotes` or the
separate original/additional input view; no controlled Materials/export/verification state;
and no deleted-list/restore or conflict-recovery callback. T08 wires every available intent,
but those acceptance surfaces cannot be completed without a lead-owned T06 interface update.
The native delete confirmation preserves the frozen copy, although a T06-owned dialog is
needed to guarantee the exact `Anuluj`/`Usuń` button labels on every platform.

The merged T05 `GET /reels` route ignores `visibility=deleted`, so a correct client request
cannot retrieve deleted records. T05 attachment initiation returns a storage key without a
signed upload URL or browser Storage transport. Blobs therefore remain durable and retryable,
but this branch does not claim they were uploaded or completed. T05 route registration in
`app.ts`, asymmetric Supabase JWKS verification, real Storage adapter/configuration and root
lock reconciliation remain lead integration work as recorded in T05's handoff.

The current T06 contracts import the built `@szronox/contracts` declarations, which were stale
in the shared root `node_modules` during this task. T08's type-only imports point directly to
the canonical current `packages/contracts/src/index.ts`; no contract source or generated output
was edited.

## Verification

Commands from `.worktrees/t08-sync`:

```sh
npm run test:t08 --workspace @szronox/web
npm run typecheck --workspace @szronox/web
npm run build --workspace @szronox/web
git diff --check
```

Results: Publication composition test 1/1 passed; web typecheck passed; Vite production build
passed (50 modules); diff check passed. An actual in-app browser loaded the local Vite build
and exposed the Polish, keyboard-addressable login form without console-visible failure.

No configured allowlisted development account, composed T05 server, Supabase project or
Storage transport was available, so authenticated end-to-end behavior and actual browser
IndexedDB capture/blob/reload/concurrent promotion remain **UNVERIFIED**. The IndexedDB code
was typechecked and reviewed, not mislabeled as browser evidence. No live service mutation,
account creation, invitation, kDrive operation, AI execution, deployment or provisioning was
performed.

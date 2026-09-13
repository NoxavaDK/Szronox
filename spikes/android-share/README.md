# T02 Android Share Target capability spike

This is a disposable standalone diagnostic PWA, not the production Quick Add UI. It checks that URL, text, image, and mixed shares become the same local capture-draft shape while preserving original fields, attachment blobs, a capture ID, and an `operationId`.

## Behavior exercised

The service worker intercepts `POST /share-target`, reads multipart `title`, `text`, `url`, and repeated `images`, commits the raw payload and blobs to IndexedDB, then returns HTTP 303. The page atomically replaces that raw record with a normalized draft and opens the same diagnostic capture form for every input kind. The draft starts as `quarantined_pending_identity` with no account. The diagnostic login action binds an explicit account and moves it to `local_pending_upload`; it never uploads. Reloading the `?incoming=<capture-id>` URL replays the saved draft without regenerating IDs.

JPEG, PNG, and WebP are supported. Unsupported file descriptors remain in `originalInput.files` and produce `UNSUPPORTED_MEDIA_TYPE`; an otherwise empty/unsupported share also produces `NO_SUPPORTED_INPUT`. Storage failure redirects to an explicit Polish error and never claims local success. The shell is cached for offline launch and the payload lives in IndexedDB; correctness does not depend on Background Sync.

This diagnostic shape maps to the frozen T00 behavior without importing or changing shared contracts. In production, `capture.originalInput` remains original input/notes, `operationId` supplies create idempotency, and each supported image descriptor supplies the attachment UUID for atomic Reel plus pending-attachment creation. The local blob stays until server acknowledgement.

## Local checks

```sh
cd spikes/android-share
npm test
npm run serve
```

Open `http://127.0.0.1:4173`, submit text/files through the form, reload, and confirm the same IDs and fields remain. Localhost is a secure context for service-worker development. These checks do not prove Android share-sheet registration.

For an automated desktop-browser integration check, start Chrome separately with remote debugging on port 9223 and this origin open, then run `npm run test:browser`. The check performs a multipart POST through the controlled service worker, promotes the raw record, reloads, and compares IDs, original input, and blob size. It is desktop evidence only.

## Required installed-Android procedure

Prerequisites: a physical Android device (or Play-enabled emulator), current Chrome, HTTPS hosting reachable by the device, and a fresh PWA install after serving this manifest. This spike does not deploy the harness.

1. Install the PWA from Chrome and confirm `SzroNox diag.` appears in Android's share sheet.
2. Force-stop it. From Chrome share a URL and record whether cold launch preserves it. Android may put the URL in `text` or `title`.
3. Repeat from Notes with text; Photos with JPEG/PNG/WebP; then a source capable of text plus image. Verify all open the same form and retain every supported field actually supplied.
4. Before diagnostic login, force-stop and reopen. Verify the item stays quarantined with no account. Bind `diagnostic-account-A`, reload, and verify capture and operation IDs stay fixed. Production must additionally key IndexedDB access by authenticated account.
5. Enable airplane mode, force-stop, share a supported payload, and verify the cached receiver opens and persists it. Reload offline. Restore network and verify the same draft remains; this spike intentionally has no upload.
6. Try GIF, PDF, video, and empty share where possible. The app should be absent from the chooser, or explicitly reject a payload supplied despite the manifest. Never record false success.
7. Reload/reopen a received share and verify no duplicate capture. Record Chrome, Android, device, source app, actual fields, cold/warm and network state, result, and a screenshot/log reference without personal content.

## Evidence status (2026-09-13)

| Check | Evidence | Status |
| --- | --- | --- |
| URL/text/image/mixed normalization and original descriptors | Node tests with synthetic diagnostic values | PASS (simulated) |
| Quarantine, explicit binding, stable IDs | Node tests | PASS (simulated) |
| Unsupported/empty classification | Node tests | PASS (simulated) |
| IndexedDB replay and service-worker receiver | Automated browser check exists; local in-app browser blocked localhost and headless Chrome did not complete CDP localhost navigation | UNVERIFIED in this environment |
| Installed Android registration, sender mapping, cold launch, offline share | No adb, emulator, Chrome binary, or connected device | UNVERIFIED — gate open |

Primary references: [Chrome Web Share Target documentation](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target), [web.dev receiving shared files](https://web.dev/articles/files/receive-shared-files), and [MDN `share_target` reference](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target).

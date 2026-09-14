# T02 Android Share Target capability spike

This is a disposable standalone diagnostic PWA, not the production Quick Add UI. It checks that URL, text, image, and mixed shares become the same local capture-draft shape while preserving original fields, attachment blobs, a capture ID, and an `operationId`.

## Behavior exercised

The service worker intercepts `POST /share-target`, reads the multipart payload **as an
ordered entry list**, allocates capture, operation and attachment IDs, commits the raw
payload and blobs to IndexedDB, then returns HTTP 303 only after transaction completion.
The page overwrites that same IndexedDB key with a normalized draft and opens the same
diagnostic capture form for every input kind. Keeping the key and preallocated IDs makes
crash/reopen and repeated promotion converge on the same capture. The draft starts as
`quarantined_pending_identity` with no account. The diagnostic login action binds an
explicit account and moves it to `local_pending_upload`; it never uploads. Reloading the
`?incoming=<capture-id>` URL replays the saved draft without regenerating IDs. Any failed
local write clears the prior success display and shows a Polish failure message.

JPEG, PNG and WebP are supported. Unsupported files remain described in
`originalInput.files` with `issue: "UNSUPPORTED_INPUT"` and never become accepted images.
Storage failure redirects to an explicit Polish error and never claims local success. The
shell is cached for offline launch and the payload lives in IndexedDB; correctness does not
depend on Background Sync.

### Share-receiver readiness

Share capture depends entirely on a **controlling** service worker, so readiness is its own
state with its own status element. A form operation never writes to it, which is what
previously let a successful local simulate paint over a broken receiver.

| State | Share capture | Meaning |
| --- | --- | --- |
| `unsupported` | unavailable | `serviceWorker` missing from this browser |
| `registration_failed` | unavailable | `register()` rejected |
| `registered_not_controlling` | not yet | registered, but no controller for this page yet |
| `ready` | available | an activated worker controls this page |

Registration and control are deliberately separate: only a controlling worker can intercept
`POST /share-target`, so a registered-but-uncontrolling worker is reported as not yet ready
rather than as success. No message claims the app can remove an installed OS share target —
it cannot; an unavailable receiver simply means the share is not captured here. The local
simulation stays usable in every state.

### Capture mapping onto the pinned contract

`toCaptureInput(draft)` builds a `CreateReelRequest` matching the pinned T00 capture
contract. It is a **diagnostic mapping only — nothing is sent**, and it is not Quick Add or
an upload client. The spike does not import `packages/contracts`; it mirrors the shape so
the spike stays standalone.

- One capture carries text, URL and **multiple** supported images together.
- `originalShare.fields` keeps the exact received scalars in order, including repeated,
  unknown and empty ones. Normalization reads the first value; it never deletes the rest.
- `originalShare.files` keeps every received descriptor in order, supported and unsupported
  alike, with unsupported entries marked `UNSUPPORTED_INPUT`.
- Nothing is silently trimmed, truncated, substituted, dropped or merged. Duplicate or
  missing attachment IDs and wholly unusable payloads are **refused outright** — the mapping
  returns `ok: false` with reasons and no partial request.

## Local checks

```sh
cd spikes/android-share
npm test                  # 44 tests
npm run serve             # http://127.0.0.1:4173
node tools/make-icons.mjs # regenerate the raster icon fallbacks
```

Open `http://127.0.0.1:4173`, submit text/files through the form, reload, and confirm the same IDs and fields remain. Localhost is a secure context for service-worker development. These checks do not prove Android share-sheet registration.

For an automated desktop-browser integration check, start Chrome separately with remote debugging on port 9223 and this origin open, then run `npm run test:browser`. The check performs a multipart POST through the controlled service worker, promotes the raw record, reloads, and compares IDs, original input, and blob size. It is desktop evidence only. C02 extended it to assert receiver control, exact ordered scalars including a repeat and an empty unknown field, two supported images plus one refused file, and the pinned-contract mapping. It has not been run.

## Required installed-Android procedure

Prerequisites: a physical Android device (or Play-enabled emulator), current Chrome, HTTPS hosting reachable by the device, and a fresh PWA install after serving this manifest. This spike does not deploy the harness.

1. Install the PWA from Chrome and confirm `SzroNox diag.` appears in Android's share sheet.
2. Force-stop it. From Chrome share a URL and record whether cold launch preserves it. Android may put the URL in `text` or `title`.
3. Repeat from Notes with text; Photos with JPEG/PNG/WebP; then a source capable of text plus image. Verify all open the same form and retain every supported field actually supplied.
4. Before diagnostic login, force-stop and reopen. Verify the item stays quarantined with no account. Bind `diagnostic-account-A`, reload, and verify capture and operation IDs stay fixed. Production must additionally key IndexedDB access by authenticated account.
5. Enable airplane mode, force-stop, share a supported payload, and verify the cached receiver opens and persists it. Reload offline. Restore network and verify the same draft remains; this spike intentionally has no upload.
6. Try GIF, PDF, video, and empty share where possible. The app should be absent from the chooser, or explicitly reject a payload supplied despite the manifest. Never record false success.
7. Reload/reopen a received share and verify no duplicate capture. Record Chrome, Android, device, source app, actual fields, cold/warm and network state, result, and a screenshot/log reference without personal content.

## Evidence status (2026-09-14)

Simulated means a Node test against authored values or a deterministic double. It is
evidence about this repository, never about a browser, a device or Android.

| Check | Evidence | Status |
| --- | --- | --- |
| URL/text/image/mixed normalization and original descriptors | Node tests with synthetic diagnostic values | PASS (simulated) |
| Exact ordered scalars: repeated, unknown and empty fields | Node tests over a real `FormData` | PASS (simulated) |
| Multi-image capture maps to one request with distinct stable IDs | Node tests | PASS (simulated) |
| Unsupported files described and refused, never accepted | Node tests | PASS (simulated) |
| Duplicate/missing IDs and unusable payloads refused without partial output | Node tests | PASS (simulated) |
| Quarantine, explicit binding and stable IDs | Node tests | PASS (simulated) |
| Receiver state table: unsupported / registration failed / not controlling / ready | Node tests over the pure decision table | PASS (simulated) |
| Manifest icons decode at 192×192 and 512×512 and are precached | Node tests decoding the committed PNGs | PASS (local files) |
| Commit/abort/reopen persistence semantics | Deterministic IndexedDB transaction double | PASS (simulated) |
| Repeated promotion of an already-committed record (replay) | Deterministic transaction double | PASS (simulated) |
| **Concurrent promotion — two overlapping transactions** | none | **UNVERIFIED — requires a real browser** |
| Service-worker receiver in a real browser | `npm run test:browser` updated for C02 (receiver readiness, ordered fields, multi-image, mapping) but **not executed** — no CDP-reachable Chrome in this environment | UNVERIFIED |
| Installed Android registration, sender mapping, cold launch, offline share | No adb, emulator or device available | UNVERIFIED — gate open |
| PWA installs on Android | Manifest now carries the documented raster sizes; installation itself not attempted | UNVERIFIED — gate open |

### Why concurrent promotion is listed as unverified

`promoteRaw` performs its read-modify-write inside a single `readwrite` transaction, and
real IndexedDB serializes overlapping `readwrite` transactions on the same object store,
which is what makes repeated promotion idempotent.

That guarantee is **inherited from IndexedDB's semantics, not demonstrated here**. The test
double models commit-on-completion but not scope serialization: driven with two concurrent
promotions it opens both transactions, lets both read the raw record and lets the second
overwrite the first — an interleaving real IndexedDB would not permit. The double is
therefore weaker than the real implementation, and no test exercises concurrency.

The replay case that *is* covered — promoting a record already committed as
`capture-draft` — is a different property and is listed separately above. Any earlier
shorthand suggesting concurrency was verified is withdrawn. Closing this gate needs two
overlapping promotions observed in a real browser.

### What the icon work does and does not establish

The manifest now references decoded 192×192 and 512×512 PNGs, and tests verify they exist,
decode at their declared dimensions and are precached in the offline shell. This removes a
known variable before device testing. **It is not evidence that the PWA installs on
Android**, and installation must not be inferred from the manifest. The generated icons
belong to this diagnostic and freeze no product icon.

Primary references: [Chrome Web Share Target documentation](https://developer.chrome.com/docs/capabilities/web-apis/web-share-target),
[web.dev receiving shared files](https://web.dev/articles/files/receive-shared-files),
[MDN `share_target` reference](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target),
[Chrome installability criteria](https://developer.chrome.com/docs/lighthouse/pwa/installable-manifest) (accessed 2026-09-14; that page also notes Lighthouse PWA auditing is deprecated).

## C04 follow-up corrections (2026-09-14)

Applied after `docs/implementation/C02-lead-review.md` (findings C02-R1/R2/R3), on top of
`9767c90`. `storage.js` remains byte-identical to `bafffec`.

| Finding | Correction | Evidence |
| --- | --- | --- |
| R1 root MIME | `server.js` derives the content type from the **resolved served file**, so `/` returns `text/html` instead of `application/octet-stream`. Icons and scripts unchanged | real HTTP against the actual server on a free port |
| R2 usability contradiction | One shared `captureUsability` rule drives both normalization and mapping. Unknown metadata (e.g. `tracking_id=123`) is preserved but never makes a capture usable. A repeated recognized field whose first value is empty now yields the later useful one, with the full received sequence intact | Node tests incl. a case-by-case agreement check |
| R3 stale receiver state | `watchReceiver` refreshes the dedicated state on `controllerchange` without re-registering; acquisition and loss of control are both reported | event-capable navigator double |

`browser-check.mjs` now waits for the **displayed** ready state rather than sampling it once.
It is still **unexecuted**: expanded assertions are test code, not test results.

## C02 corrections applied

Recorded so the change history is legible; see the lead's R01 adjudication for F1/F6/F7/F8.

| Finding | Correction |
| --- | --- |
| F1 icons | Added generated 192×192 and 512×512 PNG fallbacks, precached and test-verified. Installation remains an open gate |
| F6 concurrency evidence | Evidence table now separates replay from concurrent promotion and marks the latter UNVERIFIED, with the reason stated |
| F7 receiver readiness | Four explicit states with Polish copy naming share capture, owned by their own status element so form success cannot overwrite them; registration distinguished from control |
| F8 capture mapping | Explicit `toCaptureInput` mapping onto the pinned multi-image `CaptureInput`, preserving exact ordered scalars and all file descriptors, refusing rather than truncating |
| H1 cache cleanup | `activate` now deletes superseded caches within this diagnostic's own prefix only |

`skipWaiting()` was deliberately **not** added: replacing a worker mid-capture needs an
explicit update strategy, which this diagnostic does not decide. No account-isolation claim
is made — account-scoped IndexedDB access remains a production requirement, not something
this spike demonstrates. `bafffec`'s transaction logic in `storage.js` is unchanged.

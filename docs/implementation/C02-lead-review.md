# C02 lead review at 9767c90

Verdict: **retain the corrections; three bounded follow-ups before accepting diagnostic readiness**. Browser, real concurrent IndexedDB promotion and Android gates remain UNVERIFIED. Nothing merged or dispatched.

Execution attribution: the user reports an explicitly approved manual Opus 5 substitution for the originally proposed Sol agent. Record C02 as Opus-executed, not Sol-executed. This report does not authorize any further model substitution or execution.

## Verified

- T02 HEAD 9767c90 follows bafffec; only pre-existing lead-owned AGENTS.md is dirty.
- npm test: **44/44 PASS**, including decoded/reproducible PNG dimensions and ordered multipart mapping checks.
- storage.js is byte-identical to bafffec (git diff --exit-code).
- Ordered FormData walk retains repeated/unknown/empty scalar fields; mapping separates normalized values from original fields and carries multiple supported images plus rejected descriptors.
- Receiver status has its own DOM element, separate from simulation/login status. No skipWaiting policy was introduced.
- Concurrency documentation distinguishes the deterministic replay double from real overlapping transactions. No browser/Android success is claimed.
- Invoked the actual server handler with injected response objects: both PNG paths return image/png and index.html returns text/html. This is handler-level evidence, not a network/browser run. A separate local-server subprocess exited before readiness; no HTTP request was made through it, and no process was left running by this review.

## Remaining findings

### C02-R1 — root navigation serves HTML as a download MIME type (medium)

`spikes/android-share/server.js:7` computes MIME from the incoming path, while reading index.html for `/`. Reproduced with the actual handler: `/` returns 200 application/octet-stream (1698-byte HTML); `/index.html` correctly returns text/html. README and browser-check navigate to `/`, so this risks download behavior instead of document execution. This bug predates C02; it is still a prerequisite for the advertised browser procedure, not evidence that the new PNG fix failed.

Correction: derive MIME from the resolved served file, including index.html for `/`. Add a root-route assertion alongside the icon assertions. Then run the actual browser procedure when tooling permits; handler tests cannot close that gate.

### C02-R2 — unusable payload accepted by mapping (medium)

`spikes/android-share/share-contract.js:124` versus `:181–182`.

Reproduction: normalize `{fields:[{name:'tracking_id',value:'123'}]}` with no text, URL or files. The draft correctly contains NO_SUPPORTED_INPUT; toCaptureInput returns ok=true and a request anyway. Any nonempty unknown field currently satisfies originalTextual.

Correction: share a coherent usability rule for meaningful capture text/title, URL and supported images. Unknown metadata must be preserved but cannot by itself make a capture usable. Repeated recognized fields with an empty first value and a later nonempty value should be handled consistently without dropping the original sequence. Mapping refusal returns no partial request. Keep the valid title-only/mixed/repeated-field cases.

### C02-R3 — receiver readiness is observed only once (medium)

`spikes/android-share/app.js:78`, `receiver-state.js:75`.

The page calls observeReceiver once after registration and has no controllerchange listener. A first installation can report registered_not_controlling, then the worker activates and clients.claim() grants control while the visible message stays stale. Losing/changing control likewise does not refresh it. The new state model is sound, but a single snapshot does not maintain its live UI claim.

Correction: refresh the dedicated receiver state when controller changes, without repeatedly registering or mixing local-form success into receiver state. Test delayed acquisition/loss of control with an event-capable double; retain a separate actual-browser gate. Browser-check must wait for the displayed ready state as well as controller presence rather than racing the asynchronous registration callback.

## Acceptance and next step

Preservation, PNG assets, core lossless mapping, dedicated receiver messaging and honest concurrency documentation are useful and retained. Local suite passes; complete readiness acceptance is pending R1–R3. The expanded browser-check script is still unexecuted; its additional assertions are test code, not test results.

No production features, root contract edits, migration or broad browser support work is requested. A follow-up should stay within the existing T02 spike and preserve storage.js. Further agent execution requires explicit user approval. C01 status is unchanged by this handoff.

# R01 — lead adjudication

Reviewed 2026-09-14 against T01 `ce107c3`, T02 `bafffec` and the current root T00 working copy. Input: `.worktrees/t03-gemini/spikes/gemini/docs/R01-review.md`. Opus explicitly excluded its own T03 implementation from that report; T03 has not received independent acceptance here either. This document reviews R01, not T03.

## Verdict

Retain both artifacts, but do not integrate T01 as accepted yet. Its prior build/typecheck/test/audit results remain valid; those checks missed real boundary defects. T02 remains a locally tested diagnostic with browser/Android gates open. No source correction, new agent, merge or live-provider run was performed in this review.

| Finding | Lead assessment | Required response |
| --- | --- | --- |
| F1 icons | Compatibility risk, not a confirmed high-severity installation failure. Current manifest has only SVG; the cited Lighthouse page explicitly says its PWA testing is deprecated. | Add explicit 192×192 and 512×512 raster fallbacks before device testing, then establish installation on the target device. The heading's “192×512” is a typo, not one required rectangular asset. |
| F2 non-GET errors | Confirmed independently with GET/POST/DELETE injection: POST and DELETE return Fastify's different envelope. | Use the shared error envelope for all unknown API methods, with focused regression checks. |
| F3 missing assets | Confirmed independently: `/assets/missing.js` returns 200 HTML; a Reel navigation correctly receives HTML. | Preserve SPA navigation but return 404 for missing build assets. Do not rely solely on a dot heuristic that could reject legitimate future navigation paths. |
| F4 API shutdown | Confirmed missing signal/close handling by inspection. Lifecycle readiness gap, rather than evidence of present database corruption. | Add bounded, repeat-safe shutdown and exercise an in-flight request. Do not copy the report's minimal signal snippet without considering rejection, repeated signals and a shutdown deadline. |
| F5 unused contracts | Confirmed no API declaration/import. Package compiles alone; consumer resolution is not checked. “FAIL in substance” overstates the literal original isolated-typecheck criterion, but consumer verification belongs in the correction. | Declare the API dependency and type the existing error-envelope helper with ErrorResponse (a real current contract consumer). No invented shared health type or decorative import. Verify web type-only consumption as well. Update the lockfile with dependency declarations. Worker consumption can wait for actual job types. |
| F6 concurrency evidence | Confirmed evidence gap by reading controlledDb and its tests: replay of an already committed record is tested, overlapping transactions are not. No demonstrated production algorithm bug. | Explicit real-browser concurrent-promotion gate; retain commit/abort/reopen tests. Correct any prior shorthand suggesting concurrency was verified. |
| F7 unavailable receiver | Confirmed registration rejection reports only offline failure; absent serviceWorker has no explicit diagnostic. | Persist a clear share-receiver readiness/failure state that other successful local-form operations cannot overwrite. Distinguish registration from activation/control. Keep independent local simulation usable; do not claim buttons can remove an installed OS share target. |
| F8 capture mapping | Confirmed: root CaptureInput accepts one image; diagnostic captures multiple plus distinct original fields. This blocks a production adapter, not retaining the standalone diagnostic. | Lead direction: one Reel capture may contain multiple supported image descriptors, atomically creating all pending attachment records. Preserve accompanying URL/text and original fields; an array alone does not solve mixed-input preservation. Pin exact wire shape and runtime bounds in T00 before a production capture task is delegated. Never truncate silently. |

F1 source checked: [Chrome Lighthouse installable manifest](https://developer.chrome.com/docs/lighthouse/pwa/installable-manifest), accessed 2026-09-14. It lists 192×192 and 512×512 icons but also explicitly warns that Lighthouse PWA testing is deprecated. This supports preparation for device testing, not a claim that this SVG manifest certainly fails installation.

## Contract questions and secondary recommendations

- Q1: a null editor makes the peer verifier undefined. Lead direction: do not guess the verifier; require a valid editor before accepting verification, while leaving export linking independent. Encode that validation in the next T00 clarification before verification implementation. This does not make verification a ready/published prerequisite.
- Q2: keep the three-addition limit as an application runtime invariant. A TypeScript string array does not validate provider data; a named shared limit is useful when implementing the validator. A constant alone is not enforcement.
- Q3: deliberate and already approved. Clicking Opracuj/generate-more authorizes additive hooks; do not reopen that product decision.
- Q4: a diagnostic server 404 with no controlling worker is expected. Receiver readiness and the eventual product recovery path must be explicit, not inferred from registration success.
- H1 cache cleanup is useful within the diagnostic's own cache prefix. H2 automatic skipWaiting is not a blanket improvement: worker replacement during capture needs an explicit update strategy. H5 retaining whitespace in original input is intentional preservation, not a defect. Do not batch all H1–H9 into mandatory corrections.
- Source contracts should be pinned to a reviewed revision before further approved delegation. An uncommitted file is a reproducibility/process issue, not a failing product behavior. Existing approved root modifications must be preserved.
- Feed-cover amendment remains consistent. No cover UI implementation is authorized; existing spike snapshots predate that amendment.

## Independent checks performed

- Read T01 app entry, HTTP routing and API/web/contracts package declarations.
- Ran built T01 app.inject for GET/POST unknown API routes, DELETE missing Reel, missing JavaScript asset and a Reel navigation. Reproduced F2/F3; closed app afterward.
- Read T02 manifest, normalization, receiver registration, identity-binding UI, transaction double and evidence documentation. Earlier lead run of 12/12 tests remains valid; no need to repeat unchanged tests to adjudicate their coverage.
- Rechecked the cited Chrome installability page. No Android/browser runtime test, dependency installation, paid request or source mutation.

## Next work, not dispatched

1. Lead independent T03 review, including endpoint-specific official Gemini documentation checks; Opus's R01 does not cover it.
2. Pin capture/verification contract clarifications and current feed-cover amendment before production implementation.
3. Bounded T01 correction batch: F2/F3/F4 and real contract-consumer verification.
4. Bounded T02 preparation batch: raster icon fallbacks, truthful receiver readiness and explicit concurrency evidence gate. Preserve the spike's broader input evidence until the production mapping is fixed.
5. Actual browser/Android verification after preparation; credentialed Gemini evidence remains a separate gate.

No models assigned or execution approved by these recommendations. Any future agent start still requires the user's eight-part delegation proposal and explicit approval. T04 and AI-result UI remain blocked from execution.

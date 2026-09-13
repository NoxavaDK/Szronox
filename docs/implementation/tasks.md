# Authorized delegation

Only T00–T04 are currently authorized. The root agent owns review/integration. All paths below are relative to the assigned isolated worktree.

| Task | Status | Ownership | Acceptance |
| --- | --- | --- | --- |
| T00 contracts | Frozen baseline | AGENTS.md, docs/implementation, packages/contracts/src | Persistent hooks and additive AI application; existing-meme FK suggestion; no final editorial prompts; T16 explicit block |
| T01 scaffold | Ready to dispatch | Root package/lock/build/CI files, apps/web, apps/api, apps/worker, packages/contracts package/config only | Reproducible install/build/typecheck, same-origin static web/API, health endpoint, worker entry, CI; no routine product features or AI-result UI |
| T02 Android Share Target spike | Ready to dispatch | spikes/android-share only | Diagnostic URL/text/image/mixed reception; same-form handoff contract; local cold-start/auth boundary; actual Android evidence if available; explicitly identify unverified device checks |
| T03 Gemini capability spike | Ready to dispatch | spikes/gemini only | Diagnostic multimodal/URL/search/metadata/schema/failure probes; redacted fixtures; distinguish actual evidence from mocks; no editorial prompts or UI |
| T04 kDrive spike | Queued for first available slot | spikes/kdrive only | Isolated folder create/lookup/access/rename/move/error experiments only on designated disposable test folder; classify ambiguous creation; no production data changes or uploader |
| T12 generic AI lifecycle | Not dispatched | Future worker/job modules | May later implement infrastructure only; no frozen writing prompts |
| T13/T14/T15 service work | Not dispatched | Future owned handlers | Typed contracts/fixtures permitted in principle; editorial decisions remain with user/lead; no production prompt freeze |
| T16 AI result UI | BLOCKED | No implementation allowed | Await frozen Opracuj/facts/language/programme mockups and specifications |

Spikes must be independent of scaffold completion. Any standalone diagnostic package/config lives under the spike's own directory. Do not modify root package files, shared contracts, approved design assets or another spike. Proposed contract changes go to the lead.

Handoff: files, commands and outcomes; live vs simulated evidence; limitations/blockers; commit ID. Do not merge. No paid resource provisioning, deployments, outbound messages or production kDrive mutations.

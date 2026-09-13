# T00 — shared implementation contracts

Status: frozen for the authorized foundation/spikes; editorial prompts and AI screen composition explicitly excluded.

## Baseline and ownership

React + Vite frontend, Fastify same-origin API, PostgreSQL/Supabase, Supabase Auth and private lightweight Storage. Production media belongs to kDrive. PostgreSQL-backed durable AI jobs run in a worker from the same application codebase. TypeScript throughout. `packages/contracts/src/index.ts` is the canonical wire-type baseline; the lead owns changes.

Folders: `apps/web`, `apps/api`, `apps/worker`, `packages/contracts`, `spikes/android-share`, `spikes/gemini`, `spikes/kdrive`. Scaffold owns package/build files. No feature agent silently edits entry points, dependencies, migrations or contracts.

## Domain invariants

- Five statuses only: `idea`, `to_record`, `editing`, `ready`, `published`. Polish labels are UI mappings.
- Two allowlisted authenticated users; equivalent product access. The verifier is the other user relative to `editorId`. Editor may be null before editing. No selectable verifier or role-management UI.
- `ready` and `published` do not require verification. Without an export there is no verification state in the UI.
- Current export has an application-owned revision. Explicit replacement increments it even if its URL/file ID is unchanged. Verification names the actual signed-in expected verifier and exact export revision. Historical check information can remain to derive `outdated`. Metadata/body edits alone do not claim a video file changed. No automatic file-overwrite detection is promised.
- Entering editing from another status sets a server UTC timestamp. Re-saving editing does not reset it. Priority/editor changes do not reset it. Leaving/re-entering starts a new period. Attention thresholds are 24/96/168 elapsed hours; only current editing items count.
- Soft-delete/restore affects the Reel and its visibility, never shared memes or kDrive files.
- Publication is external; app stores date and optional multiple links.
- Original input and notes remain distinct from scripts and hooks.

## Correction 1 — persistent hook shortlist

`ReelHook`: `id`, `reelId`, `text`, `source: user | ai`, `position`, `createdAt`. SQL names are snake_case. A Reel has zero or more active hooks; there is no singular authoritative `hook` field, selected-hook field or use-hook endpoint.

- Capture may create one user hook atomically with the Reel. Existing user hooks always survive AI generation.
- User add/edit/remove operates on individual IDs. Source and creation time are server-owned provenance; editing wording does not manufacture a new generation history.
- Opracuj proposes up to three additional hook texts; `generate_hooks` is the service action behind `Wygeneruj więcej`. Its initial contract allows up to three additions per successful call, not a cap on total hooks.
- Clicking Opracuj/generate-more explicitly authorizes additive hook generation. A successful run appends its hook additions once; there is no individual `Użyj` and no replace-all path. Other Opracuj fields remain unapplied proposals.
- Appending locks/checks the live Reel, allocates positions transactionally and preserves concurrent user hooks. Record applied hook IDs on the run in the same transaction, preventing retry duplication or resurrection of a later-removed hook. Deleted Reels cannot receive additions.
- Text changes while AI runs do not permit replacing current content. Generated additions retain their run's input snapshot; the UI can identify stale run context. New hooks invalidate prior fact-check coverage.
- Primary/prominent-hook presentation is NOT frozen here. `position` provides stable order; do not implement a primary-hook selector.

## Correction 2 — existing-library meme suggestion

Opracuj returns `memeSuggestion: { memeId, rationale, relevantFragment? } | null`, never a list or an invented meme name.

The backend supplies a bounded set of existing library records with IDs and relevant existing metadata; a simple deterministic selection is enough initially. The run records candidate IDs. Validate a returned ID against both those candidates and an existing usable Meme record. Unknown/deleted/out-of-candidate IDs are rejected as invalid suggestions and exposed as a warning, never silently repaired by inventing a record. No vector meme index, usage analytics or semantic retrieval infrastructure.

Suggestions never auto-attach or replace an assignment. Future explicit acceptance uses the normal version-checked meme-attachment mutation. If a meme is already assigned, preserve it; additive/replacement UI is not an agent editorial decision.

## Mutation and conflict contract

All authenticated mutations include a UUID `operationId`; updates to an existing Reel include `expectedVersion`. Server returns authoritative data and a monotonic `version`. Compare-and-update is atomic. A mismatch returns HTTP 409 `EDIT_CONFLICT` with current version/snapshot; the client keeps its draft.

Persist operation ID + actor + route + payload hash and result atomically with the domain change. Same operation/same payload returns the original result, including after subsequent edits; same ID/different payload is `IDEMPOTENCY_CONFLICT`. Result application, hooks and attachments follow this rule. The worker's authorized additive hooks use a separate run application marker, never a stale full-Reel replacement.

Server timestamps and actor IDs are authoritative. JWTs require signature/issuer/audience/expiry validation and membership in the two-user allowlist. No anonymous/third-user API access; no privileged keys in web builds. Application tables remain in a nonexposed schema.

## Route surface

All application routes start `/api/v1`; JSON uses camelCase, SQL uses snake_case.

| Route | Contract |
| --- | --- |
| GET /me | Signed-in allowlisted user and peer identity |
| GET /reels | Status filter, optional overdue flag, cursor pagination; fixed product sorting |
| GET /reels/:id | Reel aggregate, hooks, attached memes, references and derived verification |
| POST /reels | Idempotent capture; optional initialHook; no AI/kDrive dependency |
| PATCH /reels/:id | Version-checked allowlisted scalar fields; no hook/verification/result injection |
| POST /reels/:id/delete, /restore | Version-checked soft-delete/restore |
| POST /reels/:id/hooks | Add user hook; optional insertion position, server validates order |
| PATCH, DELETE /reels/:id/hooks/:hookId | Version-checked individual text edit/removal |
| GET, POST /memes | Shared library search/create; no analytics |
| POST /reels/:id/memes; DELETE /reels/:id/memes/:memeId | Explicit attach/detach with version check; no library deletion |
| POST /reels/:id/current-export | Explicit reference replacement; increments export revision |
| POST /reels/:id/verification | Verify current export as actual expected verifier; status remains independent |
| POST /reels/:id/attachments/initiate, /:attachmentId/complete | Bounded private upload lifecycle, completion validated server-side |
| POST /reels/:id/kdrive-folder | Explicit create/link command; no folder during capture |
| GET /reels/:id/kdrive-folder | Resolve reference; distinguish missing/access/transient errors |
| POST /reels/:id/ai-runs | Version-checked enqueue from server snapshot; returns 202 run ID |
| GET /ai-runs/:id | State, snapshot identity, result, warnings and applied hook IDs |
| POST /ai-runs/:id/apply | Explicit selective field/programme application against current version; excludes hooks and automatic meme assignment |

JSON error envelope: `{ error: { code, message, retryable, currentVersion?, details? } }`. Message is diagnostic English, never displayed raw; web maps machine codes to Polish. Do not return secrets or provider payloads in error text.

## Drafts, share target and attachments

IndexedDB stores account-scoped drafts, input blobs and operation IDs before upload. Local success is not cloud acknowledgement. Storage failure prevents `Zapisano lokalnie`. First-use/account switching cannot expose another user's pending drafts. Incoming share payload before login is quarantined locally until identity is established, without automatic upload to a guessed account.

Offline support: capture queue and recoverable existing-Reel drafts, not a replica of all backend data. Reconnect retries creates; updates still use expectedVersion. No reliance on background sync for correctness. API responses/private files are not broadly cached by the service worker.

Share Target POST/manifest receiver opens the SAME Quick Add with URL/text/image already populated. Preserve mixed supported inputs. Treat inbound payload as untrusted. Unsupported payloads and unavailable browser capability are explicit, not false success. T02 establishes actual installed-Android evidence.

Original lightweight image files stay private in app storage; large production uploads are out of scope. Upload initiation and completion are distinct; failed uploads keep the local recoverable payload. Transport limits are configured and verified during implementation, not invented in the UI by a spike.

For image capture, the client supplies an attachment UUID and descriptor in CreateReelRequest. The server atomically creates the Reel plus a pending attachment record, then the ordinary Reel attachment upload routes transfer/complete it. No pre-existing Reel or uploaded image is required to create the capture record. The client retains its blob until acknowledged. Opracuj saves the record first but cannot consume an incomplete image: enqueue after completion or return UPLOAD_INCOMPLETE without losing the capture.

## AI execution and evidence

Actions: `develop`, `generate_hooks`, `fact_check`, `language_check`, `find_programme`. Job states are infrastructure states, not Reel statuses. A run snapshots current script, all active hooks and relevant input references; records model, diagnostic/production prompt identifier, input hash and requester. Leases, bounded retry and atomic finalization are required; exactly-once external model billing is not promised.

- Fact-check scope is script plus ALL active hooks. Claims identify `script` or a specific `hookId`; no implicit chosen hook. Coverage becomes stale if script or hook membership/text changes.
- Language comparison targets the script. Hook comparison composition is not implied by this correction and is not to be designed by agents.
- Opracuj input includes all existing hooks so alternatives are additional rather than replacements. Results contain title, short summary, verification issues, hook additions, script proposal, possible programme connection, optional justified priority suggestion and at most one existing-meme suggestion.
- Hashes use a canonical relevant-input representation; exclude timestamps, avatars and noninput metadata. Snapshot membership is explicit. Every accepted text change goes through mutation concurrency rules.
- Facts: source references originate from actual provider tool metadata. Preserve their relationship to claims and the supporting material available. Model-generated quotations are not automatically excerpts. Missing evidence downgrades to uncertain. Semantic correctness still requires human review.
- Programme: only indexed document fragments count as evidence. Citation IDs and exact pages resolve server-side. No web lookup in this operation. User acceptance sets the match/no-match state; provider errors do not.
- Structured outputs validate shape, limits and foreign references, not truth. Untrusted pages/files cannot grant write privileges or override system rules.

## Correction 3 — UI gate

T16 is BLOCKED pending frozen Opracuj, fact-check, language and programme mockups/specifications. Diagnostic fixtures are not UI authority. No AI-result composition, speculative controls, hook prominence design or meme acceptance layout may be invented. Existing approved low-level primitives may be reused later.

## Correction 4 — prompt gate

No final writing prompt, Style Profile, few-shot corpus or output wording is approved. T03 tests only provider capabilities with explicitly diagnostic prompts and synthetic/neutral examples. T12 may later implement generic lifecycle; T13/T14/T15 may later prepare typed contracts and fixtures, not freeze editorial prompts. These later tasks are not currently dispatched. A prompt/model identifier in a contract is a provenance field, not editorial approval.

## Acceptance before broader implementation

T01 must typecheck shared types. Spikes must distinguish live evidence, mocks and blocked checks. Lead review confirms no single-hook field/use-hook action, no invented meme creation, no T16 implementation, and no production editorial prompts. Live Android/provider/PDF gates stay open until real prerequisites exist.

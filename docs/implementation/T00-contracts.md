# T00 — shared implementation contracts

Status: pinned 2026-09-14 with approved capture, verification, feed-cover and Publication clarifications. Contracts/planning only; no correction agent dispatch. Editorial prompts and AI screen composition explicitly excluded.

## Baseline and ownership

React + Vite frontend, Fastify same-origin API, PostgreSQL/Supabase, Supabase Auth and private lightweight Storage. Production media belongs to kDrive. PostgreSQL-backed durable AI jobs run in a worker from the same application codebase. TypeScript throughout. `packages/contracts/src/index.ts` is the canonical wire-type baseline; the lead owns changes.

Folders: `apps/web`, `apps/api`, `apps/worker`, `packages/contracts`, `spikes/android-share`, `spikes/gemini`, `spikes/kdrive`. Scaffold owns package/build files. No feature agent silently edits entry points, dependencies, migrations or contracts.

## Domain invariants

- Five statuses only: `idea`, `to_record`, `editing`, `ready`, `published`. Polish labels are UI mappings.
- Two allowlisted authenticated users; equivalent product access. The verifier is the other user relative to `editorId`. Editor may be null before editing. No selectable verifier or role-management UI.
- Verification requires a currently selected editor who is one of the allowlisted users. If no valid editor is selected, reject verification with HTTP 422 `EDITOR_REQUIRED`, `retryable: false`; Polish mapping: `Wybierz montażystę przed weryfikacją eksportu.` Never infer the editor/verifier from the acting user. Check the editor, expected peer actor and export revision against the same version-checked Reel state. The wrong actor receives FORBIDDEN. Export linking/replacement remains allowed independently of editor selection and verification; linking does not verify anything. No export still means no verification state in the UI.
- `ready` and `published` do not require verification. Without an export there is no verification state in the UI.
- Current export has an application-owned revision. Explicit replacement increments it even if its URL/file ID is unchanged. Verification names the actual signed-in expected verifier and exact export revision. Historical check information can remain to derive `outdated`. Metadata/body edits alone do not claim a video file changed. No automatic file-overwrite detection is promised.
- Entering editing from another status sets a server UTC timestamp. Re-saving editing does not reset it. Priority/editor changes do not reset it. Leaving/re-entering starts a new period. Attention thresholds are 24/96/168 elapsed hours; only current editing items count.
- Soft-delete/restore affects the Reel and its visibility, never shared memes or kDrive files.
- Publication is external; app stores date and optional multiple links.
- Original input and notes remain distinct from scripts and hooks.

## Frozen product amendment — required feed cover

Every Reel requires a separate feed cover image, labeled `Okładka do feedu`. This is the social-feed image/thumbnail, not part of the video and not an optional in-video title card. It is a required production deliverable for every Reel.

- Persist SQL `feed_cover_done: boolean NOT NULL DEFAULT false`; expose required JSON `feedCoverDone: boolean` in Reel list/detail data. Creation defaults to false, including offline/share capture. Existing records receive false when this field is introduced; do not infer completion from video/export or attachment presence.
- The completion checkbox works without any asset reference. An optional lightweight attachment or kDrive/file reference may be added later using existing file facilities; no cover-specific asset contract or module is required for MVP completion tracking.
- Reel Detail always exposes a compact metadata pictogram using the same small outline image/landscape icon consistently: icon plus empty/neutral state means cover not ready; icon plus check state means cover ready. This supersedes the earlier `OKŁ` abbreviation. Exact icon artwork comes from the visual specification. No permanent text label in dense metadata except where needed for accessibility; provide an accessible name identifying `Okładka do feedu` and its completion state. No large card.
- The actual completion control belongs inside the existing expanded `PUBLIKACJA` section, alongside the optional cover reference if supported. Preserve the approved information architecture and compact visual direction.
- A missing cover does not block `editing` (`Montaż`) or `ready` (`Gotowe`). Before a transition from another status to `published` (`Opublikowane`), the effective updated Reel must have `feedCoverDone === true`.
- Enforce that transition on the server in the same version-checked transaction as the mutation, using the persisted state plus the validated patch. A single patch may mark the cover complete and publish. Reject publication with false without partial writes or silent state changes. Return HTTP 422, code `FEED_COVER_REQUIRED`, `retryable: false`; web maps this to `Przed zmianą statusu na „Opublikowane” oznacz „Okładka do feedu” jako ukończoną.` Existing conflict/idempotency rules apply; concurrent updates must not bypass the gate.
- Completion updates use the existing scalar PATCH and concurrency contract. Do not create a dedicated cover endpoint or a new workflow state. This is a transition prerequisite, not an automatic status-change mechanism.
- Missing cover remains visibly incomplete in Detail. Do not add permanent cover metadata to every list row/status. Compact list exposure may be operationally relevant in `Montaż` and `Gotowe`; exact list treatment awaits the visual specification.
- Out of scope: automatic cover generation, templates, graphic editor, platform-specific variants and cover analytics.

Future implementation acceptance: false default/backfill and list/detail serialization; checkbox without a file; compact always-available Detail state and expanded Publication control; editing/ready allowed while incomplete; incomplete publication rejected with the Polish message and unchanged data; complete publication (including an atomic combined patch) allowed subject to other existing validations; version conflict/retry behavior preserved. No implementation or visual design is authorized by this contract amendment.

## Frozen Publication amendment — copy publication text

`Opis do publikacji` and `Hashtagi` are separate editable fields in the data model and UI. Canonical JSON fields are `publicationDescription: string` and `publicationHashtags: string`; SQL fields are `publication_description` and `publication_hashtags`, each NOT NULL DEFAULT ''. Hashtags remain an editable text block, not an automatically reformatted list. Both fields use the existing version-checked scalar PATCH. Creation defaults both to empty strings.

The existing `PUBLIKACJA` section provides one primary copy action, `Kopiuj opis`. Copy the current editable field values, including unsaved edits, without saving or modifying either stored field. Formatting is exact:

| Description | Hashtags | Clipboard text |
| --- | --- | --- |
| Nonempty | Nonempty | `description + "\n\n" + hashtags` |
| Nonempty | Empty | `description` |
| Empty | Nonempty | `hashtags` |
| Empty | Empty | No text to copy; communicate this without reporting success |

The separator is exactly two newline characters: two Enter presses, one empty line. Do not add trailing blank lines or automatically trim/rewrite the editable content; newline insertion is only the separator in the both-present case.

Use the browser clipboard capability from the explicit user action. Report success only after the write succeeds. If clipboard access is unavailable or fails, provide a Polish error state and a selectable copy-ready text fallback for manual copying, without overwriting the form or claiming the clipboard was updated. No automatic copying, new API endpoint or persistence side effect.

Future implementation acceptance: the four cases above; exact separator and no added trailing blank lines; current unsaved values used without mutating either field; distinct editable fields retained; clipboard success/failure/unavailable states truthful; manual fallback matches the same composed text; cover pictogram uses neutral/check states and an accessible name without a permanent dense-metadata abbreviation. No other product change or implementation dispatch is authorized.

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

### Pinned capture contract — mixed input and multiple images

CreateReelRequest.input is one CaptureInput object: optional text, optional URL, an images array (empty for text/URL-only capture), and optional originalShare. This replaces the earlier mutually exclusive single-image union. A usable capture has text, a URL, a supported image, or usable original shared text/title; completely unusable payloads are rejected explicitly. Do not derive a title/URL by destroying the original source fields.

Each supported image descriptor has a stable attachmentId, fileName, mimeType and byteSize. The server validates distinct IDs and supported content limits, then atomically creates one Reel plus ALL pending image attachment records and any initial user hook. Failure rolls back the entire creation; never save only a truncated subset. No existing Reel or uploaded image is required to create this record. Each image subsequently uses the ordinary attachment initiate/complete lifecycle. Local blobs remain recoverable until individually acknowledged.

originalShare.fields retains exact received scalar names/values in order, including repeated, unknown and empty fields; it is distinct from normalized text/URL. originalShare.files retains all original descriptors in received order, linking supported items by attachmentId and marking unsupported items explicitly with UNSUPPORTED_INPUT. Unsupported descriptors are evidence of the original input, not permission to create accepted upload records. The receiver must keep recoverable local input and explain unsupported files or exceeded limits; it must never claim all content was accepted if it was not. No silent trimming, truncation, field substitution, dropped images or merging of separate captures. A bounded request may be rejected explicitly rather than partially persisted. Numeric transport limits remain implementation configuration, not a new product decision here.

Persist the accepted CaptureInput as immutable Reel.originalInput (SQL original_input JSONB) and return it in Detail; it is excluded from the scalar PATCH allowlist. Editable inputNote remains separate. List projections may omit the raw capture payload. All captured supported image IDs must map one-to-one to pending attachments, and original shared URL/text/title must remain recoverable even if normalized values are later edited. Existing local spike draft shapes require an explicit mapping, not blind JSON forwarding.

Opracuj saves the record first but cannot consume pending input images: enqueue after required input-image completion or return UPLOAD_INCOMPLETE without losing the capture. Feed-cover/material assets are not implicitly input images. Capture stays independent of AI/kDrive availability. Expected-version and operation-ID rules remain unchanged.

Future capture acceptance: text-only, URL-only, image-only, multiple images and URL/text/images together; exact original fields/descriptors; no partial persistence on invalid/duplicate IDs or over-limit input; explicit unsupported-file feedback without false success; retry reuses Reel/attachment IDs; crash/reopen retains pending blobs; no provider dependency on create.

## AI execution and evidence

Actions: `develop`, `generate_hooks`, `fact_check`, `language_check`, `find_programme`. Job states are infrastructure states, not Reel statuses. A run snapshots current script, all active hooks and relevant input references; records model, diagnostic/production prompt identifier, input hash and requester. Leases, bounded retry and atomic finalization are required; exactly-once external model billing is not promised.

- Fact-check scope is script plus ALL active hooks. Claims identify `script` or a specific `hookId`; no implicit chosen hook. Coverage becomes stale if script or hook membership/text changes.
- Language comparison targets the script. Hook comparison composition is not implied by this correction and is not to be designed by agents.
- Opracuj input includes all existing hooks so alternatives are additional rather than replacements. Results contain title, short summary, verification issues, hook additions, script proposal, possible programme connection, optional justified priority suggestion and at most one existing-meme suggestion.
- Hashes use a canonical relevant-input representation; exclude timestamps, avatars and noninput metadata. Snapshot membership is explicit. Every accepted text change goes through mutation concurrency rules.
- Action-specific freshness avoids self-invalidation: when comparing a hook-producing run with the live Reel, exclude that run's own appliedHookIds from the current hook inputs. Its own append is an expected output, not an external input edit. Other fact-check/develop runs still see the added hooks and become stale as appropriate. Result application must never use stale full-aggregate data from an idempotency replay to replace a newer client cache entry.
- Facts: source references originate from actual provider tool metadata. Preserve their relationship to claims and the supporting material available. Model-generated quotations are not automatically excerpts. Missing evidence downgrades to uncertain. Semantic correctness still requires human review.
- Programme: only indexed document fragments count as evidence. Citation IDs and exact pages resolve server-side. No web lookup in this operation. User acceptance sets the match/no-match state; provider errors do not.
- Structured outputs validate shape, limits and foreign references, not truth. Untrusted pages/files cannot grant write privileges or override system rules.

## Correction 3 — UI gate

T16 is BLOCKED pending frozen Opracuj, fact-check, language and programme mockups/specifications. Diagnostic fixtures are not UI authority. No AI-result composition, speculative controls, hook prominence design or meme acceptance layout may be invented. Existing approved low-level primitives may be reused later.

## Correction 4 — prompt gate

No final writing prompt, Style Profile, few-shot corpus or output wording is approved. T03 tests only provider capabilities with explicitly diagnostic prompts and synthetic/neutral examples. T12 may later implement generic lifecycle; T13/T14/T15 may later prepare typed contracts and fixtures, not freeze editorial prompts. These later tasks are not currently dispatched. A prompt/model identifier in a contract is a provenance field, not editorial approval.

The `Sprawdź postulat` product flow is still being finalized. This pin preserves only already-frozen programme contracts; it adds no UI, action semantics, proposal-acceptance behavior or new workflow for that flow. Additive hook generation also remains exactly as approved above.

## Acceptance before broader implementation

T01 must typecheck shared types. Spikes must distinguish live evidence, mocks and blocked checks. Lead review confirms no single-hook field/use-hook action, no invented meme creation, no T16 implementation, and no production editorial prompts. Live Android/provider/PDF gates stay open until real prerequisites exist.

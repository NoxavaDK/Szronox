# T00 — shared implementation contracts

Status: frozen baseline with approved capture, verification, feed-cover, Publication, programme, Fact Check and Reel Detail/Language Check amendments. Contracts/planning only; no correction agent dispatch. Final editorial prompts and other unfinished AI surfaces remain excluded.

## Written visual implementation authority

[Consolidated frozen visual specification](../../design/frozen-visual-spec.md) plus the [Reel Detail + Language Check delta](../../design/frozen-reel-detail-language-spec.md) form the current visual authority, together with T00 behavioral contracts. The delta takes precedence for its eight named surfaces. It supersedes older instructions to use or await renderer PNGs/screenshots. Existing renders are historical references, not prerequisites; no missing-image gate remains. All visible UI is Polish; code and documentation are English.

Visually frozen: global language, Main List, Quick Add, Reel Detail, completed Opracowanie, expanded Publication, programme search results, attached proposition completed Fact Check results, Language Check, Materials, metadata selectors, Meme picker, original-input/notes sections and delete/recovery. Implement at 360 px with clean 320 px reflow using the specified compact editorial hierarchy, palette, typography and accessible touch targets. The written specification governs section order, exact action labels, flat separators and plain text status labels; do not replace them with cards, filled badges or large CTAs except where expressly allowed.

Still pending: Opracuj publication-draft collision UI when existing user content is present, and other explicitly unfinished surfaces. Visual availability does not settle unspecified persistence/application behavior: generated publication draft handling must respect T00 and must not silently overwrite stored description/hashtags. No new overwrite policy, editorial prompt or bulk-apply action is authorized.

No UI implementation dispatch is authorized by this freeze. The existing explicit task/model approval process remains in force.

## Baseline and ownership

React + Vite PWA, Fastify same-origin API, real PostgreSQL on the VPS, application-owned two-user authentication and private lightweight filesystem storage. Production media belongs to kDrive through a separate integration. API and worker use the same application release; future PostgreSQL-backed durable AI jobs remain separately gated. TypeScript throughout. `packages/contracts/src/index.ts` is the canonical wire-type baseline; the lead owns changes. The approved [VPS-00 infrastructure amendment](VPS-00-contracts.md) governs session, storage, migration and environment seams. Supabase is no longer a platform requirement; product invariants below remain unchanged.

Folders: `apps/web`, `apps/api`, `apps/worker`, `packages/contracts`, `spikes/android-share`, `spikes/gemini`, `spikes/kdrive`. Scaffold owns package/build files. No feature agent silently edits entry points, dependencies, migrations or contracts.

## Domain invariants

### Accepted API shutdown decision

Graceful shutdown stops accepting new work and prioritizes not truncating valid in-flight responses. Allow active requests to finish within a bounded deadline; close idle keep-alive connections safely where supported. Do not abort an active response merely to obtain exit code 0. If connections prevent clean shutdown past the deadline, forced termination/non-clean exit is acceptable and must be observable. The accepted C01 keep-alive behavior is not an integration blocker; do not broaden C01 in this batch.

### Reel invariants

- Five statuses only: `idea`, `to_record`, `editing`, `ready`, `published`. Polish labels are UI mappings.
- Two allowlisted authenticated users; equivalent product access. The verifier is the other user relative to `editorId`. Editor may legitimately be null in any status. No selectable verifier or role-management UI.
- Verification requires a currently selected editor who is one of the allowlisted users. If no valid editor is selected, reject verification with HTTP 422 `EDITOR_REQUIRED`, `retryable: false`; Polish mapping: `Wybierz montażystę, aby wskazać osobę sprawdzającą.` Never infer the editor/verifier from the acting user. Check the editor, expected peer actor and export revision against the same version-checked Reel state. The wrong actor receives FORBIDDEN. Export linking/replacement remains allowed independently of editor selection and verification; linking does not verify anything. No export still means no verification state in the UI.
- `ready` and `published` do not require verification. Without an export there is no verification state in the UI.
- Current export has an application-owned revision. Explicit replacement increments it even if its URL/file ID is unchanged. Verification names the actual signed-in expected verifier and exact export revision. Historical check information can remain to derive `outdated`. Metadata/body edits alone do not claim a video file changed. No automatic file-overwrite detection is promised.
- Entering editing from another status sets a server UTC timestamp. Re-saving editing does not reset it. Priority/editor changes do not reset it. Leaving/re-entering starts a new period. Attention thresholds are 24/96/168 elapsed hours; only current editing items count.
- Soft-delete/restore affects the Reel and its visibility, never shared memes or kDrive files.
- Publication is external; app stores date and optional multiple links.
- Original input and notes remain distinct from scripts and hooks.

## Frozen product amendment — required feed cover

Every Reel requires a separate feed cover image, labeled `Okładka do feedu`. This is the social-feed image/thumbnail, not part of the video and not an optional in-video title card. It is a required production deliverable for every Reel.

- Persist SQL `feed_cover_done: boolean NOT NULL DEFAULT false`; expose required JSON `feedCoverDone: boolean` in Reel list/detail data. Creation defaults to false, including offline/share capture. Existing records receive false when this field is introduced; do not infer completion from video/export or attachment presence.
- The completion checkbox works without any asset reference; completion is never inferred from an export, attachment or unrelated file. KDRIVE-02 amends this: a Reel may also have one optional `feedCoverAsset` reference to a successfully uploaded kDrive file, and the successful upload sets `feedCoverDone = true` atomically with that reference in the version-checked Reel write. The explicit completion toggle remains available and may unset it. This adds no cover gallery, version list, file manager or image editor.
- Reel Detail always exposes a compact metadata pictogram using the same small outline image/landscape icon consistently: icon plus empty/neutral state means cover not ready; icon plus check state means cover ready. This supersedes the earlier `OKŁ` abbreviation. Exact icon artwork comes from the visual specification. No permanent text label in dense metadata except where needed for accessibility; provide an accessible name identifying `Okładka do feedu` and its completion state. No large card.
- The actual completion control belongs inside the existing expanded `PUBLIKACJA` section, alongside the optional cover reference if supported. Preserve the approved information architecture and compact visual direction.
- A missing cover does not block `editing` (`Montaż`) or `ready` (`Gotowe`). Before a transition from another status to `published` (`Opublikowane`), the effective updated Reel must have `feedCoverDone === true`.
- Enforce that transition on the server in the same version-checked transaction as the mutation, using the persisted state plus the validated patch. A single patch may mark the cover complete and publish. Reject publication with false without partial writes or silent state changes. Return HTTP 422, code `FEED_COVER_REQUIRED`, `retryable: false`; web maps this to `Przed zmianą statusu na „Opublikowane” oznacz „Okładka do feedu” jako ukończoną.` Existing conflict/idempotency rules apply; concurrent updates must not bypass the gate.
- Completion updates use the existing scalar PATCH and concurrency contract. Do not create a dedicated cover endpoint or a new workflow state. This is a transition prerequisite, not an automatic status-change mechanism.
- Missing cover remains visibly incomplete in Detail. Do not add permanent cover metadata to every list row/status. Compact list exposure may be operationally relevant in `Montaż` and `Gotowe`; use the list density and optional operational exposure rules in the consolidated written visual specification.
- Out of scope: automatic cover generation, templates, graphic editor, platform-specific variants and cover analytics.

Future implementation acceptance: false default/backfill and list/detail serialization; checkbox without a file; compact always-available Detail state and expanded Publication control; editing/ready allowed while incomplete; incomplete publication rejected with the Polish message and unchanged data; complete publication (including an atomic combined patch) allowed subject to other existing validations; version conflict/retry behavior preserved. No implementation or visual design is authorized by this contract amendment.

## Frozen Publication amendment — copy publication text

`Opis do publikacji` and `Hashtagi` are separate editable fields in the data model and UI. Canonical JSON fields are `publicationDescription: string` and `publicationHashtags: string`; SQL fields are `publication_description` and `publication_hashtags`, each NOT NULL DEFAULT ''. Hashtags remain an editable text block, not an automatically reformatted list. Both fields use the existing version-checked scalar PATCH. Creation defaults both to empty strings.

The existing `PUBLIKACJA` section provides one primary copy action, `Kopiuj opis`. Copy the current editable field values, including unsaved edits, without saving or modifying any stored field. For SOURCE-01, the parts are Opis, effective Źródło (`publicationSource ?? sourceMetadata.line ?? ''`), and Hashtagi, in that order. Formatting is exact:

| Nonempty parts | Clipboard text |
| --- | --- |
| Description, source and hashtags | Each non-empty part joined by exactly `"\n\n"` |
| Any one or two non-empty parts | Non-empty parts in their defined order joined by exactly `"\n\n"` |
| All empty | No text to copy; communicate this without reporting success |

The separator is exactly two newline characters: two Enter presses, one empty line. A part is empty only when it is exactly `''`; do not trim or rewrite any editable content. Do not add leading or trailing blank lines; newline insertion is only the separator between non-empty parts.

Use the browser clipboard capability from the explicit user action. Report success only after the write succeeds. If clipboard access is unavailable or fails, provide a Polish error state and a selectable copy-ready text fallback for manual copying, without overwriting the form or claiming the clipboard was updated. No automatic copying, new API endpoint or persistence side effect.

Future implementation acceptance: all eight empty/non-empty combinations; exact separator and no added leading/trailing blank lines; whitespace and embedded edge newlines preserved; current unsaved values used without mutating stored fields; distinct editable fields retained; clipboard success/failure/unavailable states truthful; manual fallback matches the same composed text; cover pictogram uses neutral/check states and an accessible name without a permanent dense-metadata abbreviation.

## PUBLICATION-01 amendment — publication copy is generated separately from Opracuj

Approved 2026-09-22 (`docs/implementation/PUBLICATION-01-opus-handoff.md`); supersedes the combined-generation wording above and in the visual spec for these two fields only. Workflow: `materiały → Opracuj → finalizacja skryptu → Wygeneruj opis → finalizacja publikacji`.

- `Opracuj` (`develop`) no longer asks for, returns or applies publication copy. Its script stays a proposal until explicit `Zastosuj`. Title, hooks (additive), meme, priority and programme hint are unchanged. Historical develop results may still carry publication fields; they stay readable, are not rewritten, and new publication applications from them are rejected (`VALIDATION_ERROR`, `details.reason='wrong_action'`) while already recorded operation replays keep their outcome.
- `Wygeneruj opis` in `PUBLIKACJA` enqueues the typed action `generate_publication` through the existing run lifecycle. Its only generation input is the saved script, snapshotted server-side with `scriptRevision`; no source retrieval, images or upload gate. An empty/whitespace saved script is refused before any run (`VALIDATION_ERROR`, `details.reason='script_required'`). The client refuses while any edit is unsaved and neither saves nor discards it.
- Result `PublicationResult`: separate `publicationDescriptionSuggestion` / `publicationHashtagsSuggestion`. Completion writes nothing to the Reel. Each field is applied separately and explicitly with `expectedVersion`, `replaceCurrentValue` and `confirmReplacement`; a filled target asks before replacement. A changed script (text or revision, including edit-and-revert) rejects application with `STALE_PUBLICATION_RESULT`; regenerate. Applying one field does not invalidate the other beyond ordinary version refresh.
- Prompts remain `development_provisional`. Migration `0009_generate_publication_action.sql` extends the action check additively.

## Correction 1 — persistent hook shortlist

`ReelHook`: `id`, `reelId`, `text`, `source: user | ai`, `position`, `createdAt`. SQL names are snake_case. A Reel has zero or more active hooks. See the explicit HOOKS-SELECT-EDIT amendment below for the one optional selected-hook reference. There is still no singular text-valued `Reel.hook` field or per-hook `Użyj` action.

- Capture may create one user hook atomically with the Reel. Existing user hooks always survive AI generation.
- User add/edit/remove operates on individual IDs. Source and creation time are server-owned provenance; editing wording does not manufacture a new generation history.
- Opracuj proposes up to three additional hook texts; `generate_hooks` is the service action behind `Wygeneruj więcej`. Its initial contract allows up to three additions per successful call, not a cap on total hooks.
- Clicking Opracuj/generate-more explicitly authorizes additive hook generation. A successful run appends its hook additions once; there is no individual `Użyj` and no replace-all path. Other Opracuj fields remain unapplied proposals.
- Appending locks/checks the live Reel, allocates positions transactionally and preserves concurrent user hooks. Record applied hook IDs on the run in the same transaction, preventing retry duplication or resurrection of a later-removed hook. Deleted Reels cannot receive additions.
- Text changes while AI runs do not permit replacing current content. Generated additions retain their run's input snapshot; the UI can identify stale run context. New hooks invalidate prior fact-check coverage.
- Primary/prominent-hook presentation is NOT frozen here. `position` provides stable order; do not implement a primary-hook selector.

### HOOKS-SELECT-EDIT — explicit selected candidate (2026-09-23)

This user-approved correction supersedes only the earlier no-selector/no-selected-hook sentences above and their historical equivalents. The shortlist remains persistent, ordered `ReelHook` records. `Reel.selectedHookId: Id | null` is one server-owned nullable reference to an existing hook belonging to that Reel; SQL `selected_hook_id` defaults null. A Reel with hooks and no selection is valid, including every historical Reel. Never infer the first hook, copy its text to a second authoritative field, or change a hook's provenance when selecting it. A selected `user` hook can show both `WŁASNY` and `✓ WYBRANY`.

Selection is an explicit, authenticated, idempotent, version-checked mutation. The server validates the hook belongs to the same nondeleted Reel, locks/checks the authoritative Reel version and stores only the ID. Selecting another replaces the ID atomically; selecting the same one may leave content unchanged but must still honor mutation and replay rules. Delete of an unselected hook leaves selection unchanged. Delete of the selected hook atomically clears selection; no replacement is guessed. Hook text edits update the existing ID, preserve `source`/`createdAt`/selection and use the existing hook-edit conflict contract. Generated hooks append as candidates and never change selection.

Reel Detail's compact HOOKI rows are touch/pointer/keyboard selection targets with a subtle but explicit `✓ WYBRANY` state independent of text highlighting. `WŁASNY` marks only user provenance. Inline edit on an existing row uses the existing hook-edit endpoint; controls for edit/delete do not also select. In-progress text is preserved on save error/conflict rather than silently overwritten. No new screen, large action, analytics or hook version-history feature.

Downstream script-development input may use the selected hook as its **current** hook context while preserving the complete shortlist for alternatives and other established processing. In particular, Fact Check still analyzes all active hooks, `generate_hooks` still appends without changing selection, and older AI snapshots/results remain readable. Selection does not automatically apply or overwrite a script. Reconcile only logic that currently expects a singular working hook; do not narrow global hook coverage or redesign Gemini actions.

Acceptance: select any candidate; switch and persist across reload; provenance independent; edit selected/unselected text in place with version conflict protection; selected deletion clears and unselected deletion preserves; no automatic selection on creation/generation/history; row/controls do not conflict; existing null-selection Reels remain valid; downstream script context uses the selected ID where applicable without changing all-hooks Fact Check or additive generation.

## Correction 2 — existing-library meme suggestion

Opracuj returns `memeSuggestion: { memeId, rationale, relevantFragment? } | null`, never a list or an invented meme name.

The backend supplies a bounded set of existing library records with IDs and relevant existing metadata; a simple deterministic selection is enough initially. The run records candidate IDs. Validate a returned ID against both those candidates and an existing usable Meme record. Unknown/deleted/out-of-candidate IDs are rejected as invalid suggestions and exposed as a warning, never silently repaired by inventing a record. No vector meme index, usage analytics or semantic retrieval infrastructure.

Suggestions never auto-attach or replace an assignment. Future explicit acceptance uses the normal version-checked meme-attachment mutation. If a meme is already assigned, preserve it; additive/replacement UI is not an agent editorial decision.

## Mutation and conflict contract

All authenticated mutations include a UUID `operationId`; updates to an existing Reel include `expectedVersion`. Server returns authoritative data and a monotonic `version`. Compare-and-update is atomic. A mismatch returns HTTP 409 `EDIT_CONFLICT` with current version/snapshot; the client keeps its draft.

Persist operation ID + actor + route + payload hash and result atomically with the domain change. Same operation/same payload returns the original result, including after subsequent edits; same ID/different payload is `IDEMPOTENCY_CONFLICT`. Result application, hooks and attachments follow this rule. The worker's authorized additive hooks use a separate run application marker, never a stale full-Reel replacement.

Server timestamps and actor IDs are authoritative. Opaque server sessions require a valid unexpired, unrevoked session and membership in the two-user allowlist. The VPS-00 amendment supersedes the former Supabase/JWT requirement. No anonymous/third-user domain API access; no privileged keys or session bearer secrets in web builds/browser storage. Application tables remain in a nonexposed schema. Authentication endpoints have only the explicit exceptions documented in VPS-00.

## Route surface

All application routes start `/api/v1`; JSON uses camelCase, SQL uses snake_case.

| Route | Contract |
| --- | --- |
| GET /me | Signed-in allowlisted user and peer identity |
| GET /reels | visibility=active (default) or deleted, status filter, optional overdue flag, cursor pagination; fixed product sorting |
| GET /reels/:id | Reel aggregate, hooks, attached memes, references and derived verification |
| POST /reels | Idempotent capture; optional initialHook; no AI/kDrive dependency |
| PATCH /reels/:id | Version-checked allowlisted scalar fields; no hook/verification/result injection |
| POST /reels/:id/delete, /restore | Version-checked soft-delete/restore |
| POST /reels/:id/hooks | Add user hook; optional insertion position, server validates order |
| PATCH, DELETE /reels/:id/hooks/:hookId | Version-checked individual text edit/removal |
| PUT /reels/:id/selected-hook | HOOKS-SELECT-EDIT: `{operationId, expectedVersion, hookId: Id \| null}`; idempotent, version-checked selection of a same-Reel hook or explicit clear; returns the authoritative Reel |
| GET, POST /memes | Name/metadata search; create with required name and validated imageAssetId, optionally atomic attachToReel; no analytics |
| POST /reels/:id/memes; DELETE /reels/:id/memes/:memeId | Explicit attach/detach with version check; no library deletion |
| POST /reels/:id/current-export | Explicit reference replacement; increments export revision |
| POST /reels/:id/verification | Verify current export as actual expected verifier; status remains independent |
| DELETE /reels/:id/programme-association | Explicit version-checked, idempotent Odłącz; clears association and returns unchecked; never starts search |
| POST /reels/:id/attachments/initiate, /:attachmentId/complete | Bounded private upload lifecycle, completion validated server-side |
| POST /reels/:id/kdrive-folder | Explicit create/link command; no folder during capture |
| GET /reels/:id/kdrive-folder | Resolve reference; distinguish missing/access/transient errors |
| POST /reels/:id/ai-runs | Version-checked enqueue from server snapshot; returns 202 run ID |
| GET /ai-runs/:id | State, snapshot identity, result, warnings and applied hook IDs |
| POST /ai-runs/:id/apply | Explicit selective field/programme application and claim-scoped fact correction; no generated-hook acceptance or automatic meme assignment |

JSON error envelope: `{ error: { code, message, retryable, currentVersion?, details? } }`. Message is diagnostic English, never displayed raw; web maps machine codes to Polish. Do not return secrets or provider payloads in error text.

## Drafts, share target and attachments

IndexedDB stores account-scoped drafts, input blobs and operation IDs before upload. Local success is not cloud acknowledgement. Storage failure prevents `Zapisano lokalnie`. First-use/account switching cannot expose another user's pending drafts. Incoming share payload before login is quarantined locally until identity is established, without automatic upload to a guessed account.

Offline support: capture queue and recoverable existing-Reel drafts, not a replica of all backend data. Reconnect retries creates; updates still use expectedVersion. No reliance on background sync for correctness. API responses/private files are not broadly cached by the service worker.

Share Target POST/manifest receiver opens the SAME Quick Add with URL/text/image already populated. Preserve mixed supported inputs. Treat inbound payload as untrusted. Unsupported payloads and unavailable browser capability are explicit, not false success. T02 establishes actual installed-Android evidence.

Original lightweight image files stay private in app storage; large production uploads are out of scope. Upload initiation and completion are distinct; failed uploads keep the local recoverable payload. Transport limits are configured and verified during implementation, not invented in the UI by a spike.

### Pinned capture contract — mixed input and multiple images

CreateReelRequest.input is one CaptureInput object: optional original text, optional separate additionalText entered alongside URL/image, optional URL, an images array (empty for text/URL-only capture), and optional originalShare. This replaces the earlier mutually exclusive single-image union. A usable capture has text, a URL, a supported image, or usable original shared text/title; completely unusable payloads are rejected explicitly. Do not derive a title/URL by destroying the original source fields.

Each supported image descriptor has a stable attachmentId, fileName, mimeType and byteSize. The server validates distinct IDs and supported content limits, then atomically creates one Reel plus ALL pending image attachment records and any initial user hook. Failure rolls back the entire creation; never save only a truncated subset. No existing Reel or uploaded image is required to create this record. Each image subsequently uses the ordinary attachment initiate/complete lifecycle. Local blobs remain recoverable until individually acknowledged.

originalShare.fields retains exact received scalar names/values in order, including repeated, unknown and empty fields; it is distinct from normalized text/URL. originalShare.files retains all original descriptors in received order, linking supported items by attachmentId and marking unsupported items explicitly with UNSUPPORTED_INPUT. Unsupported descriptors are evidence of the original input, not permission to create accepted upload records. The receiver must keep recoverable local input and explain unsupported files or exceeded limits; it must never claim all content was accepted if it was not. No silent trimming, truncation, field substitution, dropped images or merging of separate captures. A bounded request may be rejected explicitly rather than partially persisted. Numeric transport limits remain implementation configuration, not a new product decision here.

Persist the accepted CaptureInput as immutable Reel.originalInput (SQL original_input JSONB) and return it in Detail; it is excluded from the scalar PATCH allowlist. Editable inputNote remains separate. List projections may omit the raw capture payload. All captured supported image IDs must map one-to-one to pending attachments, and original shared URL/text/title must remain recoverable even if normalized values are later edited. Existing local spike draft shapes require an explicit mapping, not blind JSON forwarding.

Opracuj saves the record first but cannot consume pending input images: enqueue after required input-image completion or return UPLOAD_INCOMPLETE without losing the capture. Feed-cover/material assets are not implicitly input images. Capture stays independent of AI/kDrive availability. Expected-version and operation-ID rules remain unchanged.

Future capture acceptance: text-only, URL-only, image-only, multiple images and URL/text/images together; exact original fields/descriptors; no partial persistence on invalid/duplicate IDs or over-limit input; explicit unsupported-file feedback without false success; retry reuses Reel/attachment IDs; crash/reopen retains pending blobs; no provider dependency on create.

### Direct script capture — approved product correction, pending implementation

Quick Add's main `TEKST` field has an explicit compact `Pomysł` / `Gotowy skrypt` choice. `Pomysł` remains the default for new and legacy drafts. The choice changes the meaning of the typed text at creation; it is not a new Reel status or a second capture screen. Switching the choice preserves the current textarea contents. Its selected value survives local draft recovery and offline retry. All visible UI copy remains Polish.

`CreateReelRequest.initialScript?: string` is permitted only when the user explicitly chose `Gotowy skrypt`. It must be nonempty and exactly equal to `input.text` as received; reject conflicting or whitespace-only script requests rather than silently choosing one value. The server creates the Reel with that exact `script` and `scriptRevision=0` in the same transaction that preserves `input` verbatim as immutable `originalInput` and creates the other accepted capture records. The duplicate text serves different purposes: `originalInput.text` is the exact captured provenance, while `script` is the editable working script. In this mode, do not additionally copy the script into mutable `inputNote`; it starts empty. Existing `Pomysł` capture behavior, including its current `inputNote` initialization, remains unchanged.

The create operation's idempotency hash and account-scoped queue payload include `initialScript`. Retries cannot create a Reel without the script or reinterpret an already queued operation after the toggle changes. Creation and later edits keep the existing version/scriptRevision rules. `Opracuj` may run after such a save, but its proposed script revision still requires explicit `Zastosuj` and never replaces the user's script automatically. `Wygeneruj opis` can read the saved script. Accompanying URL/image text remains input context unless the user explicitly chose the main text field as a script; no silent conversion of shared fields.

Acceptance: default idea capture is unchanged; direct script capture and reload show the exact entered script; `originalInput` remains byte-equivalent to accepted input; `inputNote` is not a duplicate script; toggle switching, local draft recovery, offline replay, mixed input preservation, idempotent retry, validation failure and `Opracuj`/Publication behavior are covered. This amendment specifies behavior only; implementation and DEV deployment remain separately gated by the task/model dispatch process.

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

## Frozen Sprawdź fakty core behavior

Sprawdź fakty analyzes the current script and ALL active hooks from the run's immutable snapshot. Split factual content into individual claims with exact source locations; distinguish opinion, irony, rhetoric and non-factual commentary rather than forcing them into factual verdicts. The existing coverage field describes processing coverage only, never a global “script correct” judgment. No confidence percentages or probability scores in the result contract/UI.

Every factual claim has exactly one semantic status: confirmed (`Potwierdzone`), uncertain (`Niepewne`), contradicted (`Sprzeczne ze źródłami`). Uncertain means insufficient reliable evidence. Absence of evidence cannot establish contradiction. Scrutinize dates, numbers, names, positions/functions, quotations, causal claims, attribution and absolutes such as first/only/everyone/never/biggest. Unsupported absolutes normally remain uncertain.

Confirmed requires retained supporting evidence from actual grounding/search/provider results, associated with this claim. FactClaim.evidence contains server-resolvable retainedEvidenceRef and providerReference linked to sourceIds; preserve inspectable source title/URL/retrieval metadata and the actual grounding support/material available. A model-authored URL, model assertion, bare source existence or fabricated quotation cannot establish confirmation. Validate provider references and claim/source mappings before retaining evidence; if support is insufficient, downgrade to uncertain. Contradiction requires actual contradictory evidence, not lookup failure. Retained evidence remains private and inspectable by authorized users; it is not a request to expose raw provider responses in the UI.

Each claim retains location=script or a specific hookId, original reelVersion/inputHash, the sourceTextHash of its checked script/hook, and an exact half-open source span with original text. Application-owned offsets use UTF-16 code units; do not confuse them with provider citation byte offsets. Preserve the complete source in the immutable run snapshot. Validate that the recorded substring matches the snapshot; do not accept provider-invented offsets blindly.

Only uncertain/contradicted claims may offer a correction. `Użyj korekty` is a real edit: POST /ai-runs/:id/apply with selection=fact_correction and claimId plus operationId/expectedVersion. The server resolves the retained correction and source from that run, rather than trusting a client-supplied replacement or span. For script claims, correction is replacement text for that exact fragment. For hook claims, correction is the corrected complete text of that particular hook; preserve its ID, source/provenance and position, do not create another hook, and do not modify other hooks or script. Preserve unrelated content within a hook correction too; a claim correction is not authorization for broader rewriting.

Apply atomically against the live Reel version and affected source. Keep an application marker on the claim in the same transaction; retries cannot apply the correction twice. Successful application may display `Zastosowano` locally; this is separate from the three factual statuses and does not assert the corrected claim is verified. No other Reel fields change. The generic whole-script apply path must not be used to bypass fact-correction span checks.

Freshness has two levels: the run's input hash/coverage can become outdated while an unaffected item remains usable. Do not gate all claims solely on AiRun.isStale or the original Reel version. Check this item's source identity and exact checked text at application time. A deleted/edited source hook is stale for its correction. An unrelated hook change does not invalidate a script item or another unchanged hook. For script claims, unchanged unambiguously mapped spans may remain usable after unrelated edits; if offsets move, only a deterministic mapping from recorded edits may relocate them. Never use fuzzy matching or blind replace-all, especially for repeated text. If unchanged origin/span cannot be proven, reject without edits using HTTP 409 STALE_FACT_CLAIM, retryable=false, and expose stale/new-check state. Example Polish mapping: `Ten fragment zmienił się od sprawdzenia. Sprawdź fakty ponownie.` Normal expectedVersion conflicts still return EDIT_CONFLICT and preserve drafts.

After applying a script correction, update deterministic locations for unaffected spans and invalidate overlapping/context-affected claims; a whole-hook edit invalidates other claims against that changed hook. Do not infer continued factual validity from matching words where relevant context changed. The workspace may indicate content changes and offer a rerun; it must not silently recheck or overwrite content. Rechecking always snapshots current script and all active hooks.

Future acceptance: all active hooks/script covered; non-factual language distinguished; exact three statuses with no scores/global correctness claim; unsupported/absolute claims not auto-confirmed and missing evidence not contradicted; confirmed evidence retained/openable with valid provenance; exact script-fragment and specific-hook correction only; duplicate-text, Unicode, stale source, deleted hook, unrelated source edits, overlapping corrections, concurrency and idempotent retry cases; applied state distinct from factual status. The completed Fact Check workspace is now visually frozen in section 9 of the consolidated specification. No implementation dispatch is authorized without separate approval.

## Correction 3 — UI gate

T16 has not been authorized for dispatch. The surfaces explicitly covered in the consolidated written visual specification are visually frozen, including completed Opracowanie and Fact Check. Sprawdź język and publication-draft collision UI remain visually blocked. Diagnostic fixtures are not visual authority; neither missing PNGs nor historical screenshot-reference sentences create a new prerequisite.

## Frozen Sprawdź postulat search results

Visual authority is section 7 of the consolidated written visual specification. No renderer asset is required. Use flat editorial candidate sections, plain uppercase strength labels, identical compact `Przypnij` actions and the quieter `Nie ma dobrego dopasowania` action. No full-width candidate CTA, filled badges, percentages or raw source URLs. The old first-render dependency is superseded; no further render is requested.

Search ONLY the indexed Green programme. Return zero to three candidates in ranked order; enforce the maximum server-side. Each candidate includes strong/indirect match strength, programme category, proposal/title, exact indexed fragment, source metadata, short AI relevance explanation and Przypnij. Do not expose similarity percentages or confidence scores.

ProgrammeCitation is authoritative evidence: documentVersionId, proposalId where available, nonempty chunkIds, category, proposal/title, exact excerpt, sourceTitle, chapter, nullable subchapter, PDF page metadata and available printed-page labels. Resolve those fields from the selected indexed version. The AI may rank known candidates, classify strong/indirect and explain relevance; it may not supply invented wording, evidence fragments, IDs or source metadata. No web/model-memory evidence. Unsupported identifiers or evidence mismatches are errors, not no-match results.

ProgrammeResult contains only a candidates array, not an outcome that sets Reel state. Candidate IDs are stable server-owned identifiers scoped to the run. Existing POST /ai-runs/:id/apply accepts `selection: programme_match` plus ONE candidateId, replacing the earlier matchIndexes array. Resolve that candidate and its citation server-side from the run; never accept client-supplied citation text as authoritative. The usual authentication, expectedVersion and idempotency rules apply.

Only an explicit successful Przypnij attaches one primary ProgrammeAttachment and sets programmeState=matched (`✓ Jest`, programme icon plus check). Persist the full citation snapshot, strength, candidate/run identity and attachment actor/time. This replaces the plural Reel.programmeMatches field with programmeAttachment|null. Reel.programmeDocumentVersionId mirrors the current attachment version when matched; programmeInputHash identifies the reviewed input context. No script, hook, priority or publication field changes. A failed/conflicting attachment leaves prior state and citation intact.

When there is no current attachment, the explicit bottom action `Nie ma dobrego dopasowania` rejects the retrieved candidates from that run, sets programmeState=no_match (`✕ Nie znaleziono dobrego dopasowania`) and leaves no current primary attachment. Record the run/input context of this user decision through the mutation record; this is not a global claim about the full programme. During replacement search, rejecting new candidates preserves the existing attachment and matched state; only a new Przypnij or explicit Odłącz may change that association. The programme_no_match mutation must not clear an existing attachment (reject incompatible use with VALIDATION_ERROR, or EDIT_CONFLICT for a stale expectedVersion). An empty candidate array does not automatically set no_match. Technical failure preserves previous state and attachment and exposes retry/error state.

Exactly three Reel semantic states remain: unchecked (`? Nie sprawdzono`), matched (`✓ Jest`), no_match (`✕ Nie znaleziono dobrego dopasowania`). Search completion, Opracuj suggestions, ranking or technical failures cannot themselves set matched or no_match. Default is unchecked. Non-matched states have programmeAttachment=null and programmeDocumentVersionId=null; the run retains its own searched version.

An attached citation remains tied to the exact indexed version selected. Store the evidence snapshot and stable identifiers; a new index/version must not rewrite it. Keep referenced versions resolvable or preserve their immutable source snapshot. If original evidence cannot be resolved on attachment, return an explicit error rather than substituting newer text.

After attachment, tapping the programme indicator opens the attached proposition rather than automatically rerunning search. Its frozen surface and actions are specified below.

Future acceptance: at most three evidence-backed candidates; source fields resolve exactly to indexed evidence; no web or invented references; one explicit Przypnij stores one version-bound citation and sets matched only after success; unrelated content fields unchanged; explicit user rejection differs from global absence; empty/error results preserve state; concurrent/idempotent mutation rules hold; re-indexing cannot rewrite attachments; consolidated written visual specification respected; no similarity/confidence display. No feature dispatch is authorized.

## Frozen attached Program Zielonych proposition

Opening the existing attachment displays the persisted ProgrammeAttachment without enqueuing AI or programme retrieval. Reuse the visual language and evidence structure of a single Sprawdź postulat candidate. No additional render is required.

Show match strength near the top (for example `MOCNE DOPASOWANIE`), programme category, proposal/title, exact indexed fragment, authoritative source metadata with a source-open action, then `DLACZEGO PASUJE` and the stored AI relevance explanation. Source-open resolves the pinned documentVersionId and page metadata to that version's source, never a newer replacement or model-generated URL. Source-access failure exposes an error without removing/rewriting the attachment.

At the bottom use compact editorial text actions `Zmień postulat` and `Odłącz`. Odłącz is visually quieter. Neither is a large CTA.

Zmień postulat explicitly creates a fresh find_programme run from a server snapshot of the Reel's current relevant content, including current script/hooks/input references, with a new operationId. Do not replay the old run or use the attachment's original content snapshot as the new input. Retries of this new operation remain idempotent. Opening, closing, cancelling, failing or rejecting candidates in this search leaves the existing attachment and matched state unchanged.

Only explicit Przypnij on a new candidate atomically replaces the current primary attachment after the normal version/conflict/evidence checks succeed. Never detach first. Concurrent edits or failed replacement preserve the current authoritative association and expose conflict/error; a search finishing later cannot overwrite a newer attach/detach decision. Replacement updates only programme association fields, not script, hooks, priority or Publication fields.

Odłącz uses DELETE /reels/:id/programme-association with DetachProgrammeRequest (operationId, expectedVersion). Successful atomic detach sets programmeAttachment=null, programmeState=unchecked (`? Nie sprawdzono`), programmeInputHash=null and programmeDocumentVersionId=null. Keep shared indexed programme/source records and prior run evidence intact; remove only the Reel association. Do not automatically start search. Failure/conflict leaves current state intact, with no false success. Ordinary idempotency replay rules apply.

Future acceptance: attached indicator opens without AI/search; view shows the pinned citation/explanation and specified hierarchy/actions; source opens the correct version; change-search uses current content and preserves the old attachment on cancel/error/rejection; replacement occurs atomically only on explicit Przypnij; detach sets unchecked without searching; conflicts/retries preserve authoritative state and unrelated fields. No implicit detach through search-results no-match. Implementation requires separate approval.

## Correction 4 — prompt gate

No final writing prompt, Style Profile, few-shot corpus or output wording is approved. T03 tests only provider capabilities with explicitly diagnostic prompts and synthetic/neutral examples. T12 may later implement generic lifecycle; T13/T14/T15 may later prepare typed contracts and fixtures, not freeze editorial prompts. These later tasks are not currently dispatched. A prompt/model identifier in a contract is a provenance field, not editorial approval.

Programme search results and the attached-proposition flow are frozen above. Additive hook generation remains exactly as approved. These amendments do not freeze final writing/style prompts or authorize implementation dispatch.

## Acceptance before broader implementation

T01 must typecheck shared types. Spikes must distinguish live evidence, mocks and blocked checks. Lead review confirms no single-hook field/use-hook action, no invented meme creation, no T16 implementation, and no production editorial prompts. Live Android/provider/PDF gates stay open until real prerequisites exist.


## Frozen batch — Reel Detail and Language Check

The [verbatim batch delta](../../design/frozen-reel-detail-language-spec.md) is authoritative for exact Polish labels, visual hierarchy and the eight newly frozen surfaces. It supersedes older pending-language/undefined-section/missing-render statements, including historical handoffs. It does not dispatch implementation or freeze editorial prompts. Previously frozen unrelated surfaces remain unchanged.

### Language workspace and application

Full-height scrollable workspace: header/close, quiet Reel context, DO POPRAWY diagnostic notes, editable WERSJA A (Twój tekst), separator, editable WERSJA B (Propozycja po korekcie), then Sprawdź ponownie. Both versions are simultaneously visible, A above B, with normal selection/copy/paste and flat writing treatment. No tabs, scores, per-observation fixes, cards, merge/diff/track-changes or third save action.

A initializes from immutable run.input.script; B from LanguageResult.scriptSuggestion. notes supplies diagnostic observations. Editing either version changes only its recoverable local draft, never the Reel or immutable run result. Użyj wersji A/B sends selection=language_version, version=A|B and the CURRENT edited text, with operationId/expectedVersion, to the existing run apply endpoint. The server accepts this selection only for a successful language_check run on the same Reel and replaces the whole script only; no hook or other field changes. The generic selection=script path must not bypass these language-specific checks.

Reel.scriptRevision is a server-owned monotonic script-change counter (initial 0), copied into AiInputSnapshot. Increment whenever persisted script text changes through any path, including AI application/fact correction; unrelated metadata/hook edits and identical-text writes do not increment it. The counter detects edit-and-revert as well as different current text; it is not a script-history/version-management feature. It is excluded from scalar PATCH. Application atomically checks snapshot scriptRevision and original script against the current script, alongside normal expectedVersion validation. Changed script returns HTTP 409 STALE_LANGUAGE_RESULT, retryable=false; suggested Polish mapping: Tekst zmienił się od sprawdzenia. Sprawdź język ponownie. Do not overwrite or silently rebase. Metadata-only changes use the ordinary conflict/retry flow and do not themselves make the language snapshot stale. Same-operation replay returns the original outcome before re-evaluating post-apply freshness. A new check uses the authoritative current Reel script; it does not silently save local A/B edits.

Acceptance: editable A/B remain local until explicit apply; current edited text replaces the entire script; hooks untouched; metadata-only changes, script edit/revert, concurrent writes and idempotent retry handled correctly. Final writing prompts remain pending.

### Materials and metadata selectors

MATERIAŁY stays inline and expandable: FOLDER kDrive → AKTUALNY EKSPORT → WERYFIKACJA only with an export. Folder creation is explicit, never capture/status driven. KDRIVE-02 permits one combined, explicit `Utwórz folder i wgraj` action to ensure/link the Reel folder and begin a cover or video upload; no other path creates a folder implicitly. Unavailable/moved/deleted references are retained with unavailable/relink behavior, never auto-replaced. KDRIVE-02 amends export replacement: a video upload is recorded through the existing export replacement contract; every explicit replacement increments its application revision even for the same provider file. Pasting an export link remains available. Preserve historical verification to derive Nieaktualne and its actual verifier identity after replacement. Current expected peer alone can verify the new revision; null editor exposes the frozen explanatory message and no verification action. Verification never gates ready/published. No Publication fields, original input or general file manager inside Materials.

Status/priority/editor use compact mobile bottom sheets (~44 px options), desktop compact equivalents; explicit selection performs one version-checked mutation, closes on success and displays authoritative server values. Dismissal changes nothing; errors/conflicts cannot show success. Exact statuses/priority labels and avatar identities are in the delta. MONTUJE permits NOXAVA, SZRON and Brak; never infer editor or expose a verifier selector. Entering editing starts the period, same-status saves do not; priority/editor changes retain it. Thresholds remain urgent=24h, normal=96h, evergreen=168h, applied to the current period. Cover validation remains the existing atomic publication gate.

Acceptance: all selector values/null editor, cancellation/conflict, edit-period entry/re-entry and priority threshold changes; no verification without export; same-file replacement becomes a new revision; expected peer enforcement; unavailable folder reference retained without replacement creation.

### KDRIVE-02 — bounded browser uploads

The API relays browser uploads to kDrive; the provider token and session token never reach the browser. The only supported purposes are one feed-cover image and one current video export in the Reel's own linked kDrive folder. There is no general file manager, arbitrary destination, browsing, delete or rename control. A file never passes through VPS disk storage; chunks are held in memory only while relayed.

- Video accepts MP4 or QuickTime up to 4 GiB; feed covers accept JPEG, PNG or WebP up to 25 MiB. MIME and magic bytes are checked. Uploads use 16 MiB chunks, are resumable by upload ID and received-chunk list, and permit at most two open uploads per Reel and four per user. Capacity reservation and counting must be atomic so concurrent starts cannot exceed these limits. An open upload idle for 24 hours is cancelled/expired.
- Start is idempotent on `operationId` and the normalized request payload; reusing an ID with changed input follows the ordinary idempotency-conflict behavior. With an available linked folder, upload goes there. Without a folder, only the explicit combined `Utwórz folder i wgraj` action may set `createFolder=true`, ensure/link the folder once and start the session. Missing/denied linked folders are never replaced implicitly. A retry of the combined action cannot create another folder or upload session.
- Chunk transfer enforces exact index, size and `application/octet-stream`; duplicate chunks return success without another provider call. Persist each chunk's SHA-256 digest by chunk number so finish can form kDrive's ordered aggregate hash after a process restart. Finish waits for all chunks and reconciles ambiguous provider responses by the known file ID; it never creates a second file to recover. Finish and attach are idempotent. Cancel applies only before finish, and SzroNox never deletes a finished kDrive file.
- Attach is a separate version-checked Reel mutation. Video uses the existing export replacement contract, increments the export revision and makes verification `Nieaktualne`; link paste remains available. Cover atomically stores `feedCoverAsset` and sets `feedCoverDone=true`; the explicit toggle can still unset completion. A stale version leaves the file/upload intact for retry.
- kDrive names use `EKSPORT - `, `OKLADKA - ` and `MEM - ` prefixes, retain the extension and never overwrite. Meme images are copied server-side after creation into `SzroNox Memy` under the configured base folder (optional override); copy failure does not fail meme creation, retries are bounded, and copied files remain independent of meme deletion. Replaying a successful meme-create operation must not enqueue a duplicate copy. A failed copy's `Ponów` row action explicitly starts one new bounded retry cycle; repeated operation replay cannot start another cycle. The in-app Meme library continues to use SzroNox private storage.

Wire additions: `Reel.feedCoverAsset`, `Meme.kdriveCopy`, `KdriveUploadStartRequest/Response`, `KdriveUploadState` and `AttachKdriveUploadRequest`. Database state lives in `app.kdrive_uploads`; only the API role may access it. Exact routes, error reasons, file-name cleaning, provider calls and UI states are specified in `KDRIVE-02-plan.md`. No deployment, production-data mutation or live provider test is authorized by this contract pin.

### Shared Meme creation and assignment

One shared library; metadata/name search only. Compact thumbnail/name rows, + NOWY MEM; no categories/tags/folders/analytics/counts/semantic search. Existing Meme selection attaches then closes on success. Reel.memeIds is a duplicate-free stable ordered relationship list; attach appends, first is primary by order, detach preserves remaining relative order and never deletes the shared record. Normal usage is 0–1, + kolejny supports additional attachments; no drag ordering. Opracuj still suggests at most one existing valid memeId, + Dodaj uses normal attachment; never invent or replace silently.

CreateMemeRequest requires a server-validated private media upload, not an arbitrary asserted URL. In picker context attachToReel carries reelId/expectedVersion. After upload validation, create the library record and its Reel relationship atomically with operation deduplication; conflict/failure cannot report successful attachment or leave a duplicate library record on retry. Upload transport may precede this transaction; retain the draft on failure. A future standalone context may omit attachToReel. This contract does not authorize a standalone library screen. The thumbnail/asset reference is resolved by the server from validated media. KDRIVE-02 also copies each newly created Meme server-side to the dedicated `SzroNox Memy` kDrive folder; the copy has bounded retries and never makes meme creation fail. kDrive copy metadata is informational and deleting a meme never deletes its copy. Do not add a library-delete action.

Acceptance: both users see shared records; required name/validated media enforced; create-and-attach retries deduplicate and conflicts preserve drafts; ordered primary behavior, detach relationship only, no implicit suggestion acceptance.

**MEME-VIDEO-01 — video memes (operator-authorized 2026-10-02).** `Meme.mediaKind` is `image | video`; `mimeType` is nullable for legacy rows. Create exactly one validated private image (`imageAssetId`) or video (`videoAssetId`), with an optional validated image `posterAssetId` for video. New Meme media and optional poster uploads use attachment purpose `meme`, are Reel-scoped and are never exposed as captured input/material. A video attachment must have purpose `meme`; capture creation refuses any video reference. Existing image upload size/type behavior remains unchanged (8 MiB, JPEG/PNG/WebP); GIF is added as a decoded image (first frame). Video uploads are limited to 25 MiB, streamed through the existing private storage path, and accepted only when the leading bytes match a known container signature: ISO-BMFF (`ftyp`), EBML, RIFF/AVI, Ogg, FLV, MPEG-TS, MPEG-PS or ASF. The server does not decode, transcode or install video software. A declared `video/*` MIME is stored when supplied; an absent/generic declaration uses a playback MIME derived from the recognized container. The video signature is authoritative: image/text bytes cannot pass by declaring a video MIME. Unknown signatures fail with 422 and do not publish an object.

`CreateMemeRequest` requires exactly one of `imageAssetId` and `videoAssetId`; `posterAssetId` is allowed only with video. The API verifies each attachment's ready state, validation, Reel and `meme` purpose, then atomically creates the shared Meme and Reel association using the existing idempotency/version rules. Meme creation failure preserves the picker draft. Legacy rows remain images. The private `/api/v1/memes/:id/media` route streams the asset with authenticated single-byte-range support (`200`, `206`, `416`); `/image` remains a compatibility alias. `/thumbnail` serves image assets or a video poster and returns 404 when a video has no poster. Responses use stored, server-validated MIME types and `X-Content-Type-Options: nosniff`.

The picker accepts JPEG/PNG/WebP/GIF and browser-recognized video files. It may create a poster from the first decodable frame in the browser and upload it as a `meme`-purpose image; decode failure or timeout does not block saving and leaves a neutral video pictogram. Video rows show a ▶ marker and accessible `wideo` label. Tapping the thumbnail toggles inline muted, looped, plays-inline playback with no controls; only one video may play at a time, leaving the picker stops playback, and the row name continues to attach the Meme. Reel Detail and the AI suggestion show the same video marker/poster state. Opracuj may suggest an existing video Meme under the existing one-candidate/explicit-attach rules. Shared kDrive copying remains best-effort and bounded at 25 MiB; known video MIME types receive their normal extension, unknown supported video types use `.bin`; copy failure never fails Meme creation. Several Meme assignments remain unchanged.

Migration 0015 adds Reel `source_link`, Meme `media_kind`/`mime_type`/`poster_ref`, the `meme` attachment purpose and `video` kind, and replaces both upload-table kind and validated-metadata checks so image dimensions remain mandatory for images while validated video rows carry no image dimensions. It does not mutate DEV data. Acceptance includes supported container signatures and spoofed/unknown files, GIF image validation, size/streaming limits, capture rejection, XOR/create/idempotency behavior, optional poster, authenticated range responses and kDrive naming; UI poster fallback, play/stop/attach semantics and AI suggestion; exact browser and device gates are recorded by the implementation handoff.

### Original input and shared editing note

ŹRÓDŁA / WEJŚCIE is inline: only populated original LINK/TEKST, separate DODATKOWY TEKST, captured-image rows, and mutable NOTATKA DO WEJŚCIA. CaptureInput.additionalText preserves separately entered Quick Add context alongside URL/image; do not merge it into text, originalShare or inputNote. Omitted legacy additionalText remains absent; never guess provenance from historical text. All supported original image descriptors remain visible with honest upload state; unsupported descriptors remain preserved but cannot appear as uploaded. Preserve originalShare title/ordered fields. Later Fact Check evidence stays with Fact Check, never here.

inputNote is the mutable input-context field; editingNotes is one shared multiline plain-text production note in inline UWAGI DO MONTAŻU. Both use normal version-checked scalar mutations and never rewrite originalInput. Preserve line breaks/manual bullets. No separate notes, comments, per-user records, checklists or AI-generated editing instructions.

Acceptance: URL/shared text/additionalText/multiple images remain distinct across capture/read/retry; no unsupported upload claim; inputNote edits leave originalInput byte-equivalent in stored values; both users edit editingNotes with conflicts preserved.

### Soft delete and recovery

Active Reel overflow has only Usuń rolkę. Use the exact confirmation and Anuluj/Usuń labels from the delta. Soft delete removes active visibility without deleting shared Memes, kDrive data or indexed programme/source data. GET /reels defaults visibility=active; visibility=deleted supplies the secondary Usunięte view. Opening a deleted Reel permits Przywróć rolkę through the existing version-checked restore endpoint. Restore clears deletedAt and preserves the previously persisted status; restore is not a new entry into editing and must not restart its period. Normal editing/AI mutations cannot modify a deleted Reel.

Usunięte is a quiet secondary Rolki menu entry, never a sixth status/main tab/permanent primary navigation item. Compact existing list language; no permanent delete, purge/retention, bulk trash or separate trash architecture.

Acceptance: confirmed/cancelled/failed deletion, active-list exclusion, deleted-list retrieval, status-preserving restore and concurrent/idempotent delete/restore; external/shared data untouched.

## CONTENT-PLANNER-01 — publication plan (user-authorized 2026-09-25)

The user explicitly authorized a deliberately simple Content Planner. It supersedes the earlier "no calendar" exclusion only for this bounded scope; autopublishing, analytics and new workflow states remain out.

A plan is scheduling metadata on the existing Reel, never a separate planner/event record: SQL `planned_publication_date date null` and `planned_publication_time time(0) null` (check: time requires date), JSON `plannedPublicationDate: 'YYYY-MM-DD' | null` and `plannedPublicationTime: 'HH:MM' | null`. Exactly one current plan per Reel. Both are ordinary version-checked PATCH fields; clearing the date alone also clears the time; a time without a date is refused. A plan change never changes `scriptRevision` or any other field. Status also stays unchanged except for IDEAS-PLAN: assigning a date for the first time to an `idea`, without an explicit `status` in that PATCH, promotes it to `to_record` in the same version-checked write and runs the ordinary `idea` → `to_record` side effects. Existing Reels are unplanned (null).

The PLAN view, the list `Zaplanuj` quick action and Reel Detail `Zaplanuj publikację` all write the same two fields. NIEZAPLANOWANE = not deleted, no planned date, status in `idea | to_record | editing | ready` (published history excluded). Non-ideas appear first in today's order, followed by ideas in the same order. Past-dated unpublished plans show as `Po terminie` in the current week. Wide browser layouts show PLAN | CURRENT REEL | REELS (≥1280px) or PLAN | centre (≥960px); mobile keeps one full-width view at a time.

**Publication slot correction (operator, 2026-09-26).** Reels are published at exactly one of three times of day, never a free clock time: `PublicationSlot = 'morning' | 'afternoon' | 'evening'` (UI `Rano` / `Popołudnie` / `Wieczór`). Migration 0012 adds SQL `planned_publication_slot text null` (checks: one of the three values; slot requires date) and converts any 0011 time (before 12:00 morning, before 17:00 afternoon, else evening). JSON `plannedPublicationTime` is retired, no longer on the wire and refused by PATCH; it is replaced by `plannedPublicationSlot: PublicationSlot | null`. The SQL time column remains only for rollback compatibility, always null. The date remains the plan; the slot is optional; clearing the date clears the slot; a slot without a date is refused. Within a day: Rano, Popołudnie, Wieczór, then Reels with no slot. Where UX-PUBLICATION-02 says "date/time fields/validation", read "date/slot".

## SOURCE-01 — editable source attribution (operator-authorized 2026-10-01)

Each Reel has `publicationSource: string | null` (version-checked PATCH, maximum 1000 characters) and read-only derived `sourceMetadata: SourceMetadata | null`. `null` means use automatic attribution; `''` means explicitly empty. The effective source is `publicationSource ?? sourceMetadata?.line ?? ''`. A source URL is derived from `originalInput.url`, otherwise the first HTTP(S) URL in captured `text`, then `additionalText`. Capture remains successful if fetching fails. No URL yields `no_url`; a URL starts `pending` with a server-formatted host fallback line and a new request ID. Existing Reels are not backfilled automatically.

The API fetch queue uses the shared `@szronox/source-fetch` package and the worker's existing per-hop DNS pinning, redirect, body-size and timeout guards. It stores only extracted metadata. A background result updates `source_metadata` only, guarded by its owning `requestId`; it never writes `publication_source` or changes Reel `version` / `updated_at`. A five-minute sweep recovers old pending jobs; retries are bounded. Soft-deleted Reels are skipped. Refresh is session/CSRF protected, idempotent by `operationId`, rate-limited, re-derives the capture URL, and does not enqueue again when pending work is less than 30 seconds old. Metadata states are `pending | found | partial | failed | no_url`.

The `Źródło` field is between Opis and Hashtagi. Editing automatic text makes it manual; clearing saves `''`. `Przywróć automatyczne` PATCHes `null`. The UI follows delta §A for state text, single actions, pending checks, local-edit preservation and undo. `Kopiuj opis` uses current editable Opis, effective Źródło and Hashtagi exactly as specified in the Frozen Publication amendment above. The provisional `Wygeneruj opis` prompt adds one sentence forbidding a source/attribution line in the description; final editorial prompt wording remains unfrozen.

Acceptance includes: exact metadata extraction fixtures; reused network guard checks; version-independent background updates and stale-request protection; refresh idempotency; no-URL/failure behavior; version-checked `publicationSource` including the 1000-character bound; worker source tests; exact copy composition for all three fields; and the §A UI states and interactions. Live source-site quality and DEV remain separate gates.

**SOURCE-01a — final refusals (operator, 2026-10-02).** `SourceMetadata.failure?: 'blocked' | 'unsupported' | 'unavailable' | null`, set only on `failed`. A site refusal (HTTP 401/403 → `blocked`) or an unreadable link (unsupported type, private address, too large → `unsupported`) ends `failed` at the first attempt; only `unavailable` (network, timeout, 5xx, 429) keeps the bounded 30 s / 2 min retry. The host line stays. UI: `Strona blokuje automatyczne pobieranie. Wpisz autora ręcznie.` / `Tego linku nie da się odczytać automatycznie. Wpisz źródło ręcznie.`, neither with an action. Rows written earlier lack the field and keep the generic failed line with `Ponów`. Observed: politico.com and rp.pl refuse the DEV server's address for every User-Agent.

## SOURCE-02 — add an article link after capture (operator-authorized 2026-10-02)

Reel gains nullable SQL/JSON `source_link` / `sourceLink`, PATCHable through the ordinary version-checked scalar mutation. The captured original input is immutable. `captureUrl` remains the URL derived from `originalInput`; `effectiveSourceUrl = captureUrl ?? sourceLink`. `sourceLink` may be set, changed or cleared only when `captureUrl` is null. A Reel with a captured URL (including an HTTP(S) URL found in captured text/additionalText) rejects a `sourceLink` patch with 422 `VALIDATION_ERROR` and `{ reason: 'capture_has_link' }`. A non-null link is trimmed, must parse as a full `http(s)://` URL, and is limited to 2048 characters. Empty text clears to null.

Setting, changing or clearing `sourceLink` updates `source_metadata` in the same database write from the new effective URL, with a fresh requestId and the normal pending host line or `no_url` state. After commit, enqueue metadata fetching through the existing source queue; its requestId compare-and-set prevents older fetches from replacing newer values. Refresh, pending recovery and every existing source-URL derivation use `effectiveSourceUrl`. `publicationSource` remains an independent manual attribution and is never changed by the article-link field or its fetch. Existing Reels default to no added link; no backfill.

The API AI snapshot includes optional `sourceLink` for new runs; legacy snapshots remain unchanged. Where the worker currently reads `originalInput.url`, it reads `originalInput.url ?? sourceLink`, preserving captured-link precedence and leaving prompts unchanged. In `ŹRÓDŁA / WEJŚCIE`, show the link editor only when capture has no link, after original capture and before input note. Follow delta §G for exact Polish copy, validation, save/cancel, open/change/delete and 30-second `Cofnij`; undo re-saves the previous URL. PUBLIKACJA's `Brak linku w materiale.` row exposes `Dodaj link`, which opens that section and focuses the field. The original capture is never rewritten.

Acceptance includes set/change/clear metadata reset and queue ownership, stale fetch protection, immutable capture, exact URL validation/limit, captured URL rejection, version conflicts, unchanged manual publication source, source refresh, worker URL fallback and legacy snapshots, preserved drafts on save failure, undo, and Publication-to-field focus. Live source-site behavior remains the existing separate gate. Exact visuals are in approved delta §G.

## IDEAS-PLAN — schedule ideas from the planner (operator-authorized 2026-10-01)

On the first assignment of a date (`planned_publication_date` was null and becomes non-null), an `idea` is promoted to `to_record` in the same version-checked PATCH only when that PATCH does not explicitly contain `status`. An explicit status wins. An idea with a date already set stays `idea` when the date or slot changes; clearing a date or slot never changes status. The promotion follows the same side effects as the existing explicit transition.

In NIEZAPLANOWANE, non-ideas precede ideas; each group keeps its existing order. Show `POMYSŁY · n` and the hint `Zaplanowanie zmieni status na „Do nagrania”.` when ideas exist. Scheduling an unplanned idea shows `Po zaplanowaniu pomysł trafi do „Do nagrania”.` in the sheet. After a successful promotion, show `Przeniesiono do „Do nagrania”` based on the server response. The exact layout and visibility rules are in delta §B.

Acceptance includes the first-assignment promotion, existing-date and explicit-status exceptions, unplan and slot behavior, stale-version atomicity, parity with the explicit transition side effects, ordering/empty labels, server-response notice, sheet hint and desktop drag behavior.

## UX-PUBLICATION-02 — operator-approved correction (2026-09-26)

The operator authorized one bounded Luna implementation of the [UX-PUBLICATION-02 dispatch](UX-PUBLICATION-02-dispatch.md), followed by manual Opus verification and a final Astra UI check. That dispatch supersedes only the prior CONTENT-PLANNER-01 wide-layout default, the named Reel Detail hierarchy/defaults in the written visual specifications, and PUBLICATION-01's script-only generation input. Preserve the frozen compact editorial visual language, five Reel statuses, existing planner fields and publication application safeguards. No merge or deployment is authorized by this amendment.

## UX-ASTRA-03 — approved usability continuation (2026-09-26)

The operator explicitly authorized Luna to implement the actionable latest Astra usability notes. [UX-ASTRA-03-dispatch.md](UX-ASTRA-03-dispatch.md) pins the bounded visual corrections, duplicate-Detail investigation and related confirmed Opus navigation/draft/accessibility repairs. It supersedes only the named selection, identity, width, action, summary, color/contrast and supporting-control treatments. Preserve the two-pane default already approved in UX-PUBLICATION-02, slot planner, exact original inputs, explicit hook/AI selection/application and all server invariants. No title fetching, new statuses, migrations, dependency changes, merge or deployment is authorized.

## LIST-FILTER-02 — pipeline default correction (operator, 2026-09-28)

The Rolki Status filter defaults to `Wszystkie`. In that view, `Wszystkie` means all active, unpublished pipeline Reels: `idea`, `to_record`, `editing` and `ready`. It excludes `published`. The explicit `Opublikowane` option remains available and shows published Reels. The other four status options retain their exact filters. This is a list-view rule, not a sixth status or a change to Reel state, deleted-Reel visibility, API list semantics, planner membership or publication history. [LIST-FILTER-02-preparation.md](LIST-FILTER-02-preparation.md) defines the bounded implementation handoff, combined with SCRIPT-COPY-01 by explicit operator approval on 2026-09-29.

## SCRIPT-COPY-01 — recording copy (operator, 2026-09-29)

Reel Detail has a compact `Kopiuj skrypt` action beside the `Skrypt` heading, available independently of AI capability. On explicit click, copy the currently visible editable script. Prefix it with the **explicitly selected** hook's current visible text when one exists, separated by exactly two newline characters. If no hook is selected, the selected hook was deleted, or its text is empty, copy the script alone; never infer or auto-select another hook. Use the current inline edit text for that selected hook while its editor is open, and preserve the text inside both parts without rewriting it. An empty/whitespace-only script has no copy action to perform.

Copying has no save, network, AI or status side effect. Report success only after the clipboard write succeeds. On unavailable/failed clipboard access, state the failure in Polish and expose the same composed text for manual selection/copy. Keep feedback attached to the Reel that initiated the action. A read-only published Reel can still be copied. Preserve the existing publication-copy behavior and all selected-hook persistence rules. This change is combined with LIST-FILTER-02 in one bounded Luna implementation; no merge or deployment follows from this approval.

## KDRIVE-01a — kDrive folder API (operator-authorized 2026-09-26)

The operator authorized KDRIVE-01a (API, configuration, tests and DEV deployment). The web wiring (KDRIVE-01b) follows after UX-ASTRA-03 is integrated. The T00 routes are now implemented:

- **`POST /api/v1/reels/:id/kdrive-folder`** takes `{ operationId, expectedVersion, mode: 'create' }` or `{ …, mode: 'link', folderId }`. It is session- and CSRF-protected, version-checked and idempotent, and returns `{ reel, folder }`. `create` refuses a Reel that already has a folder (`already_linked`); `link` is also the explicit relink.
- **`GET /api/v1/reels/:id/kdrive-folder`** returns `KdriveFolderState`: `none` (with `configured`), `available` (with `name` and `webUrl`), or `missing` / `access_denied` / `unavailable`. A read never clears the stored reference.
- **Storage:** the Reel stores `{ driveId, folderId }` only (the existing `kdrive_folder` column; no migration).
- **Folder creation:**
  - Folders are named `<title or first capture line> [<first 8 hex of Reel id>]`, created under the configured base folder, and found again by that tag. An ambiguous or duplicate create is reconciled by lookup, never duplicated.
  - Nothing existing in kDrive is deleted, renamed, moved or written.
  - Capture and status changes never create a folder.
- **Configuration:** `KDRIVE_DRIVE_ID`, `KDRIVE_ROOT_FOLDER_ID` and `KDRIVE_TOKEN_FILE`, all or none (a partial set fails startup). None means `PROVIDER_UNAVAILABLE` with `reason: kdrive_not_configured`. The token is an API-only secret file and is never logged or described.
- **Errors:** provider failures use the existing `PROVIDER_RESOURCE_MISSING` / `PROVIDER_ACCESS_DENIED` / `PROVIDER_UNAVAILABLE` codes.
- **Web link:** `https://ksuite.infomaniak.com/kdrive/app/drive/{driveId}/files/{folderId}`. Opening it requires the viewer's own kDrive access, which the operator confirmed for NOXAVA and SZRON on base folder `1349`.

## STREAM-LIVE-01 — live messages and access keys (operator-authorized 2026-10-11)

**Purpose.** During a broadcast either user can send, from a phone-first screen **Na żywo**, a quote (text 1–400 characters, optional source ≤ 120) or one of two signals to the host — `urgent` (`Pilnie chcę coś powiedzieć`) or `moment` (`Gdy będzie chwila`) — or cancel their signal. The streaming PC (StreamControl, a separate local application) reads these messages and reports what happened to each. Live messages are independent of Reels and streams; nothing here changes Reel invariants, the five statuses, auth/session behavior or any existing route.

**Data.** Migration `0016_live_messages.sql` (OCT-2026-plan STREAM-01/02 renumbered to 0017/0018, operator-approved). `app.live_messages` holds one row per message with a monotonic `seq` used only as the feed cursor; shape is checked per kind in SQL. `app.access_keys` holds named keys (`label`, `scope`, SHA-256 `token_hash`, `revoked_at`, `last_used_at`); the only scope is `live_feed`. Keys are created and revoked by an operator command running as the owner, reading the label from arguments and printing the secret once; the secret never enters logs, Git or the database. The API role may select keys and update only `last_used_at`; it reads and writes live messages. The worker has no access to either table.

**Device principal — explicit, narrow exception to VPS-00.** VPS-00 forbids a second bearer path for *user* authentication; that remains true. A `live_feed` key is a separate *device* principal, never a user: it resolves to no `VerifiedActor` and is accepted on exactly two routes, `GET /live/feed` and `POST /live/status`, via `Authorization: Bearer <secret>`. Comparison is by digest lookup with a constant-time check; revoked or unknown keys get the generic 401. Requests carrying a session cookie or an `Origin` header are refused on these two routes, so a browser cannot use them. Every other route rejects a key with the same 401 it gives an anonymous request. Bounded per-key rate limit (429 with Retry-After). Future scopes (e.g. a guest allowed to send quotes) need a separate approved amendment.

**Routes (all under `/api/v1`).**

| Route | Contract |
| --- | --- |
| POST /live/messages | Session + exact Origin + CSRF. `CreateLiveMessageRequest`; idempotent on `operationId` per the Mutation contract (same payload → original result, different payload → `IDEMPOTENCY_CONFLICT`). Field rules per kind; violations are 422 `VALIDATION_ERROR`. Per-user rate limit. Returns 201 `LiveMessage`. |
| GET /live/messages/mine | Session. The caller's 20 most recent messages, newest first (`LiveMessageListResponse`). A user never sees the other user's messages here. |
| GET /live/feed?after=&limit= | `live_feed` key only. Messages of both users with `seq > after`, oldest first, `limit` ≤ 100 (default 50), as `LiveFeedResponse` with `authorName`. Without `after`: no items and the current cursor. Read-only: it does not change status. |
| POST /live/status | `live_feed` key only. `LiveStatusRequest`. Allowed transitions: `sent → delivered`; quote `delivered → waiting\|shown\|dismissed`, `waiting → shown\|dismissed`; signal `delivered → seen\|expired\|replaced`; `signal_cancel` stops at `delivered`. A shortcut from `sent` to any later allowed state of the same kind is accepted (the PC may report only the outcome). Same status again → 204 no-op; anything else → 422 with `{ reason: 'invalid_transition' }`. Sets `status_at`. |

**Na żywo screen.** Reachable from the app's main navigation for both users. Exact layout and Polish copy are pinned in `design/live-delta-spec.md` once the operator approves it; no UI beyond that spec. Quote and source fields, `Wyślij na stream`, the three signal buttons, and the user's own recent messages with Polish status labels. Drafts are memory-only; a failed send keeps the text. No AI entry points.

**Acceptance.** Per-kind validation and limits in API and SQL; idempotent create; own-messages isolation; feed cursor order, limit, "start at now" and read-only behavior; key accepted only on the two device routes and refused with cookie/Origin; revoked/unknown key 401; transition table including no-op and invalid cases; rate limits; API role grants and the privilege refusal rules updated (worker none); contracts/API build and web typecheck. **Open real-world gates (separate approval):** DEV migration and deployment, real phone use, StreamControl reading DEV.

## STREAM-01 — streams and topics (operator-authorized 2026-10-11)

Authority: `docs/implementation/OCT-2026-plan.md` §4 and `design/oct-2026-delta-spec.md` §D (D1–D9, Astra-reviewed, operator-approved 2026-10-11). Migration `0017_streams.sql`; wire types in `packages/contracts` (`ReelFormat`, `StreamTopic`, `StreamTopicSource`, the four request types and `StreamTopicCandidate`). "Five statuses only" is unchanged.

**Model.** A stream is a Reel with `format = 'stream'`. Planning, statuses, editor, verification, kDrive folder, export, feed cover, publication fields and soft delete apply to it unchanged. `format` is fixed at creation (`CreateReelRequest.format`, default `'reel'`). A stream requires a non-empty trimmed `title` and may have an empty capture; `initialScript` and `initialHook` are refused on a stream (`VALIDATION_ERROR`). For a `'reel'`, `title` in the request is refused, and the existing capture rules are unchanged. Every Reel on the wire carries `format`, `absorbedInto`, `topics` (`[]` for reels) and `inStreams` (active streams that link this Reel; `[]` when none).

**Topics.** `stream_topics` rows are ordered by contiguous 0-based `position`.
- *Absorbed*: the source is an `idea` (`format='reel'`, not deleted, not absorbed, not linked in any stream). Absorbing copies the idea's `title`/`inputNote`/`script` into the topic's `title`/`notes`/`script` and sets the idea's `absorbed_into`. The topic row is the editable copy; capture, `sourceMetadata`, `publicationSource` and `sourceLink` stay on the idea and are exposed through `StreamTopic.source`. **Odłącz** (DELETE on an absorbed topic) writes title→`title`, notes→`inputNote`, script→`script` back to the idea (incrementing its `version`, and its `scriptRevision` only when the script text changed), clears `absorbed_into`, removes the row and renumbers positions. The idea returns to the list as `idea`.
- *Linked*: the source is any non-deleted, non-absorbed `format='reel'` Reel. The row stores no copy (`''` fields); `source` is read live. Removing the topic removes only the reference.
- A stream is never a topic. A Reel appears at most once per stream. An absorbed idea belongs to exactly one stream. `to_record` and later may only be linked. An idea already absorbed elsewhere is refused, and so is an idea already linked in any stream (it would disappear from under that reference). Refusals are `422 VALIDATION_ERROR` with `reason`: `not_a_stream`, `source_is_stream`, `already_in_stream`, `absorbed_elsewhere`, `linked_elsewhere`, `absorb_requires_idea`, `source_deleted`, `topic_not_absorbed`.
- **New topic** (`mode: 'new'`): one write creates a hidden absorbed idea (client `reelId`, `status='idea'`, `absorbed_into` = stream, capture `{ url: link }` when a link is given, else `{ images: [] }`, `inputNote` = note) and its topic (client `topicId`) at the end. This is the only exception to the "text, URL or image required" capture rule. A given link is validated like `sourceLink` (full http(s), ≤ 2048) and enqueues SOURCE-01 metadata for the new idea after commit.
- **Topic edits** (PATCH, absorbed only): `title`/`notes`/`script`, plus `publicationSource` which is written to the idea with SOURCE-01 semantics (`null` automatic, `''` suppressed, ≤ 1000). SOURCE-01 refresh of an absorbed idea's metadata uses the existing refresh route on the idea's ID.
- Absorb, link, new, edit, reorder and remove are each one transaction, version-checked against the **stream's** `version` and idempotent on `operationId` through `app.operations`. Each increments the stream's `version`/`updated_at` and returns the authoritative stream `Reel`. Reorder takes the complete list of the stream's topic IDs; any other set is `VALIDATION_ERROR` `reason: topic_set_mismatch`.

**Hidden absorbed ideas.** A Reel with `absorbed_into` set is excluded from `GET /reels` (both visibilities), the planner, search and topic candidates. `GET /reels/:id` still returns it. `PATCH /reels/:id`, delete/restore, hook, meme, export, verification, kDrive and AI routes on it are refused with `422 VALIDATION_ERROR` `reason: absorbed_into_stream`. Its only write paths are the stream topic routes and the SOURCE-01 metadata refresh.

**Lifecycle.** Soft-deleting a stream sets the same `deleted_at` on all its absorbed ideas in the same transaction; restoring it clears `deleted_at` on all of them. Topics, order and positions are untouched. `Usunięte` lists only the stream. Soft-deleting or restoring a linked Reel never touches the stream; its topic shows `source.deletedAt`. A deleted stream refuses topic mutations like any other edit of a deleted Reel. Linked-Reel `inStreams` lists only non-deleted streams.

**No AI on streams.** `POST /reels/:id/ai-runs` on a stream returns `422 VALIDATION_ERROR` with `reason: not_available_for_stream`, checked before enqueue. Hooks, memes, exports, verification and kDrive routes behave as for a Reel (UI hides hooks per D3). `Utwórz folder` keeps today's location until KDRIVE-03.

**Copy composition.** A stream's `Kopiuj opis` = Opis, then the topics' `source.sourceLine` values in topic order (empty skipped, exact duplicates removed, joined by one newline), then Hashtagi. Non-empty sections are joined by two newlines; nothing is trimmed or rewritten. The stream's own `publicationSource` is not used. Reel composition is unchanged.

**Routes** (session, exact Origin and CSRF on unsafe methods, as for every route):

| Route | Contract |
| --- | --- |
| POST /reels/:id/topics | `AddStreamTopicRequest` (absorb / link / new) |
| PATCH /reels/:id/topics/:topicId | `StreamTopicPatchRequest`, absorbed only |
| DELETE /reels/:id/topics/:topicId | `RemoveStreamTopicRequest`: Odłącz (absorbed) or remove reference (linked) |
| PUT /reels/:id/topic-order | `StreamTopicOrderRequest` |
| GET /reels/:id/topic-candidates?q= | Non-deleted, non-absorbed `format='reel'` Reels matching `q` on title (case-insensitive), ideas and later statuses, `inThisStream` flagged; at most 100 |

**Grants.** The API gets select/insert/update/delete on `app.stream_topics`; the worker gets nothing on it (STREAM-02 will extend it). Worker access to `app.reels` is unchanged.

Acceptance: covered by the STREAM-01a (API) and STREAM-01b (web) dispatch in `docs/implementation/STREAM-01-dispatch.md`. Open real-world gates: the DEV migration and deployment, and real-device use.

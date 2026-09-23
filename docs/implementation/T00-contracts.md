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
- The completion checkbox works without any asset reference. An optional lightweight attachment or kDrive/file reference may be added later using existing file facilities; no cover-specific asset contract or module is required for MVP completion tracking.
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

MATERIAŁY stays inline and expandable: FOLDER kDrive → AKTUALNY EKSPORT → WERYFIKACJA only with an export. Folder creation is explicit, never capture/status driven. Unavailable/moved/deleted references are retained with unavailable/relink behavior, never auto-replaced. Existing production export reference selection is not a large-file uploader; every explicit replacement increments its application revision even for the same provider file. Preserve historical verification to derive Nieaktualne and its actual verifier identity after replacement. Current expected peer alone can verify the new revision; null editor exposes the frozen explanatory message and no verification action. Verification never gates ready/published. No cover, Publication fields, original input or file manager inside Materials.

Status/priority/editor use compact mobile bottom sheets (~44 px options), desktop compact equivalents; explicit selection performs one version-checked mutation, closes on success and displays authoritative server values. Dismissal changes nothing; errors/conflicts cannot show success. Exact statuses/priority labels and avatar identities are in the delta. MONTUJE permits NOXAVA, SZRON and Brak; never infer editor or expose a verifier selector. Entering editing starts the period, same-status saves do not; priority/editor changes retain it. Thresholds remain urgent=24h, normal=96h, evergreen=168h, applied to the current period. Cover validation remains the existing atomic publication gate.

Acceptance: all selector values/null editor, cancellation/conflict, edit-period entry/re-entry and priority threshold changes; no verification without export; same-file replacement becomes a new revision; expected peer enforcement; unavailable folder reference retained without replacement creation.

### Shared Meme creation and assignment

One shared library; metadata/name search only. Compact thumbnail/name rows, + NOWY MEM; no categories/tags/folders/analytics/counts/semantic search. Existing Meme selection attaches then closes on success. Reel.memeIds is a duplicate-free stable ordered relationship list; attach appends, first is primary by order, detach preserves remaining relative order and never deletes the shared record. Normal usage is 0–1, + kolejny supports additional attachments; no drag ordering. Opracuj still suggests at most one existing valid memeId, + Dodaj uses normal attachment; never invent or replace silently.

CreateMemeRequest requires name and imageAssetId pointing to a server-validated private image upload, not an arbitrary asserted URL. In picker context attachToReel carries reelId/expectedVersion. After upload validation, create the library record and its Reel relationship atomically with operation deduplication; conflict/failure cannot report successful attachment or leave a duplicate library record on retry. Upload transport may precede this transaction; retain the draft on failure. A future standalone context may omit attachToReel. This contract does not authorize a standalone library screen. The thumbnail/asset reference is resolved by the server from the validated image asset. Do not add a library-delete action.

Acceptance: both users see shared records; required name/image enforced; create-and-attach retries deduplicate and conflicts preserve drafts; ordered primary behavior, detach relationship only, no implicit suggestion acceptance.

### Original input and shared editing note

ŹRÓDŁA / WEJŚCIE is inline: only populated original LINK/TEKST, separate DODATKOWY TEKST, captured-image rows, and mutable NOTATKA DO WEJŚCIA. CaptureInput.additionalText preserves separately entered Quick Add context alongside URL/image; do not merge it into text, originalShare or inputNote. Omitted legacy additionalText remains absent; never guess provenance from historical text. All supported original image descriptors remain visible with honest upload state; unsupported descriptors remain preserved but cannot appear as uploaded. Preserve originalShare title/ordered fields. Later Fact Check evidence stays with Fact Check, never here.

inputNote is the mutable input-context field; editingNotes is one shared multiline plain-text production note in inline UWAGI DO MONTAŻU. Both use normal version-checked scalar mutations and never rewrite originalInput. Preserve line breaks/manual bullets. No separate notes, comments, per-user records, checklists or AI-generated editing instructions.

Acceptance: URL/shared text/additionalText/multiple images remain distinct across capture/read/retry; no unsupported upload claim; inputNote edits leave originalInput byte-equivalent in stored values; both users edit editingNotes with conflicts preserved.

### Soft delete and recovery

Active Reel overflow has only Usuń rolkę. Use the exact confirmation and Anuluj/Usuń labels from the delta. Soft delete removes active visibility without deleting shared Memes, kDrive data or indexed programme/source data. GET /reels defaults visibility=active; visibility=deleted supplies the secondary Usunięte view. Opening a deleted Reel permits Przywróć rolkę through the existing version-checked restore endpoint. Restore clears deletedAt and preserves the previously persisted status; restore is not a new entry into editing and must not restart its period. Normal editing/AI mutations cannot modify a deleted Reel.

Usunięte is a quiet secondary Rolki menu entry, never a sixth status/main tab/permanent primary navigation item. Compact existing list language; no permanent delete, purge/retention, bulk trash or separate trash architecture.

Acceptance: confirmed/cancelled/failed deletion, active-list exclusion, deleted-list retrieval, status-preserving restore and concurrent/idempotent delete/restore; external/shared data untouched.

/** T00 wire contracts. Frozen written specs govern UI; final editorial prompts remain pending. */
export type Id = string;
export type IsoDateTime = string;
/** Calendar date without time zone, `YYYY-MM-DD`. */
export type IsoDate = string;
/** CONTENT-PLANNER-01: the only three publication times of day (Rano / Popołudnie / Wieczór). */
export type PublicationSlot = 'morning' | 'afternoon' | 'evening';
export type ReelStatus = 'idea' | 'to_record' | 'editing' | 'ready' | 'published';
export type Priority = 'urgent' | 'normal' | 'evergreen';
export interface MutationContext { operationId: Id; expectedVersion: number }
export interface User { id: Id; name: 'NOXAVA' | 'SZRON'; avatarUrl: string | null }
/** VPS-00: credentials are sent only to the same-origin login endpoint. */
export interface LoginRequest { name: User['name']; password: string }
/** Metadata only: the opaque session secret is exclusively in an HttpOnly cookie. */
export interface AuthSessionResponse {
  user: User;
  peer: User;
  expiresAt: IsoDateTime;
  /** Held in memory; send as X-CSRF-Token for authenticated unsafe requests. */
  csrfToken: string;
}
export interface ReelHook {
  id: Id;
  reelId: Id;
  text: string;
  source: 'user' | 'ai';
  position: number;
  createdAt: IsoDateTime;
}
export type SourceMetadataState = 'pending' | 'found' | 'partial' | 'failed' | 'no_url';
/**
 * Why a fetch ended `failed`. `blocked` (the site refused: 401/403) and `unsupported` (the link
 * can't be read as a page) are final at the first attempt; only `unavailable` is retried.
 * Absent on rows written before SOURCE-01a.
 */
export type SourceFetchFailure = 'blocked' | 'unsupported' | 'unavailable';
export interface SourceMetadata {
  state: SourceMetadataState;
  /** Canonical public URL that was, or will be, fetched. */
  url: string | null;
  author: string | null;
  /** Extracted site name, or the URL host when metadata is incomplete. */
  siteName: string | null;
  /** Article publication date rendered as YYYY-MM-DD in Europe/Warsaw. */
  publishedDate: string | null;
  /** Server-formatted Polish attribution line; null only for no_url. */
  line: string | null;
  /** operationId of the fetch request that owns this value. */
  requestId: Id;
  requestedAt: IsoDateTime;
  fetchedAt: IsoDateTime | null;
  attempts: number;
  /** Set only when `state` is `failed`. */
  failure?: SourceFetchFailure | null;
  /**
   * CAPTURE-DRAFT-01: the article headline (og:title, else <title>, trailing site name removed when
   * it equals siteName), at most 300 characters. Absent on rows fetched before it existed.
   */
  headline?: string | null;
}
export interface Meme {
  id: Id;
  name: string;
  /** Existing library items are images; new memes may also be videos. */
  mediaKind: 'image' | 'video';
  /** Server-validated media type; null on legacy library rows. */
  mimeType: string | null;
  thumbnailRef: string | null;
  assetRef: string;
  kdriveCopy: MemeKdriveCopy;
}
export interface MemeKdriveCopy {
  state: 'pending' | 'copied' | 'failed' | 'not_configured';
  name?: string;
  webUrl?: string;
}
export interface MemeSuggestion {
  memeId: Id;
  rationale: string;
  relevantFragment?: string;
}
export interface ExportReference {
  revision: number;
  url: string;
  label: string;
  driveId?: string;
  fileId?: string;
  providerVersion?: string;
}
export interface VerificationRecord {
  checkedBy: Id;
  checkedAt: IsoDateTime;
  exportRevision: number;
}
export type VerificationState = 'not_verified' | 'verified' | 'outdated';
export interface AttachmentReference {
  id: Id;
  reelId: Id;
  purpose: 'input' | 'source' | 'material' | 'meme';
  kind: 'url' | 'image' | 'video';
  label: string;
  url?: string;
  storageKey?: string;
  state: 'pending' | 'ready' | 'failed';
}
/** Provider-neutral shape retained from T05's corrected upload transport. */
export interface UploadTransport {
  uploadUrl: string;
  method: 'PUT' | 'POST';
  headers: Record<string, string>;
  /** Unix seconds, unlike ISO expiresAt in AuthSessionResponse. */
  expiresAt: number;
}
export interface InitiateAttachmentRequest {
  operationId: Id;
  attachmentId: Id;
  fileName: string;
  mimeType: string;
  byteSize: number;
  purpose?: AttachmentReference['purpose'];
  /** Omitted for existing clients; defaults to `image`. */
  kind?: 'image' | 'video';
}
export interface InitiateAttachmentResponse {
  attachment: AttachmentReference;
  /** Opaque identifier, never a filesystem path or read authorization. */
  storageKey: string;
  upload: UploadTransport;
}
export interface CompleteAttachmentRequest { operationId: Id }
/** Completion returns AttachmentReference; byte-transfer success is not completion. */
export type CompleteAttachmentResponse = AttachmentReference;
/** Refresh transport only; does not mutate the attachment or its operation history. */
export interface RenewAttachmentUploadResponse { upload: UploadTransport }
/** Authoritative evidence resolved from the indexed programme, never authored by AI. */
export interface ProgrammeCitation {
  documentVersionId: Id;
  proposalId: Id | null;
  chunkIds: Id[];
  category: string;
  proposal: string;
  excerpt: string;
  sourceTitle: string;
  sourceUrl: string;
  chapter: string;
  subchapter: string | null;
  pdfPages: number[];
  printedPages: string[];
}
export interface ProgrammeMatch extends ProgrammeCitation {
  /** Stable server-owned ID scoped to the originating run. */
  candidateId: Id;
  rationale: string;
  strength: 'strong' | 'indirect';
}
export interface ProgrammeAttachment extends ProgrammeMatch {
  sourceRunId: Id;
  attachedBy: Id;
  attachedAt: IsoDateTime;
}
export interface Reel {
  id: Id;
  version: number;
  title: string;
  status: ReelStatus;
  priority: Priority;
  inputNote: string;
  /** Immutable original capture, distinct from editable inputNote and generated content. */
  originalInput: CaptureInput;
  script: string;
  /** Monotonic script-only change counter; unrelated metadata edits do not increment it. */
  scriptRevision: number;
  editingNotes: string;
  editorId: Id | null;
  hooks: ReelHook[];
  /**
   * HOOKS-SELECT-EDIT: the one explicitly chosen hook, or null. Always an ID of a hook in
   * `hooks`; its text is read from that row. Never inferred, and cleared when that hook is deleted.
   */
  selectedHookId: Id | null;
  memeIds: Id[];
  attachments: AttachmentReference[];
  currentExport: ExportReference | null;
  verification: VerificationRecord | null;
  verificationState: VerificationState | null;
  programmeState: 'unchecked' | 'matched' | 'no_match';
  programmeAttachment: ProgrammeAttachment | null;
  programmeInputHash: string | null;
  programmeDocumentVersionId: Id | null;
  kdriveFolder: { driveId: string; folderId: string } | null;
  editingStartedAt: IsoDateTime | null;
  publishedAt: IsoDateTime | null;
  publicationUrls: string[];
  /** Separate editable publication fields; SQL defaults each to ''. */
  publicationDescription: string;
  publicationHashtags: string;
  /** null uses sourceMetadata.line; '' explicitly suppresses automatic attribution. */
  publicationSource: string | null;
  /** Read-only derived attribution metadata, null until SOURCE-01 has fetched it. */
  sourceMetadata: SourceMetadata | null;
  /** SOURCE-02: added article link, only when originalInput contains no link. */
  sourceLink: string | null;
  /** Required production deliverable; SQL feed_cover_done NOT NULL DEFAULT false. */
  feedCoverDone: boolean;
  /** Optional kDrive file reference; uploading it also marks feedCoverDone in the same write. */
  feedCoverAsset: FeedCoverAsset | null;
  /**
   * CONTENT-PLANNER-01: the one current publication plan, local calendar date `YYYY-MM-DD`,
   * or null when unplanned. Planning never changes `status`.
   */
  plannedPublicationDate: IsoDate | null;
  /** Optional part of the day; only ever set together with a date. */
  plannedPublicationSlot: PublicationSlot | null;
  /** STREAM-01: fixed at creation; every pre-existing Reel is 'reel'. */
  format: ReelFormat;
  /** STREAM-01: set only on an idea absorbed into that stream; such a Reel is hidden, not deleted. */
  absorbedInto: Id | null;
  /** STREAM-01: ordered topics of a stream (position order); always [] for format 'reel'. */
  topics: StreamTopic[];
  /** STREAM-01 (D6): active streams that link this Reel as a reference topic; [] when none. */
  inStreams: StreamRef[];
  /** CAPTURE-DRAFT-01: the develop run queued by this Reel's capture, or null when none was queued. */
  autoDraft: AutoDraftSummary | null;
  createdBy: Id;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  deletedAt: IsoDateTime | null;
}
/** CAPTURE-DRAFT-01 */
export interface AutoDraftSummary {
  runId: Id;
  state: AiJobState;
  /** DevelopResult.titleSuggestion once the run succeeded; otherwise null. */
  titleSuggestion: string | null;
  isStale: boolean;
}
/** STREAM-01 */
export type ReelFormat = 'reel' | 'stream';
export type StreamTopicKind = 'absorbed' | 'linked';
export interface StreamRef { id: Id; title: string }
/** Live, read-only view of the Reel behind a topic (the absorbed idea or the referenced Reel). */
export interface StreamTopicSource {
  reelId: Id;
  /** The source Reel's own title (for absorbed topics the editable copy is StreamTopic.title). */
  title: string;
  status: ReelStatus;
  editorId: Id | null;
  /** Effective attribution: publicationSource ?? sourceMetadata?.line ?? '' of the source Reel. */
  sourceLine: string;
  /** Absorbed topics only (D4 `Źródło` and `Materiał źródłowy`); null for linked topics. */
  publicationSource: string | null;
  sourceMetadata: SourceMetadata | null;
  sourceLink: string | null;
  originalInput: CaptureInput | null;
  /** Integration amendment: the source Reel's selected hook text, for its derived label. */
  selectedHookText: string | null;
  /** A deleted referenced Reel stays as a muted `Usunięta rolka` row. */
  deletedAt: IsoDateTime | null;
}
export interface StreamTopic {
  id: Id;
  kind: StreamTopicKind;
  /** 0-based, contiguous, unique per stream. */
  position: number;
  /** Absorbed: editable copy. Linked: always '' (read source.title live). */
  title: string;
  notes: string;
  script: string;
  source: StreamTopicSource;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
/** POST /reels/:streamId/topics — every variant is a version-checked mutation of the stream. */
export type AddStreamTopicRequest = MutationContext & (
  | { mode: 'absorb'; reelId: Id }
  | { mode: 'link'; reelId: Id }
  /** `+ Nowy temat`: creates a hidden absorbed idea; reelId is client-generated like POST /reels. */
  | { mode: 'new'; topicId: Id; reelId: Id; title: string; link?: string; note?: string }
);
/** PATCH /reels/:streamId/topics/:topicId — absorbed topics only. */
export interface StreamTopicPatchRequest extends MutationContext {
  changes: Partial<Pick<StreamTopic, 'title' | 'notes' | 'script'>> & {
    /** Written to the absorbed idea's publicationSource with SOURCE-01 semantics. */
    publicationSource?: string | null;
  };
}
/** DELETE /reels/:streamId/topics/:topicId — linked: remove reference; absorbed: Odłącz. */
export type RemoveStreamTopicRequest = MutationContext;
/** PUT /reels/:streamId/topic-order — the complete new order of the stream's topic IDs. */
export interface StreamTopicOrderRequest extends MutationContext { topicIds: Id[] }
/** GET /reels/:streamId/topic-candidates?q= — the D5 picker. */
export interface StreamTopicCandidate {
  id: Id;
  title: string;
  status: ReelStatus;
  plannedPublicationDate: IsoDate | null;
  plannedPublicationSlot: PublicationSlot | null;
  /**
   * Integration amendment: most Reels have no typed title, so the picker needs the material
   * the web label chain uses (reel-label.ts) to show a readable row.
   */
  originalInput: CaptureInput;
  script: string;
  selectedHookText: string | null;
  sourceMetadata: SourceMetadata | null;
  /** Rows already in this stream are listed disabled (`W tym streamie`). */
  inThisStream: boolean;
}
export interface StreamTopicCandidatesResponse { items: StreamTopicCandidate[] }
export interface CaptureImageDescriptor {
  attachmentId: Id;
  fileName: string;
  mimeType: string;
  byteSize: number;
}
export interface OriginalSharedInput {
  /** Exact scalar fields in received order, including repeated names and empty values. */
  fields: Array<{ name: string; value: string }>;
  /** All received file descriptors in order, including explicitly unsupported files. */
  files: Array<CaptureImageDescriptor & {
    lastModified?: number;
    issue?: 'UNSUPPORTED_INPUT';
  }>;
}
/** One capture may combine text, URL and multiple supported images. */
export interface CaptureInput {
  text?: string;
  /** Separate Quick Add context entered alongside URL/image; immutable after capture. */
  additionalText?: string;
  url?: string;
  images: CaptureImageDescriptor[];
  originalShare?: OriginalSharedInput;
}
export interface CreateReelRequest {
  operationId: Id;
  reelId: Id;
  input: CaptureInput;
  /** Explicit ready-script capture: must exactly match nonempty input.text. */
  initialScript?: string;
  initialHook?: string;
  priority?: Priority;
  /** STREAM-01: defaults to 'reel'. A stream requires a non-empty title and may have an empty input. */
  format?: ReelFormat;
  title?: string;
}
export interface ReelPatchRequest extends MutationContext {
  changes: Partial<Pick<Reel,
    'title' | 'status' | 'priority' | 'inputNote' | 'script' | 'editingNotes' |
    'editorId' | 'publishedAt' | 'publicationUrls' | 'publicationDescription' |
    'publicationHashtags' | 'publicationSource' | 'sourceLink' | 'feedCoverDone' | 'plannedPublicationDate' | 'plannedPublicationSlot'>>;
}
export interface SourceMetadataRefreshRequest { operationId: Id }
export interface AddHookRequest extends MutationContext { text: string; position?: number }
export interface EditHookRequest extends MutationContext { text: string }
export type RemoveHookRequest = MutationContext;
/** Explicit selection; null clears it. The server resolves the hook within the same Reel. */
export interface SelectHookRequest extends MutationContext { hookId: Id | null }
/** The authoritative Reel after selection. */
export type SelectHookResponse = Reel;
export interface AttachMemeRequest extends MutationContext { memeId: Id }
export type DetachMemeRequest = MutationContext;
/** Validated private media; picker creation and attachment commit atomically. */
export type CreateMemeRequest = {
  operationId: Id;
  name: string;
  attachToReel?: { reelId: Id; expectedVersion: number };
} & (
  | { imageAssetId: Id; videoAssetId?: never; posterAssetId?: never }
  | { imageAssetId?: never; videoAssetId: Id; posterAssetId?: Id }
);
/**
 * KDRIVE-01: explicit kDrive folder command (T00 `POST /reels/:id/kdrive-folder`).
 * `create` makes (or, after an ambiguous earlier attempt, finds) this Reel's folder under the
 * configured base folder; `link` stores an existing folder id, also used to relink. Never
 * issued implicitly by capture or a status change.
 */
export type KdriveFolderRequest = MutationContext & ({ mode: 'create' } | { mode: 'link'; folderId: string });
/**
 * Resolved state of a Reel's stored folder reference (`GET /reels/:id/kdrive-folder`). A
 * missing/denied/unavailable reference is retained on the Reel, never cleared by a read.
 */
export type KdriveFolderState =
  | { state: 'none'; configured: boolean }
  | { state: 'available'; driveId: string; folderId: string; name: string; webUrl: string }
  | { state: 'missing' | 'access_denied' | 'unavailable'; driveId: string; folderId: string; webUrl: string; retryable: boolean };
export interface KdriveFolderResponse { reel: Reel; folder: KdriveFolderState }
export interface FeedCoverAsset {
  driveId: string;
  fileId: string;
  name: string;
  byteSize: number;
  uploadedAt: IsoDateTime;
  uploadedBy: Id;
}
export type KdriveUploadPurpose = 'video' | 'cover';
export type KdriveUploadLifecycleState = 'open' | 'finished' | 'attached' | 'cancelled' | 'expired' | 'failed';
/** Explicit kDrive relay upload. `expectedVersion` is consumed only if this operation creates and links a Reel folder. */
export interface KdriveUploadStartRequest extends MutationContext {
  purpose: KdriveUploadPurpose;
  fileName: string;
  byteSize: number;
  mimeType: string;
  createFolder?: boolean;
}
/** Safe resumable state; provider tokens and upload hosts are never exposed. */
export interface KdriveUploadState {
  uploadId: Id;
  reelId: Id;
  purpose: KdriveUploadPurpose;
  fileName: string;
  mimeType: string;
  byteSize: number;
  chunkSize: number;
  totalChunks: number;
  receivedChunks: number[];
  state: KdriveUploadLifecycleState;
  finalName?: string;
  fileId?: string;
}
export interface KdriveUploadStartResponse extends KdriveUploadState {}
export interface AttachKdriveUploadRequest extends MutationContext {}
export interface ReelListQuery {
  /** Defaults to active. Deleted is a secondary view, never a ReelStatus. */
  visibility?: 'active' | 'deleted';
  status?: ReelStatus;
  overdue?: boolean;
  cursor?: string;
}
export interface ReplaceExportRequest extends MutationContext {
  export: Omit<ExportReference, 'revision'>;
}
/** Requires a valid selected editor; the actor must be the other allowlisted user. */
export interface VerifyExportRequest extends MutationContext { exportRevision: number }
/** Explicit Odłącz: clear the programme association without starting search. */
export type DetachProgrammeRequest = MutationContext;
export type AiAction = 'develop' | 'generate_hooks' | 'fact_check' | 'language_check' | 'find_programme' | 'generate_publication';
export type AiJobState = 'queued' | 'running' | 'succeeded' | 'failed';
export interface AiInputSnapshot {
  reelVersion: number;
  title: string;
  originalInput: CaptureInput;
  /** SOURCE-02: article URL added after capture; absent in older snapshots. */
  sourceLink?: string | null;
  script: string;
  scriptRevision: number;
  /**
   * PUBLICATION-02: grounded publication runs; absent on legacy script-only runs. v3 (UI-02)
   * also reads the linked source and saved input images, with a bounded web-search fallback.
   * Freshness is identical for v2 and v3.
   */
  publicationContextVersion?: 2 | 3;
  hooks: Array<Pick<ReelHook, 'id' | 'text' | 'source' | 'position'>>;
  /** The selected hook at snapshot time; absent in runs recorded before HOOKS-SELECT-EDIT. */
  selectedHookId?: Id | null;
  inputNote: string;
  publicationDescription: string;
  publicationHashtags: string;
  attachments: AttachmentReference[];
  priority: Priority;
  attachedMemeIds: Id[];
  memeCandidateIds: Id[];
  memeCandidates: Array<Pick<Meme, 'id' | 'name' | 'thumbnailRef'>>;
  programmeDocumentVersionId: Id | null;
  /**
   * VOICE-01: the team's own recent Reels as style examples (develop, generate_hooks,
   * generate_publication). Recorded for provenance only: excluded from inputHash and staleness.
   * Absent in older snapshots.
   */
  styleExamples?: StyleExample[];
}
/** VOICE-01: one past Reel used as a style example. */
export interface StyleExample {
  reelId: Id;
  /** Selected hook, else the single team-written hook, else null. */
  hook: string | null;
  /** First 600 characters of the script. */
  scriptExcerpt: string;
  /** Publication description (first 600 characters), or '' when none. */
  description: string;
}
/**
 * PUBLICATION-01: Opracuj no longer drafts publication copy. Historical stored develop results
 * may still carry publicationDescriptionSuggestion/publicationHashtagsSuggestion; they are
 * ignored and can no longer be applied.
 */
export interface DevelopResult {
  titleSuggestion: string;
  eventSummary: string;
  verificationIssues: string[];
  hookAdditions: string[];
  scriptSuggestion: string;
  possibleProgrammeConnection: string | null;
  prioritySuggestion: { priority: Priority; rationale: string } | null;
  memeSuggestion: MemeSuggestion | null;
}
export interface SourceEvidence {
  id: Id;
  url: string;
  title: string;
  origin: 'google_search' | 'url_context';
  retrievedAt: IsoDateTime;
  providerReference: string;
  evidenceText: string | null;
  evidenceKind: 'retrieved_excerpt' | 'tool_metadata_only';
}
export interface FactClaimOrigin {
  reelVersion: number;
  inputHash: string;
  /** Hash of the exact checked script or complete source hook in the run snapshot. */
  sourceTextHash: string;
  /** Half-open offsets into that snapshot source; JavaScript UTF-16 code units. */
  span: { start: number; end: number; text: string; offsetUnit: 'utf16_code_units' };
}
export interface FactClaimEvidence {
  sourceId: Id;
  providerReference: string;
  /** Server-owned retained grounding evidence, including its claim/source association. */
  retainedEvidenceRef: Id;
}
export interface FactClaim {
  id: Id;
  location: { field: 'script' } | { field: 'hook'; hookId: Id };
  origin: FactClaimOrigin;
  text: string;
  status: 'confirmed' | 'uncertain' | 'contradicted';
  explanation: string;
  sourceIds: Id[];
  evidence: FactClaimEvidence[];
  /** Script: replacement fragment. Hook: corrected complete text of that one hook. */
  correction: string | null;
  /** Derived per item; neither freshness nor application is a fourth factual status. */
  isStale: boolean;
  applied: { operationId: Id; reelVersion: number; appliedAt: IsoDateTime } | null;
}
export interface FactCheckResult {
  coverage: 'complete' | 'partial' | 'no_factual_claims';
  claims: FactClaim[];
  sources: SourceEvidence[];
  warnings: string[];
}
/** Version A starts from run.input.script; B from scriptSuggestion. Edits are local drafts. */
export interface LanguageResult { scriptSuggestion: string; notes: string[] }
/**
 * Wygeneruj opis: two separate proposals from the server-snapshotted saved script. Neither is
 * persisted until explicitly applied per field.
 */
export interface PublicationResult {
  publicationDescriptionSuggestion: string;
  publicationHashtagsSuggestion: string;
  /**
   * v3 only. `saved_material`: grounded in the Reel's own saved input; `web_search`: the bounded
   * fallback found quoted support; `script_only`: no reliable supporting material was found.
   */
  publicationGrounding?: 'saved_material' | 'web_search' | 'script_only';
  /**
   * v3 only. Evidence for the proposal, never inserted into the copy. Every URL is the saved
   * link or a provider-returned search result the worker actually retrieved.
   */
  publicationSources?: Array<{
    id: string; url: string; title: string; origin: 'saved_link' | 'google_search';
    retrievedAt: IsoDateTime; providerReference: string | null;
  }>;
}
/** Zero to three candidates; an empty result never mutates Reel programme state. */
export interface ProgrammeResult { candidates: ProgrammeMatch[] }
export interface AiResultMap {
  develop: DevelopResult;
  generate_hooks: { hookAdditions: string[] };
  fact_check: FactCheckResult;
  language_check: LanguageResult;
  find_programme: ProgrammeResult;
  generate_publication: PublicationResult;
}
export interface StartAiRunRequest extends MutationContext { action: AiAction }
export interface AiRunBase {
  id: Id;
  /** CAPTURE-DRAFT-01: 'capture' for the automatic draft queued by capture; legacy rows are 'user'. */
  trigger: 'user' | 'capture';
  reelId: Id;
  state: AiJobState;
  input: AiInputSnapshot;
  inputHash: string;
  isStale: boolean;
  model: string;
  promptId: string;
  promptStage: 'diagnostic' | 'development_provisional' | 'editorial_approved';
  requestedBy: Id;
  createdAt: IsoDateTime;
  completedAt: IsoDateTime | null;
  appliedHookIds: Id[];
  warnings: string[];
  error: ApiError | null;
}
export type AiRun = {
  [A in AiAction]: AiRunBase & { action: A; result: AiResultMap[A] | null }
}[AiAction];
export type ApplyAiRequest = MutationContext & (
  | { selection: 'title'; text: string }
  | { selection: 'script'; text: string }
  | { selection: 'priority'; priority: Priority }
  /** Publication selections apply only generate_publication runs, never legacy develop runs. */
  | { selection: 'publication_description'; text: string; replaceCurrentValue: string; confirmReplacement: true }
  | { selection: 'publication_hashtags'; text: string; replaceCurrentValue: string; confirmReplacement: true }
  | { selection: 'programme_match'; candidateId: Id }
  | { selection: 'programme_no_match' }
  | { selection: 'fact_correction'; claimId: Id }
  /** Whole-script replacement with the current edited version, guarded against the run snapshot. */
  | { selection: 'language_version'; version: 'A' | 'B'; text: string }
);
export type ErrorCode =
  | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION_ERROR'
  | 'RATE_LIMITED'
  | 'EDIT_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'EXPORT_CHANGED'
  | 'FEED_COVER_REQUIRED'
  | 'EDITOR_REQUIRED'
  | 'STALE_FACT_CLAIM'
  | 'STALE_LANGUAGE_RESULT'
  | 'STALE_PUBLICATION_RESULT'
  | 'SOURCE_UNSUPPORTED' | 'SOURCE_UNAVAILABLE' | 'SOURCE_ACCESS_DENIED'
  | 'SOURCE_TOO_LARGE' | 'SOURCE_TEXT_TOO_LONG' | 'SOURCE_TEXT_UNAVAILABLE'
  | 'UPLOAD_INCOMPLETE' | 'UNSUPPORTED_INPUT' | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_ACCESS_DENIED' | 'PROVIDER_RESOURCE_MISSING'
  | 'INVALID_AI_RESULT' | 'INSUFFICIENT_EVIDENCE' | 'INTERNAL_ERROR';
export interface ApiError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  currentVersion?: number;
  details?: Record<string, unknown>;
}
export interface ErrorResponse { error: ApiError }

/**
 * STREAM-LIVE-01: live messages during a broadcast. Both users send them from "Na żywo";
 * the streaming PC reads them with a `live_feed` access key and reports their status.
 */
export type LiveMessageKind = 'quote' | 'signal' | 'signal_cancel';
/** `urgent` = "Pilnie chcę coś powiedzieć", `moment` = "Gdy będzie chwila". */
export type LiveSignalLevel = 'urgent' | 'moment';
export type LiveMessageStatus = 'sent' | 'delivered' | 'waiting' | 'shown' | 'dismissed' | 'seen' | 'expired' | 'replaced';
export interface LiveMessage {
  id: Id;
  kind: LiveMessageKind;
  /** Quote only: 1–400 characters. */
  text: string | null;
  /** Quote only: up to 120 characters; null when not given. */
  source: string | null;
  /** Signal only. */
  level: LiveSignalLevel | null;
  status: LiveMessageStatus;
  /** Null while `sent`. */
  statusAt: IsoDateTime | null;
  createdAt: IsoDateTime;
}
/** POST /live/messages. Idempotent on operationId; no expectedVersion (nothing is edited). */
export interface CreateLiveMessageRequest {
  operationId: Id;
  kind: LiveMessageKind;
  text?: string;
  source?: string;
  level?: LiveSignalLevel;
}
/** GET /live/messages/mine: the caller's own most recent messages, newest first. */
export interface LiveMessageListResponse { items: LiveMessage[] }
/** Device feed item: every author's message, oldest first. */
export interface LiveFeedItem extends LiveMessage { authorName: User['name'] }
/**
 * GET /live/feed?after=<cursor>. Without `after`, returns no items and the current cursor, so a
 * newly started reader begins at "now" instead of replaying earlier broadcasts.
 */
export interface LiveFeedResponse { items: LiveFeedItem[]; cursor: string }
/** POST /live/status. Same status again is a no-op; disallowed transitions are 422. */
export interface LiveStatusRequest { id: Id; status: Exclude<LiveMessageStatus, 'sent'> }

/**
 * STREAM-PLAN-01: the stream screen, set up per broadcast and separate from Reels. A plan holds
 * up to eight topics (picked from recent Reels or typed), each with a main link, extra links and
 * points to go through; the Social Stream Ninja session whose dock both users use to highlight
 * comments; and whether it is the plan StreamControl on the streaming PC imports.
 */
// Limits (API-enforced; they match StreamControl's agenda): plan title 1–120; at most 8 topics;
// topic title 1–180; main link plus at most 11 extra links, each a full http(s) link ≤ 2000 with a
// label ≤ 120; at most 12 points of ≤ 200 characters.
export interface StreamPlanLink { url: string; label: string }
export interface StreamPlanTopic {
  /** Client-generated, stable across edits. */
  id: Id;
  /** The Reel this topic was picked from, read live; null for a topic typed by hand. */
  reelId: Id | null;
  /** The broadcast title shown on screen; 1–180 characters. */
  title: string;
  mainLink: string | null;
  extraLinks: StreamPlanLink[];
  /** What to go through, in order. */
  points: string[];
}
/** Live state of a topic's Reel; null when the topic has no Reel or it no longer exists. */
export interface StreamPlanTopicReel { id: Id; status: ReelStatus; deleted: boolean }
export interface StreamPlanTopicView extends StreamPlanTopic { reel: StreamPlanTopicReel | null }
export interface StreamPlan {
  id: Id;
  title: string;
  scheduledFor: IsoDate | null;
  commentsSession: string | null;
  isCurrent: boolean;
  topics: StreamPlanTopicView[];
  version: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
export interface StreamPlanSummary {
  id: Id;
  title: string;
  scheduledFor: IsoDate | null;
  isCurrent: boolean;
  topicCount: number;
  updatedAt: IsoDateTime;
}
/** GET /stream-plans: active plans, latest date first (undated after dated). */
export interface StreamPlanListResponse { items: StreamPlanSummary[] }
/** POST /stream-plans. Idempotent on operationId. */
export interface CreateStreamPlanRequest { operationId: Id; id: Id; title: string; scheduledFor?: IsoDate | null }
/** PUT /stream-plans/:id — the whole editable document, version-checked. */
export interface UpdateStreamPlanRequest {
  operationId: Id;
  expectedVersion: number;
  title: string;
  scheduledFor: IsoDate | null;
  commentsSession: string | null;
  topics: StreamPlanTopic[];
}
/** PUT /stream-plans/:id/current — mark (or unmark) the plan StreamControl imports. */
export interface StreamPlanCurrentRequest { operationId: Id; expectedVersion: number; current: boolean }
/** DELETE /stream-plans/:id */
export interface DeleteStreamPlanRequest { operationId: Id; expectedVersion: number }
/** GET /stream-plans/candidates?q= — recent Reels to pick topics from, newest first. */
export interface StreamPlanCandidate extends Omit<StreamTopicCandidate, 'inThisStream'> { sourceLink: string | null }
export interface StreamPlanCandidatesResponse { items: StreamPlanCandidate[] }
/** GET /live/stream (live_feed key): the current plan for StreamControl to import. */
export interface LiveStreamPlan {
  id: Id;
  title: string;
  scheduledFor: IsoDate | null;
  version: number;
  updatedAt: IsoDateTime;
  /** Broadcast content only: no Reel IDs or Reel data reach the device. */
  topics: Array<Omit<StreamPlanTopic, 'reelId'>>;
}
export interface LiveStreamPlanResponse { plan: LiveStreamPlan | null }

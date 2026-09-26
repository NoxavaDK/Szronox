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
export interface Meme {
  id: Id;
  name: string;
  thumbnailRef: string | null;
  assetRef: string;
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
  purpose: 'input' | 'source' | 'material';
  kind: 'url' | 'image';
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
  /** Required production deliverable; SQL feed_cover_done NOT NULL DEFAULT false. */
  feedCoverDone: boolean;
  /**
   * CONTENT-PLANNER-01: the one current publication plan, local calendar date `YYYY-MM-DD`,
   * or null when unplanned. Planning never changes `status`.
   */
  plannedPublicationDate: IsoDate | null;
  /** Optional part of the day; only ever set together with a date. */
  plannedPublicationSlot: PublicationSlot | null;
  createdBy: Id;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  deletedAt: IsoDateTime | null;
}
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
}
export interface ReelPatchRequest extends MutationContext {
  changes: Partial<Pick<Reel,
    'title' | 'status' | 'priority' | 'inputNote' | 'script' | 'editingNotes' |
    'editorId' | 'publishedAt' | 'publicationUrls' | 'publicationDescription' |
    'publicationHashtags' | 'feedCoverDone' | 'plannedPublicationDate' | 'plannedPublicationSlot'>>;
}
export interface AddHookRequest extends MutationContext { text: string; position?: number }
export interface EditHookRequest extends MutationContext { text: string }
export type RemoveHookRequest = MutationContext;
/** Explicit selection; null clears it. The server resolves the hook within the same Reel. */
export interface SelectHookRequest extends MutationContext { hookId: Id | null }
/** The authoritative Reel after selection. */
export type SelectHookResponse = Reel;
export interface AttachMemeRequest extends MutationContext { memeId: Id }
export type DetachMemeRequest = MutationContext;
/** Validated private image asset; picker creation and attachment commit atomically. */
export interface CreateMemeRequest {
  operationId: Id;
  name: string;
  imageAssetId: Id;
  attachToReel?: { reelId: Id; expectedVersion: number };
}
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
  script: string;
  scriptRevision: number;
  /** PUBLICATION-02: new grounded publication runs; absent on legacy script-only runs. */
  publicationContextVersion?: 2;
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
export interface PublicationResult { publicationDescriptionSuggestion: string; publicationHashtagsSuggestion: string }
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

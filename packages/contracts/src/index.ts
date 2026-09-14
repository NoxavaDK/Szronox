/** T00 wire contracts. Editorial prompts and AI result composition are not frozen. */
export type Id = string;
export type IsoDateTime = string;
export type ReelStatus = 'idea' | 'to_record' | 'editing' | 'ready' | 'published';
export type Priority = 'urgent' | 'normal' | 'evergreen';
export interface MutationContext { operationId: Id; expectedVersion: number }
export interface User { id: Id; name: 'NOXAVA' | 'SZRON'; avatarUrl: string | null }
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
/** Authoritative evidence resolved from the indexed programme, never authored by AI. */
export interface ProgrammeCitation {
  documentVersionId: Id;
  proposalId: Id | null;
  chunkIds: Id[];
  category: string;
  proposal: string;
  excerpt: string;
  sourceTitle: string;
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
  editingNotes: string;
  editorId: Id | null;
  hooks: ReelHook[];
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
  url?: string;
  images: CaptureImageDescriptor[];
  originalShare?: OriginalSharedInput;
}
export interface CreateReelRequest {
  operationId: Id;
  reelId: Id;
  input: CaptureInput;
  initialHook?: string;
  priority?: Priority;
}
export interface ReelPatchRequest extends MutationContext {
  changes: Partial<Pick<Reel,
    'title' | 'status' | 'priority' | 'inputNote' | 'script' | 'editingNotes' |
    'editorId' | 'publishedAt' | 'publicationUrls' | 'publicationDescription' |
    'publicationHashtags' | 'feedCoverDone'>>;
}
export interface AddHookRequest extends MutationContext { text: string; position?: number }
export interface EditHookRequest extends MutationContext { text: string }
export type RemoveHookRequest = MutationContext;
export interface AttachMemeRequest extends MutationContext { memeId: Id }
export interface ReplaceExportRequest extends MutationContext {
  export: Omit<ExportReference, 'revision'>;
}
/** Requires a valid selected editor; the actor must be the other allowlisted user. */
export interface VerifyExportRequest extends MutationContext { exportRevision: number }
/** Explicit Odłącz: clear the programme association without starting search. */
export type DetachProgrammeRequest = MutationContext;
export type AiAction = 'develop' | 'generate_hooks' | 'fact_check' | 'language_check' | 'find_programme';
export type AiJobState = 'queued' | 'running' | 'succeeded' | 'failed';
export interface AiInputSnapshot {
  reelVersion: number;
  script: string;
  hooks: Array<Pick<ReelHook, 'id' | 'text' | 'source' | 'position'>>;
  inputNote: string;
  attachments: AttachmentReference[];
  priority: Priority;
  attachedMemeIds: Id[];
  memeCandidateIds: Id[];
  programmeDocumentVersionId: Id | null;
}
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
export interface LanguageResult { scriptSuggestion: string; notes: string[] }
/** Zero to three candidates; an empty result never mutates Reel programme state. */
export interface ProgrammeResult { candidates: ProgrammeMatch[] }
export interface AiResultMap {
  develop: DevelopResult;
  generate_hooks: { hookAdditions: string[] };
  fact_check: FactCheckResult;
  language_check: LanguageResult;
  find_programme: ProgrammeResult;
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
  promptStage: 'diagnostic' | 'editorial_approved';
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
  | { selection: 'programme_match'; candidateId: Id }
  | { selection: 'programme_no_match' }
  | { selection: 'fact_correction'; claimId: Id }
);
export type ErrorCode =
  | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION_ERROR'
  | 'EDIT_CONFLICT' | 'IDEMPOTENCY_CONFLICT' | 'EXPORT_CHANGED'
  | 'FEED_COVER_REQUIRED'
  | 'EDITOR_REQUIRED'
  | 'STALE_FACT_CLAIM'
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

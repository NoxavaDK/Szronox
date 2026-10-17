import type {
  AddHookRequest, AttachmentReference, CompleteAttachmentRequest, CreateReelRequest, EditHookRequest,
  AiAction, AiRun, ApplyAiRequest, AttachMemeRequest, CreateMemeRequest, Meme, StartAiRunRequest,
  ErrorResponse, InitiateAttachmentRequest, InitiateAttachmentResponse, Reel, ReelListQuery,
  ReelPatchRequest, RemoveHookRequest, RenewAttachmentUploadResponse, ReplaceExportRequest,
  SourceMetadata,
  SelectHookRequest, SelectHookResponse, KdriveFolderRequest, KdriveFolderResponse, KdriveFolderState,
  UploadTransport, User, VerifyExportRequest, KdriveUploadStartRequest, KdriveUploadStartResponse,
  KdriveUploadState, AttachKdriveUploadRequest,
  CreateLiveMessageRequest, LiveMessage, LiveMessageListResponse,
  AddStreamTopicRequest, RemoveStreamTopicRequest, StreamTopicOrderRequest,
  StreamTopicPatchRequest, StreamTopicCandidatesResponse,
  CreateStreamPlanRequest, DeleteStreamPlanRequest, StreamPlan, StreamPlanCandidatesResponse,
  StreamPlanCurrentRequest, StreamPlanListResponse, UpdateStreamPlanRequest, StreamPlanLiveResponse, CueStreamPlanRequest,
} from '../../../../packages/contracts/src/index.js';
import { ClientApiError } from './errors.js';

/**
 * What the transport needs to know at the moment a request is dispatched.
 *
 * Captured as one value rather than read field by field, so a sign-out happening
 * mid-request cannot leave a response half-attributed: the generation that was
 * current at dispatch is compared against the generation current at arrival.
 */
export interface RequestContext {
  generation: number;
  /** Server-confirmed identity. Null means no request may be dispatched at all. */
  actorId: string | null;
  csrfToken: string | null;
  signal: AbortSignal;
}

export interface SessionSource { context(): RequestContext }

/**
 * A response that arrived after the active account changed.
 *
 * Thrown rather than returned so no caller can accidentally apply it. It is not a
 * failure of the request — the request may well have succeeded on the server — it
 * is a statement that its result belongs to an account that is no longer active.
 */
/**
 * Same-origin address of a stored, validated attachment's bytes (VPS-02 content route). The
 * browser's session cookie authenticates it, so it works directly as an `<img src>` or a link.
 */
export function attachmentContentUrl(reelId: string, attachmentId: string): string {
  return `/api/v1/reels/${encodeURIComponent(reelId)}/attachments/${encodeURIComponent(attachmentId)}/content`;
}

export class StaleResponseError extends Error {
  constructor(readonly dispatchedIn: number, readonly currentGeneration: number) {
    super('Response belongs to a previous session generation');
    this.name = 'StaleResponseError';
  }
}

export interface ReelPage { items: Reel[]; nextCursor: string | null }
export interface MeResponse { user: User; peer: User | null }

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class CoreApiClient {
  constructor(private readonly session: SessionSource, private readonly baseUrl = '/api/v1') {}

  /**
   * `absolutePath` is for the upload ticket's own path, which the server already
   * issued complete with the `/api/v1` prefix. Prefixing it again would produce a
   * doubled path, and rewriting the server's path would be worse: the ticket is bound
   * to that exact reel and attachment.
   */
  private async request<T>(
    path: string,
    init: RequestInit = {},
    options: { absolutePath?: boolean } = {},
  ): Promise<T> {
    const context = this.session.context();
    // No confirmed identity means no request. This is what keeps queued work from
    // being flushed against whichever account happens to log in next.
    if (context.actorId === null) {
      throw new ClientApiError(401, { code: 'UNAUTHENTICATED', message: 'No confirmed session', retryable: false });
    }

    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    };
    if (UNSAFE.has(method)) {
      if (context.csrfToken === null) {
        throw new ClientApiError(401, { code: 'UNAUTHENTICATED', message: 'No CSRF token', retryable: false });
      }
      headers['X-CSRF-Token'] = context.csrfToken;
    }

    const response = await fetch(options.absolutePath ? path : `${this.baseUrl}${path}`, {
      ...init,
      // The session cookie is attached by the browser. Nothing here reads it, and
      // no Authorization header is ever sent.
      credentials: 'same-origin',
      signal: init.signal ?? context.signal,
      headers,
    });

    // Checked before the body is read, so a stale result is never parsed into
    // something a caller could mistake for current state.
    const current = this.session.context();
    if (current.generation !== context.generation) {
      throw new StaleResponseError(context.generation, current.generation);
    }

    if (!response.ok) {
      let envelope: ErrorResponse = {
        error: {
          code: response.status === 429 ? 'RATE_LIMITED' : 'INTERNAL_ERROR',
          message: `HTTP ${response.status}`,
          retryable: response.status >= 500 || response.status === 429,
        },
      };
      try { envelope = await response.json() as ErrorResponse; } catch { /* use safe envelope */ }
      throw new ClientApiError(response.status, envelope.error);
    }

    // 204 carries no body; parsing it as JSON would throw on a successful call.
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  me = () => this.request<MeResponse>('/me');
  /** STREAM-LIVE-01. Idempotent on operationId, so a retry after a dropped response is safe. */
  sendLiveMessage = (body: CreateLiveMessageRequest) => this.request<LiveMessage>('/live/messages', { method: 'POST', body: JSON.stringify(body) });
  myLiveMessages = () => this.request<LiveMessageListResponse>('/live/messages/mine');
  /** STREAM-PLAN-01: stream plans, separate from Reels. Writes are version-checked and idempotent. */
  streamPlans = () => this.request<StreamPlanListResponse>('/stream-plans');
  streamPlan = (id: string) => this.request<StreamPlan>(`/stream-plans/${encodeURIComponent(id)}`);
  createStreamPlan = (body: CreateStreamPlanRequest) => this.request<StreamPlan>('/stream-plans', { method: 'POST', body: JSON.stringify(body) });
  updateStreamPlan = (id: string, body: UpdateStreamPlanRequest) => this.request<StreamPlan>(`/stream-plans/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
  setCurrentStreamPlan = (id: string, body: StreamPlanCurrentRequest) => this.request<StreamPlan>(`/stream-plans/${encodeURIComponent(id)}/current`, { method: 'PUT', body: JSON.stringify(body) });
  deleteStreamPlan = (id: string, body: DeleteStreamPlanRequest) => this.request<{ id: string }>(`/stream-plans/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify(body) });
  streamPlanLive = (id: string) => this.request<StreamPlanLiveResponse>(`/stream-plans/${encodeURIComponent(id)}/live`);
  cueStreamPlan = (id: string, body: CueStreamPlanRequest) => this.request<StreamPlanLiveResponse>(`/stream-plans/${encodeURIComponent(id)}/cue`, { method: 'PUT', body: JSON.stringify(body) });
  streamPlanCandidates = (q: string) => this.request<StreamPlanCandidatesResponse>(`/stream-plans/candidates${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
  list(query: ReelListQuery & { limit?: number } = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    return this.request<ReelPage>(`/reels${params.size ? `?${params}` : ''}`);
  }
  /** `includeDeleted` is an explicit opt-in so the restore view can load a deleted Reel. */
  reel = (id: string, options: { includeDeleted?: boolean } = {}) =>
    this.request<Reel>(`/reels/${encodeURIComponent(id)}${options.includeDeleted ? '?includeDeleted=true' : ''}`);
  create = (body: CreateReelRequest) => this.request<Reel>('/reels', { method: 'POST', body: JSON.stringify(body) });
  patch = (id: string, body: ReelPatchRequest) => this.request<Reel>(`/reels/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
  refreshSourceMetadata = (id: string, operationId: string) => this.request<{ sourceMetadata: SourceMetadata }>(`/reels/${encodeURIComponent(id)}/source-metadata/refresh`, { method: 'POST', body: JSON.stringify({ operationId }) });
  addHook = (id: string, body: AddHookRequest) => this.request<Reel>(`/reels/${id}/hooks`, { method: 'POST', body: JSON.stringify(body) });
  editHook = (id: string, hookId: string, body: EditHookRequest) => this.request<Reel>(`/reels/${id}/hooks/${hookId}`, { method: 'PATCH', body: JSON.stringify(body) });
  removeHook = (id: string, hookId: string, body: RemoveHookRequest) => this.request<Reel>(`/reels/${id}/hooks/${hookId}`, { method: 'DELETE', body: JSON.stringify(body) });
  selectHook = (id: string, body: SelectHookRequest) => this.request<SelectHookResponse>(`/reels/${id}/selected-hook`, { method: 'PUT', body: JSON.stringify(body) });
  remove = (id: string, body: RemoveHookRequest) => this.request<Reel>(`/reels/${id}/delete`, { method: 'POST', body: JSON.stringify(body) });
  restore = (id: string, body: RemoveHookRequest) => this.request<Reel>(`/reels/${id}/restore`, { method: 'POST', body: JSON.stringify(body) });
  replaceExport = (id: string, body: ReplaceExportRequest) => this.request<Reel>(`/reels/${id}/current-export`, { method: 'POST', body: JSON.stringify(body) });
  verifyExport = (id: string, body: VerifyExportRequest) => this.request<Reel>(`/reels/${id}/verification`, { method: 'POST', body: JSON.stringify(body) });
  /** KDRIVE-01: resolve the stored folder, or explicitly create/link one. */
  kdriveFolder = (id: string) => this.request<KdriveFolderState>(`/reels/${encodeURIComponent(id)}/kdrive-folder`);
  commandKdriveFolder = (id: string, body: KdriveFolderRequest) => this.request<KdriveFolderResponse>(`/reels/${encodeURIComponent(id)}/kdrive-folder`, { method: 'POST', body: JSON.stringify(body) });
  startKdriveUpload = (id: string, body: KdriveUploadStartRequest) => this.request<KdriveUploadStartResponse>(`/reels/${encodeURIComponent(id)}/kdrive-uploads`, { method: 'POST', body: JSON.stringify(body) });
  openKdriveUploads = (id: string) => this.request<KdriveUploadState[]>(`/reels/${encodeURIComponent(id)}/kdrive-uploads?state=open`);
  sendKdriveChunk = (uploadId: string, index: number, bytes: Blob, signal?: AbortSignal) => this.request<void>(`/kdrive-uploads/${encodeURIComponent(uploadId)}/chunks/${index}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes, ...(signal ? { signal } : {}) });
  finishKdriveUpload = (uploadId: string) => this.request<KdriveUploadState>(`/kdrive-uploads/${encodeURIComponent(uploadId)}/finish`, { method: 'POST', body: JSON.stringify({}) });
  attachKdriveUpload = (uploadId: string, body: AttachKdriveUploadRequest) => this.request<Reel>(`/kdrive-uploads/${encodeURIComponent(uploadId)}/attach`, { method: 'POST', body: JSON.stringify(body) });
  cancelKdriveUpload = (uploadId: string) => this.request<void>(`/kdrive-uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE' });

  aiCapabilities = () => this.request<{ enabled: boolean; programmeIndexed: boolean }>('/ai/capabilities');
  startAi = (id: string, body: StartAiRunRequest) => this.request<{ id: string; state: 'queued' }>(`/reels/${id}/ai-runs`, { method: 'POST', body: JSON.stringify(body) });
  latestAi = (id: string, action?: AiAction) => this.request<{ run: AiRun | null }>(`/reels/${id}/ai-runs/latest${action ? `?action=${action}` : ''}`);
  aiRun = (id: string) => this.request<AiRun>(`/ai-runs/${id}`);
  applyAi = (id: string, body: ApplyAiRequest) => this.request<Reel>(`/ai-runs/${id}/apply`, { method: 'POST', body: JSON.stringify(body) });
  memes = (query = '') => this.request<{ items: Meme[] }>(`/memes?q=${encodeURIComponent(query)}`);
  createMeme = (body: CreateMemeRequest) => this.request<{ meme: Meme; reel: Reel | null }>('/memes', { method: 'POST', body: JSON.stringify(body) });
  retryMemeCopy = (memeId: string, body: { operationId: string }) => this.request<Meme>(`/memes/${encodeURIComponent(memeId)}/kdrive-copy/retry`, { method: 'POST', body: JSON.stringify(body) });
  attachMeme = (reelId: string, body: AttachMemeRequest) => this.request<Reel>(`/reels/${reelId}/memes`, { method: 'POST', body: JSON.stringify(body) });
  detachMeme = (reelId: string, memeId: string, body: { operationId: string; expectedVersion: number }) => this.request<Reel>(`/reels/${reelId}/memes/${memeId}`, { method: 'DELETE', body: JSON.stringify(body) });
  detachProgramme = (reelId: string, body: { operationId: string; expectedVersion: number }) => this.request<Reel>(`/reels/${reelId}/programme-association`, { method: 'DELETE', body: JSON.stringify(body) });

  // ── STREAM-01: topics ───────────────────────────────────────────────────

  addStreamTopic = (streamId: string, body: AddStreamTopicRequest) =>
    this.request<Reel>(`/reels/${encodeURIComponent(streamId)}/topics`, { method: 'POST', body: JSON.stringify(body) });
  patchStreamTopic = (streamId: string, topicId: string, body: StreamTopicPatchRequest) =>
    this.request<Reel>(`/reels/${encodeURIComponent(streamId)}/topics/${encodeURIComponent(topicId)}`, { method: 'PATCH', body: JSON.stringify(body) });
  removeStreamTopic = (streamId: string, topicId: string, body: RemoveStreamTopicRequest) =>
    this.request<Reel>(`/reels/${encodeURIComponent(streamId)}/topics/${encodeURIComponent(topicId)}`, { method: 'DELETE', body: JSON.stringify(body) });
  reorderStreamTopics = (streamId: string, body: StreamTopicOrderRequest) =>
    this.request<Reel>(`/reels/${encodeURIComponent(streamId)}/topic-order`, { method: 'PUT', body: JSON.stringify(body) });
  streamTopicCandidates = (streamId: string, q = '') =>
    this.request<StreamTopicCandidatesResponse>(`/reels/${encodeURIComponent(streamId)}/topic-candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`);

  // ── Private attachment transport ───────────────────────────────────────────
  //
  // Three separate operations rather than one upload call, because the server treats
  // them as three: initiation reserves an id and a ticket, the PUT moves bytes, and
  // only completion acknowledges. Collapsing them would hide the one boundary the
  // client must respect — a transferred byte is not an acknowledged attachment.

  initiateAttachment = (reelId: string, body: InitiateAttachmentRequest) =>
    this.request<InitiateAttachmentResponse>(
      `/reels/${encodeURIComponent(reelId)}/attachments/initiate`,
      { method: 'POST', body: JSON.stringify(body) },
    );

  /** Renews transport only. It creates no attachment and changes no version history. */
  renewAttachmentUpload = (reelId: string, attachmentId: string) =>
    this.request<RenewAttachmentUploadResponse>(
      `/reels/${encodeURIComponent(reelId)}/attachments/${encodeURIComponent(attachmentId)}/upload-authorization`,
      { method: 'POST', body: JSON.stringify({}) },
    );

  completeAttachment = (reelId: string, attachmentId: string, body: CompleteAttachmentRequest) =>
    this.request<AttachmentReference>(
      `/reels/${encodeURIComponent(reelId)}/attachments/${encodeURIComponent(attachmentId)}/complete`,
      { method: 'POST', body: JSON.stringify(body) },
    );

  /**
   * Raw bytes, on the server's own upload path.
   *
   * `path` is an already-validated same-origin path, not a URL: the caller checks the
   * origin before this method attaches the session cookie and the CSRF token. The
   * blob is passed straight to `fetch` so the browser streams it rather than the page
   * copying a large image into a string first.
   *
   * It goes through the same `request` funnel as every other call, so it inherits the
   * CSRF header, the same-origin credential mode, the abort signal and the stale
   * generation check, and returns nothing because the server answers 204.
   */
  uploadAttachmentContent = (
    path: string,
    blob: Blob,
    options: { method: UploadTransport['method']; headers: Record<string, string> },
  ) => this.request<void>(path, {
    method: options.method,
    // Not JSON: `request` only sets a JSON content type when it was not given one.
    headers: options.headers,
    body: blob,
  }, { absolutePath: true });
}

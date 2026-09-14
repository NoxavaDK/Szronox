import type {
  AddHookRequest, CreateReelRequest, EditHookRequest, ErrorResponse, Reel, ReelListQuery,
  ReelPatchRequest, RemoveHookRequest, ReplaceExportRequest, User, VerifyExportRequest,
} from '../../../../packages/contracts/src/index.js';
import { ClientApiError } from './errors.js';

export interface AccessTokenSource { getAccessToken(): Promise<string | null> }
export interface ReelPage { items: Reel[]; nextCursor: string | null }
export interface MeResponse { user: User; peer: User | null }

export class CoreApiClient {
  constructor(private readonly tokens: AccessTokenSource, private readonly baseUrl = '/api/v1') {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.tokens.getAccessToken();
    if (!token) throw new ClientApiError(401, { code: 'UNAUTHENTICATED', message: 'No session', retryable: false });
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
    if (!response.ok) {
      let envelope: ErrorResponse = { error: { code: 'INTERNAL_ERROR', message: `HTTP ${response.status}`, retryable: response.status >= 500 } };
      try { envelope = await response.json() as ErrorResponse; } catch { /* use safe envelope */ }
      throw new ClientApiError(response.status, envelope.error);
    }
    return response.json() as Promise<T>;
  }

  me = () => this.request<MeResponse>('/me');
  list(query: ReelListQuery & { limit?: number } = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    return this.request<ReelPage>(`/reels${params.size ? `?${params}` : ''}`);
  }
  reel = (id: string) => this.request<Reel>(`/reels/${encodeURIComponent(id)}`);
  create = (body: CreateReelRequest) => this.request<Reel>('/reels', { method: 'POST', body: JSON.stringify(body) });
  patch = (id: string, body: ReelPatchRequest) => this.request<Reel>(`/reels/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
  addHook = (id: string, body: AddHookRequest) => this.request<Reel>(`/reels/${id}/hooks`, { method: 'POST', body: JSON.stringify(body) });
  editHook = (id: string, hookId: string, body: EditHookRequest) => this.request<Reel>(`/reels/${id}/hooks/${hookId}`, { method: 'PATCH', body: JSON.stringify(body) });
  removeHook = (id: string, hookId: string, body: RemoveHookRequest) => this.request<Reel>(`/reels/${id}/hooks/${hookId}`, { method: 'DELETE', body: JSON.stringify(body) });
  remove = (id: string, body: RemoveHookRequest) => this.request<Reel>(`/reels/${id}/delete`, { method: 'POST', body: JSON.stringify(body) });
  restore = (id: string, body: RemoveHookRequest) => this.request<Reel>(`/reels/${id}/restore`, { method: 'POST', body: JSON.stringify(body) });
  replaceExport = (id: string, body: ReplaceExportRequest) => this.request<Reel>(`/reels/${id}/current-export`, { method: 'POST', body: JSON.stringify(body) });
  verifyExport = (id: string, body: VerifyExportRequest) => this.request<Reel>(`/reels/${id}/verification`, { method: 'POST', body: JSON.stringify(body) });
}

import type {
  ApiError, CreateMonitorSourceRequest, CreateReelFromMonitorPostRequest, MonitorPost, MonitorPostListResponse,
  MonitorPlatform, MonitorReport, MonitorSource, MonitorSourceListResponse, MonitorSourcePatchRequest,
} from '../../../../packages/contracts/src/index.js';
import type { BrowserSession } from '../auth/session.js';
import { ClientApiError } from './errors.js';
import { StaleResponseError } from './api.js';

const UNSAFE = new Set(['POST', 'PATCH']);

export class MonitorApiClient {
  constructor(private readonly session: BrowserSession, private readonly baseUrl = '/api/v1') {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const context = this.session.context();
    if (context.actorId === null) {
      throw new ClientApiError(401, { code: 'UNAUTHENTICATED', message: 'No confirmed session', retryable: false });
    }
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    };
    if (UNSAFE.has(method)) {
      if (context.csrfToken === null) throw new ClientApiError(401, { code: 'UNAUTHENTICATED', message: 'No CSRF token', retryable: false });
      headers['X-CSRF-Token'] = context.csrfToken;
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init, credentials: 'same-origin', signal: init.signal ?? context.signal, headers,
    });
    const current = this.session.context();
    if (current.generation !== context.generation) throw new StaleResponseError(context.generation, current.generation);
    if (!response.ok) {
      let error: ApiError = { code: response.status === 429 ? 'RATE_LIMITED' : 'INTERNAL_ERROR', message: `HTTP ${response.status}`, retryable: response.status >= 500 };
      try { error = (await response.json() as { error: typeof error }).error; } catch { /* safe fallback */ }
      throw new ClientApiError(response.status, error);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  sources = () => this.request<MonitorSourceListResponse>('/monitor/sources');
  posts = (query: { date: string; before?: string; limit?: number }) => {
    const params = new URLSearchParams({ date: query.date, limit: String(query.limit ?? 100) });
    if (query.before) params.set('before', query.before);
    return this.request<MonitorPostListResponse>(`/monitor/posts?${params}`);
  };
  report = (date: string) => this.request<MonitorReport>(`/monitor/reports/${encodeURIComponent(date)}`);
  createSource = (body: CreateMonitorSourceRequest) =>
    this.request<MonitorSource>('/monitor/sources', { method: 'POST', body: JSON.stringify(body) });
  patchSource = (id: string, body: MonitorSourcePatchRequest) =>
    this.request<MonitorSource>(`/monitor/sources/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
  regenerateReport = (date: string, operationId: string) =>
    this.request<MonitorReport>(`/monitor/reports/${encodeURIComponent(date)}/regenerate`, {
      method: 'POST', body: JSON.stringify({ operationId }),
    });
  createReel = (postId: string, body: CreateReelFromMonitorPostRequest) =>
    this.request<{ id: string }>(`/monitor/posts/${encodeURIComponent(postId)}/reel`, { method: 'POST', body: JSON.stringify(body) });
}

export function warsawToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export type { MonitorPost, MonitorPlatform, MonitorReport, MonitorSource };

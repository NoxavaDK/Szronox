/**
 * The three authentication requests, and nothing else.
 *
 * Separate from `CoreApiClient` because these are the only requests that may run
 * without a confirmed session, and the only ones that carry a password. Keeping
 * them here means the domain client can refuse outright to dispatch before identity
 * is confirmed, with no exception carved out for login.
 *
 * `credentials: 'same-origin'` on every call: the session cookie is sent by the
 * browser and never handled by this code. No token is read, stored or attached.
 */

import type { AuthSessionResponse, ErrorResponse, User } from '../../../../packages/contracts/src/index.js';
import { ClientApiError } from '../data/errors.js';

export interface AuthTransportPort {
  login(name: User['name'], password: string): Promise<AuthSessionResponse>;
  session(): Promise<AuthSessionResponse>;
  logout(csrfToken: string): Promise<void>;
}

/** Fetch is injected so a test can drive the transport without a DOM. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function envelopeOf(response: Response): Promise<ClientApiError> {
  let envelope: ErrorResponse = {
    error: {
      code: response.status === 429 ? 'RATE_LIMITED' : 'INTERNAL_ERROR',
      message: `HTTP ${response.status}`,
      retryable: response.status >= 500 || response.status === 429,
    },
  };
  try {
    envelope = await response.json() as ErrorResponse;
  } catch { /* a non-JSON failure still yields a truthful generic envelope */ }
  return new ClientApiError(response.status, envelope.error);
}

export class AuthTransport implements AuthTransportPort {
  constructor(
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly baseUrl = '/api/v1',
  ) {}

  async login(name: User['name'], password: string): Promise<AuthSessionResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/auth/login`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password }),
    });
    if (!response.ok) throw await envelopeOf(response);
    return await response.json() as AuthSessionResponse;
  }

  async session(): Promise<AuthSessionResponse> {
    const response = await this.fetchImpl(`${this.baseUrl}/me`, {
      method: 'GET',
      credentials: 'same-origin',
      // A cached bootstrap could hand one account's identity to the other.
      cache: 'no-store',
    });
    if (!response.ok) throw await envelopeOf(response);
    return await response.json() as AuthSessionResponse;
  }

  async logout(csrfToken: string): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/auth/logout`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrfToken },
    });
    // 204, so there is no body to parse.
    if (!response.ok) throw await envelopeOf(response);
  }
}

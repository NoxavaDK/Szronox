/**
 * Browser session state.
 *
 * The browser holds no credential. The session secret lives in an HttpOnly cookie
 * the page cannot read, and everything this class keeps — the confirmed identity,
 * the expiry, the CSRF token — is in memory only. Nothing is written to
 * localStorage, sessionStorage, IndexedDB or a cache, so closing the tab leaves
 * nothing behind that could be replayed, and a reload re-derives the state from the
 * server rather than trusting anything local.
 *
 * Three distinctions this class exists to keep straight:
 *
 *   - "not logged in" and "could not reach the server" are different states. Only
 *     a 401 is confirmation that there is no session; a network failure leaves the
 *     status `unreachable`, which must not be shown as a logout and must never
 *     cause a local draft to be discarded.
 *   - Identity is the server's answer, never a local guess. `current()` is only
 *     non-null after the server confirmed it.
 *   - Work belongs to the generation it was dispatched in. Signing in or out
 *     increments the generation and aborts the previous one, so a response that
 *     was already in flight cannot land against the account that is now active.
 */

import type { AuthSessionResponse, User } from '../../../../packages/contracts/src/index.js';
import { ClientApiError } from '../data/errors.js';
import type { RequestContext, SessionSource } from '../data/api.js';
import { AuthTransport, type AuthTransportPort } from './transport.js';

export type AuthStatus =
  /** Nothing has been asked of the server yet. */
  | 'unknown'
  /** The server confirmed there is no session. */
  | 'anonymous'
  | 'authenticated'
  /** The server could not be reached. Recoverable, and not a logout. */
  | 'unreachable';

export interface AuthState {
  status: AuthStatus;
  session: AuthSessionResponse | null;
  generation: number;
}

type Listener = (state: AuthState) => void;

/** The interface VPS-00 pinned, provider-neutral by construction. */
export interface BrowserAuth extends SessionSource {
  current(): AuthSessionResponse | null;
  subscribe(listener: Listener): () => void;
  restore(): Promise<void>;
  signIn(name: User['name'], password: string): Promise<void>;
  signOut(): Promise<void>;
}

export class BrowserSession implements BrowserAuth {
  private status: AuthStatus = 'unknown';
  private session: AuthSessionResponse | null = null;
  private generation = 0;
  private controller = new AbortController();
  private readonly listeners = new Set<Listener>();
  private restoring: Promise<void> | null = null;

  constructor(private readonly transport: AuthTransportPort = new AuthTransport()) {}

  current(): AuthSessionResponse | null {
    return this.session;
  }

  state(): AuthState {
    return { status: this.status, session: this.session, generation: this.generation };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => { this.listeners.delete(listener); };
  }

  /**
   * What the domain client needs at dispatch time, captured as one value.
   *
   * `actorId` is null unless the server confirmed the identity, which is what stops
   * a request — or a queue flush — from being sent on the strength of a local guess.
   */
  context(): RequestContext {
    return {
      generation: this.generation,
      actorId: this.session?.user.id ?? null,
      csrfToken: this.session?.csrfToken ?? null,
      signal: this.controller.signal,
    };
  }

  private emit(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }

  /**
   * Start a new generation. Anything still in flight is aborted, and any response
   * that arrives anyway is stamped with the old generation and discarded by the
   * domain client.
   */
  private rotate(): void {
    this.controller.abort();
    this.controller = new AbortController();
    this.generation += 1;
  }

  private settle(status: AuthStatus, session: AuthSessionResponse | null): void {
    this.status = status;
    this.session = session;
    this.emit();
  }

  /**
   * Re-derive the session from the server. Single-flight, because a reload can
   * easily trigger this from several places at once and two bootstraps would race
   * to set the state.
   */
  restore(): Promise<void> {
    this.restoring ??= this.runRestore().finally(() => { this.restoring = null; });
    return this.restoring;
  }

  private async runRestore(): Promise<void> {
    const previous = this.session?.user.id ?? null;
    try {
      const session = await this.transport.session();
      // A restore that returns a different user than before is an account change,
      // not a refresh: the generation must move so nothing from the previous
      // account is applied to this one.
      if (previous !== null && previous !== session.user.id) this.rotate();
      this.settle('authenticated', session);
    } catch (error) {
      if (error instanceof ClientApiError && error.status === 401) {
        // Confirmed anonymous. Only here is the local state cleared.
        if (previous !== null) this.rotate();
        this.settle('anonymous', null);
        return;
      }
      // Unreachable, or a server fault. The previous session is kept as-is: a
      // failed request is not evidence that it ended.
      this.status = 'unreachable';
      this.emit();
    }
  }

  async signIn(name: User['name'], password: string): Promise<void> {
    const session = await this.transport.login(name, password);
    // Rotated even when the same account signs in again, because the server issued
    // a new session and revoked the old one; work dispatched under the old CSRF
    // token would now be refused anyway.
    this.rotate();
    this.settle('authenticated', session);
  }

  /**
   * Sign out.
   *
   * The server revocation is attempted first, and a 401 counts as success because
   * it means the session is already gone. The local state is dropped either way:
   * the user asked to stop working in this account, and in-memory state is not
   * authority. A failure is re-thrown so the caller can say that the server-side
   * session may still be live — it is never swallowed into a clean "logged out".
   */
  async signOut(): Promise<void> {
    const csrfToken = this.session?.csrfToken ?? null;
    let failure: unknown = null;
    try {
      if (csrfToken !== null) await this.transport.logout(csrfToken);
    } catch (error) {
      if (!(error instanceof ClientApiError) || error.status !== 401) failure = error;
    }
    this.rotate();
    this.settle('anonymous', null);
    if (failure !== null) throw failure;
  }
}

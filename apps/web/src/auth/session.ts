import type { User } from '../../../../packages/contracts/src/index.js';
import type { AccessTokenSource } from '../data/api.js';

export interface BrowserSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId: string;
}
export interface AuthState { session: BrowserSession; user: User | null }
type Listener = (state: AuthState | null) => void;
const KEY = 'szronox.supabase.session.v1';

/** Minimal browser adapter for Supabase GoTrue. It contains no service-role key and exposes no signup. */
export class SupabaseBrowserSession implements AccessTokenSource {
  private state: AuthState | null = null;
  private listeners = new Set<Listener>();
  private refreshing: Promise<void> | null = null;

  constructor(private readonly supabaseUrl: string, private readonly anonKey: string, private readonly storage: Storage = localStorage) {
    this.state = this.read();
  }
  current() { return this.state; }
  subscribe(listener: Listener) { this.listeners.add(listener); listener(this.state); return () => { this.listeners.delete(listener); }; }
  private emit() { for (const listener of this.listeners) listener(this.state); }
  private read(): AuthState | null {
    try {
      const value = JSON.parse(this.storage.getItem(KEY) ?? 'null') as AuthState | null;
      return value?.session?.userId ? value : null;
    } catch { return null; }
  }
  private write(state: AuthState | null) {
    this.state = state;
    if (state) this.storage.setItem(KEY, JSON.stringify(state)); else this.storage.removeItem(KEY);
    this.emit();
  }
  private async token(body: URLSearchParams): Promise<BrowserSession> {
    const response = await fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=${body.get('grant_type')}`, {
      method: 'POST', headers: { apikey: this.anonKey, 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    if (!response.ok) throw new Error('AUTH_FAILED');
    const value = await response.json() as { access_token: string; refresh_token: string; expires_in: number; user: { id: string } };
    return { accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: Date.now() + value.expires_in * 1000, userId: value.user.id };
  }
  async signIn(email: string, password: string) {
    const body = new URLSearchParams({ grant_type: 'password', email, password });
    const session = await this.token(body);
    this.write({ session, user: null });
    return session;
  }
  setUser(user: User) {
    if (!this.state || this.state.session.userId !== user.id) throw new Error('SESSION_USER_MISMATCH');
    this.write({ ...this.state, user });
  }
  signOut() { this.write(null); }
  async getAccessToken() {
    if (!this.state) return null;
    if (this.state.session.expiresAt > Date.now() + 30_000) return this.state.session.accessToken;
    if (!this.refreshing) this.refreshing = this.refresh().finally(() => { this.refreshing = null; });
    await this.refreshing;
    return this.state?.session.accessToken ?? null;
  }
  private async refresh() {
    if (!this.state) return;
    try {
      const session = await this.token(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.state.session.refreshToken }));
      this.write({ session, user: this.state.user });
    } catch { this.write(null); }
  }
}

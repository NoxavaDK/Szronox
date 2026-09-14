import { useState } from 'react';
import type { SupabaseBrowserSession } from './session.js';

export function Login({ auth, onSignedIn }: { auth: SupabaseBrowserSession; onSignedIn: () => Promise<void> }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await auth.signIn(email, password); await onSignedIn(); } catch { auth.signOut(); setError('Nie udało się zalogować. Sprawdź dane.'); } finally { setBusy(false); }
  }
  return <main className="auth-shell"><form className="auth-form" onSubmit={submit}><h1>SzroNox</h1><label>E-mail<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label><label>Hasło<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label><button type="submit" disabled={busy}>{busy ? 'Logowanie…' : 'Zaloguj się'}</button>{error ? <p role="alert">{error}</p> : null}</form></main>;
}

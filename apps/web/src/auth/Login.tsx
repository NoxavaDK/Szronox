import { useState } from 'react';
import type { User } from '../../../../packages/contracts/src/index.js';
import { ClientApiError, polishError } from '../data/errors.js';
import type { BrowserAuth } from './session.js';

/**
 * The login surface.
 *
 * It asks for an account, not an e-mail. There are exactly two accounts and they
 * are provisioned, so a free-text identifier field would only be a way to mistype
 * one of two known names — and the previous version's e-mail field existed solely
 * because GoTrue required one.
 *
 * No screen redesign: the same shell, the same Polish copy pattern, the same single
 * submit. The password field keeps `autoComplete="current-password"` so a password
 * manager still works, and the account name is a choice rather than an input.
 */
export function Login({ auth, onSignedIn }: { auth: BrowserAuth; onSignedIn: () => Promise<void> }) {
  const [name, setName] = useState<User['name']>('NOXAVA');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await auth.signIn(name, password);
      // Cleared as soon as it has been sent: there is no reason to keep it in a
      // React state tree afterwards.
      setPassword('');
      await onSignedIn();
    } catch (failure) {
      // The server answers one generic 401 for every credential failure, so this
      // copy must not imply which part was wrong. Throttling is reported as itself.
      setError(
        failure instanceof ClientApiError && failure.api.code === 'RATE_LIMITED'
          ? polishError(failure)
          : failure instanceof ClientApiError && failure.status === 401
            ? 'Nie udało się zalogować. Sprawdź dane.'
            : polishError(failure),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <form className="auth-form" onSubmit={submit}>
        <h1>SzroNox</h1>
        <fieldset className="auth-accounts">
          <legend>Konto</legend>
          {(['NOXAVA', 'SZRON'] as const).map((account) => (
            <label key={account}>
              <input
                type="radio"
                name="account"
                value={account}
                checked={name === account}
                onChange={() => setName(account)}
              />
              {account}
            </label>
          ))}
        </fieldset>
        <label>
          Hasło
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={busy}>{busy ? 'Logowanie…' : 'Zaloguj się'}</button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </main>
  );
}

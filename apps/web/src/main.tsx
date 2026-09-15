import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { App } from './app/App.js';
import { BrowserSession } from './auth/session.js';
import { AuthTransport } from './auth/transport.js';
import { CoreApiClient } from './data/api.js';
import { AttachmentRecovery } from './data/attachment-recovery.js';
import { DraftStore } from './drafts/store.js';
import { SyncQueue } from './drafts/queue.js';

/**
 * Composition root.
 *
 * No authentication configuration reaches the browser bundle. The API is same-origin,
 * so there is no URL to configure, and there is no anon key, project reference or
 * signing secret to hold — which is why the former `VITE_SUPABASE_*` variables are
 * gone rather than renamed.
 */
const auth = new BrowserSession(new AuthTransport());
const api = new CoreApiClient(auth);
const store = new DraftStore();
// The queue's account comes from the server-confirmed session, so a flush cannot be
// attributed to an account the server never acknowledged.
const queue = new SyncQueue(store, api, () => auth.current()?.user.id ?? null);
// Attachment recovery reads the active account from the same confirmed session, so a
// late upload result can never be acknowledged against the other account's partition.
const attachments = new AttachmentRecovery({
  api,
  store,
  activeAccountId: () => auth.current()?.user.id ?? null,
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App auth={auth} api={api} store={store} queue={queue} attachments={attachments} />
  </StrictMode>,
);

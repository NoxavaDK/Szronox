import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { App } from './app/App.js';
import { SupabaseBrowserSession } from './auth/session.js';
import { CoreApiClient } from './data/api.js';
import { DraftStore } from './drafts/store.js';
import { SyncQueue } from './drafts/queue.js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? '';
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY ?? '';
const auth = new SupabaseBrowserSession(supabaseUrl, anonKey);
const api = new CoreApiClient(auth);
const store = new DraftStore();
const queue = new SyncQueue(store, api, () => auth.current()?.session.userId ?? null);

createRoot(document.getElementById('root')!).render(<StrictMode><App auth={auth} api={api} store={store} queue={queue} /></StrictMode>);

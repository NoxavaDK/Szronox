import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CaptureImageDescriptor, Reel, ReelPatchRequest, ReelStatus, User } from '../../../../packages/contracts/src/index.js';
import type { AuthStatus, BrowserSession } from '../auth/session.js';
import type { CoreApiClient } from '../data/api.js';
import { ClientApiError, isAbandonedRequest, polishError } from '../data/errors.js';
import { composePublicationText } from '../data/publication.js';
import type { CaptureDraft, DraftStore, ReelDraft } from '../drafts/store.js';
import type { SyncQueue } from '../drafts/queue.js';

export type Route =
  | { name: 'list' }
  | { name: 'capture'; draftId: string }
  | { name: 'detail'; reelId: string }
  /** `Usunięte` — a secondary view, never a sixth status (frozen batch sec. 8). */
  | { name: 'deleted' };

/**
 * A 409 keeps the local draft and offers an explicit choice. Nothing is resolved
 * automatically and the local value is never discarded on arrival.
 */
export interface ConflictState {
  field: string;
  localValue: string;
  serverValue: string;
  changes: ReelPatchRequest['changes'];
  serverReel: Reel;
}
export interface CaptureForm {
  draft: CaptureDraft; kind: 'image' | 'url' | 'text'; blobs: Map<string, Blob>; showAdditional: boolean; showHook: boolean;
}

export function useAppController(auth: BrowserSession, api: CoreApiClient, store: DraftStore, queue: SyncQueue) {
  const [user, setUser] = useState<User | null>(auth.current()?.user ?? null);
  const [peer, setPeer] = useState<User | null>(auth.current()?.peer ?? null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>(auth.state().status);
  const [route, setRoute] = useState<Route>({ name: 'list' });
  const [status, setStatus] = useState<ReelStatus>('idea');
  const [reels, setReels] = useState<Reel[]>([]);
  const [current, setCurrent] = useState<Reel | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error' | 'offline'>('idle');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'offline' | 'conflict' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [capture, setCapture] = useState<CaptureForm | null>(null);
  const [deleted, setDeleted] = useState<Reel[]>([]);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const saveTimer = useRef<number>();
  const currentRef = useRef<Reel | null>(null);
  const pendingPatch = useRef<{ reelId: string; expectedVersion: number; changes: ReelPatchRequest['changes'] } | null>(null);
  useEffect(() => { currentRef.current = current; }, [current]);

  /**
   * Re-derive who we are from the server, then resume queued work.
   *
   * `restore()` asks the server; `api.me()` then confirms the identity through the
   * domain surface, which is the value every account-scoped read and write uses. The
   * queue is flushed only after that, so nothing pending is ever sent on the
   * strength of a remembered account.
   *
   * A failure is not a logout. `restore()` distinguishes a confirmed anonymous state
   * from an unreachable server, and only the former clears the session — so a draft
   * made offline survives a failed reconnection instead of being dropped.
   */
  const recover = useCallback(async () => {
    await auth.restore();
    const session = auth.current();
    if (!session) { setUser(null); setPeer(null); return; }
    try {
      const me = await api.me();
      setUser(me.user); setPeer(me.peer);
      await queue.flush();
    } catch (error) {
      if (isAbandonedRequest(error)) return;
      setMessage(polishError(error));
    }
  }, [api, auth, queue]);

  useEffect(() => auth.subscribe((state) => {
    setAuthStatus(state.status);
    setUser(state.session?.user ?? null);
    setPeer(state.session?.peer ?? null);
  }), [auth]);
  useEffect(() => { void recover(); const online = () => { void recover(); }; window.addEventListener('online', online); return () => window.removeEventListener('online', online); }, [recover]);

  /**
   * A read that was abandoned because the account changed leaves no trace: no list,
   * no error banner, no load state. Showing "could not load" for work the user
   * cancelled by switching accounts would be wrong twice over.
   */
  const reportLoadFailure = useCallback((error: unknown) => {
    if (isAbandonedRequest(error)) return;
    setLoadState(navigator.onLine ? 'error' : 'offline');
    setMessage(polishError(error));
  }, []);

  const loadList = useCallback(async () => {
    if (!user) return; setLoadState('loading');
    try { const page = await api.list({ status }); setReels(page.items); setLoadState('loaded'); }
    catch (error) { reportLoadFailure(error); }
  }, [api, reportLoadFailure, status, user]);
  useEffect(() => { if (route.name === 'list') void loadList(); }, [loadList, route.name]);

  const loadDeleted = useCallback(async () => {
    if (!user) return; setLoadState('loading');
    try { const page = await api.list({ visibility: 'deleted' }); setDeleted(page.items); setLoadState('loaded'); }
    catch (error) { reportLoadFailure(error); }
  }, [api, reportLoadFailure, user]);
  useEffect(() => { if (route.name === 'deleted') void loadDeleted(); }, [loadDeleted, route.name]);

  const openDetail = useCallback(async (reelId: string) => {
    setRoute({ name: 'detail', reelId }); setLoadState('loading');
    try {
      const reel = await api.reel(reelId, { includeDeleted: true });
      // Drafts are read for the account that is active now, and the id is part of
      // the key, so a draft can only ever be paired with its own account's Reel.
      const draft = user ? await store.reel(user.id, reelId) : undefined;
      setCurrent(draft ? { ...reel, ...draft.changes } : reel); setSaveState(draft ? 'offline' : 'idle'); setLoadState('loaded');
    } catch (error) { reportLoadFailure(error); }
  }, [api, reportLoadFailure, store, user]);

  const startCapture = useCallback(() => {
    if (!user) return; const reelId = crypto.randomUUID();
    const draft: CaptureDraft = { id: `${user.id}:${reelId}`, accountId: user.id, reelId, operationId: crypto.randomUUID(), input: { images: [] }, priority: 'normal', fileNames: {}, updatedAt: Date.now(), state: 'draft' };
    setCapture({ draft, kind: 'text', blobs: new Map(), showAdditional: false, showHook: false }); setRoute({ name: 'capture', draftId: reelId });
    void store.saveCapture(draft, new Map()).catch((e) => { setSaveState('error'); setMessage(polishError(e)); });
  }, [store, user]);
  const updateCapture = useCallback((change: (form: CaptureForm) => CaptureForm) => {
    setCapture((old) => {
      if (!old) return old; const next = change(old); next.draft.updatedAt = Date.now();
      void store.saveCapture(next.draft, next.blobs).then(() => setSaveState(navigator.onLine ? 'saved' : 'offline')).catch((e) => { setSaveState('error'); setMessage(polishError(e)); }); return next;
    });
  }, [store]);
  const addFiles = useCallback((files: FileList) => updateCapture((form) => {
    const images: CaptureImageDescriptor[] = []; const blobs = new Map(form.blobs); const fileNames = { ...form.draft.fileNames };
    for (const file of Array.from(files)) { const attachmentId = crypto.randomUUID(); images.push({ attachmentId, fileName: file.name, mimeType: file.type, byteSize: file.size }); blobs.set(attachmentId, file); fileNames[attachmentId] = file.name; }
    return { ...form, kind: 'image', blobs, draft: { ...form.draft, input: { ...form.draft.input, images: [...form.draft.input.images, ...images] }, fileNames } };
  }), [updateCapture]);
  const submitCapture = useCallback(async () => {
    if (!capture || !user) return; setSaveState('saving');
    try {
      await store.saveCapture({ ...capture.draft, state: 'queued' }, capture.blobs);
      await store.enqueue({ id: capture.draft.operationId, accountId: user.id, kind: 'create', reelId: capture.draft.reelId, createdAt: Date.now(), state: 'pending', payload: { operationId: capture.draft.operationId, reelId: capture.draft.reelId, input: capture.draft.input, initialHook: capture.draft.initialHook || undefined, priority: capture.draft.priority } });
      await queue.flush(); const remaining = await store.queue(user.id); const item = remaining.find((x) => x.id === capture.draft.operationId);
      if (item) { setSaveState(item.state === 'conflict' ? 'conflict' : navigator.onLine ? 'error' : 'offline'); return; }
      setSaveState('saved'); setCapture(null); setRoute({ name: 'list' });
    } catch (error) { if (isAbandonedRequest(error)) return; setSaveState('error'); setMessage(polishError(error)); }
  }, [capture, queue, store, user]);

  const changeReel = useCallback((changes: ReelPatchRequest['changes']) => {
    const reel = currentRef.current;
    if (!reel || !user) return;
    const pending = pendingPatch.current?.reelId === reel.id ? pendingPatch.current : { reelId: reel.id, expectedVersion: reel.version, changes: {} };
    pending.changes = { ...pending.changes, ...changes }; pendingPatch.current = pending;
    const next = { ...reel, ...changes }; currentRef.current = next; setCurrent(next); setSaveState('saving');
    const draft: ReelDraft = { id: `${user.id}:${reel.id}`, accountId: user.id, reelId: reel.id, expectedVersion: pending.expectedVersion, changes: pending.changes, updatedAt: Date.now() };
    void store.saveReel(draft).then(() => {
      window.clearTimeout(saveTimer.current); saveTimer.current = window.setTimeout(async () => {
        const sending = pendingPatch.current;
        if (!sending) return;
        pendingPatch.current = null;
        const request = { operationId: crypto.randomUUID(), expectedVersion: sending.expectedVersion, changes: sending.changes };
        try { const saved = await api.patch(sending.reelId, request); currentRef.current = saved; setCurrent(saved); await store.deleteReel(user.id, sending.reelId); setSaveState('saved'); }
        catch (error) {
          // Abandoned after an account switch: the draft stays in this account's
          // partition untouched, and nothing is queued or shown against the new one.
          if (isAbandonedRequest(error)) return;
          if (error instanceof ClientApiError && error.status === 409) {
            // Keep the draft, then read the authoritative value so the user is shown
            // a real comparison rather than "something changed".
            await store.saveReel({ ...draft, conflictSnapshot: error.api.details });
            setSaveState('conflict');
            try {
              const serverReel = await api.reel(sending.reelId);
              const field = Object.keys(sending.changes)[0] ?? 'title';
              const read = (source: Record<string, unknown>) => {
                const value = source[field];
                return Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? '' : String(value);
              };
              setConflict({
                field,
                localValue: read(sending.changes as Record<string, unknown>),
                serverValue: read(serverReel as unknown as Record<string, unknown>),
                changes: sending.changes,
                serverReel,
              });
            } catch { /* the conflict state alone is still truthful */ }
          }
          else { await store.enqueue({ id: request.operationId, accountId: user.id, kind: 'patch', reelId: sending.reelId, createdAt: Date.now(), state: 'pending', payload: request }); setSaveState(navigator.onLine ? 'error' : 'offline'); }
          setMessage(polishError(error));
        }
      }, 600);
    }).catch((error) => { setSaveState('error'); setMessage(polishError(error)); });
  }, [api, store, user]);

  const removeHook = useCallback(async (hookId: string) => {
    if (!current || !user) return; const request = { operationId: crypto.randomUUID(), expectedVersion: current.version }; setSaveState('saving');
    try { setCurrent(await api.removeHook(current.id, hookId, request)); setSaveState('saved'); }
    catch (error) { if (isAbandonedRequest(error)) return; await store.enqueue({ id: request.operationId, accountId: user.id, kind: 'remove-hook', reelId: current.id, createdAt: Date.now(), state: error instanceof ClientApiError && error.status === 409 ? 'conflict' : 'pending', payload: { hookId, request } }); setSaveState(error instanceof ClientApiError && error.status === 409 ? 'conflict' : 'offline'); setMessage(polishError(error)); }
  }, [api, current, store, user]);

  const deleteCurrent = useCallback(async () => {
    if (!current || !user) return;
    const request = { operationId: crypto.randomUUID(), expectedVersion: current.version }; setSaveState('saving');
    try { await api.remove(current.id, request); setCurrent(null); setRoute({ name: 'list' }); setSaveState('saved'); }
    catch (error) {
      if (isAbandonedRequest(error)) return;
      const conflict = error instanceof ClientApiError && error.status === 409;
      await store.enqueue({ id: request.operationId, accountId: user.id, kind: 'delete', reelId: current.id, createdAt: Date.now(), state: conflict ? 'conflict' : 'pending', payload: request });
      setSaveState(conflict ? 'conflict' : 'offline'); setMessage(polishError(error));
    }
  }, [api, current, store, user]);

  const restore = useCallback(async (reel: Reel) => {
    if (!user) return; const request = { operationId: crypto.randomUUID(), expectedVersion: reel.version };
    try { await api.restore(reel.id, request); setRoute({ name: 'list' }); }
    catch (error) {
      if (isAbandonedRequest(error)) return;
      const conflict = error instanceof ClientApiError && error.status === 409;
      await store.enqueue({ id: request.operationId, accountId: user.id, kind: 'restore', reelId: reel.id, createdAt: Date.now(), state: conflict ? 'conflict' : 'pending', payload: request }); setMessage(polishError(error));
    }
  }, [api, store, user]);

  /**
   * Explicit recovery. `local` retries the same edit against the current version;
   * `server` abandons the local edit. Neither happens without the user asking.
   */
  const resolveConflict = useCallback(async (choice: 'local' | 'server') => {
    const pending = conflict;
    if (!pending || !user) return;
    setConflict(null);
    if (choice === 'server') {
      currentRef.current = pending.serverReel; setCurrent(pending.serverReel);
      await store.deleteReel(user.id, pending.serverReel.id); setSaveState('idle'); return;
    }
    setSaveState('saving');
    try {
      const saved = await api.patch(pending.serverReel.id, {
        operationId: crypto.randomUUID(),
        expectedVersion: pending.serverReel.version,
        changes: pending.changes,
      });
      currentRef.current = saved; setCurrent(saved);
      await store.deleteReel(user.id, saved.id); setSaveState('saved');
    } catch (error) { if (isAbandonedRequest(error)) return; setSaveState('error'); setMessage(polishError(error)); }
  }, [api, conflict, store, user]);

  const replaceExport = useCallback(async (reference: { url: string; label: string }) => {
    const reel = currentRef.current;
    if (!reel) return; setSaveState('saving');
    try {
      const saved = await api.replaceExport(reel.id, {
        operationId: crypto.randomUUID(), expectedVersion: reel.version, export: reference,
      });
      currentRef.current = saved; setCurrent(saved); setSaveState('saved');
    } catch (error) { if (isAbandonedRequest(error)) return; setSaveState(error instanceof ClientApiError && error.status === 409 ? 'conflict' : 'error'); setMessage(polishError(error)); }
  }, [api]);

  const verifyExport = useCallback(async () => {
    const reel = currentRef.current;
    if (!reel || reel.currentExport === null) return; setSaveState('saving');
    try {
      const saved = await api.verifyExport(reel.id, {
        operationId: crypto.randomUUID(),
        expectedVersion: reel.version,
        exportRevision: reel.currentExport.revision,
      });
      currentRef.current = saved; setCurrent(saved); setSaveState('saved');
    } catch (error) { if (isAbandonedRequest(error)) return; setSaveState(error instanceof ClientApiError && error.status === 409 ? 'conflict' : 'error'); setMessage(polishError(error)); }
  }, [api]);

  const copyPublication = useCallback(async () => {
    if (!current) return; const { publicationDescription: description, publicationHashtags: hashtags } = current;
    const value = composePublicationText(description, hashtags);
    if (!value) { setMessage('Brak opisu i hashtagów do skopiowania.'); return; }
    try { if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE'); await navigator.clipboard.writeText(value); setMessage('Skopiowano opis.'); }
    catch { setMessage(`Nie udało się skopiować. Zaznacz i skopiuj ręcznie:\n\n${value}`); }
  }, [current]);

  /**
   * Drop everything this account had on screen.
   *
   * Only in-memory view state is cleared. Drafts, queued operations and blobs stay in
   * their own account's IndexedDB partition, so signing back in finds them exactly
   * where they were — and the other account never sees them, because the partition
   * key is the account id.
   */
  const clearAccountView = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    pendingPatch.current = null;
    currentRef.current = null;
    setCurrent(null); setCapture(null); setReels([]); setDeleted([]); setConflict(null);
    setSaveState('idle'); setLoadState('idle'); setRoute({ name: 'list' });
  }, []);

  /**
   * Sign out, then clear.
   *
   * `auth.signOut()` increments the auth generation and aborts in-flight work before
   * this resolves, so no response from the previous account can still land. It throws
   * when the server revocation could not be confirmed; the local view is anonymous
   * either way, and the failure is reported rather than hidden behind a clean logout.
   */
  const signOut = useCallback(async () => {
    try {
      await auth.signOut();
    } catch (error) {
      setMessage(
        isAbandonedRequest(error)
          ? 'Wylogowano lokalnie.'
          : `Wylogowano lokalnie, ale serwer nie potwierdził zakończenia sesji. ${polishError(error)}`,
      );
    } finally {
      clearAccountView();
    }
  }, [auth, clearAccountView]);

  /**
   * Switch to the other account.
   *
   * The sign-in rotates the generation first, so anything still in flight for the
   * previous account is aborted and any response that arrives anyway is discarded.
   * Only then is the view cleared and rebuilt from the new account's own data.
   */
  const signInAs = useCallback(async (name: User['name'], password: string) => {
    await auth.signIn(name, password);
    clearAccountView();
    await recover();
  }, [auth, clearAccountView, recover]);

  const counts = useMemo(() => Object.fromEntries((['idea', 'to_record', 'editing', 'ready', 'published'] as ReelStatus[]).map((s) => [s, s === status ? reels.length : undefined])), [reels.length, status]);
  return { user, peer, authStatus, route, setRoute, status, setStatus, reels, current, capture, loadState, saveState, message, setMessage, counts, recover, loadList, openDetail, startCapture, updateCapture, addFiles, submitCapture, changeReel, removeHook, deleteCurrent, restore, copyPublication,
    deleted, loadDeleted, conflict, resolveConflict, replaceExport, verifyExport, signOut, signInAs };
}

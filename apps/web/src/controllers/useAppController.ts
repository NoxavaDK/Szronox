import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CaptureImageDescriptor, Reel, ReelPatchRequest, ReelStatus, User } from '../../../../packages/contracts/src/index.js';
import type { SupabaseBrowserSession } from '../auth/session.js';
import type { CoreApiClient } from '../data/api.js';
import { ClientApiError, polishError } from '../data/errors.js';
import { composePublicationText } from '../data/publication.js';
import type { CaptureDraft, DraftStore, ReelDraft } from '../drafts/store.js';
import type { SyncQueue } from '../drafts/queue.js';

export type Route = { name: 'list' } | { name: 'capture'; draftId: string } | { name: 'detail'; reelId: string };
export interface CaptureForm {
  draft: CaptureDraft; kind: 'image' | 'url' | 'text'; blobs: Map<string, Blob>; showAdditional: boolean; showHook: boolean;
}

export function useAppController(auth: SupabaseBrowserSession, api: CoreApiClient, store: DraftStore, queue: SyncQueue) {
  const [user, setUser] = useState<User | null>(auth.current()?.user ?? null);
  const [peer, setPeer] = useState<User | null>(null);
  const [route, setRoute] = useState<Route>({ name: 'list' });
  const [status, setStatus] = useState<ReelStatus>('idea');
  const [reels, setReels] = useState<Reel[]>([]);
  const [current, setCurrent] = useState<Reel | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error' | 'offline'>('idle');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'offline' | 'conflict' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [capture, setCapture] = useState<CaptureForm | null>(null);
  const saveTimer = useRef<number>();
  const currentRef = useRef<Reel | null>(null);
  const pendingPatch = useRef<{ reelId: string; expectedVersion: number; changes: ReelPatchRequest['changes'] } | null>(null);
  useEffect(() => { currentRef.current = current; }, [current]);

  const recover = useCallback(async () => {
    if (!auth.current()) { setUser(null); return; }
    try {
      const me = await api.me(); auth.setUser(me.user); setUser(me.user); setPeer(me.peer);
      await queue.flush();
    } catch (error) { if (error instanceof ClientApiError && error.status === 401) auth.signOut(); setMessage(polishError(error)); }
  }, [api, auth, queue]);
  useEffect(() => auth.subscribe((state) => setUser(state?.user ?? null)), [auth]);
  useEffect(() => { void recover(); const online = () => { void recover(); }; window.addEventListener('online', online); return () => window.removeEventListener('online', online); }, [recover]);

  const loadList = useCallback(async () => {
    if (!user) return; setLoadState('loading');
    try { const page = await api.list({ status }); setReels(page.items); setLoadState('loaded'); }
    catch (error) { setLoadState(navigator.onLine ? 'error' : 'offline'); setMessage(polishError(error)); }
  }, [api, status, user]);
  useEffect(() => { if (route.name === 'list') void loadList(); }, [loadList, route.name]);

  const openDetail = useCallback(async (reelId: string) => {
    setRoute({ name: 'detail', reelId }); setLoadState('loading');
    try {
      const reel = await api.reel(reelId); const draft = user ? await store.reel(user.id, reelId) : undefined;
      setCurrent(draft ? { ...reel, ...draft.changes } : reel); setSaveState(draft ? 'offline' : 'idle'); setLoadState('loaded');
    } catch (error) { setLoadState(navigator.onLine ? 'error' : 'offline'); setMessage(polishError(error)); }
  }, [api, store, user]);

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
    } catch (error) { setSaveState('error'); setMessage(polishError(error)); }
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
          if (error instanceof ClientApiError && error.status === 409) { await store.saveReel({ ...draft, conflictSnapshot: error.api.details }); setSaveState('conflict'); }
          else { await store.enqueue({ id: request.operationId, accountId: user.id, kind: 'patch', reelId: sending.reelId, createdAt: Date.now(), state: 'pending', payload: request }); setSaveState(navigator.onLine ? 'error' : 'offline'); }
          setMessage(polishError(error));
        }
      }, 600);
    }).catch((error) => { setSaveState('error'); setMessage(polishError(error)); });
  }, [api, store, user]);

  const removeHook = useCallback(async (hookId: string) => {
    if (!current || !user) return; const request = { operationId: crypto.randomUUID(), expectedVersion: current.version }; setSaveState('saving');
    try { setCurrent(await api.removeHook(current.id, hookId, request)); setSaveState('saved'); }
    catch (error) { await store.enqueue({ id: request.operationId, accountId: user.id, kind: 'remove-hook', reelId: current.id, createdAt: Date.now(), state: error instanceof ClientApiError && error.status === 409 ? 'conflict' : 'pending', payload: { hookId, request } }); setSaveState(error instanceof ClientApiError && error.status === 409 ? 'conflict' : 'offline'); setMessage(polishError(error)); }
  }, [api, current, store, user]);

  const deleteCurrent = useCallback(async () => {
    if (!current || !user) return;
    const request = { operationId: crypto.randomUUID(), expectedVersion: current.version }; setSaveState('saving');
    try { await api.remove(current.id, request); setCurrent(null); setRoute({ name: 'list' }); setSaveState('saved'); }
    catch (error) {
      const conflict = error instanceof ClientApiError && error.status === 409;
      await store.enqueue({ id: request.operationId, accountId: user.id, kind: 'delete', reelId: current.id, createdAt: Date.now(), state: conflict ? 'conflict' : 'pending', payload: request });
      setSaveState(conflict ? 'conflict' : 'offline'); setMessage(polishError(error));
    }
  }, [api, current, store, user]);

  const restore = useCallback(async (reel: Reel) => {
    if (!user) return; const request = { operationId: crypto.randomUUID(), expectedVersion: reel.version };
    try { await api.restore(reel.id, request); setRoute({ name: 'list' }); }
    catch (error) {
      const conflict = error instanceof ClientApiError && error.status === 409;
      await store.enqueue({ id: request.operationId, accountId: user.id, kind: 'restore', reelId: reel.id, createdAt: Date.now(), state: conflict ? 'conflict' : 'pending', payload: request }); setMessage(polishError(error));
    }
  }, [api, store, user]);

  const copyPublication = useCallback(async () => {
    if (!current) return; const { publicationDescription: description, publicationHashtags: hashtags } = current;
    const value = composePublicationText(description, hashtags);
    if (!value) { setMessage('Brak opisu i hashtagów do skopiowania.'); return; }
    try { if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE'); await navigator.clipboard.writeText(value); setMessage('Skopiowano opis.'); }
    catch { setMessage(`Nie udało się skopiować. Zaznacz i skopiuj ręcznie:\n\n${value}`); }
  }, [current]);

  const counts = useMemo(() => Object.fromEntries((['idea', 'to_record', 'editing', 'ready', 'published'] as ReelStatus[]).map((s) => [s, s === status ? reels.length : undefined])), [reels.length, status]);
  return { user, peer, route, setRoute, status, setStatus, reels, current, capture, loadState, saveState, message, setMessage, counts, recover, loadList, openDetail, startCapture, updateCapture, addFiles, submitCapture, changeReel, removeHook, deleteCurrent, restore, copyPublication, signOut: () => { auth.signOut(); setCurrent(null); setCapture(null); setReels([]); setRoute({ name: 'list' }); } };
}

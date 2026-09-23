import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CaptureImageDescriptor, Reel, ReelPatchRequest, ReelStatus, User } from '../../../../packages/contracts/src/index.js';
import type { AuthStatus, BrowserSession } from '../auth/session.js';
import type { CoreApiClient } from '../data/api.js';
import type { AttachmentRecovery, AttachmentProgress } from '../data/attachment-recovery.js';
import { ClientApiError, isAbandonedRequest, polishError } from '../data/errors.js';
import { composePublicationText } from '../data/publication.js';
import type { CaptureDraft, DraftStore, ReelDraft } from '../drafts/store.js';
import type { SyncQueue } from '../drafts/queue.js';
import { claimIncomingShare, clearIncomingSignal, readIncomingSignal, shareFailureMessage } from '../share/pending.js';

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
/**
 * An inline hook edit in progress (HOOKS-SELECT-EDIT). Held apart from the Reel, so a refresh,
 * conflict or failed save never replaces the user's text; only Gotowe/Anuluj ends it.
 * `base` is the server text the draft was written against, to name a concurrent change.
 */
export interface HookEdit { reelId: string; text: string; base: string; saving: boolean; error: string | null }
export interface CaptureForm {
  draft: CaptureDraft; kind: 'image' | 'url' | 'text'; blobs: Map<string, Blob>; showAdditional: boolean; showHook: boolean;
  /**
   * What an incoming share turned out to contain, or `null` for a capture the user started.
   *
   * Drives the compact chip in Quick Add (frozen visual spec sec. 3): a detected payload
   * starts collapsed, a manual one shows the full selector. It is a record of what arrived,
   * so it does not change when the user picks a different type afterwards.
   */
  detectedKind: 'image' | 'url' | 'text' | null;
}

/** What the share actually carried, for the detected-type chip. */
function detectedKindOf(input: CaptureDraft['input']): 'image' | 'url' | 'text' {
  if (input.images.length > 0) return 'image';
  return input.url !== undefined && input.url !== '' ? 'url' : 'text';
}

export function useAppController(auth: BrowserSession, api: CoreApiClient, store: DraftStore, queue: SyncQueue, attachments: AttachmentRecovery) {
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
  const [hookEdits, setHookEdits] = useState<Record<string, HookEdit>>({});
  const [hookSelecting, setHookSelecting] = useState(false);
  const hookEditsRef = useRef<Record<string, HookEdit>>({});
  const saveTimer = useRef<number>();
  const currentRef = useRef<Reel | null>(null);
  const pendingPatch = useRef<{ reelId: string; expectedVersion: number; changes: ReelPatchRequest['changes'] } | null>(null);
  useEffect(() => { currentRef.current = current; }, [current]);
  useEffect(() => { hookEditsRef.current = hookEdits; }, [hookEdits]);

  /**
   * Report attachment progress.
   *
   * Silence on an outstanding attachment would be the worst outcome: the user would
   * believe their image was saved while the bytes are still only on this device. An
   * abandoned run says nothing, because the account changed and the work belongs to
   * the previous one.
   */
  const reportAttachments = useCallback((results: readonly AttachmentProgress[]) => {
    const outstanding = results
      .filter((result) => !result.abandoned)
      .reduce((total, result) => total + result.outstanding.length, 0);
    if (outstanding > 0) {
      setMessage(outstanding === 1
        ? 'Jedno zdjęcie czeka jeszcze na wysłanie. Zostało zapisane na tym urządzeniu.'
        : `${outstanding} zdjęcia czekają jeszcze na wysłanie. Zostały zapisane na tym urządzeniu.`);
    }
  }, []);

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
      // Only after the queue: an image cannot be uploaded to a Reel the server has
      // not created yet, and the create operation lives in the queue.
      reportAttachments(await attachments.resume(me.user.id));
    } catch (error) {
      if (isAbandonedRequest(error)) return;
      setMessage(polishError(error));
    }
  }, [api, attachments, auth, queue, reportAttachments]);

  useEffect(() => auth.subscribe((state) => {
    setAuthStatus(state.status);
    setUser(state.session?.user ?? null);
    setPeer(state.session?.peer ?? null);
  }), [auth]);
  useEffect(() => { void recover(); const online = () => { void recover(); }; window.addEventListener('online', online); return () => window.removeEventListener('online', online); }, [recover]);

  /**
   * An Android share that the service worker put in quarantine.
   *
   * Read once, from this document's own URL, and held in a ref rather than in state: the
   * address bar is cleaned up as soon as the share is dealt with, so state derived from it
   * would be re-derived as empty on the next render.
   *
   * Binding waits for `user`, which is only set after `/me` has confirmed the session. That
   * is the whole point of quarantine — the worker cannot know who is signed in, so a share
   * received while signed out or offline stays unattributed until the server says who this
   * is. It is never consumed automatically into whichever account happens to be remembered.
   */
  const incoming = useRef(readIncomingSignal(typeof location === 'undefined' ? '' : location.search));
  useEffect(() => {
    const failure = incoming.current.failure;
    if (failure === null) return;
    // A receipt that failed has nothing in quarantine; say so and clear it.
    incoming.current = { ...incoming.current, failure: null };
    setMessage(shareFailureMessage(failure));
    if (incoming.current.shareId === null) clearIncomingSignal();
  }, []);

  const captureOpen = capture !== null;
  useEffect(() => {
    const shareId = incoming.current.shareId;
    if (!user || shareId === null) return;
    // An unsaved capture is never replaced. The share keeps waiting in quarantine, and this
    // effect runs again when that capture closes, because `captureOpen` is a dependency.
    if (captureOpen) { setMessage('Udostępniona treść czeka. Zapisz lub zamknij bieżący pomysł, aby ją otworzyć.'); return; }
    const accountId = user.id;
    void (async () => {
      try {
        const outcome = await claimIncomingShare(store, shareId, accountId, { hasUnsavedCapture: false });
        if (outcome.status === 'deferred') return;
        incoming.current = { shareId: null, failure: null };
        clearIncomingSignal();
        // Already consumed: the share was bound on an earlier visit, or by the other
        // account on this device. Which of the two is never disclosed — but silence would
        // look like a failure, so the fact that it is gone is stated plainly.
        if (outcome.status === 'already_consumed') {
          setMessage('Ta udostępniona treść została już odebrana.');
          return;
        }
        const draft = outcome.draft;
        const blobs = new Map<string, Blob>();
        for (const image of draft.input.images) {
          const blob = await store.blob(accountId, image.attachmentId);
          if (blob) blobs.set(image.attachmentId, blob);
        }
        setCapture({ draft, kind: detectedKindOf(draft.input), blobs, showAdditional: false, showHook: false, detectedKind: detectedKindOf(draft.input) });
        setRoute({ name: 'capture', draftId: draft.reelId });
      } catch (error) {
        if (isAbandonedRequest(error)) return;
        setMessage(polishError(error));
      }
    })();
  }, [captureOpen, store, user]);

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

  /**
   * Re-fetches the currently selected status tab without touching `loadState` (LIST-01).
   *
   * A status-changing list mutation — the swipe/sheet quick move, or its undo — can move a
   * Reel out of (or back into) the tab currently being viewed. Patching the item in place
   * left it sitting in the old tab under its new status label instead of leaving the list
   * it no longer belongs to. Going through `loadList()` would work too, but it also flips
   * `loadState` to `'loading'`, replacing the whole list with a spinner for what should read
   * as a quick, quiet move; this re-fetches the same filtered page silently instead. A
   * failure here is not reported — the row simply keeps its optimistic-free prior state and
   * the ordinary `onRetry` path remains available.
   */
  const refreshFilteredList = useCallback(async () => {
    if (!user) return;
    try { const page = await api.list({ status }); setReels(page.items); } catch { /* keep current view */ }
  }, [api, status, user]);

  const loadDeleted = useCallback(async () => {
    if (!user) return; setLoadState('loading');
    try { const page = await api.list({ visibility: 'deleted' }); setDeleted(page.items); setLoadState('loaded'); }
    catch (error) { reportLoadFailure(error); }
  }, [api, reportLoadFailure, user]);
  useEffect(() => { if (route.name === 'deleted') void loadDeleted(); }, [loadDeleted, route.name]);

  /**
   * Open a Reel's detail screen.
   *
   * The route is changed only once the Reel is in hand, because `current` and `route` are
   * what the detail screen is rendered from and they must never disagree:
   *
   *   - Navigating first left the previous Reel in `current` for the whole round trip, so
   *     tapping B straight after A rendered *A's* title, script and hooks under route B.
   *     `changeReel` patches `currentRef.current`, so an edit made in that window would
   *     have been written to A.
   *   - A failed read then left `route` on `detail` with `current` still null, which falls
   *     through to the list — and the list's own effect is guarded by `route.name === 'list'`,
   *     so the status tabs silently stopped reloading while still highlighting the new tab.
   *
   * Loading and failure are reported through the shared `loadState`, which the list screen
   * already renders as "Wczytywanie…" and "Nie udało się wczytać" with a retry. Staying put
   * on a failure keeps that retry meaningful instead of stranding the user on a dead route.
   */
  const openDetail = useCallback(async (reelId: string) => {
    setLoadState('loading');
    try {
      const reel = await api.reel(reelId, { includeDeleted: true });
      // Drafts are read for the account that is active now, and the id is part of
      // the key, so a draft can only ever be paired with its own account's Reel.
      const draft = user ? await store.reel(user.id, reelId) : undefined;
      const resolved = draft ? { ...reel, ...draft.changes } : reel;
      currentRef.current = resolved;
      setCurrent(resolved); setSaveState(draft ? 'offline' : 'idle'); setLoadState('loaded');
      setRoute({ name: 'detail', reelId });
      // `route` alone is in-memory and vanishes on reload. `Kopiuj link` (LIST-01) and
      // reloading while a Reel is open both need the address bar to actually name it.
      const path = `/reels/${encodeURIComponent(reelId)}`;
      if (typeof history !== 'undefined' && location.pathname !== path) history.pushState({ reelId }, '', path);
    } catch (error) { reportLoadFailure(error); }
  }, [api, reportLoadFailure, store, user]);

  /** Reads a deep link (`/reels/:id`) on first load, once the session is confirmed. */
  const deepLinkAttempted = useRef(false);
  useEffect(() => {
    if (deepLinkAttempted.current || !user) return;
    deepLinkAttempted.current = true;
    const match = typeof location === 'undefined' ? null : location.pathname.match(/^\/reels\/([^/]+)\/?$/);
    if (match) void openDetail(decodeURIComponent(match[1]));
  }, [openDetail, user]);

  /** Browser back/forward on the one URL this app pushes: a deep-linked or opened Reel. */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPopState = () => {
      const match = location.pathname.match(/^\/reels\/([^/]+)\/?$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (!(currentRef.current?.id === id && route.name === 'detail')) void openDetail(id);
      } else if (route.name === 'detail') {
        setRoute({ name: 'list' });
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [openDetail, route]);

  /** Undo the address bar's `/reels/:id` when leaving Detail through any success path. */
  const syncListUrl = useCallback(() => {
    if (typeof history !== 'undefined' && location.pathname !== '/') history.pushState({}, '', '/');
  }, []);

  const leaveDetail = useCallback(() => { setRoute({ name: 'list' }); syncListUrl(); }, [syncListUrl]);

  const startCapture = useCallback(() => {
    if (!user) return; const reelId = crypto.randomUUID();
    const draft: CaptureDraft = { id: `${user.id}:${reelId}`, accountId: user.id, reelId, operationId: crypto.randomUUID(), input: { images: [] }, priority: 'normal', fileNames: {}, updatedAt: Date.now(), state: 'draft' };
    setCapture({ draft, kind: 'text', blobs: new Map(), showAdditional: false, showHook: false, detectedKind: null }); setRoute({ name: 'capture', draftId: reelId });
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
  const submitCapture = useCallback(async (withAi = false): Promise<Reel | null> => {
    if (!capture || !user) return null; setSaveState('saving');
    try {
      await store.saveCapture({ ...capture.draft, state: 'queued' }, capture.blobs);
      await store.enqueue({ id: capture.draft.operationId, accountId: user.id, kind: 'create', reelId: capture.draft.reelId, createdAt: Date.now(), state: 'pending', payload: { operationId: capture.draft.operationId, reelId: capture.draft.reelId, input: capture.draft.input, initialHook: capture.draft.initialHook || undefined, priority: capture.draft.priority } });
      await queue.flush(); const remaining = await store.queue(user.id); const item = remaining.find((x) => x.id === capture.draft.operationId);
      if (item) { setSaveState(item.state === 'conflict' ? 'conflict' : navigator.onLine ? 'error' : 'offline'); return null; }
      // The Reel exists now, so the images can go. The draft and its blobs stay until
      // the server acknowledges each attachment, so leaving this screen — or closing
      // the tab mid-upload — loses nothing and the next recovery pass resumes with the
      // same attachment and operation ids.
      const progress = capture.draft.input.images.length === 0
        ? []
        : [await attachments.runCapture({ ...capture.draft, state: 'queued' })];
      const complete = progress.every((item) => item.complete && !item.abandoned);
      setSaveState(complete ? 'saved' : 'error'); setCapture(null);
      if (withAi && complete) {
        const reel = await api.reel(capture.draft.reelId);
        currentRef.current = reel; setCurrent(reel); setRoute({ name: 'detail', reelId: reel.id });
        return reel;
      }
      setRoute({ name: 'list' });
      reportAttachments(progress);
      return null;
    } catch (error) { if (isAbandonedRequest(error)) return null; setSaveState('error'); setMessage(polishError(error)); return null; }
  }, [api, attachments, capture, queue, reportAttachments, store, user]);

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

  const acceptReel = useCallback((reel: Reel) => {
    currentRef.current = reel;
    setCurrent(reel);
  }, []);

  /**
   * Show a server Reel without losing a debounced scalar edit that has not been sent yet.
   *
   * `own` marks the result of this client's hook mutation made from `before`. When nothing
   * else happened in between (exactly one version later), the pending patch is rebased onto
   * it, because that mutation touched only hooks/selection. A refreshed Reel is never
   * rebased: a genuine concurrent change still surfaces as the ordinary conflict.
   */
  const acceptServerReel = useCallback((before: Reel, server: Reel, own: boolean) => {
    const pending = pendingPatch.current?.reelId === server.id ? pendingPatch.current : null;
    if (pending && own && pending.expectedVersion === before.version && server.version === before.version + 1) {
      pending.expectedVersion = server.version;
    }
    // The user may have left this Reel while the request was in flight.
    if (currentRef.current?.id !== server.id) return;
    const next = pending ? { ...server, ...pending.changes } : server;
    currentRef.current = next; setCurrent(next);
  }, []);

  const removeHook = useCallback(async (hookId: string) => {
    if (!current || !user) return; const request = { operationId: crypto.randomUUID(), expectedVersion: current.version }; setSaveState('saving');
    try { acceptServerReel(current, await api.removeHook(current.id, hookId, request), true); setSaveState('saved'); }
    catch (error) { if (isAbandonedRequest(error)) return; await store.enqueue({ id: request.operationId, accountId: user.id, kind: 'remove-hook', reelId: current.id, createdAt: Date.now(), state: error instanceof ClientApiError && error.status === 409 ? 'conflict' : 'pending', payload: { hookId, request } }); setSaveState(error instanceof ClientApiError && error.status === 409 ? 'conflict' : 'offline'); setMessage(polishError(error)); }
  }, [acceptServerReel, api, current, store, user]);

  /** Re-read the Reel after a refused hook mutation, so the rendered selection is the server's. */
  const refreshAfterRefusal = useCallback(async (before: Reel): Promise<Reel | null> => {
    try { const server = await api.reel(before.id); acceptServerReel(before, server, false); return server; }
    catch { return null; }
  }, [acceptServerReel, api]);

  /**
   * Explicit selection from a HOOKI row. Selecting the chosen row again clears the choice.
   * Not optimistic and not queued offline: the row shows the server's answer, and a failure
   * says plainly that the choice was not saved.
   */
  const selectHook = useCallback(async (hookId: string | null) => {
    const reel = currentRef.current;
    if (!reel || !user) return;
    const request = { operationId: crypto.randomUUID(), expectedVersion: reel.version, hookId };
    setHookSelecting(true);
    setSaveState((state) => (['conflict', 'offline', 'error'].includes(state) ? state : 'saving'));
    try {
      acceptServerReel(reel, await api.selectHook(reel.id, request), true);
      setSaveState((state) => (state === 'saving' ? 'saved' : state));
    } catch (error) {
      if (isAbandonedRequest(error)) return;
      setSaveState((state) => (state === 'saving' ? 'idle' : state));
      if (error instanceof ClientApiError && (error.status === 409 || error.status === 404)) {
        await refreshAfterRefusal(reel);
        setMessage(error.status === 404
          ? 'Tego hooka już nie ma. Wybór nie został zapisany.'
          : 'Rolka zmieniła się na innym urządzeniu. Wybór hooka nie został zapisany — wybierz ponownie.');
      } else {
        setMessage(error instanceof ClientApiError ? `Wybór hooka nie został zapisany. ${polishError(error)}` : 'Brak połączenia. Wybór hooka nie został zapisany.');
      }
    } finally {
      setHookSelecting(false);
    }
  }, [acceptServerReel, api, refreshAfterRefusal, user]);

  const updateHookEdit = useCallback((hookId: string, update: (edit: HookEdit) => HookEdit | null) => {
    const edits = { ...hookEditsRef.current };
    const existing = edits[hookId];
    if (!existing) return;
    const next = update(existing);
    if (next) edits[hookId] = next; else delete edits[hookId];
    hookEditsRef.current = edits; setHookEdits(edits);
  }, []);

  const startHookEdit = useCallback((hookId: string) => {
    const reel = currentRef.current;
    const hook = reel?.hooks.find((entry) => entry.id === hookId);
    if (!reel || !hook || hookEditsRef.current[hookId]) return;
    const edits = { ...hookEditsRef.current, [hookId]: { reelId: reel.id, text: hook.text, base: hook.text, saving: false, error: null } };
    hookEditsRef.current = edits; setHookEdits(edits);
  }, []);

  const changeHookEdit = useCallback((hookId: string, text: string) =>
    updateHookEdit(hookId, (edit) => ({ ...edit, text })), [updateHookEdit]);

  const cancelHookEdit = useCallback((hookId: string) => updateHookEdit(hookId, () => null), [updateHookEdit]);

  /**
   * Gotowe: save through the existing hook-edit endpoint. The draft is removed only after the
   * server confirms; any refusal or network failure keeps it in the field with a reason.
   */
  const saveHookEdit = useCallback(async (hookId: string) => {
    const reel = currentRef.current;
    const edit = hookEditsRef.current[hookId];
    if (!reel || !user || !edit || edit.saving) return;
    const hook = reel.hooks.find((entry) => entry.id === hookId);
    if (edit.text.trim() === '') { updateHookEdit(hookId, (x) => ({ ...x, error: 'Hook nie może być pusty.' })); return; }
    if (!hook) { updateHookEdit(hookId, (x) => ({ ...x, error: 'Tego hooka już nie ma. Twój tekst pozostaje w polu — skopiuj go, jeśli chcesz go zachować.' })); return; }
    if (hook.text === edit.text) { updateHookEdit(hookId, () => null); return; }
    updateHookEdit(hookId, (x) => ({ ...x, saving: true, error: null }));
    try {
      const saved = await api.editHook(reel.id, hookId, { operationId: crypto.randomUUID(), expectedVersion: reel.version, text: edit.text });
      acceptServerReel(reel, saved, true);
      updateHookEdit(hookId, () => null);
    } catch (error) {
      if (isAbandonedRequest(error)) return;
      let message = error instanceof ClientApiError
        ? `Hook nie został zapisany. ${polishError(error)}`
        : 'Brak połączenia. Hook nie został zapisany — tekst pozostaje w edycji.';
      let base = edit.base;
      if (error instanceof ClientApiError && (error.status === 409 || error.status === 404)) {
        const server = await refreshAfterRefusal(reel);
        const now = server?.hooks.find((entry) => entry.id === hookId);
        if (server && !now) message = 'Ten hook został usunięty na innym urządzeniu. Twój tekst pozostaje w polu — skopiuj go, jeśli chcesz go zachować.';
        else if (now && now.text !== edit.base) {
          message = `Ktoś zmienił ten hook w międzyczasie. Twoja wersja jest zachowana; Gotowe zastąpi obecny tekst: „${now.text}”.`;
          base = now.text;
        } else if (error.status === 409) message = 'Rolka zmieniła się na innym urządzeniu. Twój tekst hooka jest zachowany — naciśnij Gotowe, aby zapisać ponownie.';
      }
      updateHookEdit(hookId, (x) => ({ ...x, base, saving: false, error: message }));
    }
  }, [acceptServerReel, api, refreshAfterRefusal, updateHookEdit, user]);

  const deleteCurrent = useCallback(async () => {
    if (!current || !user) return;
    const request = { operationId: crypto.randomUUID(), expectedVersion: current.version }; setSaveState('saving');
    try { await api.remove(current.id, request); setCurrent(null); setRoute({ name: 'list' }); syncListUrl(); setSaveState('saved'); }
    catch (error) {
      if (isAbandonedRequest(error)) return;
      const conflict = error instanceof ClientApiError && error.status === 409;
      await store.enqueue({ id: request.operationId, accountId: user.id, kind: 'delete', reelId: current.id, createdAt: Date.now(), state: conflict ? 'conflict' : 'pending', payload: request });
      setSaveState(conflict ? 'conflict' : 'offline'); setMessage(polishError(error));
    }
  }, [api, current, store, syncListUrl, user]);

  const restore = useCallback(async (reel: Reel) => {
    if (!user) return; const request = { operationId: crypto.randomUUID(), expectedVersion: reel.version };
    try { await api.restore(reel.id, request); setRoute({ name: 'list' }); syncListUrl(); }
    catch (error) {
      if (isAbandonedRequest(error)) return;
      const conflict = error instanceof ClientApiError && error.status === 409;
      await store.enqueue({ id: request.operationId, accountId: user.id, kind: 'restore', reelId: reel.id, createdAt: Date.now(), state: conflict ? 'conflict' : 'pending', payload: request }); setMessage(polishError(error));
    }
  }, [api, store, syncListUrl, user]);

  /**
   * Version-checked patch against a Reel that may not be `current` (LIST-01 list quick
   * actions: swipe-right status move, Przypisz).
   *
   * Only a genuine transport failure — `error` is NOT a `ClientApiError`, meaning no
   * response ever came back — reuses the exact same offline queue `changeReel` and
   * `deleteCurrent` already use below (`store.enqueue` + `SyncQueue.flush()` on reconnect).
   * A `ClientApiError` means the server actually answered: a 409 is the existing
   * version-conflict case, and every OTHER status (422 FEED_COVER_REQUIRED, 400
   * VALIDATION_ERROR, 403 FORBIDDEN, ...) is a real rejection that a retry cannot fix, so it
   * is surfaced via `polishError` as-is rather than queued — queuing it would silently
   * re-fail later instead of telling the user now. Nothing is ever reported accepted before
   * the server actually has it, and a status-changing patch re-syncs the currently viewed
   * tab through `refreshFilteredList` rather than leaving the row misfiled under its old tab.
   */
  const patchReelById = useCallback(async (
    id: string, expectedVersion: number, changes: ReelPatchRequest['changes'],
  ): Promise<{ ok: true; reel: Reel } | { ok: false; conflict: boolean; queued: boolean; message: string }> => {
    if (!user) return { ok: false, conflict: false, queued: false, message: '' };
    const request = { operationId: crypto.randomUUID(), expectedVersion, changes };
    try {
      const saved = await api.patch(id, request);
      if (currentRef.current?.id === id) { currentRef.current = saved; setCurrent(saved); }
      if (changes.status !== undefined) await refreshFilteredList();
      else setReels((list) => list.map((item) => (item.id === id ? saved : item)));
      return { ok: true, reel: saved };
    } catch (error) {
      if (isAbandonedRequest(error)) return { ok: false, conflict: false, queued: false, message: '' };
      if (error instanceof ClientApiError) {
        if (error.status === 409) {
          return { ok: false, conflict: true, queued: false, message: 'Ktoś zmienił tę rolkę. Otwórz ją, aby zobaczyć aktualny stan.' };
        }
        return { ok: false, conflict: false, queued: false, message: polishError(error) };
      }
      await store.enqueue({ id: request.operationId, accountId: user.id, kind: 'patch', reelId: id, createdAt: Date.now(), state: 'pending', payload: request });
      return { ok: false, conflict: false, queued: true, message: 'Brak sieci. Zmiana zostanie wysłana po powrocie sieci.' };
    }
  }, [api, refreshFilteredList, store, user]);

  /** Same reasoning as `patchReelById`: a list-row delete that is not necessarily `current`. */
  const removeReelById = useCallback(async (id: string, expectedVersion: number): Promise<{ ok: true } | { ok: false; conflict: boolean; queued: boolean; message: string }> => {
    if (!user) return { ok: false, conflict: false, queued: false, message: '' };
    const request = { operationId: crypto.randomUUID(), expectedVersion };
    try {
      await api.remove(id, request);
      setReels((list) => list.filter((item) => item.id !== id));
      if (currentRef.current?.id === id) { currentRef.current = null; setCurrent(null); }
      return { ok: true };
    } catch (error) {
      if (isAbandonedRequest(error)) return { ok: false, conflict: false, queued: false, message: '' };
      if (error instanceof ClientApiError) {
        if (error.status === 409) {
          return { ok: false, conflict: true, queued: false, message: 'Ktoś zmienił tę rolkę. Otwórz ją, aby zobaczyć aktualny stan.' };
        }
        return { ok: false, conflict: false, queued: false, message: polishError(error) };
      }
      await store.enqueue({ id: request.operationId, accountId: user.id, kind: 'delete', reelId: id, createdAt: Date.now(), state: 'pending', payload: request });
      return { ok: false, conflict: false, queued: true, message: 'Brak sieci. Usunięcie zostanie wysłane po powrocie sieci.' };
    }
  }, [api, store, user]);

  /** `Kopiuj link` (LIST-01): a same-origin, session-authenticated deep link to this Reel. */
  const copyReelLink = useCallback(async (id: string) => {
    const link = `${location.origin}/reels/${encodeURIComponent(id)}`;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE');
      await navigator.clipboard.writeText(link);
      setMessage('Skopiowano link.');
    } catch {
      setMessage(`Nie udało się skopiować. Zaznacz i skopiuj ręcznie:\n\n${link}`);
    }
  }, []);

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
    hookEditsRef.current = {}; setHookEdits({});
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

  /**
   * Whether any Reel edit has not reached the server yet: debounced, in flight, conflicted,
   * queued or held offline. Server-side generation reads only saved content, so it is refused
   * rather than run against text the user no longer sees — and the edit itself is kept.
   */
  const hasUnsavedChanges = useCallback(() => pendingPatch.current !== null ||
    ['saving', 'conflict', 'offline', 'error'].includes(saveState) || conflict !== null, [conflict, saveState]);

  const counts = useMemo(() => Object.fromEntries((['idea', 'to_record', 'editing', 'ready', 'published'] as ReelStatus[]).map((s) => [s, s === status ? reels.length : undefined])), [reels.length, status]);
  return { user, peer, authStatus, route, setRoute, status, setStatus, reels, current, capture, loadState, saveState, message, setMessage, counts, recover, loadList, openDetail, leaveDetail, acceptReel, startCapture, updateCapture, addFiles, submitCapture, changeReel, removeHook, selectHook, hookSelecting,
    hookEdits, startHookEdit, changeHookEdit, cancelHookEdit, saveHookEdit, deleteCurrent, restore, copyPublication,
    deleted, loadDeleted, conflict, resolveConflict, replaceExport, verifyExport, signOut, signInAs,
    patchReelById, removeReelById, copyReelLink, hasUnsavedChanges };
}

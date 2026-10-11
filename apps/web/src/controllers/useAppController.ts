import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CaptureImageDescriptor, KdriveUploadPurpose, KdriveUploadState, Reel, ReelPatchRequest, ReelStatus, User } from '../../../../packages/contracts/src/index.js';
import type { AuthStatus, BrowserSession } from '../auth/session.js';
import type { CoreApiClient } from '../data/api.js';
import type { AttachmentRecovery, AttachmentProgress } from '../data/attachment-recovery.js';
import { ClientApiError, isAbandonedRequest, polishError } from '../data/errors.js';
import { composePublicationText } from '../data/publication.js';
import { uploadKdriveFile, uploadPercent, type KdriveUploadProgress } from '../data/kdrive-upload.js';
import { planChanges, type PublicationSlot } from '../data/planner.js';
import type { CaptureDraft, DraftStore, ReelDraft } from '../drafts/store.js';
import { createRequestFromDraft } from '../drafts/create-request.js';
import type { SyncQueue } from '../drafts/queue.js';
import { claimIncomingShare, clearIncomingSignal, readIncomingSignal, shareFailureMessage } from '../share/pending.js';
import { canMarkSavedAfterSend, changesForConflictResolution, deleteDraftIfNoNewerWrite, enqueueDraftStoreOperation, hasUnfinishedHookEditForReel, retainPendingDraftBeforeSwitch, withConflictSnapshot, type DraftWriteRecord, type DraftWriteResult } from './draft-switch.js';

export type Route =
  | { name: 'list' }
  | { name: 'capture'; draftId: string }
  | { name: 'detail'; reelId: string }
  /** `Usunięte` — a secondary view, never a sixth status (frozen batch sec. 8). */
  | { name: 'deleted' }
  /** CONTENT-PLANNER-01: the full-width PLAN view on single-pane (mobile) layouts. */
  | { name: 'plan' }
  /** STREAM-LIVE-01: `Na żywo`, also reachable directly at `/na-zywo` for a small side window. */
  | { name: 'live' };

const LIVE_PATH = '/na-zywo';

/**
 * How many workspace panes the viewport holds (CONTENT-PLANNER-01). `single` is the mobile
 * one-view-at-a-time app; `two` keeps PLAN beside the centre; `three` adds REELS on the right.
 */
export type WorkspaceLayout = 'single' | 'drawer' | 'two' | 'three' | 'focus';

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

export interface KdriveUploadJob {
  reelId: string; purpose: KdriveUploadPurpose; file: File | null; fileName: string; uploadId: string | null;
  completedBytes: number; totalBytes: number; phase: KdriveUploadProgress['phase'] | 'error' | 'done'; error: string | null; percent: number; finished: boolean;
}

/** What the share actually carried, for the detected-type chip. */
function detectedKindOf(input: CaptureDraft['input']): 'image' | 'url' | 'text' {
  if (input.images.length > 0) return 'image';
  return input.url !== undefined && input.url !== '' ? 'url' : 'text';
}

async function listEveryActiveReel(api: CoreApiClient): Promise<Reel[]> {
  const items: Reel[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const result = await api.list({ cursor });
    items.push(...result.items);
    const next = result.nextCursor;
    if (!next) return items;
    if (seenCursors.has(next)) throw new Error('Reel list pagination repeated a cursor');
    seenCursors.add(next);
    cursor = next;
  }
}

export function useAppController(auth: BrowserSession, api: CoreApiClient, store: DraftStore, queue: SyncQueue, attachments: AttachmentRecovery) {
  const [user, setUser] = useState<User | null>(auth.current()?.user ?? null);
  const [peer, setPeer] = useState<User | null>(auth.current()?.peer ?? null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>(auth.state().status);
  const [route, setRoute] = useState<Route>({ name: 'list' });
  const [status, setStatus] = useState<ReelStatus | 'all'>('idea');
  const [reels, setReels] = useState<Reel[]>([]);
  const [current, setCurrent] = useState<Reel | null>(null);
  const [sourceUndo, setSourceUndo] = useState<{ reelId: string; text: string } | null>(null);
  const sourceUndoTimer = useRef<number | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error' | 'offline'>('idle');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'offline' | 'conflict' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [capture, setCapture] = useState<CaptureForm | null>(null);
  const [kdriveUploadJobs, setKdriveUploadJobs] = useState<Record<string, KdriveUploadJob>>({});
  const kdriveUploadControllers = useRef(new Map<string, AbortController>());
  const [deleted, setDeleted] = useState<Reel[]>([]);
  const [conflictsByReel, setConflictsByReel] = useState<Record<string, ConflictState>>({});
  const conflict = current ? conflictsByReel[current.id] ?? null : null;
  const [hookEdits, setHookEdits] = useState<Record<string, HookEdit>>({});
  /** HOOK-ADD-01: one new-hook draft (per open Reel). The operation id survives retries of the
   * same text, so a retry after a lost response cannot add the hook twice. */
  const [newHook, setNewHook] = useState<{ reelId: string; text: string; saving: boolean; error: string | null; operationId: string } | null>(null);
  const [hookSelecting, setHookSelecting] = useState(false);
  const [layout, setLayout] = useState<WorkspaceLayout>('single');
  const layoutRef = useRef<WorkspaceLayout>('single');
  useEffect(() => { layoutRef.current = layout; }, [layout]);
  /** Every active Reel, for the planner view. The plan itself lives on each Reel. */
  const [planReels, setPlanReels] = useState<Reel[]>([]);
  const [planLoadState, setPlanLoadState] = useState<'idle' | 'loading' | 'loaded' | 'error' | 'offline'>('idle');
  /** Where Wstecz from Detail returns on a single-pane layout: the list or the plan. */
  const lastPrimary = useRef<'list' | 'plan'>('list');
  const primaryRoute = (): Route => (lastPrimary.current === 'plan' ? { name: 'plan' } : { name: 'list' });
  useEffect(() => { if (route.name === 'list' || route.name === 'plan') lastPrimary.current = route.name; }, [route]);
  const hookEditsRef = useRef<Record<string, HookEdit>>({});
  const saveTimers = useRef(new Map<string, number>());
  const conflictsRef = useRef<Record<string, ConflictState>>({});
  const blockedConflictReels = useRef(new Set<string>());
  const currentRef = useRef<Reel | null>(null);
  const pendingPatches = useRef(new Map<string, { reelId: string; expectedVersion: number; changes: ReelPatchRequest['changes'] }>());
  /** Per-Reel flush callback while a debounced edit is waiting for its timer. */
  const flushPending = useRef(new Map<string, () => Promise<void>>());
  const draftWrites = useRef(new Map<string, DraftWriteRecord>());
  const draftStoreQueues = useRef(new Map<string, Promise<void>>());
  /**
   * The scalar save currently on the network, per Reel. The next save of the same Reel waits
   * for it and is then rebased onto the version it returned; sending both on the same
   * `expectedVersion` made the second one conflict with the author's own first save.
   */
  const inFlightSaves = useRef(new Map<string, Promise<void>>());
  const draftWriteRevision = useRef(0);
  const setConflictForReel = useCallback((reelId: string, value: ConflictState | null) => {
    const next = { ...conflictsRef.current };
    if (value) { next[reelId] = value; blockedConflictReels.current.add(reelId); }
    else { delete next[reelId]; blockedConflictReels.current.delete(reelId); }
    conflictsRef.current = next;
    setConflictsByReel(next);
  }, []);
  useEffect(() => { currentRef.current = current; }, [current]);
  useEffect(() => {
    if (route.name === 'detail' && sourceUndo?.reelId === route.reelId) return;
    if (sourceUndo) setSourceUndo(null);
    if (sourceUndoTimer.current !== null) window.clearTimeout(sourceUndoTimer.current);
    sourceUndoTimer.current = null;
  }, [route, sourceUndo]);
  useEffect(() => { hookEditsRef.current = hookEdits; }, [hookEdits]);

  useEffect(() => {
    if (route.name !== 'detail') return;
    let live = true;
    void api.openKdriveUploads(route.reelId).then((items) => {
      if (!live) return;
      setKdriveUploadJobs((old) => {
        const next = { ...old };
        for (const item of items) if (!next[route.reelId]) next[route.reelId] = {
          reelId: route.reelId, purpose: item.purpose, file: null, fileName: item.fileName, uploadId: item.uploadId,
          completedBytes: item.receivedChunks.reduce((sum, index) => sum + Math.min(item.chunkSize, item.byteSize - index * item.chunkSize), 0),
          totalBytes: item.byteSize, phase: 'error', error: 'Wysyłanie przerwane — wybierz ten sam plik, aby wznowić.',
          percent: Math.floor(item.receivedChunks.length / item.totalChunks * 100), finished: false,
        };
        return next;
      });
    }).catch(() => undefined);
    return () => { live = false; };
  }, [api, route]);

  useEffect(() => {
    const active = Object.values(kdriveUploadJobs).some((job) => ['uploading', 'finishing', 'attaching'].includes(job.phase));
    if (!active) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [kdriveUploadJobs]);

  /**
   * Show the server Reel after this client's own upload write (folder link at start, cover/export
   * attach). Those touch no scalar field, so a pending scalar patch made against the version just
   * before is rebased, exactly as acceptServerReel does for own hook mutations. Only exactly one
   * version later: anything more is a genuine concurrent change and still surfaces as a conflict.
   */
  const syncAfterUploadWrite = useCallback((server: Reel) => {
    const pending = pendingPatches.current.get(server.id) ?? null;
    if (pending && server.version === pending.expectedVersion + 1) pending.expectedVersion = server.version;
    setReels((old) => old.map((item) => item.id === server.id ? server : item));
    setPlanReels((old) => old.map((item) => item.id === server.id ? server : item));
    if (currentRef.current?.id !== server.id) return;
    const next = pending ? { ...server, ...pending.changes } : server;
    currentRef.current = next; setCurrent(next);
  }, []);

  const startKdriveUpload = useCallback(async (reelId: string, purpose: KdriveUploadPurpose, file: File, createFolder: boolean) => {
    const reel = currentRef.current?.id === reelId ? currentRef.current : reels.find((item) => item.id === reelId);
    if (!reel || kdriveUploadControllers.current.has(reelId)) return;
    // Same rule as the explicit folder action: the combined create links the folder with a
    // version-checked write, so wait for unsaved edits first.
    if (createFolder && (pendingPatches.current.has(reelId) || inFlightSaves.current.has(reelId))) {
      setMessage('Poczekaj, aż zmiany w rolce zostaną zapisane, i spróbuj ponownie.'); return;
    }
    const supported = purpose === 'video' ? ['video/mp4', 'video/quicktime'] : ['image/jpeg', 'image/png', 'image/webp'];
    const maxBytes = purpose === 'video' ? 4 * 1024 * 1024 * 1024 : 25 * 1024 * 1024;
    if (!file.size || !supported.includes(file.type)) { setMessage(purpose === 'video' ? 'Wybierz plik MP4 lub QuickTime.' : 'Wybierz zdjęcie JPG, PNG lub WebP.'); return; }
    if (file.size > maxBytes) { setMessage(purpose === 'video' ? 'Wideo przekracza limit 4 GiB.' : 'Okładka przekracza limit 25 MiB.'); return; }
    const controller = new AbortController(); kdriveUploadControllers.current.set(reelId, controller);
    setKdriveUploadJobs((old) => ({ ...old, [reelId]: { reelId, purpose, file, fileName: file.name, uploadId: null, completedBytes: 0, totalBytes: file.size, phase: 'uploading', error: null, percent: 0, finished: false } }));
    let wakeLock: { release(): Promise<void> } | null = null;
    if (purpose === 'video') {
      try { wakeLock = await (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null; } catch { /* unavailable or denied */ }
    }
    try {
      const open = await api.openKdriveUploads(reelId);
      const matching = open.find((item) => item.purpose === purpose && item.fileName === file.name && item.byteSize === file.size && item.mimeType === file.type);
      if (open.some((item) => item.purpose === purpose) && !matching) throw new Error('Wysyłanie przerwane — wybierz ten sam plik, aby wznowić albo anuluj wysyłanie.');
      const saved = await uploadKdriveFile({ api, reel, purpose, file, createFolder, existing: matching, signal: controller.signal,
        // The combined start linked the folder (one new version): pick it up before the upload runs.
        onStarted: createFolder ? () => { void api.reel(reelId).then(syncAfterUploadWrite).catch(() => undefined); } : undefined,
        onProgress(progress) { setKdriveUploadJobs((old) => ({ ...old, [reelId]: { ...old[reelId], uploadId: progress.uploadId, completedBytes: progress.completedBytes, totalBytes: progress.totalBytes, phase: progress.phase, percent: uploadPercent(progress), error: null, finished: old[reelId]?.finished === true || progress.phase === 'attaching' } })); },
      });
      syncAfterUploadWrite(saved);
      setKdriveUploadJobs((old) => ({ ...old, [reelId]: { ...old[reelId], phase: 'done', percent: 100, completedBytes: file.size, error: null } }));
      setMessage(purpose === 'cover' ? 'Okładka wgrana i oznaczona jako gotowa.' : 'Eksport wgrany. Sprawdź ponownie.');
    } catch (error) {
      if (controller.signal.aborted) return;
      const reason = error instanceof ClientApiError ? error.api.details?.reason : undefined;
      const text = reason === 'kdrive_not_configured' ? 'Integracja kDrive nie jest skonfigurowana na tym serwerze.'
        : reason === 'folder_required' ? 'Utwórz folder i wgraj plik.'
          : reason === 'folder_missing' || reason === 'folder_unavailable' ? 'Połącz ponownie folder kDrive przed wysłaniem pliku.'
            : error instanceof ClientApiError ? polishError(error) : error instanceof Error ? error.message : polishError(error);
      setKdriveUploadJobs((old) => ({ ...old, [reelId]: { ...old[reelId], phase: 'error', error: text || 'Nie udało się wgrać pliku. Spróbuj ponownie.' } }));
      // A failed combined start may already have linked the folder (a new Reel version).
      // Pick that up so later saves and Ponów are not checked against a stale version.
      if (createFolder) { try { syncAfterUploadWrite(await api.reel(reelId)); } catch { /* next load refreshes */ } }
    } finally { kdriveUploadControllers.current.delete(reelId); await wakeLock?.release().catch(() => undefined); }
  }, [api, reels, syncAfterUploadWrite]);

  const cancelKdriveUpload = useCallback(async (reelId: string) => {
    const job = kdriveUploadJobs[reelId];
    kdriveUploadControllers.current.get(reelId)?.abort();
    if (job?.uploadId) {
      try { await api.cancelKdriveUpload(job.uploadId); }
      catch (error) {
        const text = error instanceof ClientApiError ? polishError(error) : polishError(error);
        const message = `Nie udało się anulować wysyłania. Sesja kDrive może nadal być aktywna. ${text}`.trim();
        setKdriveUploadJobs((old) => ({ ...old, [reelId]: { ...old[reelId], phase: 'error', error: message } }));
        setMessage(message);
        return;
      }
    }
    setKdriveUploadJobs((old) => { const next = { ...old }; delete next[reelId]; return next; });
  }, [api, kdriveUploadJobs]);

  const retryKdriveAttach = useCallback(async (reelId: string) => {
    const job = kdriveUploadJobs[reelId]; const reel = currentRef.current?.id === reelId ? currentRef.current : reels.find((item) => item.id === reelId);
    if (!job?.uploadId || !reel) return;
    setKdriveUploadJobs((old) => ({ ...old, [reelId]: { ...old[reelId], phase: 'attaching', error: null, finished: true } }));
    try {
      const latest = await api.reel(reelId);
      const saved = await api.attachKdriveUpload(job.uploadId, { operationId: crypto.randomUUID(), expectedVersion: latest.version });
      syncAfterUploadWrite(saved);
      setKdriveUploadJobs((old) => ({ ...old, [reelId]: { ...old[reelId], phase: 'done', percent: 100, error: null } }));
      setMessage(job.purpose === 'cover' ? 'Okładka wgrana i oznaczona jako gotowa.' : 'Eksport wgrany. Sprawdź ponownie.');
    } catch (error) {
      const message = error instanceof ClientApiError ? polishError(error) : polishError(error);
      setKdriveUploadJobs((old) => ({ ...old, [reelId]: { ...old[reelId], phase: 'error', error: message } }));
    }
  }, [api, kdriveUploadJobs, reels, syncAfterUploadWrite]);

  /**
   * Report attachment progress.
   *
   * Silence on an outstanding attachment would be the worst outcome: the user would
   * believe their image was saved while the bytes are still only on this device. An
   * abandoned run says nothing, because the account changed and the work belongs to
   * the previous one.
   */
  const reportAttachments = useCallback((results: readonly AttachmentProgress[]) => {
    const failed = results.filter((result) => !result.abandoned).reduce((total, result) => total + result.failures.length, 0);
    const outstanding = results
      .filter((result) => !result.abandoned)
      .reduce((total, result) => total + result.outstanding.length, 0);
    if (failed > 0) {
      setMessage(failed === 1
        ? 'Nie udało się wysłać jednego zdjęcia. Plik zachowano na tym urządzeniu i można ponowić próbę.'
        : `Nie udało się wysłać ${failed} zdjęć. Pliki zachowano na tym urządzeniu i można ponowić próbę.`);
    } else if (outstanding > 0) {
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
    try {
      if (status !== 'all') { const page = await api.list({ status }); setReels(page.items); }
      else setReels(await listEveryActiveReel(api));
      setLoadState('loaded');
    }
    catch (error) { reportLoadFailure(error); }
  }, [api, reportLoadFailure, status, user]);
  // On the three-pane layout REELS is always on screen, so it loads regardless of the route.
  const listShown = layout === 'drawer' || layout === 'two' || layout === 'three' || route.name === 'list';
  useEffect(() => { if (listShown) void loadList(); }, [loadList, listShown]);

  /**
   * The planner reads every active Reel (all statuses) and derives days and NIEZAPLANOWANE
   * from their plan fields. A reload keeps the previous items on screen instead of blanking.
   */
  const loadPlanner = useCallback(async () => {
    if (!user) return;
    setPlanLoadState((state) => (state === 'loaded' ? state : 'loading'));
    try {
      const items: Reel[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page += 1) {
        const result = await api.list({ limit: 100, cursor });
        items.push(...result.items);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      setPlanReels(items); setPlanLoadState('loaded');
    } catch (error) {
      if (isAbandonedRequest(error)) return;
      setPlanLoadState(navigator.onLine ? 'error' : 'offline');
    }
  }, [api, user]);
  const planShown = layout !== 'single' || route.name === 'plan';
  useEffect(() => { if (planShown) void loadPlanner(); }, [loadPlanner, planShown]);
  /** Refresh after a change the planner cannot derive locally (capture, delete, restore). */
  const refreshPlanner = useCallback(() => { if (planShown) void loadPlanner(); }, [loadPlanner, planShown]);

  /**
   * The open Reel is the freshest copy of itself (including unsent local edits), so the
   * planner and the list show it rather than their last fetched copy. This is how a plan set
   * in Reel Detail appears in the planner immediately, and how later list/planner writes
   * against this Reel use its current version.
   */
  useEffect(() => {
    if (!current) return;
    const sync = (list: Reel[]) => (list.some((item) => item.id === current.id && item !== current)
      ? list.map((item) => (item.id === current.id && current.version >= item.version ? current : item))
      : list);
    setPlanReels(sync); setReels(sync);
  }, [current]);

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
    try {
      if (status !== 'all') { const page = await api.list({ status }); setReels(page.items); }
      else setReels(await listEveryActiveReel(api));
    } catch { /* keep current view */ }
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
    // With PLAN/REELS on screen beside the centre, switching Reels must not blank the list
    // into "Wczytywanie…": the load is quiet and a failure is reported as a notice instead.
    const quiet = layoutRef.current !== 'single';
    // Switching straight to another Reel (one click in PLAN/REELS) sends the previous Reel's
    // debounced edit now rather than letting the next Reel's edit replace it unsent.
    const retainCurrentDraft = async () => {
      const oldReelId = currentRef.current?.id;
      if (!oldReelId || oldReelId === reelId || !pendingPatches.current.has(oldReelId)) return true;
      const retained = await retainPendingDraftBeforeSwitch(
        oldReelId,
        () => pendingPatches.current.has(oldReelId) ? oldReelId : null,
        () => draftWrites.current.get(oldReelId),
        () => {
          const timer = saveTimers.current.get(oldReelId);
          if (timer !== undefined) { window.clearTimeout(timer); saveTimers.current.delete(oldReelId); }
          const flush = flushPending.current.get(oldReelId);
          return flush ? flush().catch((error) => {
            if (currentRef.current?.id === oldReelId) { setSaveState('error'); setMessage(polishError(error)); }
          }) : null;
        },
        () => blockedConflictReels.current.has(oldReelId),
      );
      if (!retained.ok) {
        if (currentRef.current?.id === oldReelId) {
          setSaveState('error');
          setMessage(polishError(retained.error));
          if (!quiet) setLoadState('loaded');
        }
        return false;
      }
      return true;
    };
    if (!await retainCurrentDraft()) return;
    if (!quiet) setLoadState('loading');
    try {
      const reel = await api.reel(reelId, { includeDeleted: true });
      // Drafts are read for the account that is active now, and the id is part of
      // the key, so a draft can only ever be paired with its own account's Reel.
      const draft = user ? await store.reel(user.id, reelId) : undefined;
      // The previous Reel remains editable while this read is in flight. Re-check so a
      // draft typed after the first retention pass is also durable before selection moves.
      if (!await retainCurrentDraft()) return;
      const resolved = draft ? { ...reel, ...draft.changes } : reel;
      currentRef.current = resolved;
      setCurrent(resolved); setSaveState(draft ? 'offline' : 'idle'); if (!quiet) setLoadState('loaded');
      setRoute({ name: 'detail', reelId });
      // `route` alone is in-memory and vanishes on reload. `Kopiuj link` (LIST-01) and
      // reloading while a Reel is open both need the address bar to actually name it.
      const path = `/reels/${encodeURIComponent(reelId)}`;
      if (typeof history !== 'undefined' && location.pathname !== path) history.pushState({ reelId }, '', path);
    } catch (error) {
      if (quiet) { if (!isAbandonedRequest(error)) setMessage(polishError(error)); return; }
      reportLoadFailure(error);
    }
  }, [api, reportLoadFailure, store, user]);

  /** Reads a deep link (`/reels/:id`) on first load, once the session is confirmed. */
  const deepLinkAttempted = useRef(false);
  useEffect(() => {
    if (deepLinkAttempted.current || !user) return;
    deepLinkAttempted.current = true;
    if (typeof location !== 'undefined' && location.pathname === LIVE_PATH) { setRoute({ name: 'live' }); return; }
    const match = typeof location === 'undefined' ? null : location.pathname.match(/^\/reels\/([^/]+)\/?$/);
    if (match) void openDetail(decodeURIComponent(match[1]));
  }, [openDetail, user]);

  /** Browser back/forward on the one URL this app pushes: a deep-linked or opened Reel. */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPopState = () => {
      if (location.pathname === LIVE_PATH) { setRoute({ name: 'live' }); return; }
      if (route.name === 'live') { setRoute(primaryRoute()); return; }
      const match = location.pathname.match(/^\/reels\/([^/]+)\/?$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (!(currentRef.current?.id === id && route.name === 'detail')) void openDetail(id);
      } else if (route.name === 'detail') {
        setRoute(primaryRoute());
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [openDetail, route]);

  /** Undo the address bar's `/reels/:id` when leaving Detail through any success path. */
  const syncListUrl = useCallback(() => {
    if (typeof history !== 'undefined' && location.pathname !== '/') history.pushState({}, '', '/');
  }, []);

  const leaveDetail = useCallback(() => { setRoute(primaryRoute()); syncListUrl(); }, [syncListUrl]);

  const openLive = useCallback(() => {
    setRoute({ name: 'live' });
    if (typeof history !== 'undefined' && location.pathname !== LIVE_PATH) history.pushState({}, '', LIVE_PATH);
  }, []);
  const leaveLive = useCallback(() => { setRoute(primaryRoute()); syncListUrl(); }, [syncListUrl]);

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
      await store.enqueue({ id: capture.draft.operationId, accountId: user.id, kind: 'create', reelId: capture.draft.reelId, createdAt: Date.now(), state: 'pending', payload: createRequestFromDraft(capture.draft) });
      await queue.flush(); const remaining = await store.queue(user.id); const item = remaining.find((x) => x.id === capture.draft.operationId);
      if (item) {
        setSaveState(item.state === 'conflict' ? 'conflict' : item.state === 'failed' ? 'error' : 'offline');
        setMessage(item.state === 'pending' || item.state === 'running'
          ? 'Zapis rolki oczekuje na połączenie z serwerem. Rolka nie została jeszcze utworzona.'
          : item.state === 'conflict' ? 'Nie udało się utworzyć rolki z powodu konfliktu. Dane pozostają na tym urządzeniu.'
            : 'Nie udało się utworzyć rolki. Dane pozostają na tym urządzeniu.');
        return null;
      }
      // The Reel exists now, so the images can go. The draft and its blobs stay until
      // the server acknowledges each attachment, so leaving this screen — or closing
      // the tab mid-upload — loses nothing and the next recovery pass resumes with the
      // same attachment and operation ids.
      const progress = capture.draft.input.images.length === 0
        ? []
        : [await attachments.runCapture({ ...capture.draft, state: 'queued' })];
      const complete = progress.every((item) => item.complete && !item.abandoned);
      setSaveState(complete ? 'saved' : 'idle'); setCapture(null);
      if (withAi && complete) {
        const reel = await api.reel(capture.draft.reelId);
        currentRef.current = reel; setCurrent(reel); setRoute({ name: 'detail', reelId: reel.id });
        return reel;
      }
      await openDetail(capture.draft.reelId);
      refreshPlanner();
      reportAttachments(progress);
      return null;
    } catch (error) { if (isAbandonedRequest(error)) return null; setSaveState('error'); setMessage(polishError(error)); return null; }
  }, [api, attachments, capture, openDetail, queue, refreshPlanner, reportAttachments, store, user]);

  const changeReel = useCallback((changes: ReelPatchRequest['changes'], immediate = false) => {
    const reel = currentRef.current;
    if (!reel || !user) return;
    if (Object.hasOwn(changes, 'publicationSource')) {
      setSourceUndo(null);
      if (sourceUndoTimer.current !== null) window.clearTimeout(sourceUndoTimer.current);
      sourceUndoTimer.current = null;
    }
    const pending = pendingPatches.current.get(reel.id) ?? { reelId: reel.id, expectedVersion: reel.version, changes: {} };
    pending.changes = { ...pending.changes, ...changes }; pendingPatches.current.set(reel.id, pending);
    const next = { ...reel, ...changes }; currentRef.current = next; setCurrent(next); setSaveState('saving');
    const draft: ReelDraft = { id: `${user.id}:${reel.id}`, accountId: user.id, reelId: reel.id, expectedVersion: pending.expectedVersion, changes: pending.changes, updatedAt: Date.now() };
    const revision = ++draftWriteRevision.current;
    const promise: Promise<DraftWriteResult> = enqueueDraftStoreOperation(draftStoreQueues.current, reel.id, () => store.saveReel(draft))
      .then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }));
    const record: DraftWriteRecord = { revision, promise };
    draftWrites.current.set(reel.id, record);
    void promise.then((result) => {
      if (draftWrites.current.get(reel.id) !== record) return;
      if (!result.ok) {
        if (currentRef.current?.id === reel.id) { setSaveState('error'); setMessage(polishError(result.error)); }
        return;
      }
      if (blockedConflictReels.current.has(reel.id)) {
        const existingConflict = conflictsRef.current[reel.id];
        if (existingConflict) {
          const value = (draft.changes as Record<string, unknown>)[existingConflict.field];
          const localValue = Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? '' : String(value);
          setConflictForReel(reel.id, { ...existingConflict, localValue, changes: draft.changes });
          if (currentRef.current?.id === reel.id) setSaveState('conflict');
        }
        return;
      }
      const previousTimer = saveTimers.current.get(reel.id);
      if (previousTimer !== undefined) window.clearTimeout(previousTimer);
      const send = async () => {
        saveTimers.current.delete(reel.id);
        if (flushPending.current.get(reel.id) === send) flushPending.current.delete(reel.id);
        // One save per Reel on the network at a time. Re-checked in a loop because another
        // waiting send may have started (and registered itself) first.
        let sending: { reelId: string; expectedVersion: number; changes: ReelPatchRequest['changes'] } | undefined;
        let consumedWrite: DraftWriteRecord | undefined;
        while (true) {
          const prior = inFlightSaves.current.get(reel.id);
          if (prior) { await prior; continue; }
          if (blockedConflictReels.current.has(reel.id)) return;
          sending = pendingPatches.current.get(reel.id);
          consumedWrite = draftWrites.current.get(reel.id);
          if (!sending || !consumedWrite) return;
          const retained = await consumedWrite.promise;
          // Typing may have produced a newer local write while this callback waited in the
          // network queue. Only send the exact pending revision that is durably retained.
          if (draftWrites.current.get(reel.id) !== consumedWrite || pendingPatches.current.get(reel.id) !== sending) continue;
          if (!retained.ok) {
            if (currentRef.current?.id === reel.id) { setSaveState('error'); setMessage(polishError(retained.error)); }
            return;
          }
          // A second callback may have won the send slot while this one awaited IndexedDB.
          // Re-enter the loop so the version returned by that request is available first.
          if (inFlightSaves.current.has(reel.id)) continue;
          if (blockedConflictReels.current.has(reel.id)) return;
          break;
        }
        pendingPatches.current.delete(reel.id);
        let release!: () => void;
        const mine = new Promise<void>((resolve) => { release = resolve; });
        inFlightSaves.current.set(sending.reelId, mine);
        const sendingDraft: ReelDraft = {
          id: `${user.id}:${sending.reelId}`, accountId: user.id, reelId: sending.reelId,
          expectedVersion: sending.expectedVersion, changes: sending.changes, updatedAt: Date.now(),
        };
        const request = { operationId: crypto.randomUUID(), expectedVersion: sending.expectedVersion, changes: sending.changes };
        try {
          const saved = await api.patch(sending.reelId, request);
          // Edits typed while this save was in flight were based on the same version; our own
          // save is the only change in between, so they are rebased — whether or not this Reel
          // is still the one on screen (a switch flushes them right behind this save).
          const typed = pendingPatches.current.get(saved.id) ?? null;
          if (typed && typed.expectedVersion === sending.expectedVersion) typed.expectedVersion = saved.version;
          // The user may have switched to another Reel while this save was debounced or in
          // flight (one click away in the planner/list panes): it must not replace that one.
          if (currentRef.current?.id === saved.id) {
            const next = typed ? { ...saved, ...typed.changes } : saved;
            currentRef.current = next; setCurrent(next);
          } else {
            const upsert = (list: Reel[]) => list.map((item) => (item.id === saved.id ? saved : item));
            setPlanReels(upsert); setReels(upsert);
          }
          const deletedDraft = await deleteDraftIfNoNewerWrite(consumedWrite.revision, () => draftWrites.current.get(sending.reelId),
            () => enqueueDraftStoreOperation(draftStoreQueues.current, sending.reelId, () => store.deleteReel(user.id, sending.reelId)));
          if (canMarkSavedAfterSend(sending.reelId, currentRef.current?.id ?? null, typed?.reelId ?? null, deletedDraft)) setSaveState('saved');
        }
        catch (error) {
          // Abandoned after an account switch: the draft stays in this account's
          // partition untouched, and nothing is queued or shown against the new one.
          if (isAbandonedRequest(error)) return;
          let localDraftFailure = false;
          if (error instanceof ClientApiError && error.status === 409) {
            blockedConflictReels.current.add(sending.reelId);
            // Stop a newer same-Reel debounce before awaiting storage; otherwise its timer
            // could issue another patch before the conflict decision is available.
            const conflictTimer = saveTimers.current.get(sending.reelId);
            if (conflictTimer !== undefined) { window.clearTimeout(conflictTimer); saveTimers.current.delete(sending.reelId); }
            flushPending.current.delete(sending.reelId);
            // Keep the draft, then read the authoritative value so the user is shown
            // a real comparison rather than "something changed".
            // The request may have been in flight while the author typed a newer draft.
            // Wait for that local write and attach the conflict snapshot to its contents.
            let latestWrite = draftWrites.current.get(sending.reelId);
            let latestWriteResult: DraftWriteResult = { ok: true };
            while (latestWrite && latestWrite.revision > consumedWrite.revision) {
              latestWriteResult = await latestWrite.promise;
              if (draftWrites.current.get(sending.reelId) === latestWrite) break;
              latestWrite = draftWrites.current.get(sending.reelId);
            }
            localDraftFailure = !latestWriteResult.ok;
            const latestDraft = await store.reel(user.id, sending.reelId);
            const newerPending = pendingPatches.current.get(sending.reelId) ?? null;
            const conflictChanges = changesForConflictResolution(latestDraft?.changes, newerPending?.changes, sending.changes);
            const conflictBase = { ...(latestDraft ?? sendingDraft), changes: conflictChanges };
            if (latestWriteResult.ok) {
              const conflictPromise: Promise<DraftWriteResult> = enqueueDraftStoreOperation(draftStoreQueues.current, sending.reelId,
                () => store.saveReel(withConflictSnapshot(conflictBase, sendingDraft, error.api.details)))
                .then(() => ({ ok: true }), (writeError: unknown) => ({ ok: false, error: writeError }));
              const conflictRecord: DraftWriteRecord = { revision: ++draftWriteRevision.current, promise: conflictPromise };
              draftWrites.current.set(sending.reelId, conflictRecord);
              const conflictWriteResult = await conflictPromise;
              if (!conflictWriteResult.ok) {
                localDraftFailure = true;
                if (currentRef.current?.id === sending.reelId) setMessage(polishError(conflictWriteResult.error));
              } else if (pendingPatches.current.has(sending.reelId) && draftWrites.current.get(sending.reelId) === conflictRecord) {
                pendingPatches.current.delete(sending.reelId);
              }
            }
            // A pending debounce must not send while the user is deciding how to resolve
            // this Reel's conflict. Its latest values are now in the conflict draft.
            if (currentRef.current?.id === sending.reelId) {
              setSaveState(localDraftFailure ? 'error' : 'conflict');
              if (localDraftFailure && latestWriteResult.error !== undefined) setMessage(polishError(latestWriteResult.error));
            }
            try {
              const serverReel = await api.reel(sending.reelId);
              const pendingAfterRead = pendingPatches.current.get(sending.reelId) ?? null;
              const finalChanges = changesForConflictResolution(undefined,
                pendingAfterRead?.reelId === sending.reelId ? pendingAfterRead.changes : undefined,
                conflictChanges);
              const field = Object.keys(finalChanges)[0] ?? 'title';
              const read = (source: Record<string, unknown>) => {
                const value = source[field];
                return Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? '' : String(value);
              };
              setConflictForReel(sending.reelId, {
                field,
                localValue: read(finalChanges as Record<string, unknown>),
                serverValue: read(serverReel as unknown as Record<string, unknown>),
                changes: finalChanges,
                serverReel,
              });
            } catch { /* the conflict state alone is still truthful */ }
          }
          else {
            await store.enqueue({ id: request.operationId, accountId: user.id, kind: 'patch', reelId: sending.reelId, createdAt: Date.now(), state: 'pending', payload: request });
            if (currentRef.current?.id === sending.reelId) setSaveState(navigator.onLine ? 'error' : 'offline');
          }
          if (!localDraftFailure && currentRef.current?.id === sending.reelId) setMessage(polishError(error));
        }
        finally {
          release();
          if (inFlightSaves.current.get(sending.reelId) === mine) inFlightSaves.current.delete(sending.reelId);
        }
      };
      flushPending.current.set(reel.id, send);
      saveTimers.current.set(reel.id, window.setTimeout(() => { void send(); }, immediate ? 0 : 600));
    });
  }, [api, setConflictForReel, store, user]);

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
    const pending = pendingPatches.current.get(server.id) ?? null;
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
  const startNewHook = useCallback(() => {
    const reel = currentRef.current; if (!reel) return;
    setNewHook((old) => old?.reelId === reel.id ? old : { reelId: reel.id, text: '', saving: false, error: null, operationId: crypto.randomUUID() });
  }, []);
  const changeNewHook = useCallback((text: string) => {
    setNewHook((old) => old && !old.saving ? { ...old, text, error: null, operationId: text === old.text ? old.operationId : crypto.randomUUID() } : old);
  }, []);
  const cancelNewHook = useCallback(() => { setNewHook((old) => old?.saving ? old : null); }, []);
  const saveNewHook = useCallback(async () => {
    const reel = currentRef.current; const draft = newHook;
    if (!reel || !user || !draft || draft.reelId !== reel.id || draft.saving) return;
    if (draft.text.trim() === '') { setNewHook({ ...draft, error: 'Hook nie może być pusty.' }); return; }
    setNewHook({ ...draft, saving: true, error: null });
    try {
      const saved = await api.addHook(reel.id, { operationId: draft.operationId, expectedVersion: reel.version, text: draft.text });
      acceptServerReel(reel, saved, true);
      setNewHook(null);
    } catch (error) {
      if (isAbandonedRequest(error)) return;
      let message = error instanceof ClientApiError
        ? `Hook nie został dodany. ${polishError(error)}`
        : 'Brak połączenia. Hook nie został dodany — tekst pozostaje w polu.';
      let operationId = draft.operationId;
      if (error instanceof ClientApiError && error.status === 409) {
        // Adding is additive: after picking up the current Reel, Gotowe can simply retry.
        await refreshAfterRefusal(reel);
        message = 'Rolka zmieniła się w międzyczasie. Twój hook jest zachowany — naciśnij Gotowe, aby dodać go ponownie.';
        operationId = crypto.randomUUID();
      }
      setNewHook({ ...draft, saving: false, error: message, operationId });
    }
  }, [acceptServerReel, api, newHook, refreshAfterRefusal, user]);

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
    try {
      await api.remove(current.id, request);
      setPlanReels((list) => list.filter((item) => item.id !== current.id));
      setCurrent(null); setRoute(primaryRoute()); syncListUrl(); setSaveState('saved');
    }
    catch (error) {
      if (isAbandonedRequest(error)) return;
      const conflict = error instanceof ClientApiError && error.status === 409;
      await store.enqueue({ id: request.operationId, accountId: user.id, kind: 'delete', reelId: current.id, createdAt: Date.now(), state: conflict ? 'conflict' : 'pending', payload: request });
      setSaveState(conflict ? 'conflict' : 'offline'); setMessage(polishError(error));
    }
  }, [api, current, store, syncListUrl, user]);

  const restore = useCallback(async (reel: Reel) => {
    if (!user) return; const request = { operationId: crypto.randomUUID(), expectedVersion: reel.version };
    try { await api.restore(reel.id, request); setRoute({ name: 'list' }); syncListUrl(); refreshPlanner(); }
    catch (error) {
      if (isAbandonedRequest(error)) return;
      const conflict = error instanceof ClientApiError && error.status === 409;
      await store.enqueue({ id: request.operationId, accountId: user.id, kind: 'restore', reelId: reel.id, createdAt: Date.now(), state: conflict ? 'conflict' : 'pending', payload: request }); setMessage(polishError(error));
    }
  }, [api, refreshPlanner, store, syncListUrl, user]);

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
      setPlanReels((list) => (list.some((item) => item.id === id) ? list.map((item) => (item.id === id ? saved : item)) : [...list, saved]));
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
      setPlanReels((list) => list.filter((item) => item.id !== id));
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

  /**
   * Set, move or clear one Reel's publication plan (CONTENT-PLANNER-01). Every surface —
   * planner, list quick action, Reel Detail — calls this, and it only ever writes the two
   * plan fields of that Reel through the ordinary PATCH; the server owns idea promotion.
   *
   * The open Reel goes through `changeReel`, the same debounced, draft-backed save as every
   * other Detail edit, so a plan change cannot race an unsent script edit into a conflict.
   * Any other Reel uses the list's version-checked `patchReelById`.
   */
  const scheduleReel = useCallback(async (id: string, date: string | null, slot: PublicationSlot | null): Promise<{ ok: boolean; message: string; promoted?: boolean }> => {
    const changes = planChanges(date, slot);
    if (currentRef.current?.id === id && route.name === 'detail') {
      const before = currentRef.current;
      changeReel(changes);
      const flush = flushPending.current.get(id);
      if (flush) await flush();
      try {
        const saved = await api.reel(id);
        const ok = saved.plannedPublicationDate === date;
        return { ok, message: ok ? '' : 'Nie udało się zapisać terminu.', promoted: ok && before.status === 'idea' && saved.status === 'to_record' };
      } catch (error) { return { ok: false, message: polishError(error) }; }
    }
    let base = planReels.find((item) => item.id === id) ?? reels.find((item) => item.id === id);
    if (!base) {
      try { base = await api.reel(id); } catch (error) { return { ok: false, message: polishError(error) }; }
    }
    const result = await patchReelById(id, base.version, changes);
    return result.ok ? { ok: true, message: '', promoted: base.status === 'idea' && result.reel.status === 'to_record' } : { ok: false, message: result.message };
  }, [api, changeReel, patchReelById, planReels, reels, route.name]);

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
    if (!pending || !user || currentRef.current?.id !== pending.serverReel.id) return;
    const reelId = pending.serverReel.id;
    const timer = saveTimers.current.get(reelId);
    if (timer !== undefined) { window.clearTimeout(timer); saveTimers.current.delete(reelId); }
    flushPending.current.delete(reelId);
    pendingPatches.current.delete(reelId);
    if (choice === 'server') {
      currentRef.current = pending.serverReel; setCurrent(pending.serverReel);
      await enqueueDraftStoreOperation(draftStoreQueues.current, reelId, () => store.deleteReel(user.id, reelId));
      setConflictForReel(reelId, null);
      if (currentRef.current?.id === reelId) setSaveState('idle');
      return;
    }
    setSaveState('saving');
    try {
      const saved = await api.patch(pending.serverReel.id, {
        operationId: crypto.randomUUID(),
        expectedVersion: pending.serverReel.version,
        changes: pending.changes,
      });
      if (currentRef.current?.id === saved.id) { currentRef.current = saved; setCurrent(saved); }
      await enqueueDraftStoreOperation(draftStoreQueues.current, saved.id, () => store.deleteReel(user.id, saved.id));
      setConflictForReel(reelId, null);
      if (currentRef.current?.id === saved.id) setSaveState('saved');
    } catch (error) { if (isAbandonedRequest(error)) return; if (currentRef.current?.id === pending.serverReel.id) { setSaveState('error'); setMessage(polishError(error)); } }
  }, [api, conflict, setConflictForReel, store, user]);

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

  const mergeSourceMetadata = useCallback((reelId: string, sourceMetadata: Reel['sourceMetadata']) => {
    if (currentRef.current?.id !== reelId) return;
    const next = { ...currentRef.current, sourceMetadata };
    currentRef.current = next; setCurrent(next);
  }, []);
  const checkSourceMetadata = useCallback(async (reelId?: string) => {
    const targetId = reelId ?? currentRef.current?.id;
    if (!targetId) return;
    try { const fresh = await api.reel(targetId); mergeSourceMetadata(targetId, fresh.sourceMetadata); }
    catch { /* polling is best-effort; manual Sprawdź remains available */ }
  }, [api, mergeSourceMetadata]);
  const refreshSourceMetadata = useCallback(async () => {
    const reel = currentRef.current;
    if (!reel) return;
    try {
      const response = await api.refreshSourceMetadata(reel.id, crypto.randomUUID());
      mergeSourceMetadata(reel.id, response.sourceMetadata);
    } catch (error) { if (!isAbandonedRequest(error)) setMessage(polishError(error)); }
  }, [api, mergeSourceMetadata]);
  const restoreAutomaticSource = useCallback(async () => {
    const reel = currentRef.current;
    if (!reel || reel.publicationSource === null) return;
    const oldText = reel.publicationSource;
    if (sourceUndoTimer.current !== null) window.clearTimeout(sourceUndoTimer.current);
    changeReel({ publicationSource: null }, true);
    setSourceUndo({ reelId: reel.id, text: oldText });
    sourceUndoTimer.current = window.setTimeout(() => { setSourceUndo(null); sourceUndoTimer.current = null; }, 30_000);
    setMessage('Przywrócono automatyczne źródło.');
  }, [changeReel]);
  const undoRestoreSource = useCallback(() => {
    const undo = sourceUndo;
    if (!undo || currentRef.current?.id !== undo.reelId) return;
    if (sourceUndoTimer.current !== null) window.clearTimeout(sourceUndoTimer.current);
    sourceUndoTimer.current = null; setSourceUndo(null); changeReel({ publicationSource: undo.text });
  }, [changeReel, sourceUndo]);

  const copyPublication = useCallback(async () => {
    if (!current) return; const { publicationDescription: description, publicationHashtags: hashtags } = current;
    // During the Cofnij window the restored automatic value is the truth; the old manual
    // text is only held for undo, never displayed or copied.
    const source = current.publicationSource ?? current.sourceMetadata?.line ?? '';
    const value = composePublicationText(description, source, hashtags);
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
    if (sourceUndoTimer.current !== null) window.clearTimeout(sourceUndoTimer.current);
    sourceUndoTimer.current = null; setSourceUndo(null);
    for (const controller of kdriveUploadControllers.current.values()) controller.abort();
    kdriveUploadControllers.current.clear(); setKdriveUploadJobs({});
    for (const timer of saveTimers.current.values()) window.clearTimeout(timer);
    saveTimers.current.clear();
    pendingPatches.current.clear();
    flushPending.current.clear();
    draftWrites.current.clear(); draftWriteRevision.current++;
    draftStoreQueues.current.clear();
    inFlightSaves.current.clear();
    currentRef.current = null;
    conflictsRef.current = {}; blockedConflictReels.current.clear();
    setCurrent(null); setCapture(null); setReels([]); setDeleted([]); setConflictsByReel({});
    setPlanReels([]); setPlanLoadState('idle');
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
  const hasUnsavedChanges = useCallback(() => {
    const activeReelId = currentRef.current?.id;
    const hasScalarDraft = activeReelId !== undefined && (pendingPatches.current.has(activeReelId) || inFlightSaves.current.has(activeReelId));
    return hasScalarDraft || hasUnfinishedHookEditForReel(hookEdits, activeReelId) ||
      (newHook !== null && newHook.reelId === activeReelId && newHook.text !== '') ||
      ['saving', 'conflict', 'offline', 'error'].includes(saveState) || conflict !== null;
  }, [conflict, hookEdits, newHook, saveState]);

  const counts = useMemo(() => Object.fromEntries((['idea', 'to_record', 'editing', 'ready', 'published'] as ReelStatus[]).map((s) => [s, s === status ? reels.length : undefined])), [reels.length, status]);
  return { openLive, leaveLive, user, peer, authStatus, route, setRoute, status, setStatus, reels, current, capture, loadState, saveState, message, setMessage, counts, recover, loadList, openDetail, leaveDetail, acceptReel, startCapture, updateCapture, addFiles, submitCapture, changeReel, removeHook, selectHook, hookSelecting,
    hookEdits, startHookEdit, changeHookEdit, cancelHookEdit, saveHookEdit, deleteCurrent,
    newHook: newHook && newHook.reelId === current?.id ? newHook : null, startNewHook, changeNewHook, cancelNewHook, saveNewHook, restore, copyPublication,
    deleted, loadDeleted, conflict, resolveConflict, replaceExport, verifyExport, signOut, signInAs,
    sourceUndo: sourceUndo?.reelId === current?.id ? sourceUndo : null, refreshSourceMetadata, checkSourceMetadata, restoreAutomaticSource, undoRestoreSource,
    patchReelById, removeReelById, copyReelLink, hasUnsavedChanges,
    layout, setLayout, planReels, planLoadState, loadPlanner, scheduleReel, kdriveUploadJobs, startKdriveUpload, cancelKdriveUpload, retryKdriveAttach };
}

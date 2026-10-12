import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import './App.css';
import type { Reel, ReelStatus } from '../../../../packages/contracts/src/index.js';
import { Login } from '../auth/Login.js';
import type { BrowserSession } from '../auth/session.js';
import type { CoreApiClient } from '../data/api.js';
import type { DraftStore } from '../drafts/store.js';
import type { SyncQueue } from '../drafts/queue.js';
import type { AttachmentRecovery } from '../data/attachment-recovery.js';
import { reelLabel } from '../data/reel-label.js';
import { streamDeleteConfirmBody } from '../data/streams.js';
import { detailPrimaryAction, isReadOnlyReel } from '../data/detail-actions.js';
import { SCRIPT_REQUIRED, UNSAVED_BEFORE_PUBLICATION, polishError } from '../data/errors.js';
import { useAppController } from '../controllers/useAppController.js';
import { QuickAddScreen } from '../screens/QuickAddScreen.js';
import { ReelDetailScreen } from '../screens/ReelDetailScreen.js';
import { ReelListScreen } from '../screens/ReelListScreen.js';
import { LiveScreen } from '../screens/LiveScreen.js';
import { DeletedReelsScreen } from '../screens/DeletedReelsScreen.js';
import { AiWorkspace } from '../screens/AiWorkspace.js';
import { MemePicker } from '../screens/MemePicker.js';
import { PlannerPane } from '../screens/PlannerPane.js';
import { ScheduleSheet } from '../screens/ScheduleSheet.js';
import { localIsoDate, planLabel, planOf, type PublicationSlot } from '../data/planner.js';
import { useWorkspaceLayout } from '../ui/workspace-layout.js';
import { kdriveCommandMessage, kdriveFolderView, kdriveWebUrl, parseKdriveFolderInput, type KdriveViewState } from '../data/kdrive.js';
import {
  COPY,
  STATUS_LABELS,
  STATUS_TAB_LABELS,
  statusChangedLabel,
  type AutoDraftRowView,
  type ConflictRecoveryView,
  type EditorView,
  type ListQuickActionsView,
  type ReelListItemView,
  type MetadataSelector,
  type SaveState,
  type VerificationViewState,
} from '../ui/screen-contracts.js';

/** D7: the unique non-empty topic source lines of a stream, in topic order. */
function streamSourceLinesOf(reel: Reel): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const topic of reel.topics) {
    const line = topic.source.sourceLine;
    if (line === '' || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

export function App({ auth, api, store, queue, attachments }: { auth: BrowserSession; api: CoreApiClient; store: DraftStore; queue: SyncQueue; attachments: AttachmentRecovery }) {
  const c = useAppController(auth, api, store, queue, attachments);
  type DetailSection = 'sources' | 'materials' | 'notes' | 'publication';
  const [sectionOverrides, setSectionOverrides] = useState<Record<string, Partial<Record<DetailSection, boolean>>>>({});
  const [articleLinkFocus, setArticleLinkFocus] = useState(0);
  const sectionDefaults = useRef<Record<string, Record<DetailSection, boolean>>>({});
  const [openSelector, setOpenSelector] = useState<MetadataSelector | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [aiCapability, setAiCapability] = useState({ enabled: false, programmeIndexed: false });
  const [sourceLongWait, setSourceLongWait] = useState(false);
  const [sourceCheckEpoch, setSourceCheckEpoch] = useState(0);
  const currentDetailId = c.route.name === 'detail' ? c.route.reelId : null;
  const publicationIsExpanded = currentDetailId
    ? sectionOverrides[currentDetailId]?.publication ?? sectionDefaults.current[currentDetailId]?.publication ?? false
    : false;
  useEffect(() => {
    const metadata = c.current?.id === currentDetailId ? c.current.sourceMetadata : null;
    if (!currentDetailId || !publicationIsExpanded || metadata?.state !== 'pending') { setSourceLongWait(false); return; }
    setSourceLongWait(false);
    const started = Date.now();
    const poll = window.setInterval(() => {
      if (Date.now() - started >= 4 * 60_000) { window.clearInterval(poll); setSourceLongWait(true); return; }
      void c.checkSourceMetadata(currentDetailId);
    }, 5_000);
    return () => window.clearInterval(poll);
  }, [currentDetailId, publicationIsExpanded, c.current?.sourceMetadata?.requestId, c.current?.sourceMetadata?.state, sourceCheckEpoch]);

  // ── CONTENT-PLANNER-01 ────────────────────────────────────────────────────
  const workspaceLayout = useWorkspaceLayout(c.user?.id);
  const layout = workspaceLayout.layout;
  const [leftView, setLeftView] = useState<'list' | 'plan'>('list');
  const [drawerView, setDrawerView] = useState<'list' | 'plan' | null>(null);
  /**
   * The side drawer is modal while open: focus moves into it, Tab stays inside, Escape closes
   * it and focus returns to what opened it — the same contract as the list quick-actions sheet.
   */
  const drawerRef = useRef<HTMLElement>(null);
  const drawerShellRef = useRef<HTMLDivElement>(null);
  const drawerReturnFocus = useRef<HTMLElement | null>(null);
  const drawerFocusable = () => Array.from(drawerRef.current?.querySelectorAll<HTMLElement>(
    'button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  ) ?? []).filter((element) => element.offsetParent !== null);
  useEffect(() => {
    if (!drawerView) return;
    if (!drawerRef.current?.contains(document.activeElement)) {
      drawerReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    drawerFocusable()[0]?.focus();
  }, [drawerView]);
  useEffect(() => {
    const shell = drawerShellRef.current;
    if (!shell) return;
    if (drawerView) shell.setAttribute('inert', '');
    else shell.removeAttribute('inert');
  }, [drawerView]);
  const closeDrawer = () => {
    setDrawerView(null);
    const target = drawerReturnFocus.current;
    drawerReturnFocus.current = null;
    // A selection may have removed the opener; focus then stays wherever the page puts it.
    if (target?.isConnected) window.requestAnimationFrame(() => target.focus());
  };
  const onDrawerKeyDown = (event: ReactKeyboardEvent) => {
    // A sheet opened from inside the drawer handles its own Escape first.
    if (event.key === 'Escape' && !event.defaultPrevented) { event.stopPropagation(); closeDrawer(); return; }
    if (event.key !== 'Tab') return;
    const focusable = drawerFocusable();
    if (focusable.length === 0) { event.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const [listQuery, setListQuery] = useState('');
  const setLayout = (next: 'two' | 'three' | 'focus') => {
    workspaceLayout.setLayout(next);
    c.setLayout(next);
  };
  useEffect(() => { c.setLayout(layout); }, [layout, c.setLayout]);
  const [today, setToday] = useState(() => localIsoDate(new Date()));
  // Keeps DZIŚ honest across midnight in a tab left open.
  useEffect(() => { const timer = window.setInterval(() => setToday(localIsoDate(new Date())), 60_000); return () => window.clearInterval(timer); }, []);
  const [weekOffset, setWeekOffset] = useState(0);
  const [scheduleFor, setScheduleFor] = useState<string | null>(null);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const openSchedule = (id: string) => { setScheduleError(null); setScheduleSaving(false); setScheduleFor(id); };
  const closeSchedule = () => { setScheduleFor(null); setScheduleError(null); setScheduleSaving(false); };
  const applySchedule = async (id: string, date: string | null, slot: PublicationSlot | null) => {
    setScheduleSaving(true); setScheduleError(null);
    const result = await c.scheduleReel(id, date, slot);
    setScheduleSaving(false);
    if (result.ok) {
      closeSchedule();
      if (result.promoted) c.setMessage(COPY.scheduleIdeaPromoted);
    }
    else if (result.message) setScheduleError(result.message);
  };
  /** Desktop drag and drop: a new day keeps the Reel's explicit slot; NIEZAPLANOWANE clears both. */
  const moveReel = async (id: string, date: string | null) => {
    const reel = c.planReels.find((item) => item.id === id);
    const result = await c.scheduleReel(id, date, date === null ? null : reel ? planOf(reel).slot : null);
    if (!result.ok && result.message) c.setMessage(result.message);
    else if (result.promoted) c.setMessage(COPY.scheduleIdeaPromoted);
  };

  // ── LIST-01: list-row quick actions (long-press / swipe) ──────────────────
  const [quickOpenReelId, setQuickOpenReelId] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState<ListQuickActionsView>(null);
  const [quickError, setQuickError] = useState<string | null>(null);
  const [quickConfirmDeleteId, setQuickConfirmDeleteId] = useState<string | null>(null);
  const [quickSaveState, setQuickSaveState] = useState<SaveState>('idle');
  const [radialAnchor, setRadialAnchor] = useState<{ x: number; y: number } | null>(null);
  const [undo, setUndo] = useState<{ reelId: string; fromStatus: ReelStatus; version: number; message: string } | null>(null);
  const [undoSaveState, setUndoSaveState] = useState<SaveState>('idle');
  const undoTimer = useRef<number>();

  const closeQuickActions = () => {
    setQuickOpen(null); setQuickOpenReelId(null); setQuickError(null); setQuickConfirmDeleteId(null); setQuickSaveState('idle'); setRadialAnchor(null);
  };
  // With the sheet open, an error belongs right next to the picker that produced it — the
  // same place Reel Detail's own selectors show one. A bare swipe commit has no sheet open
  // to show it in, so it falls back to the ordinary app-wide notice.
  const reportQuickError = (message: string) => { if (quickOpen !== null) setQuickError(message); else c.setMessage(message); };
  const clearUndoTimer = () => { if (undoTimer.current) { window.clearTimeout(undoTimer.current); undoTimer.current = undefined; } };
  const scheduleUndoClear = () => { clearUndoTimer(); undoTimer.current = window.setTimeout(() => setUndo(null), 6000); };
  useEffect(() => clearUndoTimer, []);

  const applyQuickStatus = async (id: string, status: ReelStatus) => {
    const item = c.reels.find((reel) => reel.id === id);
    if (!item) return;
    // The frozen publish gate, checked before the request exactly as Detail checks it.
    if (status === 'published' && !item.feedCoverDone) { reportQuickError(COPY.feedCoverRequired); return; }
    const previousStatus = item.status;
    const result = await c.patchReelById(id, item.version, { status });
    if (result.ok) {
      closeQuickActions();
      setUndo({ reelId: id, fromStatus: previousStatus, version: result.reel.version, message: statusChangedLabel(STATUS_LABELS[status]) });
      scheduleUndoClear();
    } else if (result.message) reportQuickError(result.message);
  };

  const applyQuickEditor = async (id: string, editorId: string | null) => {
    const item = c.reels.find((reel) => reel.id === id);
    if (!item) return;
    const result = await c.patchReelById(id, item.version, { editorId });
    if (result.ok) closeQuickActions();
    else if (result.message) reportQuickError(result.message);
  };

  const confirmQuickDelete = async () => {
    const id = quickConfirmDeleteId;
    const item = id ? c.reels.find((reel) => reel.id === id) : undefined;
    if (!id || !item) return;
    setQuickSaveState('saving');
    const result = await c.removeReelById(id, item.version);
    if (result.ok) { setQuickSaveState('saved'); closeQuickActions(); }
    else { setQuickSaveState('error'); setQuickError(result.message); }
  };

  /** Version-safe: a 409 here means someone else changed the Reel since the move, so the
   * undo is refused rather than forced — never overwriting their intervening edit. */
  const onUndoStatus = async () => {
    if (!undo) return;
    clearUndoTimer();
    setUndoSaveState('saving');
    const result = await c.patchReelById(undo.reelId, undo.version, { status: undo.fromStatus });
    setUndoSaveState('idle');
    setUndo(null);
    if (!result.ok && result.message) c.setMessage(result.message);
  };
  /**
   * The AI workspace and the meme picker belong to one Reel, so each remembers which Reel
   * opened it and is ignored for any other.
   *
   * Without the `reelId` they outlived their Reel. An incoming Android share routes straight
   * to Quick Add from an open workspace, and saving that capture returns to the list with
   * `aiView` still set — so the next Reel opened jumped into an AI workspace nobody asked
   * for and, finding no saved run for it, started a fresh provider call.
   *
   * Scoping the state is used rather than clearing it from an effect on route change: the
   * `Opracuj` path sets the new route and then `aiView` in a later microtask, and a passive
   * effect would run after both and wipe the workspace the user explicitly asked for.
   */
  const [aiView, setAiView] = useState<{ reelId: string; view: 'develop' | 'generate_hooks' | 'fact_check' | 'language_check' | 'find_programme' | 'generate_publication' | 'attached_programme'; autoStart: boolean } | null>(null);
  const [memeReelId, setMemeReelId] = useState<string | null>(null);
  const [memeNames, setMemeNames] = useState<Array<{ id: string; name: string; mediaKind?: 'image' | 'video' }>>([]);

  useEffect(() => {
    if (!c.user) { setAiView(null); setMemeReelId(null); setAiCapability({ enabled: false, programmeIndexed: false }); return; }
    let live = true;
    void api.aiCapabilities().then((value) => { if (live) setAiCapability(value); }).catch(() => undefined);
    return () => { live = false; };
  }, [api, c.user?.id]);
  useEffect(() => {
    if (!c.current) { setMemeNames([]); return; }
    let live = true;
    void api.memes().then(({ items }) => { if (live) setMemeNames(items.filter((item) => c.current?.memeIds.includes(item.id)).map(({ id, name, mediaKind }) => ({ id, name, mediaKind }))); }).catch(() => undefined);
    return () => { live = false; };
  }, [api, c.current?.id, c.current?.memeIds.join(',')]);

  // ── KDRIVE-01b: the open Reel's kDrive folder, resolved by the server ──────
  // Keyed by Reel so a late answer for one Reel never shows under another.
  const [kdriveStates, setKdriveStates] = useState<Record<string, KdriveViewState>>({});
  /** Whether this server has kDrive configured; unknown until a first resolve answers. */
  const [kdriveConfigured, setKdriveConfigured] = useState<boolean | null>(null);
  const [kdriveBusy, setKdriveBusy] = useState(false);
  const kdriveReelId = c.route.name === 'detail' ? c.current?.id ?? null : null;
  const kdriveFolderKey = c.current?.kdriveFolder ? `${c.current.kdriveFolder.driveId}/${c.current.kdriveFolder.folderId}` : '';
  const resolveKdrive = (reelId: string) => {
    setKdriveStates((old) => ({ ...old, [reelId]: { state: 'loading' } }));
    void api.kdriveFolder(reelId).then((state) => {
      setKdriveStates((old) => ({ ...old, [reelId]: state }));
      // Only `none` says unambiguously whether kDrive is configured; `unavailable` may just be
      // a temporary outage, so it never disables the actions.
      if (state.state === 'none') setKdriveConfigured(state.configured);
    }).catch(() => setKdriveStates((old) => ({ ...old, [reelId]: { state: 'error' } })));
  };
  useEffect(() => {
    if (!kdriveReelId || !c.user) return;
    resolveKdrive(kdriveReelId);
    // Re-resolve when the stored reference itself changes, not on every scalar edit.
  }, [api, kdriveReelId, kdriveFolderKey, c.user?.id]);

  /**
   * Explicit create or relink. Refused while an edit of this Reel is still being saved, because
   * the command is version-checked against the saved Reel and would otherwise conflict.
   */
  const commandKdrive = async (reel: Reel, request: { mode: 'create' } | { mode: 'link'; folderId: string }) => {
    if (kdriveBusy) return;
    if (c.hasUnsavedChanges()) { c.setMessage('Poczekaj, aż zmiany w rolce zostaną zapisane, i spróbuj ponownie.'); return; }
    setKdriveBusy(true);
    try {
      const result = await api.commandKdriveFolder(reel.id, { operationId: crypto.randomUUID(), expectedVersion: reel.version, ...request });
      if (c.current?.id === reel.id) c.acceptReel(result.reel);
      setKdriveStates((old) => ({ ...old, [reel.id]: result.folder }));
      setKdriveConfigured(true);
      c.setMessage(request.mode === 'create' ? 'Utworzono folder kDrive.' : 'Połączono folder kDrive.');
    } catch (error) {
      c.setMessage(kdriveCommandMessage(error as never));
    } finally {
      setKdriveBusy(false);
    }
  };
  const relinkKdrive = (reel: Reel) => {
    const raw = window.prompt('Wklej link do folderu w kDrive albo jego numer');
    if (raw === null) return;
    const folderId = parseKdriveFolderInput(raw);
    if (!folderId) { c.setMessage('To nie jest link do folderu kDrive ani jego numer.'); return; }
    void commandKdrive(reel, { mode: 'link', folderId });
  };

  // STREAM-01 (D9): the list quick-actions delete dialog's body for every stream with
  // absorbed topics, keyed by Reel id. A stream with no absorbed topics is absent, so its
  // dialog keeps the exact Reel wording.
  const streamDeleteConfirmBodies = useMemo(() => {
    const bodies: Record<string, string> = {};
    for (const reel of c.reels) {
      if (reel.format !== 'stream') continue;
      const absorbedTopicCount = reel.topics.filter((topic) => topic.kind === 'absorbed').length;
      if (absorbedTopicCount > 0) bodies[reel.id] = streamDeleteConfirmBody(reelLabel(reel).text, absorbedTopicCount);
    }
    return bodies;
  }, [c.reels]);

  const previews = useMemo(
    () => c.capture?.draft.input.images.map((image) => ({
      id: image.attachmentId,
      fileName: image.fileName,
      previewUrl: c.capture?.blobs.get(image.attachmentId)
        ? URL.createObjectURL(c.capture.blobs.get(image.attachmentId)!)
        : null,
    })) ?? [],
    [c.capture],
  );

  // 'unknown' is the state before the server has answered at all. Rendering the
  // login form then would flash it at a user who is in fact still signed in, so the
  // bootstrap is awaited instead.
  if (c.authStatus === 'unknown') return <main className="auth-shell"><p>Ładowanie…</p></main>;
  if (!c.user) {
    // An unreachable server is not a logout. The distinction is shown, and the
    // retry re-asks rather than silently leaving the user on a login form that
    // cannot succeed. Local drafts are untouched either way.
    return <>
      <Login auth={auth} onSignedIn={c.recover} />
      {c.authStatus === 'unreachable' ? (
        <div className="app-notice" role="status">
          <span>Brak połączenia z serwerem. Wersje robocze pozostają na tym urządzeniu.</span>
          <button onClick={() => void c.recover()} aria-label="Ponów próbę">↻</button>
        </div>
      ) : null}
    </>;
  }

  const notice = c.message ? (
    <div className="app-notice" role="status">
      <span>{c.message}</span>
      <button onClick={() => c.setMessage(null)} aria-label="Zamknij">×</button>
    </div>
  ) : null;

  /** Resolve an editor id to a view, using only the two known identities. */
  const editorOf = (editorId: string | null): EditorView | null =>
    editorId === c.user?.id ? c.user : editorId === c.peer?.id ? c.peer : null;

  const toListItem = (reel: Reel): ReelListItemView => {
    // Capture never writes a title, so an untitled Reel is labelled from the capture it
    // already carries. Derived labels are flagged, not disguised as authored ones.
    const label = reelLabel(reel);
    return {
      id: reel.id,
      version: reel.version,
      status: reel.status,
      hasKdriveFolder: reel.kdriveFolder !== null,
      title: label.text,
      titleIsDerived: label.derived,
      sourceDomain: label.sourceDomain,
      priority: reel.priority,
      editor: editorOf(reel.editorId),
      isOverdue: false,
      elapsedLabel: null,
      verificationState: reel.verificationState,
      programmeState: reel.programmeState,
      memeName: null,
      feedCoverDone: reel.feedCoverDone,
      planLabel: planLabel(planOf(reel), today),
      format: reel.format,
    };
  };

  /** Build the conflict-recovery view. Rendering it never resolves anything. */
  const conflictView = (): ConflictRecoveryView | undefined => (c.conflict ? {
    field: c.conflict.field,
    localValue: c.conflict.localValue,
    serverValue: c.conflict.serverValue,
    onKeepLocal: () => void c.resolveConflict('local'),
    onUseServer: () => void c.resolveConflict('server'),
    onDismiss: () => void c.resolveConflict('server'),
  } : undefined);

  if (c.route.name === 'capture' && c.capture) {
    const form = c.capture;
    const pick = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png,image/webp';
      input.multiple = true;
      input.onchange = () => { if (input.files) c.addFiles(input.files); };
      input.click();
    };
    return <>{notice}<QuickAddScreen
      onBack={() => c.setRoute({ name: 'list' })}
      detectedKind={form.detectedKind}
      selectedKind={form.kind}
      onChangeKind={(kind) => c.updateCapture((x) => ({ ...x, kind }))}
      url={form.draft.input.url ?? ''}
      onChangeUrl={(url) => c.updateCapture((x) => ({ ...x, draft: { ...x.draft, input: { ...x.draft.input, url } } }))}
      images={previews}
      onAddImage={pick}
      onRemoveImage={(id) => c.updateCapture((x) => {
        const blobs = new Map(x.blobs); blobs.delete(id);
        return { ...x, blobs, draft: { ...x.draft, input: { ...x.draft.input, images: x.draft.input.images.filter((i) => i.attachmentId !== id) } } };
      })}
      text={form.draft.input.text ?? ''}
      onChangeText={(text) => c.updateCapture((x) => ({ ...x, draft: { ...x.draft, input: { ...x.draft.input, text } } }))}
      textMode={form.draft.textMode ?? 'idea'}
      onChangeTextMode={(textMode) => c.updateCapture((x) => ({ ...x, draft: { ...x.draft, textMode } }))}
      showAccompanyingText={form.showAdditional}
      onRevealAccompanyingText={() => c.updateCapture((x) => ({ ...x, showAdditional: true }))}
      accompanyingText={form.draft.input.additionalText ?? ''}
      onChangeAccompanyingText={(additionalText) => c.updateCapture((x) => ({ ...x, draft: { ...x.draft, input: { ...x.draft.input, additionalText } } }))}
      showHookField={form.showHook}
      onRevealHookField={() => c.updateCapture((x) => ({ ...x, showHook: true }))}
      initialHook={form.draft.initialHook ?? ''}
      onChangeInitialHook={(initialHook) => c.updateCapture((x) => ({ ...x, draft: { ...x.draft, initialHook } }))}
      priority={form.draft.priority}
      onChangePriority={(priority) => c.updateCapture((x) => ({ ...x, draft: { ...x.draft, priority } }))}
      // D2: a stream requires only a non-empty trimmed title; its capture is optional. A reel
      // keeps the existing "text, URL or image" rule.
      canSave={(form.draft.format ?? 'reel') === 'stream'
        ? Boolean((form.draft.streamTitle ?? '').trim())
        : Boolean(form.draft.input.text || form.draft.input.url || form.draft.input.images.length)}
      onSave={() => void c.submitCapture()}
      onOpracuj={() => { void c.submitCapture(true).then((saved) => {
        if (!saved) return;
        if (aiCapability.enabled) setAiView({ reelId: saved.id, view: 'develop', autoStart: true });
        else c.setMessage('Opracuj jest teraz niedostępne. Pomysł został zapisany.');
      }); }}
      saveState={c.saveState}
      autoDraftPending={c.autoDraftPending}
      // D2: the compact ROLKA | STREAM selector. Android Share Target always opens with no
      // `format` on the draft, which defaults to 'reel' here — the selector itself stays
      // available regardless.
      format={form.draft.format ?? 'reel'}
      onChangeFormat={(format) => c.updateCapture((x) => ({ ...x, draft: { ...x.draft, format } }))}
      streamTitle={form.draft.streamTitle ?? ''}
      onChangeStreamTitle={(streamTitle) => c.updateCapture((x) => ({ ...x, draft: { ...x.draft, streamTitle } }))}
    /></>;
  }

  if (c.route.name === 'live' && c.user) {
    return <>{notice}<LiveScreen api={api} user={c.user} onBack={c.leaveLive} /></>;
  }

  if (c.route.name === 'deleted') {
    return <>{notice}<DeletedReelsScreen
      onBack={() => c.setRoute({ name: 'list' })}
      loadState={c.loadState}
      items={c.deleted.map(toListItem)}
      onOpenReel={(id) => void c.openDetail(id)}
      onRetry={() => void c.loadDeleted()}
    /></>;
  }

  /** The open Reel — Detail or one of its overlays — for the full screen or the centre pane. */
  const renderDetail = (): JSX.Element | null => {
    if (!(c.route.name === 'detail' && c.current)) return null;
    const reel = c.current;
    const defaults = sectionDefaults.current[reel.id] ?? (sectionDefaults.current[reel.id] = {
      sources: false,
      materials: reel.status === 'editing',
      notes: reel.status === 'editing' && reel.editingNotes.trim() !== '',
      publication: reel.status === 'ready',
    });
    const expanded = (section: DetailSection) => sectionOverrides[reel.id]?.[section] ?? defaults[section];
    const toggleSection = (section: DetailSection) => setSectionOverrides((old) => ({
      ...old, [reel.id]: { ...old[reel.id], [section]: !expanded(section) },
    }));
    // Both overlays are honoured only for the Reel that opened them.
    if (memeReelId === reel.id) return <MemePicker api={api} reel={reel} onClose={() => setMemeReelId(null)} onReel={c.acceptReel} />;
    if (aiView?.reelId === reel.id) return <AiWorkspace key={aiView.view} api={api} reel={reel}
      initialView={aiView.view} autoStart={aiView.autoStart} programmeIndexed={aiCapability.programmeIndexed}
      onClose={() => setAiView(null)} onReel={c.acceptReel} onRefresh={() => c.openDetail(reel.id)}
      onSwitch={(view, autoStart = false) => setAiView({ reelId: reel.id, view, autoStart })} />;
    const editor = editorOf(reel.editorId);
    const peerName = c.peer?.name ?? '';
    const kdriveView = kdriveFolderView(reel.kdriveFolder, kdriveStates[reel.id]);
    const uploadJob = c.kdriveUploadJobs[reel.id];
    const uploadView = uploadJob ? { purpose: uploadJob.purpose, fileName: uploadJob.fileName, completedBytes: uploadJob.completedBytes,
      totalBytes: uploadJob.totalBytes, percent: uploadJob.percent, phase: uploadJob.phase, error: uploadJob.error } as const : null;
    const uploadAllowed = kdriveConfigured !== false && !kdriveView.unavailable;
    const chooseKdriveFile = (purpose: 'video' | 'cover') => {
      if (!uploadAllowed) { c.setMessage(kdriveConfigured === false ? 'Integracja kDrive nie jest skonfigurowana na tym serwerze.' : 'Połącz ponownie folder kDrive przed wysłaniem pliku.'); return; }
      if (c.hasUnsavedChanges()) { c.setMessage('Poczekaj, aż zmiany w rolce zostaną zapisane, i spróbuj ponownie.'); return; }
      const input = document.createElement('input'); input.type = 'file';
      input.accept = purpose === 'video' ? 'video/mp4,video/quicktime' : 'image/jpeg,image/png,image/webp';
      input.onchange = () => { const file = input.files?.[0]; if (file) void c.startKdriveUpload(reel.id, purpose, file, !reel.kdriveFolder); };
      input.click();
    };
    const retryOrResumeUpload = () => {
      if (!uploadJob) return;
      if (uploadJob.finished) void c.retryKdriveAttach(reel.id);
      else if (uploadJob.file) void c.startKdriveUpload(reel.id, uploadJob.purpose, uploadJob.file, !reel.kdriveFolder);
      else chooseKdriveFile(uploadJob.purpose);
    };

    /**
     * A derived label reaches the title field as a placeholder, never as its value.
     *
     * The field stays genuinely empty, so opening an untitled Reel and editing something else
     * cannot turn a guess into an authored title — and the user still sees what the Reel is
     * instead of an empty box.
    */
    const label = reelLabel(reel);
    const contextualAiEnabled = aiCapability.enabled && !c.hasUnsavedChanges();
    const scheduleFromDetail = () => {
      setSectionOverrides((old) => ({ ...old, [reel.id]: { ...old[reel.id], publication: true } }));
      openSchedule(reel.id);
    };
    const generatePublication = () => {
      if (c.hasUnsavedChanges()) { c.setMessage(UNSAVED_BEFORE_PUBLICATION); return; }
      if (!reel.script.trim()) { c.setMessage(SCRIPT_REQUIRED); return; }
      c.setMessage(null);
      setAiView({ reelId: reel.id, view: 'generate_publication', autoStart: false });
    };
    const replaceExport = () => {
      const url = window.prompt('Adres eksportu');
      if (!url) return;
      const exportLabel = window.prompt('Nazwa eksportu', url.split('/').pop() ?? 'eksport') ?? 'eksport';
      void c.replaceExport({ url, label: exportLabel });
    };
    const readOnly = isReadOnlyReel(reel);
    // STREAM-01 (D9): overrides the delete dialog's body only for a stream that has absorbed
    // topics; a plain Reel, or a stream with none, keeps the exact existing wording.
    const absorbedTopicCount = reel.topics.filter((topic) => topic.kind === 'absorbed').length;
    const deleteConfirmBody = reel.format === 'stream' && absorbedTopicCount > 0
      ? streamDeleteConfirmBody(label.text, absorbedTopicCount)
      : undefined;
    // CAPTURE-DRAFT-01: the Detail row under the title, only while there is no title yet and
    // the draft is neither failed nor stale. `Użyj` applies the suggestion through the same
    // AI apply route AiWorkspace's own title apply uses; `Zobacz` opens the existing Opracuj
    // result view the same way the primary `Opracuj` context action already does.
    const autoDraft: AutoDraftRowView | undefined = (() => {
      const summary = reel.autoDraft;
      if (reel.title.trim() !== '' || !summary || summary.isStale) return undefined;
      if (summary.state === 'queued' || summary.state === 'running') return { state: 'preparing' };
      if (summary.state === 'succeeded' && summary.titleSuggestion) {
        const titleSuggestion = summary.titleSuggestion;
        return {
          state: 'ready',
          titleSuggestion,
          onUseTitle: () => {
            void api.applyAi(summary.runId, {
              operationId: crypto.randomUUID(),
              expectedVersion: reel.version,
              selection: 'title',
              text: titleSuggestion,
            }).then(c.acceptReel).catch((error) => c.setMessage(polishError(error)));
          },
          onOpenDraft: () => setAiView({ reelId: reel.id, view: 'develop', autoStart: false }),
        };
      }
      return undefined;
    })();
    const openSection = (section: DetailSection) => setSectionOverrides((old) => ({ ...old, [reel.id]: { ...old[reel.id], [section]: true } }));
    /** Open a section, then scroll to and focus a control inside it once it has rendered. */
    const focusLater = (selector: string) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(selector);
      target?.scrollIntoView({ block: 'center' });
      target?.focus();
    }));
    // UI-02 C: one explicit, testable rule table (data/detail-actions.ts) picks the action; this
    // only maps each kind to the existing work it opens. Nothing here mutates the Reel.
    const primary = detailPrimaryAction({
      reel, aiAvailable: contextualAiEnabled, canVerify: reel.editorId !== c.user?.id,
      planLabel: planOf(reel).date ? planLabel(planOf(reel), today) : null,
    });
    const onPrimary: Record<NonNullable<typeof primary>['kind'], () => void> = {
      restore: () => void c.restore(reel),
      develop: () => setAiView({ reelId: reel.id, view: 'develop', autoStart: false }),
      write_script: () => focusLater('#reel-script'),
      add_export: () => { openSection('materials'); replaceExport(); },
      reverify_export: () => { openSection('materials'); focusLater('[data-materials-verify] button'); },
      generate_publication: generatePublication,
      write_description: () => { openSection('publication'); focusLater('textarea[aria-label="Opis publikacji"]'); },
      feed_cover: () => { openSection('publication'); focusLater('[data-feed-cover-toggle]'); },
      schedule: scheduleFromDetail,
      reschedule: scheduleFromDetail,
      select_hook: () => focusLater('[data-hook-option]'),
    };
    const contextAction = primary ? { label: primary.label, tone: primary.tone, onClick: onPrimary[primary.kind] } : undefined;

    /**
     * Verification is derived, never chosen: the verifier is the peer of the
     * selected editor. No export means no verification section at all.
     */
    const verification: VerificationViewState = reel.currentExport === null
      ? { kind: 'no_export' }
      : editor === null
        ? { kind: 'needs_editor' }
        : reel.verificationState === 'outdated'
          ? {
              kind: 'outdated',
              previousVerifierName: editorOf(reel.verification?.checkedBy ?? null)?.name ?? peerName,
              canVerifyNewRevision: reel.editorId !== c.user?.id,
            }
          : reel.verificationState === 'verified'
            ? { kind: 'verified', verifierName: editorOf(reel.verification?.checkedBy ?? null)?.name ?? peerName }
            : reel.editorId === c.user?.id
              // The editor cannot verify their own export.
              ? { kind: 'awaiting_peer', peerName }
              : { kind: 'unverified_by_me' };

    return <ReelDetailScreen
      key={reel.id}
      onBack={c.leaveDetail}
      title={reel.title}
      onChangeTitle={(title) => c.changeReel({ title })}
      titlePlaceholder={label.derived ? label.text : undefined}
      sourceDomain={label.sourceDomain}
      autoDraft={autoDraft}
      plan={reel.deletedAt ? undefined : { label: planLabel(planOf(reel), today), onOpen: () => openSchedule(reel.id) }}
      metadata={{
        status: reel.status,
        statusLabel: STATUS_LABELS[reel.status],
        priority: reel.priority,
        editor,
        programmeState: reel.programmeState,
        memeName: memeNames[0]?.name ?? null,
        feedCoverDone: reel.feedCoverDone,
        verificationState: reel.verificationState,
        format: reel.format,
      }}
      contextAction={contextAction}
      readOnly={readOnly}
      selectors={{
        open: openSelector,
        onOpen: (selector) => { setSelectionError(null); setOpenSelector(selector); },
        onDismiss: () => setOpenSelector(null),
        status: reel.status,
        onSelectStatus: (status) => {
          // The frozen publish gate, checked before a request so the refusal is
          // immediate and the authoritative value stays rendered.
          if (status === 'published' && !reel.feedCoverDone) { setSelectionError(COPY.feedCoverRequired); return; }
          setSelectionError(null); setOpenSelector(null); c.changeReel({ status });
        },
        priority: reel.priority,
        onSelectPriority: (priority) => { setOpenSelector(null); c.changeReel({ priority }); },
        editor,
        editorOptions: [c.user, c.peer].filter((entry): entry is NonNullable<typeof entry> => entry !== null),
        onSelectEditor: (editorId) => { setOpenSelector(null); c.changeReel({ editorId }); },
        selectionError,
        saveState: c.saveState,
      }}
      overflow={{
        open: overflowOpen,
        onOpen: () => setOverflowOpen(true),
        onDismiss: () => setOverflowOpen(false),
        onRequestDelete: () => { setOverflowOpen(false); setConfirmingDelete(true); },
        confirmingDelete,
        onCancelDelete: () => setConfirmingDelete(false),
        onConfirmDelete: () => { setConfirmingDelete(false); void c.deleteCurrent(); },
        deleteState: c.saveState,
        deleteConfirmBody,
      }}
      restore={reel.deletedAt ? { onRestore: () => void c.restore(reel), saveState: c.saveState } : undefined}
      onOpenFeedCover={() => setSectionOverrides((old) => ({ ...old, [reel.id]: { ...old[reel.id], publication: true } }))}
      hooks={reel.hooks}
      onRemoveHook={(id) => void c.removeHook(id)}
      // `?? null`: a Reel cached before HOOKS-SELECT-EDIT has no such field, meaning no choice.
      selectedHookId={reel.selectedHookId ?? null}
      onSelectHook={(id) => void c.selectHook((reel.selectedHookId ?? null) === id ? null : id)}
      hookSelectionPending={c.hookSelecting}
      hookEdits={Object.fromEntries(Object.entries(c.hookEdits).filter(([, edit]) => edit.reelId === reel.id))}
      onStartHookEdit={c.startHookEdit}
      onChangeHookEdit={c.changeHookEdit}
      onSaveHookEdit={(id) => void c.saveHookEdit(id)}
      onCancelHookEdit={c.cancelHookEdit}
      newHook={c.newHook}
      onStartNewHook={c.startNewHook}
      onChangeNewHook={c.changeNewHook}
      onSaveNewHook={() => void c.saveNewHook()}
      onCancelNewHook={c.cancelNewHook}
      script={reel.script}
      onChangeScript={(script) => c.changeReel({ script })}
      scriptConflict={c.conflict?.field === 'script' ? conflictView() : undefined}
      aiRowEnabled={contextualAiEnabled}
      onAiAction={(action) => setAiView({ reelId: reel.id, view: action, autoStart: false })}
      onOpenMeme={() => setMemeReelId(reel.id)}
      attachedMemes={memeNames}
      onDetachMeme={(memeId) => { void api.detachMeme(reel.id, memeId, { operationId: crypto.randomUUID(), expectedVersion: reel.version })
        .then(c.acceptReel).catch((error) => c.setMessage(String(error))); }}
      onOpenProgramme={() => setAiView({ reelId: reel.id, view: reel.programmeAttachment ? 'attached_programme' : 'find_programme', autoStart: false })}
      // STREAM-01 (D6): the quiet "W streamie" row for a Reel referenced by one or more
      // active streams; [] renders nothing.
      inStreams={reel.inStreams}
      onOpenStream={(id) => void c.openDetail(id)}
      // STREAM-01 (D3/D4/D5): present only for a stream Reel; `StreamTopics` owns its own
      // fetch/mutation state against the live API, the same pattern `LiveScreen` already uses.
      streamTopics={reel.format === 'stream'
        ? { api, stream: reel, onStreamChange: c.acceptReel, onOpenReel: (id) => void c.openDetail(id) }
        : undefined}
      sources={{
        expanded: expanded('sources'),
        onToggle: () => toggleSection('sources'),
        summary: [
          label.text,
          reel.originalInput.images.length ? `${reel.originalInput.images.length} załączniki` : '',
          reel.inputNote.trim() ? `Notatka: ${reel.inputNote.trim().replace(/\s+/g, ' ').slice(0, 48)}` : '',
        ].filter(Boolean).join(' · '),
        // The immutable original capture, shown as itself rather than summarised.
        originalUrl: reel.originalInput.url ?? null,
        onOpenSource: () => { if (reel.originalInput.url) window.open(reel.originalInput.url, '_blank', 'noopener,noreferrer'); },
        sourceLink: reel.sourceLink,
        onChangeSourceLink: (sourceLink) => c.changeReel({ sourceLink }, true),
        focusArticleLink: articleLinkFocus,
        originalText: reel.originalInput.text ?? null,
        // `additionalText` is a first-class capture field written by Quick Add, not a shared
        // scalar: `share/receive.ts` states it is "deliberately absent" from `originalShare`,
        // because it belongs to the user rather than the sending app. Reading it out of
        // `originalShare.fields` therefore always produced `null`, and the accompanying text
        // a user typed next to a link or an image was persisted but never shown again.
        additionalText: reel.originalInput.additionalText ?? null,
        attachments: reel.originalInput.images.map((image) => ({
          id: image.attachmentId,
          fileName: image.fileName,
          thumbnailUrl: null,
          // Preserved descriptors that were never accepted as uploads.
          unsupported: reel.attachments.find((a) => a.id === image.attachmentId)?.state === 'failed',
        })),
        onOpenAttachment: () => c.setMessage('Podgląd załącznika będzie dostępny po wdrożeniu transportu plików.'),
        inputNote: reel.inputNote,
        onChangeInputNote: (inputNote) => c.changeReel({ inputNote }),
        inputNoteSaveState: c.saveState,
        inputNoteConflict: c.conflict?.field === 'inputNote' ? conflictView() : undefined,
      }}
      editingNotes={{
        expanded: expanded('notes'),
        onToggle: () => toggleSection('notes'),
        summary: reel.editingNotes.trim() ? reel.editingNotes.trim().replace(/\s+/g, ' ').slice(0, 72) : 'Brak uwag',
        value: reel.editingNotes,
        onChange: (editingNotes) => c.changeReel({ editingNotes }),
        saveState: c.saveState,
        conflict: c.conflict?.field === 'editingNotes' ? conflictView() : undefined,
      }}
      materials={{
        expanded: expanded('materials'),
        onToggle: () => toggleSection('materials'),
        summary: reel.currentExport
          ? `Eksport: ${reel.currentExport.label}${verification.kind === 'verified' ? ' · Zweryfikowano' : verification.kind === 'outdated' ? ' · Nieaktualna weryfikacja' : ' · Do weryfikacji'}`
          : 'Brak eksportu'
          + (reel.kdriveFolder ? ' · Folder kDrive' : ''),
        kdriveFolder: { name: kdriveView.name, unavailable: kdriveView.unavailable, note: kdriveView.note },
        onCreateKdriveFolder: () => void commandKdrive(reel, { mode: 'create' }),
        onOpenKdriveFolder: () => { if (kdriveView.webUrl) window.open(kdriveView.webUrl, '_blank', 'noopener,noreferrer'); },
        onRelinkKdriveFolder: () => relinkKdrive(reel),
        // Creating/relinking needs the server's kDrive configuration; opening a stored link
        // does not. Unknown (not yet resolved) is treated as available rather than blocking.
        kdriveEnabled: kdriveConfigured !== false,
        currentExport: { label: reel.currentExport?.label ?? null, revision: reel.currentExport?.revision ?? null },
        onOpenExport: () => { if (reel.currentExport) window.open(reel.currentExport.url, '_blank', 'noopener,noreferrer'); },
        onReplaceExport: replaceExport,
        onUploadVideo: () => chooseKdriveFile('video'), uploadEnabled: uploadAllowed,
        uploadJob: uploadView?.purpose === 'video' ? uploadView : null,
        onCancelUpload: () => void c.cancelKdriveUpload(reel.id), onRetryUpload: retryOrResumeUpload,
        verification,
        onMarkVerified: () => void c.verifyExport(),
        saveState: c.saveState,
      }}
      publicationExpanded={expanded('publication')}
      onTogglePublication={() => toggleSection('publication')}
      publication={{
        feedCoverDone: reel.feedCoverDone,
        hasFeedCoverAsset: Boolean(reel.feedCoverAsset),
        onToggleFeedCoverDone: () => c.changeReel({ feedCoverDone: !reel.feedCoverDone }),
        onAddOrChangeFeedCoverAsset: () => chooseKdriveFile('cover'),
        onOpenFeedCoverAsset: () => { if (reel.feedCoverAsset && reel.kdriveFolder) window.open(kdriveWebUrl(reel.kdriveFolder.driveId, reel.kdriveFolder.folderId), '_blank', 'noopener,noreferrer'); },
        kdriveEnabled: uploadAllowed, createFolderForCover: !reel.kdriveFolder,
        uploadJob: uploadView?.purpose === 'cover' ? uploadView : null,
        onCancelUpload: () => void c.cancelKdriveUpload(reel.id), onRetryUpload: retryOrResumeUpload,
        description: reel.publicationDescription,
        onChangeDescription: (publicationDescription) => c.changeReel({ publicationDescription }),
        source: reel.publicationSource ?? reel.sourceMetadata?.line ?? '',
        sourceManual: reel.publicationSource !== null,
        sourceAutomaticAvailable: reel.sourceMetadata?.line !== null && reel.sourceMetadata !== null,
        sourceMetadataState: reel.sourceMetadata?.state === 'failed' && (reel.sourceMetadata.failure === 'blocked' || reel.sourceMetadata.failure === 'unsupported')
          ? reel.sourceMetadata.failure : reel.sourceMetadata?.state ?? 'never',
        onAddArticleLink: () => {
          setSectionOverrides((old) => ({ ...old, [reel.id]: { ...old[reel.id], sources: true } }));
          setArticleLinkFocus((value) => value + 1);
        },
        sourceLongWait,
        sourceUndoAvailable: c.sourceUndo?.reelId === reel.id,
        onChangeSource: (publicationSource) => c.changeReel({ publicationSource }),
        onRefreshSource: () => void c.refreshSourceMetadata(),
        onRestoreAutomaticSource: () => void c.restoreAutomaticSource(),
        onUndoRestoreSource: () => c.undoRestoreSource(),
        onCheckSource: () => { setSourceCheckEpoch((value) => value + 1); void c.checkSourceMetadata(reel.id); },
        hashtags: reel.publicationHashtags,
        onChangeHashtags: (publicationHashtags) => c.changeReel({ publicationHashtags }),
        onCopyDescription: () => void c.copyPublication(),
        generatePublicationEnabled: aiCapability.enabled && reel.script.trim().length > 0 && !c.hasUnsavedChanges(),
        generatePublicationHint: c.hasUnsavedChanges() ? 'Wymaga zapisania zmian. Wygeneruje z zapisanego skryptu, wybranego hooka i źródeł.' : !reel.script.trim() ? 'Wymaga zapisanego skryptu. Źródła uzupełniają opis, a wybrany hook określa ton.' : 'Użyje zapisanego skryptu, wybranego hooka i tekstowych źródeł.',
        onGeneratePublication: generatePublication,
        plan: { label: planLabel(planOf(reel), today), onOpen: scheduleFromDetail },
        isPublished: reel.status === 'published',
        publishedAt: reel.publishedAt,
        publicationLinks: reel.publicationUrls.map((url, index) => ({ id: `${index}`, url })),
        onAddPublicationLink: () => {
          const url = window.prompt('Adres publikacji');
          if (url) c.changeReel({ publicationUrls: [...reel.publicationUrls, url] });
        },
        onOpenPublicationLink: (id) => window.open(reel.publicationUrls[Number(id)], '_blank', 'noopener,noreferrer'),
        // D7: a stream's PUBLIKACJA shows ŹRÓDŁA — a read-only list of its topics' source
        // lines — instead of the editable Źródło field above.
        streamSourceLines: reel.format === 'stream' ? streamSourceLinesOf(reel) : undefined,
      }}
      saveState={c.saveState}
      conflict={c.conflict && !['script', 'inputNote', 'editingNotes'].includes(c.conflict.field) ? conflictView() : undefined}
    />;
  };

  const renderList = (embedded: boolean, showSignOut = false) => <ReelListScreen
    embedded={embedded}
    onOpenPlan={c.layout === 'single' ? () => c.setRoute({ name: 'plan' }) : undefined}
    onSignOut={showSignOut ? () => void c.signOut() : undefined}
    currentUser={c.user!}
    statusTabs={[{ status: 'all', label: 'Wszystkie' }, ...(Object.keys(STATUS_TAB_LABELS) as ReelStatus[]).map((value) => ({
      status: value, label: STATUS_TAB_LABELS[value],
    }))]}
    selectedStatus={c.status}
    onSelectStatus={c.setStatus}
    searchQuery={listQuery}
    onChangeSearchQuery={setListQuery}
    loadState={c.loadState}
    // The open Reel is synced into the list; one whose status just changed leaves this tab.
    items={c.reels.filter((reel) => c.status === 'all' || reel.status === c.status).map(toListItem)}
    selectedReelId={c.route.name === 'detail' ? c.current?.id ?? null : null}
    onOpenReel={(id) => { if (c.layout === 'drawer') setDrawerView(null); void c.openDetail(id); }}
    onAddNew={() => { setDrawerView(null); c.startCapture(); }}
    onRetry={() => void c.loadList()}
    onOpenDeleted={() => c.setRoute({ name: 'deleted' })}
    onOpenLive={c.openLive}
    quickActions={{
      openReelId: quickOpenReelId,
      open: quickOpen,
      onOpenSheet: (id) => { setQuickError(null); setRadialAnchor(null); setQuickOpenReelId(id); setQuickOpen('sheet'); },
      onOpenRadial: (id, anchor) => { setQuickError(null); setRadialAnchor(anchor); setQuickOpenReelId(id); setQuickOpen('radial'); },
      radialAnchor,
      onOpenStatus: (id) => { setQuickError(null); setQuickOpenReelId(id); setQuickOpen('status'); },
      onOpenAssign: (id) => { setQuickError(null); setQuickOpenReelId(id); setQuickOpen('assign'); },
      onDismiss: closeQuickActions,
      editorOptions: [c.user, c.peer].filter((entry): entry is NonNullable<typeof entry> => entry !== null),
      onSelectStatus: (id, status) => void applyQuickStatus(id, status),
      onSelectEditor: (id, editorId) => void applyQuickEditor(id, editorId),
      onQuickAdvanceStatus: (id, status) => void applyQuickStatus(id, status),
      onCopyLink: (id) => void c.copyReelLink(id),
      onOpenSchedule: (id) => { closeQuickActions(); openSchedule(id); },
      kdriveEnabled: true,
      // A stored reference opens directly; the list does not wait for a resolve.
      onOpenKdrive: (id) => {
        const reel = c.reels.find((item) => item.id === id) ?? c.planReels.find((item) => item.id === id);
        if (reel?.kdriveFolder) window.open(kdriveWebUrl(reel.kdriveFolder.driveId, reel.kdriveFolder.folderId), '_blank', 'noopener,noreferrer');
      },
      onRequestDelete: (id) => setQuickConfirmDeleteId(id),
      confirmingDeleteId: quickConfirmDeleteId,
      onCancelDelete: () => setQuickConfirmDeleteId(null),
      onConfirmDelete: () => void confirmQuickDelete(),
      selectionError: quickError,
      saveState: quickSaveState,
      undo: undo ? { message: undo.message, onUndo: () => void onUndoStatus(), saveState: undoSaveState } : null,
      deleteConfirmBody: streamDeleteConfirmBodies,
    }}
  />;

  const renderPlanner = (variant: 'pane' | 'screen') => <PlannerPane
    variant={variant}
    reels={c.planReels}
    today={today}
    weekOffset={weekOffset}
    onChangeWeek={setWeekOffset}
    loadState={c.planLoadState}
    onRetry={() => void c.loadPlanner()}
    selectedReelId={c.route.name === 'detail' ? c.current?.id ?? null : null}
    onOpenReel={(id) => { if (c.layout === 'drawer') setDrawerView(null); void c.openDetail(id); }}
    onSchedule={openSchedule}
    onMove={variant === 'pane' ? (id, date) => void moveReel(id, date) : undefined}
    onOpenReels={variant === 'screen' ? () => { setDrawerView(null); c.setRoute({ name: 'list' }); } : undefined}
  />;

  const scheduleReel = scheduleFor === null ? null
    : (c.current?.id === scheduleFor ? c.current : null)
      ?? c.planReels.find((reel) => reel.id === scheduleFor)
      ?? c.reels.find((reel) => reel.id === scheduleFor)
      ?? null;
  const scheduleSheet = scheduleReel ? <ScheduleSheet
    // Namespaced: on the single-pane layout the sheet renders beside the Detail screen, which is
    // keyed by the same Reel id. Equal sibling keys made React leave a stale Detail behind.
    key={`schedule:${scheduleReel.id}`}
    reelTitle={reelLabel(scheduleReel).text}
    isStream={scheduleReel.format === 'stream'}
    status={scheduleReel.status}
    plan={planOf(scheduleReel)}
    today={today}
    saving={scheduleSaving}
    error={scheduleError}
    onDismiss={closeSchedule}
    onConfirm={(date, slot) => void applySchedule(scheduleReel.id, date, slot)}
    onClear={() => void applySchedule(scheduleReel.id, null, null)}
  /> : null;

  if (c.layout === 'single') {
    if (c.route.name === 'detail' && c.current) return <>{notice}{renderDetail()}{scheduleSheet}</>;
    if (c.route.name === 'plan') return <>{notice}{renderPlanner('screen')}{scheduleSheet}</>;
    return <>{notice}{renderList(false, true)}{scheduleSheet}</>;
  }

  if (c.layout === 'drawer') {
    const centre = c.route.name === 'detail' && c.current ? renderDetail()
      : c.route.name === 'plan' ? renderPlanner('screen') : renderList(false);
    return <>
      {notice}
      <div ref={drawerShellRef} className="drawer-shell" aria-hidden={Boolean(drawerView)}>
        <nav className="drawer-toolbar" aria-label="Nawigacja">
          <button type="button" onClick={() => setDrawerView('list')}>Rolki</button>
          <button type="button" onClick={() => setDrawerView('plan')}>Plan</button>
          <button type="button" className="drawer-signout" onClick={() => void c.signOut()}>Wyloguj</button>
        </nav>
        <main className="drawer-centre">{centre}</main>
      </div>
      <div className="side-drawer-backdrop" hidden={!drawerView} role="presentation" onClick={closeDrawer}>
        <aside ref={drawerRef} className="side-drawer" role="dialog" aria-modal="true" aria-label={drawerView === 'list' ? 'Rolki' : 'Plan'}
          onClick={(event) => event.stopPropagation()} onKeyDown={onDrawerKeyDown}>
          <button type="button" className="side-drawer-close" onClick={closeDrawer}>Zamknij</button>
          <div hidden={drawerView !== 'list'}>{renderList(false)}</div>
          <div hidden={drawerView !== 'plan'}>{renderPlanner('screen')}</div>
        </aside>
      </div>
      {scheduleSheet}
    </>;
  }

  // Desktop defaults to ROLKI/PLAN | CURRENT REEL. Spacious displays may add a third pane;
  // focus mode hides both side panes while preserving the selected Reel.
  const detail = renderDetail();
  const centre = detail ?? <div className="workspace-empty"><p>Wybierz rolkę z listy albo z planu.</p></div>;
  return <>
    {notice}
    <div className="workspace" data-layout={c.layout}>
      <div className="workspace-toolbar">
        {c.layout === 'two' ? <div className="workspace-side-switch" aria-label="Lewy panel">
          <button type="button" aria-pressed={leftView === 'list'} onClick={() => setLeftView('list')}>Rolki</button>
          <button type="button" aria-pressed={leftView === 'plan'} onClick={() => setLeftView('plan')}>Plan</button>
        </div> : null}
        <div className="workspace-layout-switch" aria-label="Układ">
          <button type="button" aria-pressed={c.layout === 'two'} onClick={() => setLayout('two')}>Dwa panele</button>
          <button type="button" className="workspace-three-option" aria-pressed={c.layout === 'three'} onClick={() => setLayout('three')}>Trzy panele</button>
          <button type="button" aria-pressed={c.layout === 'focus'} onClick={() => setLayout('focus')}>Skupienie</button>
          {/* In the toolbar rather than fixed over it, so it never covers the layout controls. */}
          <button type="button" className="workspace-signout" onClick={() => void c.signOut()}>Wyloguj</button>
        </div>
      </div>
      {c.layout === 'three' ? <aside className="workspace-pane workspace-plan">{renderPlanner('pane')}</aside> : null}
      {c.layout === 'two' ? <aside className="workspace-pane workspace-side">
        <div hidden={leftView !== 'list'}>{renderList(true)}</div>
        <div hidden={leftView !== 'plan'}>{renderPlanner('pane')}</div>
      </aside> : null}
      <main className="workspace-pane workspace-centre">{centre}</main>
      {c.layout === 'three' ? <aside className="workspace-pane workspace-reels">{renderList(true)}</aside> : null}
    </div>
    {scheduleSheet}
  </>;
}

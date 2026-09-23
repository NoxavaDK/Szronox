import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import type { Reel, ReelStatus } from '../../../../packages/contracts/src/index.js';
import { Login } from '../auth/Login.js';
import type { BrowserSession } from '../auth/session.js';
import type { CoreApiClient } from '../data/api.js';
import type { DraftStore } from '../drafts/store.js';
import type { SyncQueue } from '../drafts/queue.js';
import type { AttachmentRecovery } from '../data/attachment-recovery.js';
import { reelLabel } from '../data/reel-label.js';
import { SCRIPT_REQUIRED, UNSAVED_BEFORE_PUBLICATION } from '../data/errors.js';
import { useAppController } from '../controllers/useAppController.js';
import { QuickAddScreen } from '../screens/QuickAddScreen.js';
import { ReelDetailScreen } from '../screens/ReelDetailScreen.js';
import { ReelListScreen } from '../screens/ReelListScreen.js';
import { DeletedReelsScreen } from '../screens/DeletedReelsScreen.js';
import { AiWorkspace } from '../screens/AiWorkspace.js';
import { MemePicker } from '../screens/MemePicker.js';
import {
  COPY,
  STATUS_LABELS,
  STATUS_TAB_LABELS,
  statusChangedLabel,
  type ConflictRecoveryView,
  type EditorView,
  type ListQuickActionsView,
  type ReelListItemView,
  type MetadataSelector,
  type SaveState,
  type VerificationViewState,
} from '../ui/screen-contracts.js';

/** kDrive integration is not enabled anywhere in the product yet (T04 remains unauthorized). */
const KDRIVE_ENABLED = false;

export function App({ auth, api, store, queue, attachments }: { auth: BrowserSession; api: CoreApiClient; store: DraftStore; queue: SyncQueue; attachments: AttachmentRecovery }) {
  const c = useAppController(auth, api, store, queue, attachments);
  const [publicationExpanded, setPublicationExpanded] = useState(false);
  const [openSelector, setOpenSelector] = useState<MetadataSelector | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [materialsExpanded, setMaterialsExpanded] = useState(false);
  const [aiCapability, setAiCapability] = useState({ enabled: false, programmeIndexed: false });

  // ── LIST-01: list-row quick actions (long-press / swipe) ──────────────────
  const [quickOpenReelId, setQuickOpenReelId] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState<ListQuickActionsView>(null);
  const [quickError, setQuickError] = useState<string | null>(null);
  const [quickConfirmDeleteId, setQuickConfirmDeleteId] = useState<string | null>(null);
  const [quickSaveState, setQuickSaveState] = useState<SaveState>('idle');
  const [undo, setUndo] = useState<{ reelId: string; fromStatus: ReelStatus; version: number; message: string } | null>(null);
  const [undoSaveState, setUndoSaveState] = useState<SaveState>('idle');
  const undoTimer = useRef<number>();

  const closeQuickActions = () => {
    setQuickOpen(null); setQuickOpenReelId(null); setQuickError(null); setQuickConfirmDeleteId(null); setQuickSaveState('idle');
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
  const [memeNames, setMemeNames] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    if (!c.user) { setAiView(null); setMemeReelId(null); setAiCapability({ enabled: false, programmeIndexed: false }); return; }
    let live = true;
    void api.aiCapabilities().then((value) => { if (live) setAiCapability(value); }).catch(() => undefined);
    return () => { live = false; };
  }, [api, c.user?.id]);
  useEffect(() => {
    if (!c.current) { setMemeNames([]); return; }
    let live = true;
    void api.memes().then(({ items }) => { if (live) setMemeNames(items.filter((item) => c.current?.memeIds.includes(item.id)).map(({ id, name }) => ({ id, name }))); }).catch(() => undefined);
    return () => { live = false; };
  }, [api, c.current?.id, c.current?.memeIds.join(',')]);

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
      priority: reel.priority,
      editor: editorOf(reel.editorId),
      isOverdue: false,
      elapsedLabel: null,
      verificationState: reel.verificationState,
      programmeState: reel.programmeState,
      memeName: null,
      feedCoverDone: reel.feedCoverDone,
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
      canSave={Boolean(form.draft.input.text || form.draft.input.url || form.draft.input.images.length)}
      onSave={() => void c.submitCapture()}
      onOpracuj={() => { void c.submitCapture(true).then((saved) => {
        if (!saved) return;
        if (aiCapability.enabled) setAiView({ reelId: saved.id, view: 'develop', autoStart: true });
        else c.setMessage('Opracuj jest teraz niedostępne. Pomysł został zapisany.');
      }); }}
      saveState={c.saveState}
    /></>;
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

  if (c.route.name === 'detail' && c.current) {
    const reel = c.current;
    // Both overlays are honoured only for the Reel that opened them.
    if (memeReelId === reel.id) return <>{notice}<MemePicker api={api} reel={reel} onClose={() => setMemeReelId(null)} onReel={c.acceptReel} /></>;
    if (aiView?.reelId === reel.id) return <>{notice}<AiWorkspace key={aiView.view} api={api} reel={reel}
      initialView={aiView.view} autoStart={aiView.autoStart} programmeIndexed={aiCapability.programmeIndexed}
      onClose={() => setAiView(null)} onReel={c.acceptReel} onRefresh={() => c.openDetail(reel.id)}
      onSwitch={(view, autoStart = false) => setAiView({ reelId: reel.id, view, autoStart })} /></>;
    const editor = editorOf(reel.editorId);
    const peerName = c.peer?.name ?? '';

    /**
     * A derived label reaches the title field as a placeholder, never as its value.
     *
     * The field stays genuinely empty, so opening an untitled Reel and editing something else
     * cannot turn a guess into an authored title — and the user still sees what the Reel is
     * instead of an empty box.
     */
    const label = reelLabel(reel);

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

    return <>{notice}<ReelDetailScreen
      onBack={c.leaveDetail}
      title={reel.title}
      onChangeTitle={(title) => c.changeReel({ title })}
      titlePlaceholder={label.derived ? label.text : undefined}
      metadata={{
        status: reel.status,
        statusLabel: STATUS_LABELS[reel.status],
        priority: reel.priority,
        editor,
        programmeState: reel.programmeState,
        memeName: memeNames[0]?.name ?? null,
        feedCoverDone: reel.feedCoverDone,
        verificationState: reel.verificationState,
      }}
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
      }}
      restore={reel.deletedAt ? { onRestore: () => void c.restore(reel), saveState: c.saveState } : undefined}
      onOpenFeedCover={() => setPublicationExpanded(true)}
      hooks={reel.hooks}
      onRemoveHook={(id) => void c.removeHook(id)}
      script={reel.script}
      onChangeScript={(script) => c.changeReel({ script })}
      scriptConflict={c.conflict?.field === 'script' ? conflictView() : undefined}
      aiRowEnabled={aiCapability.enabled && !['saving', 'conflict', 'offline'].includes(c.saveState)}
      onAiAction={(action) => setAiView({ reelId: reel.id, view: action, autoStart: false })}
      onOpenMeme={() => setMemeReelId(reel.id)}
      attachedMemes={memeNames}
      onDetachMeme={(memeId) => { void api.detachMeme(reel.id, memeId, { operationId: crypto.randomUUID(), expectedVersion: reel.version })
        .then(c.acceptReel).catch((error) => c.setMessage(String(error))); }}
      onOpenProgramme={() => setAiView({ reelId: reel.id, view: reel.programmeAttachment ? 'attached_programme' : 'find_programme', autoStart: false })}
      sources={{
        expanded: sourcesExpanded,
        onToggle: () => setSourcesExpanded((value) => !value),
        // The immutable original capture, shown as itself rather than summarised.
        originalUrl: reel.originalInput.url ?? null,
        onOpenSource: () => { if (reel.originalInput.url) window.open(reel.originalInput.url, '_blank', 'noopener,noreferrer'); },
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
        expanded: notesExpanded,
        onToggle: () => setNotesExpanded((value) => !value),
        value: reel.editingNotes,
        onChange: (editingNotes) => c.changeReel({ editingNotes }),
        saveState: c.saveState,
        conflict: c.conflict?.field === 'editingNotes' ? conflictView() : undefined,
      }}
      materials={{
        expanded: materialsExpanded,
        onToggle: () => setMaterialsExpanded((value) => !value),
        kdriveFolder: { name: reel.kdriveFolder ? reel.kdriveFolder.folderId : null, unavailable: false },
        onCreateKdriveFolder: () => c.setMessage(COPY.kdriveUnavailable),
        onOpenKdriveFolder: () => c.setMessage(COPY.kdriveUnavailable),
        onRelinkKdriveFolder: () => c.setMessage(COPY.kdriveUnavailable),
        // Honestly unavailable rather than pretending.
        kdriveEnabled: KDRIVE_ENABLED,
        currentExport: { label: reel.currentExport?.label ?? null, revision: reel.currentExport?.revision ?? null },
        onOpenExport: () => { if (reel.currentExport) window.open(reel.currentExport.url, '_blank', 'noopener,noreferrer'); },
        onReplaceExport: () => {
          const url = window.prompt('Adres eksportu');
          if (!url) return;
          const label = window.prompt('Nazwa eksportu', url.split('/').pop() ?? 'eksport') ?? 'eksport';
          void c.replaceExport({ url, label });
        },
        verification,
        onMarkVerified: () => void c.verifyExport(),
        saveState: c.saveState,
      }}
      publicationExpanded={publicationExpanded}
      onTogglePublication={() => setPublicationExpanded((value) => !value)}
      publication={{
        feedCoverDone: reel.feedCoverDone,
        hasFeedCoverAsset: false,
        onToggleFeedCoverDone: () => c.changeReel({ feedCoverDone: !reel.feedCoverDone }),
        onAddOrChangeFeedCoverAsset: () => c.setMessage('Dodawanie pliku okładki nie jest jeszcze dostępne.'),
        onOpenFeedCoverAsset: () => {},
        description: reel.publicationDescription,
        onChangeDescription: (publicationDescription) => c.changeReel({ publicationDescription }),
        hashtags: reel.publicationHashtags,
        onChangeHashtags: (publicationHashtags) => c.changeReel({ publicationHashtags }),
        onCopyDescription: () => void c.copyPublication(),
        generatePublicationEnabled: aiCapability.enabled,
        onGeneratePublication: () => {
          // Generation reads the saved script only: unsaved edits are neither saved nor
          // discarded here, and an empty saved script is refused before any request.
          if (c.hasUnsavedChanges()) { c.setMessage(UNSAVED_BEFORE_PUBLICATION); return; }
          if (reel.script.trim().length === 0) { c.setMessage(SCRIPT_REQUIRED); return; }
          c.setMessage(null);
          setAiView({ reelId: reel.id, view: 'generate_publication', autoStart: false });
        },
        publishedAt: reel.publishedAt,
        publicationLinks: reel.publicationUrls.map((url, index) => ({ id: `${index}`, url })),
        onAddPublicationLink: () => {
          const url = window.prompt('Adres publikacji');
          if (url) c.changeReel({ publicationUrls: [...reel.publicationUrls, url] });
        },
        onOpenPublicationLink: (id) => window.open(reel.publicationUrls[Number(id)], '_blank', 'noopener,noreferrer'),
      }}
      saveState={c.saveState}
      conflict={c.conflict && !['script', 'inputNote', 'editingNotes'].includes(c.conflict.field) ? conflictView() : undefined}
    /></>;
  }

  return <>{notice}<ReelListScreen
    currentUser={c.user}
    statusTabs={(Object.keys(STATUS_TAB_LABELS) as ReelStatus[]).map((value) => ({
      status: value, label: STATUS_TAB_LABELS[value], count: c.counts[value],
    }))}
    selectedStatus={c.status}
    onSelectStatus={c.setStatus}
    loadState={c.loadState}
    items={c.reels.map(toListItem)}
    onOpenReel={(id) => void c.openDetail(id)}
    onAddNew={c.startCapture}
    onRetry={() => void c.loadList()}
    onOpenDeleted={() => c.setRoute({ name: 'deleted' })}
    quickActions={{
      openReelId: quickOpenReelId,
      open: quickOpen,
      onOpenSheet: (id) => { setQuickError(null); setQuickOpenReelId(id); setQuickOpen('sheet'); },
      onOpenStatus: (id) => { setQuickError(null); setQuickOpenReelId(id); setQuickOpen('status'); },
      onOpenAssign: (id) => { setQuickError(null); setQuickOpenReelId(id); setQuickOpen('assign'); },
      onDismiss: closeQuickActions,
      editorOptions: [c.user, c.peer].filter((entry): entry is NonNullable<typeof entry> => entry !== null),
      onSelectStatus: (id, status) => void applyQuickStatus(id, status),
      onSelectEditor: (id, editorId) => void applyQuickEditor(id, editorId),
      onQuickAdvanceStatus: (id, status) => void applyQuickStatus(id, status),
      onCopyLink: (id) => void c.copyReelLink(id),
      kdriveEnabled: KDRIVE_ENABLED,
      onOpenKdrive: () => c.setMessage(COPY.kdriveUnavailable),
      onRequestDelete: (id) => setQuickConfirmDeleteId(id),
      confirmingDeleteId: quickConfirmDeleteId,
      onCancelDelete: () => setQuickConfirmDeleteId(null),
      onConfirmDelete: () => void confirmQuickDelete(),
      selectionError: quickError,
      saveState: quickSaveState,
      undo: undo ? { message: undo.message, onUndo: () => void onUndoStatus(), saveState: undoSaveState } : null,
    }}
  /><button className="sign-out" onClick={() => void c.signOut()}>Wyloguj</button></>;
}

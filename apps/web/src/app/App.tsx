import { useMemo, useState } from 'react';
import './App.css';
import type { Reel, ReelStatus } from '../../../../packages/contracts/src/index.js';
import { Login } from '../auth/Login.js';
import type { BrowserSession } from '../auth/session.js';
import type { CoreApiClient } from '../data/api.js';
import type { DraftStore } from '../drafts/store.js';
import type { SyncQueue } from '../drafts/queue.js';
import { useAppController } from '../controllers/useAppController.js';
import { QuickAddScreen } from '../screens/QuickAddScreen.js';
import { ReelDetailScreen } from '../screens/ReelDetailScreen.js';
import { ReelListScreen } from '../screens/ReelListScreen.js';
import { DeletedReelsScreen } from '../screens/DeletedReelsScreen.js';
import {
  COPY,
  STATUS_LABELS,
  STATUS_TAB_LABELS,
  type ConflictRecoveryView,
  type EditorView,
  type MetadataSelector,
  type ReelListItemView,
  type VerificationViewState,
} from '../ui/screen-contracts.js';

export function App({ auth, api, store, queue }: { auth: BrowserSession; api: CoreApiClient; store: DraftStore; queue: SyncQueue }) {
  const c = useAppController(auth, api, store, queue);
  const [publicationExpanded, setPublicationExpanded] = useState(false);
  const [openSelector, setOpenSelector] = useState<MetadataSelector | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [sourcesExpanded, setSourcesExpanded] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [materialsExpanded, setMaterialsExpanded] = useState(false);

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

  const toListItem = (reel: Reel): ReelListItemView => ({
    id: reel.id,
    title: reel.title,
    priority: reel.priority,
    editor: editorOf(reel.editorId),
    isOverdue: false,
    elapsedLabel: null,
    verificationState: reel.verificationState,
    programmeState: reel.programmeState,
    memeName: null,
    feedCoverDone: reel.feedCoverDone,
  });

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
      detectedKind={null}
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
      onOpracuj={() => c.setMessage('Opracuj będzie dostępne w kolejnym etapie.')}
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
    const editor = editorOf(reel.editorId);
    const peerName = c.peer?.name ?? '';

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
      onBack={() => c.setRoute({ name: 'list' })}
      title={reel.title}
      onChangeTitle={(title) => c.changeReel({ title })}
      metadata={{
        status: reel.status,
        statusLabel: STATUS_LABELS[reel.status],
        priority: reel.priority,
        editor,
        programmeState: reel.programmeState,
        memeName: null,
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
      aiRowEnabled={false}
      sources={{
        expanded: sourcesExpanded,
        onToggle: () => setSourcesExpanded((value) => !value),
        // The immutable original capture, shown as itself rather than summarised.
        originalUrl: reel.originalInput.url ?? null,
        onOpenSource: () => { if (reel.originalInput.url) window.open(reel.originalInput.url, '_blank', 'noopener,noreferrer'); },
        originalText: reel.originalInput.text ?? null,
        additionalText: reel.originalInput.originalShare?.fields.find((f) => f.name === 'additionalText')?.value ?? null,
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
        onCreateKdriveFolder: () => c.setMessage('Integracja kDrive nie jest jeszcze dostępna.'),
        onOpenKdriveFolder: () => c.setMessage('Integracja kDrive nie jest jeszcze dostępna.'),
        onRelinkKdriveFolder: () => c.setMessage('Integracja kDrive nie jest jeszcze dostępna.'),
        // Honestly unavailable rather than pretending.
        kdriveEnabled: false,
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
  /><button className="sign-out" onClick={() => void c.signOut()}>Wyloguj</button></>;
}

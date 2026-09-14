import { useState } from 'react';
import '../../ui/tokens.css';
import type { CaptureKind, EditorView, LoadState, MetadataSelector, SaveState } from '../../ui/screen-contracts.js';
import { COPY } from '../../ui/screen-contracts.js';
import type { Priority, ReelStatus } from '@szronox/contracts';
import { ReelListScreen } from '../ReelListScreen.js';
import { QuickAddScreen } from '../QuickAddScreen.js';
import { ReelDetailScreen } from '../ReelDetailScreen.js';
import {
  fixtureCurrentUser,
  fixtureOtherUser,
  fixtureDetailMetadata,
  fixtureHooks,
  fixtureListItems,
  fixturePublicationLinks,
  fixtureStatusTabs,
} from '../fixtures.js';
import styles from './DevPreview.module.css';

/**
 * Local, fixture-driven preview of the four T06 screens for visual inspection
 * at the 360px reference width and the 320px reflow width (frozen-visual-spec.md
 * sec. 1). Not wired into any production entry point — apps/web/src/main.tsx is
 * outside T06's file allowlist, so mounting this for a manual look during
 * development means temporarily pointing main.tsx at <DevPreview /> and
 * reverting that change before committing (see docs/implementation/T06-result.md).
 */
export function DevPreview() {
  const [screen, setScreen] = useState<'list' | 'quickAdd' | 'detail'>('list');
  const [width, setWidth] = useState<360 | 320 | 400>(360);

  return (
    <div className={styles.harness}>
      <div className={styles.controls}>
        <select value={screen} onChange={(event) => setScreen(event.target.value as typeof screen)}>
          <option value="list">Rolki</option>
          <option value="quickAdd">Nowy pomysł</option>
          <option value="detail">Reel Detail</option>
        </select>
        <select value={width} onChange={(event) => setWidth(Number(event.target.value) as typeof width)}>
          <option value={360}>360px (reference)</option>
          <option value={320}>320px (reflow)</option>
          <option value={400}>400px (desktop-ish)</option>
        </select>
      </div>
      <p className={styles.frameLabel}>{width}px</p>
      <div className={styles.frame} style={{ width }}>
        {screen === 'list' ? <ListPreview /> : screen === 'quickAdd' ? <QuickAddPreview /> : <DetailPreview />}
      </div>
    </div>
  );
}

function ListPreview() {
  const [selectedStatus, setSelectedStatus] = useState<(typeof fixtureStatusTabs)[number]['status']>('editing');
  const [loadState] = useState<LoadState>('loaded');
  return (
    <ReelListScreen
      currentUser={fixtureCurrentUser}
      statusTabs={fixtureStatusTabs}
      selectedStatus={selectedStatus}
      onSelectStatus={setSelectedStatus}
      attentionCount={3}
      onOpenAttention={() => console.info('open attention')}
      loadState={loadState}
      items={fixtureListItems}
      onOpenReel={(id) => console.info('open reel', id)}
      onAddNew={() => console.info('add new')}
      onOpenDeleted={() => console.info('open deleted')}
    />
  );
}

function QuickAddPreview() {
  const [selectedKind, setSelectedKind] = useState<CaptureKind>('url');
  const [url, setUrl] = useState('https://example.com/artykul');
  const [text, setText] = useState('');
  const [showAccompanyingText, setShowAccompanyingText] = useState(false);
  const [accompanyingText, setAccompanyingText] = useState('');
  const [showHookField, setShowHookField] = useState(false);
  const [initialHook, setInitialHook] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [saveState, setSaveState] = useState<SaveState>('idle');

  return (
    <QuickAddScreen
      onBack={() => console.info('back')}
      detectedKind="url"
      selectedKind={selectedKind}
      onChangeKind={setSelectedKind}
      url={url}
      onChangeUrl={setUrl}
      images={[]}
      onAddImage={() => console.info('add image')}
      onRemoveImage={(id) => console.info('remove image', id)}
      text={text}
      onChangeText={setText}
      showAccompanyingText={showAccompanyingText}
      onRevealAccompanyingText={() => setShowAccompanyingText(true)}
      accompanyingText={accompanyingText}
      onChangeAccompanyingText={setAccompanyingText}
      showHookField={showHookField}
      onRevealHookField={() => setShowHookField(true)}
      initialHook={initialHook}
      onChangeInitialHook={setInitialHook}
      priority={priority}
      onChangePriority={setPriority}
      canSave={url.length > 0}
      onSave={() => setSaveState('saved')}
      onOpracuj={() => console.info('opracuj')}
      saveState={saveState}
    />
  );
}

function DetailPreview() {
  const [title, setTitle] = useState('Maszyniści zwalniają');
  const [hooks, setHooks] = useState(fixtureHooks);
  const [script, setScript] = useState('Scenariusz w przygotowaniu...');
  const [publicationExpanded, setPublicationExpanded] = useState(true);
  const [feedCoverDone, setFeedCoverDone] = useState(false);
  const [description, setDescription] = useState('Krótki opis publikacji.');
  const [hashtags, setHashtags] = useState('#polityka #transport');

  // Controlled metadata (frozen batch sec. 3).
  const [openSelector, setOpenSelector] = useState<MetadataSelector | null>(null);
  const [status, setStatus] = useState<ReelStatus>('editing');
  const [priority, setPriority] = useState<Priority>('urgent');
  const [editor, setEditor] = useState<EditorView | null>(fixtureCurrentUser);
  const [selectionError, setSelectionError] = useState<string | null>(null);

  // Sections.
  const [sourcesExpanded, setSourcesExpanded] = useState(true);
  const [inputNote, setInputNote] = useState('Ważny fragment od 0:42.');
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [editingNotes, setEditingNotes] = useState('Napisy od 0:03.');
  const [materialsExpanded, setMaterialsExpanded] = useState(false);

  // Overflow / delete.
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const editorOptions = [fixtureCurrentUser, fixtureOtherUser];

  return (
    <ReelDetailScreen
      onBack={() => console.info('back')}
      title={title}
      onChangeTitle={setTitle}
      metadata={{ ...fixtureDetailMetadata, status, priority, editor, feedCoverDone }}
      selectors={{
        open: openSelector,
        onOpen: setOpenSelector,
        onDismiss: () => setOpenSelector(null),
        status,
        onSelectStatus: (next) => {
          // Demonstrates the frozen publish gate without inventing a mutation.
          if (next === 'published' && !feedCoverDone) {
            setSelectionError(COPY.feedCoverRequired);
            return;
          }
          setSelectionError(null);
          setStatus(next);
          setOpenSelector(null);
        },
        priority,
        onSelectPriority: (next) => { setPriority(next); setOpenSelector(null); },
        editor,
        editorOptions,
        onSelectEditor: (id) => {
          setEditor(id === null ? null : editorOptions.find((option) => option.id === id) ?? null);
          setOpenSelector(null);
        },
        selectionError,
        saveState: 'idle',
      }}
      overflow={{
        open: overflowOpen,
        onOpen: () => setOverflowOpen(true),
        onDismiss: () => setOverflowOpen(false),
        onRequestDelete: () => { setOverflowOpen(false); setConfirmingDelete(true); },
        confirmingDelete,
        onCancelDelete: () => setConfirmingDelete(false),
        onConfirmDelete: () => { setConfirmingDelete(false); console.info('soft delete'); },
        deleteState: 'idle',
      }}
      onOpenFeedCover={() => console.info('open feed cover')}
      hooks={hooks}
      onRemoveHook={(id) => setHooks((current) => current.filter((hook) => hook.id !== id))}
      script={script}
      onChangeScript={setScript}
      aiRowEnabled={false}
      sources={{
        expanded: sourcesExpanded,
        onToggle: () => setSourcesExpanded((value) => !value),
        originalUrl: 'https://example.com/artykul',
        onOpenSource: () => console.info('open source'),
        originalText: null,
        additionalText: 'Kontekst dopisany przy przechwyceniu.',
        attachments: [
          { id: 'a-1', fileName: 'zrzut.png', thumbnailUrl: null, unsupported: false },
          { id: 'a-2', fileName: 'film.mp4', thumbnailUrl: null, unsupported: true },
        ],
        onOpenAttachment: (id) => console.info('open attachment', id),
        inputNote,
        onChangeInputNote: setInputNote,
        inputNoteSaveState: 'idle',
      }}
      editingNotes={{
        expanded: notesExpanded,
        onToggle: () => setNotesExpanded((value) => !value),
        value: editingNotes,
        onChange: setEditingNotes,
        saveState: 'idle',
      }}
      materials={{
        expanded: materialsExpanded,
        onToggle: () => setMaterialsExpanded((value) => !value),
        kdriveFolder: { name: null, unavailable: false },
        onCreateKdriveFolder: () => console.info('create folder'),
        onOpenKdriveFolder: () => console.info('open folder'),
        onRelinkKdriveFolder: () => console.info('relink folder'),
        kdriveEnabled: false,
        currentExport: { label: 'montaz-v2.mp4', revision: 2 },
        onOpenExport: () => console.info('open export'),
        onReplaceExport: () => console.info('replace export'),
        // Editor is NOXAVA here, so the derived verifier is the peer.
        verification: { kind: 'awaiting_peer', peerName: fixtureOtherUser.name },
        onMarkVerified: () => console.info('mark verified'),
        saveState: 'idle',
      }}
      publicationExpanded={publicationExpanded}
      onTogglePublication={() => setPublicationExpanded((value) => !value)}
      publication={{
        feedCoverDone,
        hasFeedCoverAsset: false,
        onToggleFeedCoverDone: () => setFeedCoverDone((value) => !value),
        onAddOrChangeFeedCoverAsset: () => console.info('cover asset'),
        onOpenFeedCoverAsset: () => console.info('open cover asset'),
        description,
        onChangeDescription: setDescription,
        hashtags,
        onChangeHashtags: setHashtags,
        onCopyDescription: () => console.info('copy'),
        publishedAt: null,
        publicationLinks: fixturePublicationLinks,
        onAddPublicationLink: () => console.info('add link'),
        onOpenPublicationLink: (id) => console.info('open link', id),
      }}
      saveState="idle"
    />
  );
}

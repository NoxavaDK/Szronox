import { useState } from 'react';
import '../../ui/tokens.css';
import type { CaptureKind, LoadState, SaveState } from '../../ui/screen-contracts.js';
import type { Priority } from '@szronox/contracts';
import { ReelListScreen } from '../ReelListScreen.js';
import { QuickAddScreen } from '../QuickAddScreen.js';
import { ReelDetailScreen } from '../ReelDetailScreen.js';
import {
  fixtureCurrentUser,
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

  return (
    <ReelDetailScreen
      onBack={() => console.info('back')}
      title={title}
      onChangeTitle={setTitle}
      onOpenOverflowMenu={() => console.info('overflow')}
      metadata={fixtureDetailMetadata}
      onOpenFeedCover={() => console.info('open feed cover')}
      hooks={hooks}
      onRemoveHook={(id) => setHooks((current) => current.filter((hook) => hook.id !== id))}
      script={script}
      onChangeScript={setScript}
      aiRowEnabled={false}
      sourcesSummary="2"
      onOpenSources={() => console.info('open sources')}
      materialsSummary={undefined}
      onOpenMaterials={() => console.info('open materials')}
      editingNotesSummary={undefined}
      onOpenEditingNotes={() => console.info('open editing notes')}
      publicationExpanded={publicationExpanded}
      onTogglePublication={() => setPublicationExpanded((current) => !current)}
      publication={{
        feedCoverDone,
        hasFeedCoverAsset: false,
        onToggleFeedCoverDone: () => setFeedCoverDone((current) => !current),
        onAddOrChangeFeedCoverAsset: () => console.info('add/change cover asset'),
        onOpenFeedCoverAsset: () => console.info('open cover asset'),
        description,
        onChangeDescription: setDescription,
        hashtags,
        onChangeHashtags: setHashtags,
        onCopyDescription: () => console.info('copy description'),
        publishedAt: null,
        publicationLinks: fixturePublicationLinks,
        onAddPublicationLink: () => console.info('add publication link'),
        onOpenPublicationLink: (id) => console.info('open publication link', id),
      }}
      saveState="idle"
    />
  );
}

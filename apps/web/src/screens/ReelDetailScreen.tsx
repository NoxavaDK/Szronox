import { useRef, useState } from 'react';
import '../ui/tokens.css';
import { STATUS_LABELS, type HookEditView, type ReelDetailScreenProps } from '../ui/screen-contracts.js';
import { ActionButton, CoverIndicator, SectionRow, StreamMarker, TextAction } from '../ui/primitives.js';
import { BackArrowIcon, BroadcastIcon, CheckIcon, CloseIcon, WarningIcon } from '../ui/icons.js';
import {
  ConflictNotice,
  EditingNotesSection,
  MaterialsSection,
  MetadataSelectors,
  ReelOverflow,
  RestoreBanner,
  SourcesSection,
} from '../ui/detail-sections.js';
import { PublicationSection } from './PublicationSection.js';
import { StreamTopics } from './StreamTopics.js';
import styles from './ReelDetailScreen.module.css';

/**
 * Reel Detail — frozen-visual-spec.md sec. 4 plus the frozen Reel Detail batch.
 *
 * Controlled throughout: every value and intent arrives via props. The section
 * order is the frozen one — metadata, hooks, script, AI row, ŹRÓDŁA / WEJŚCIE,
 * UWAGI DO MONTAŻU, MATERIAŁY, PUBLIKACJA.
 */
export function ReelDetailScreen(props: ReelDetailScreenProps) {
  const {
    onBack, title, onChangeTitle, titlePlaceholder, sourceDomain,
    metadata, plan, contextAction, readOnly, selectors, overflow, onOpenFeedCover, restore,
    hooks, onRemoveHook, selectedHookId, onSelectHook, hookSelectionPending,
    hookEdits, onStartHookEdit, onChangeHookEdit, onSaveHookEdit, onCancelHookEdit,
    newHook, onStartNewHook, onChangeNewHook, onSaveNewHook, onCancelNewHook,
    script, onChangeScript, scriptConflict,
    sources, editingNotes, materials,
    publicationExpanded, onTogglePublication, publication,
    saveState, conflict,
    aiRowEnabled, onAiAction, onOpenMeme, onDetachMeme, attachedMemes, onOpenProgramme,
    inStreams, onOpenStream, streamTopics,
  } = props;
  // STREAM-01 (D3): a stream replaces HOOK/HOOKI and SCENARIUSZ with TEMATY and shows no AI
  // entry point anywhere — enforced here regardless of what the host passes for aiRowEnabled,
  // so a host that has not finished wiring streamTopics/metadata.format cannot regress D3.
  const isStream = metadata.format === 'stream';
  const publicationRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  // STREAM-01 (D6): "W 2 streamach" opens a short list to pick from; a single stream opens it directly.
  const [streamsListOpen, setStreamsListOpen] = useState(false);
  const openFeedCover = () => {
    onOpenFeedCover();
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const target = publicationRef.current?.querySelector<HTMLElement>('[data-feed-cover-toggle]');
      target?.scrollIntoView({ block: 'center' });
      target?.focus();
    }));
  };
  /**
   * HOOKS-SELECT-EDIT, clarified in UI-02: the whole row is the selection target. A visible
   * radio-style mark (empty ring / filled check) plus the `WYBRANY` label say what the row does
   * and which one is chosen, so selection never relies on colour. `WŁASNY` is provenance only.
   * Edit and delete are separate sibling buttons, so they can never select by accident.
   */
  const renderHook = (hook: typeof hooks[number]) => {
    const selected = hook.id === selectedHookId;
    const edit = hookEdits[hook.id];
    const own = hook.source === 'user' ? <span className={styles.hookOwnTag}>własny</span> : null;
    if (readOnly) {
      return (
        <li key={hook.id} className={selected ? `${styles.hookRow} ${styles.hookRowSelected}` : styles.hookRow}>
          <div className={styles.hookStatic}>
            <span className={styles.hookText}>{hook.text}</span>
            {selected || own ? <span className={styles.hookTags}>{selected ? <span className={styles.hookSelectedTag}>✓ Wybrany</span> : null}{own}</span> : null}
          </div>
        </li>
      );
    }
    return (
      <li key={hook.id} className={selected ? `${styles.hookRow} ${styles.hookRowSelected}` : styles.hookRow}>
        {edit ? (
          <HookEditor edit={edit} onChange={(text) => onChangeHookEdit(hook.id, text)} onSave={() => onSaveHookEdit(hook.id)} onCancel={() => onCancelHookEdit(hook.id)} />
        ) : <>
          <button
            type="button"
            className={styles.hookSelect}
            data-hook-option
            aria-pressed={selected}
            disabled={hookSelectionPending}
            onClick={() => onSelectHook(hook.id)}
          >
            <span className={styles.hookMark} data-selected={selected ? 'true' : undefined} aria-hidden="true">
              {selected ? <CheckIcon size={12} /> : null}
            </span>
            <span className={styles.hookBody}>
              <span className={styles.hookText}>{hook.text}</span>
              {selected || own ? <span className={styles.hookTags}>
                {selected ? <span className={styles.hookSelectedTag}>Wybrany</span> : null}
                {own}
              </span> : null}
            </span>
          </button>
          <button type="button" className={`${styles.hookControl} ${styles.hookEditControl}`} onClick={() => onStartHookEdit(hook.id)} aria-label="Edytuj hook">Edytuj</button>
          <button type="button" className={styles.hookControl} onClick={() => onRemoveHook(hook.id)} aria-label="Usuń hook"><CloseIcon /></button>
        </>}
      </li>
    );
  };
  const selectedHook = hooks.find((hook) => hook.id === selectedHookId);
  const otherHooks = selectedHook ? hooks.filter((hook) => hook.id !== selectedHook.id) : hooks;

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <button type="button" className={styles.iconButton} onClick={onBack} aria-label="Wstecz">
          <BackArrowIcon />
        </button>
        <div className={styles.titleIdentity}>
          <span className={styles.titleRow}>
            {/* STREAM-01 (D1): before the title in the Detail title row too. */}
            {isStream ? <BroadcastIcon size={15} aria-hidden="true" className={styles.titleStreamGlyph} /> : null}
            <textarea
              ref={titleRef}
              className={styles.titleField}
              aria-label="Tytuł"
              value={title}
              rows={2}
              readOnly={readOnly}
              // The derived label, when there is no title. A placeholder keeps the field empty,
              // so nothing here can be saved as a title the user did not write.
              placeholder={titlePlaceholder}
              onChange={(event) => onChangeTitle(event.target.value)}
            />
          </span>
          <span className={styles.titleMeta}>
            {/* D1: paired with the word "Stream" in the metadata cluster. */}
            {isStream ? <StreamMarker /> : null}
            {sourceDomain ? <span className={styles.sourceDomain}>{sourceDomain}</span> : null}
            {/* A visible edit affordance: an untitled Reel shows a derived label that is not a title yet. */}
            {!readOnly ? <button type="button" className={styles.titleEdit} onClick={() => titleRef.current?.focus()}>
              {titlePlaceholder ? 'Nadaj tytuł' : 'Edytuj tytuł'}
            </button> : null}
          </span>
        </div>
        {readOnly ? <CoverIndicator done={metadata.feedCoverDone} /> : <CoverIndicator done={metadata.feedCoverDone} onClick={openFeedCover} />}
        {readOnly ? null : <ReelOverflow {...overflow} />}
      </header>

      {/* Shown only when this Reel is soft-deleted: explains the state; Przywróć is the context action. */}
      {restore ? <RestoreBanner {...restore} /> : null}

      <div className={styles.metaGroup}>
        {/* Controlled STATUS / PRIORYTET / MONTUJE (frozen batch sec. 3). A deleted Reel only shows them. */}
        {readOnly
          ? <p className={styles.readOnlyMeta}>{STATUS_LABELS[metadata.status]}{metadata.editor ? ` · ${metadata.editor.name}` : ''}</p>
          : <MetadataSelectors {...selectors} />}
        {!readOnly ? <div className={styles.metaLinks}>
          {/* STREAM-01 (D6): shown on a Reel referenced by one or more active streams. */}
          {inStreams && inStreams.length > 0 ? (
            <span className={styles.streamsLinkWrap}>
              <button
                type="button"
                className={styles.metadataInlineAction}
                onClick={() => (inStreams.length === 1 ? onOpenStream?.(inStreams[0].id) : setStreamsListOpen((open) => !open))}
              >
                <BroadcastIcon size={13} aria-hidden="true" /> {inStreams.length === 1 ? `W streamie: ${inStreams[0].title}` : `W ${inStreams.length} streamach`}
              </button>
              {streamsListOpen && inStreams.length > 1 ? (
                <ul className={styles.streamsList} role="list">
                  {inStreams.map((stream) => (
                    <li key={stream.id}>
                      <button type="button" className={styles.streamsListItem} onClick={() => { setStreamsListOpen(false); onOpenStream?.(stream.id); }}>
                        {stream.title}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </span>
          ) : null}
          {/* D3: no programme metadata/actions on a stream. */}
          {!isStream && metadata.programmeState !== 'unchecked' ? (
            // Attached is a completed association (check); no match is ordinary information, never an error.
            <button type="button" className={styles.metadataProgramme} data-state={metadata.programmeState} onClick={onOpenProgramme}>
              {metadata.programmeState === 'matched' ? <><CheckIcon size={13} aria-hidden="true" /> Program: powiązane</> : 'Program: brak dopasowania'}
            </button>
          ) : null}
          {attachedMemes?.map((meme) => <span key={meme.id} className={styles.metadataItem}>Mem: {meme.name}{meme.mediaKind === 'video' ? <span aria-label="wideo" title="wideo"> ▶</span> : null} <button type="button" className={styles.memeDetach} onClick={() => onDetachMeme?.(meme.id)} aria-label={`Odłącz mem ${meme.name}`}>×</button></span>)}
          <button type="button" className={styles.metadataInlineAction} onClick={onOpenMeme}>{attachedMemes?.length ? '+ kolejny mem' : '+ Mem'}</button>
        </div> : null}
      </div>

      {contextAction ? (
        <ActionButton className={styles.contextAction} tone={contextAction.tone ?? 'primary'} onClick={contextAction.onClick}>
          {contextAction.tone === 'attention' ? <WarningIcon size={14} aria-hidden="true" /> : null}
          {contextAction.label}
        </ActionButton>
      ) : null}
      <SourcesSection {...sources} readOnly={readOnly} />

      {/*
       * STREAM-01 (D3): a stream's main editorial content is TEMATY, in place of HOOK/HOOKI,
       * SCENARIUSZ and the AI action row — none of which are rendered at all for a stream,
       * never merely disabled, per D3's "no AI entry point anywhere on a stream" rule.
       */}
      {isStream ? (
        streamTopics ? (
          <StreamTopics
            api={streamTopics.api}
            stream={streamTopics.stream}
            onStreamChange={streamTopics.onStreamChange}
            onOpenReel={streamTopics.onOpenReel}
            readOnly={readOnly}
          />
        ) : null
      ) : (
        <>
          <section className={styles.contentBlock} data-hooks-section>
            <div className={styles.hookHeading}>
              <h2 className={styles.sectionLabel}>Hooki</h2>
              {/* One concise instruction instead of a second `Wybierz hook` action at this level. */}
              {!readOnly && metadata.status !== 'published' && !selectedHook && hooks.length > 0 ? <span className={styles.hookHint}>Stuknij hook, aby go wybrać</span> : null}
            </div>
            <ul className={styles.hookList}>
              {selectedHook ? renderHook(selectedHook) : null}
              {otherHooks.length > 0 ? selectedHook ? <li className={styles.otherHooks}><details>
                <summary>Pozostałe hooki ({otherHooks.length})</summary>
                <ul className={styles.hookList}>{otherHooks.map(renderHook)}</ul>
              </details></li> : otherHooks.map(renderHook) : null}
              {/* A draft whose hook was deleted elsewhere: still shown, so the text is not lost. */}
              {Object.entries(hookEdits)
                .filter(([id]) => !hooks.some((hook) => hook.id === id))
                .map(([id, edit]) => (
                  <li key={id} className={styles.hookRow}>
                    <HookEditor edit={edit} onChange={(text) => onChangeHookEdit(id, text)} onCancel={() => onCancelHookEdit(id)} />
                  </li>
                ))}
              {/* HOOK-ADD-01: a manual hook is appended as `własny` and is never selected automatically. */}
              {!readOnly && newHook ? (
                <li className={styles.hookRow}>
                  <HookEditor edit={newHook} onChange={onChangeNewHook} onSave={onSaveNewHook} onCancel={onCancelNewHook} />
                </li>
              ) : null}
            </ul>
            {!readOnly && !newHook ? <TextAction onClick={onStartNewHook}>+ Dodaj hook</TextAction> : null}
          </section>

          <section className={styles.contentBlock}>
            <h2 className={styles.sectionLabel}>Skrypt</h2>
            <textarea
              id="reel-script"
              className={styles.scriptField}
              aria-label="Skrypt"
              value={script}
              rows={4}
              readOnly={readOnly}
              onChange={(event) => onChangeScript(event.target.value)}
            />
            {scriptConflict ? <ConflictNotice conflict={scriptConflict} /> : null}
          </section>

          {!readOnly ? <div className={styles.aiRow} aria-label="Akcje AI">
            <button type="button" className={styles.aiButton} disabled={!aiRowEnabled} onClick={() => onAiAction?.('fact_check')}>Fakty</button>
            <button type="button" className={styles.aiButton} disabled={!aiRowEnabled} onClick={() => onAiAction?.('language_check')}>Aa Język</button>
            <button type="button" className={styles.aiButton} disabled={!aiRowEnabled} onClick={() => onAiAction?.('develop')}>✦ Opracuj</button>
          </div> : null}
        </>
      )}

      {/* Production (Materiały, Uwagi) and Publication are separate groups below the editorial work. */}
      {!readOnly ? <div className={styles.secondarySections}>
        <h2 className={styles.groupLabel}>Produkcja</h2>
        <MaterialsSection {...materials} />
        <EditingNotesSection {...editingNotes} />
        <div className={styles.publicationGroup}>
          <SectionRow label="PUBLIKACJA" expanded={publicationExpanded} summary={publicationExpanded ? undefined : <PublicationSummary status={metadata.status} publication={publication} />}
            onClick={onTogglePublication} />
          {publicationExpanded ? <div ref={publicationRef}><PublicationSection {...publication} isReady={metadata.status === 'ready'} plan={plan} /></div> : null}
        </div>
      </div> : null}

      {conflict ? <ConflictNotice conflict={conflict} /> : null}
      {saveState === 'saving' ? <p className={styles.saveState} role="status">Zapisywanie…</p> : null}
      {saveState === 'offline' ? <p className={styles.saveState} role="status">Brak połączenia — zapisano lokalnie</p> : null}
      {saveState === 'error' ? <p className={styles.saveState} role="alert">Nie udało się zapisać</p> : null}
    </div>
  );
}

/**
 * Collapsed PUBLIKACJA summary: short text plus symbol per state. Complete is a quiet green
 * check, a missing publish prerequisite is amber with a warning mark, the rest stays neutral.
 */
function PublicationSummary({ status, publication }: { status: ReelDetailScreenProps['metadata']['status']; publication: ReelDetailScreenProps['publication'] }) {
  if (status === 'published') {
    return <span className={styles.summaryComplete}><CheckIcon size={13} aria-hidden="true" /> Opublikowano{publication.publishedAt ? ` · ${publication.publishedAt}` : ''}</span>;
  }
  const description = publication.description.trim()
    ? <span className={styles.summaryComplete}><CheckIcon size={13} aria-hidden="true" /> Opis gotowy</span>
    : status === 'ready' ? <span className={styles.summaryAttention}>! Brak opisu</span> : <span>Brak opisu</span>;
  const cover = publication.feedCoverDone
    ? <span className={styles.summaryComplete}><CheckIcon size={13} aria-hidden="true" /> Okładka</span>
    : status === 'ready' ? <span className={styles.summaryAttention}>! Okładka niegotowa</span> : <span>Okładka niegotowa</span>;
  return <span className={styles.summaryLine}>{description}<span aria-hidden="true">·</span>{cover}</span>;
}

/**
 * Inline edit of one existing hook. Gotowe saves through the existing hook-edit endpoint;
 * Anuluj (or Escape) discards the local text. Without `onSave` the hook no longer exists,
 * so only closing is offered.
 */
function HookEditor({ edit, onChange, onSave, onCancel }: {
  edit: HookEditView;
  onChange: (text: string) => void;
  onSave?: () => void;
  onCancel: () => void;
}) {
  return (
    <div className={styles.hookEditor}>
      <textarea
        className={styles.hookEditField}
        aria-label="Tekst hooka"
        value={edit.text}
        rows={1}
        readOnly={edit.saving}
        autoFocus
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !edit.saving) onCancel();
          if (event.key === 'Enter' && !event.shiftKey && onSave) { event.preventDefault(); onSave(); }
        }}
      />
      <div className={styles.hookEditActions}>
        {edit.error ? <p className={styles.hookEditError} role="alert">{edit.error}</p> : null}
        <button type="button" className={styles.hookEditButton} disabled={edit.saving} onClick={onCancel}>
          {onSave ? 'Anuluj' : 'Zamknij'}
        </button>
        {onSave ? (
          <button
            type="button"
            className={`${styles.hookEditButton} ${styles.hookEditDone}`}
            disabled={edit.saving || edit.text.trim() === ''}
            onClick={onSave}
          >
            {edit.saving ? 'Zapisywanie…' : 'Gotowe'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

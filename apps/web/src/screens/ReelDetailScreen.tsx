import { useRef } from 'react';
import '../ui/tokens.css';
import type { HookEditView, ReelDetailScreenProps } from '../ui/screen-contracts.js';
import { Avatar, CoverIndicator, SectionRow } from '../ui/primitives.js';
import { BackArrowIcon, CloseIcon } from '../ui/icons.js';
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
    metadata, plan, contextAction, selectors, overflow, onOpenFeedCover, restore,
    hooks, onRemoveHook, selectedHookId, onSelectHook, hookSelectionPending,
    hookEdits, onStartHookEdit, onChangeHookEdit, onSaveHookEdit, onCancelHookEdit,
    script, onChangeScript, scriptConflict,
    sources, editingNotes, materials,
    publicationExpanded, onTogglePublication, publication,
    saveState, conflict,
    aiRowEnabled, onAiAction, onOpenMeme, onDetachMeme, attachedMemes, onOpenProgramme,
  } = props;
  const publicationRef = useRef<HTMLDivElement>(null);
  const openFeedCover = () => {
    onOpenFeedCover();
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const target = publicationRef.current?.querySelector<HTMLElement>('[data-feed-cover-toggle]');
      target?.scrollIntoView({ block: 'center' });
      target?.focus();
    }));
  };
  const renderHook = (hook: typeof hooks[number]) => {
    const selected = hook.id === selectedHookId;
    const edit = hookEdits[hook.id];
    return (
      <li key={hook.id} className={selected ? `${styles.hookRow} ${styles.hookRowSelected}` : styles.hookRow}>
        {edit ? (
          <HookEditor edit={edit} onChange={(text) => onChangeHookEdit(hook.id, text)} onSave={() => onSaveHookEdit(hook.id)} onCancel={() => onCancelHookEdit(hook.id)} />
        ) : <>
          <button type="button" className={styles.hookSelect} data-hook-option aria-pressed={selected} disabled={hookSelectionPending} onClick={() => onSelectHook(hook.id)}>
            <span className={styles.hookText}>{hook.text}</span>
            {selected || hook.source === 'user' ? <span className={styles.hookTags}>
              {selected ? <span className={styles.hookSelectedTag}>✓ WYBRANY</span> : null}
              {hook.source === 'user' ? <span className={styles.hookOwnTag}>własny</span> : null}
            </span> : null}
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
          <textarea
            className={styles.titleField}
            aria-label="Tytuł"
            value={title}
            rows={2}
            // The derived label, when there is no title. A placeholder keeps the field empty,
            // so nothing here can be saved as a title the user did not write.
            placeholder={titlePlaceholder}
            onChange={(event) => onChangeTitle(event.target.value)}
          />
          {sourceDomain ? <span className={styles.sourceDomain}>{sourceDomain}</span> : null}
        </div>
        <CoverIndicator done={metadata.feedCoverDone} onClick={openFeedCover} />
        <ReelOverflow {...overflow} />
      </header>

      {/* Shown only when this Reel is soft-deleted. */}
      {restore ? <RestoreBanner {...restore} /> : null}

      {/* Controlled STATUS / PRIORYTET / MONTUJE (frozen batch sec. 3). */}
      <MetadataSelectors {...selectors} />

      {metadata.programmeState !== 'unchecked' ? (
        <button type="button" className={styles.metadataProgramme} onClick={onOpenProgramme}>
          {metadata.programmeState === 'matched' ? 'Program: powiązane' : 'Program: brak powiązania'}
        </button>
      ) : null}
      <div className={styles.metadataItem}>
        {attachedMemes?.map((meme) => <span key={meme.id}>Mem: {meme.name} <button type="button" onClick={() => onDetachMeme?.(meme.id)} aria-label={`Odłącz mem ${meme.name}`}>×</button> </span>)}
        <button type="button" className={styles.metadataInlineAction} onClick={onOpenMeme}>{attachedMemes?.length ? '+ kolejny' : '+ Mem'}</button>
      </div>

      {contextAction ? <button type="button" className={styles.contextAction} onClick={contextAction.onClick}>{contextAction.label}</button> : null}
      <SourcesSection {...sources} />

      <section className={styles.contentBlock} data-hooks-section>
        <div className={styles.hookHeading}>
          <h2 className={styles.sectionLabel}>Hooki</h2>
          {!selectedHook && hooks.length > 0 ? <button type="button" className={styles.hookChooseAction} onClick={() => document.querySelector<HTMLElement>('[data-hook-option]')?.focus()}>Wybierz hook</button> : null}
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
        </ul>
      </section>

      <section className={styles.contentBlock}>
        <h2 className={styles.sectionLabel}>Skrypt</h2>
        <textarea
          className={styles.scriptField}
          aria-label="Skrypt"
          value={script}
          rows={4}
          onChange={(event) => onChangeScript(event.target.value)}
        />
        {scriptConflict ? <ConflictNotice conflict={scriptConflict} /> : null}
      </section>

      <div className={styles.aiRow} aria-label="Akcje AI">
        <button type="button" className={styles.aiButton} disabled={!aiRowEnabled} onClick={() => onAiAction?.('fact_check')}>Fakty</button>
        <button type="button" className={styles.aiButton} disabled={!aiRowEnabled} onClick={() => onAiAction?.('language_check')}>Aa Język</button>
        <button type="button" className={styles.aiButton} disabled={!aiRowEnabled} onClick={() => onAiAction?.('develop')}>✦ Opracuj</button>
      </div>

      <div className={styles.secondarySections}>
        <MaterialsSection {...materials} />
        <EditingNotesSection {...editingNotes} />
        <SectionRow label="PUBLIKACJA" expanded={publicationExpanded} summary={publicationExpanded ? undefined : metadata.status === 'published'
          ? `Opublikowano${publication.publishedAt ? ` · ${publication.publishedAt}` : ''} · Okładka ${publication.feedCoverDone ? 'gotowa' : 'niegotowa'}`
          : metadata.status === 'ready' && !publication.feedCoverDone
            ? <>{publication.description.trim() ? 'Opis gotowy' : 'Brak opisu'} · <span className={styles.publicationWarning}>Okładka niegotowa</span></>
            : `${publication.description.trim() ? 'Opis gotowy' : 'Brak opisu'} · Okładka ${publication.feedCoverDone ? 'gotowa' : 'niegotowa'}`}
          onClick={onTogglePublication} />
        {publicationExpanded ? <div ref={publicationRef}><PublicationSection {...publication} isReady={metadata.status === 'ready'} plan={plan} /></div> : null}
      </div>

      {conflict ? <ConflictNotice conflict={conflict} /> : null}
      {saveState === 'saving' ? <p className={styles.saveState} role="status">Zapisywanie…</p> : null}
      {saveState === 'offline' ? <p className={styles.saveState} role="status">Brak połączenia — zapisano lokalnie</p> : null}
      {saveState === 'error' ? <p className={styles.saveState} role="alert">Nie udało się zapisać</p> : null}
    </div>
  );
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

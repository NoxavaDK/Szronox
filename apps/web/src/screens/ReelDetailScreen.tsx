import '../ui/tokens.css';
import type { ReelDetailScreenProps } from '../ui/screen-contracts.js';
import { Avatar, CoverIndicator, PriorityGlyph, SectionRow } from '../ui/primitives.js';
import { priorityLabel } from '../ui/tokens.js';
import { BackArrowIcon, CloseIcon, OverflowIcon } from '../ui/icons.js';
import { PublicationSection } from './PublicationSection.js';
import styles from './ReelDetailScreen.module.css';

/** Reel Detail — frozen-visual-spec.md sec. 4. Controlled: all state and intents come from props. */
export function ReelDetailScreen(props: ReelDetailScreenProps) {
  const {
    onBack, title, onChangeTitle, onOpenOverflowMenu,
    metadata, onOpenFeedCover,
    hooks, onRemoveHook,
    script, onChangeScript,
    sourcesSummary, onOpenSources, materialsSummary, onOpenMaterials, editingNotesSummary, onOpenEditingNotes,
    publicationExpanded, onTogglePublication, publication,
    saveState,
  } = props;

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <button type="button" className={styles.iconButton} onClick={onBack} aria-label="Wstecz">
          <BackArrowIcon />
        </button>
        <input
          className={styles.titleField}
          aria-label="Tytuł"
          value={title}
          onChange={(event) => onChangeTitle(event.target.value)}
        />
        <button type="button" className={styles.iconButton} onClick={onOpenOverflowMenu} aria-label="Więcej opcji">
          <OverflowIcon />
        </button>
      </header>

      <div className={styles.metadataCluster}>
        <span className={styles.metadataItem}>{metadata.statusLabel}</span>
        {metadata.priority !== 'normal' ? (
          <span className={styles.metadataItem}>
            <PriorityGlyph priority={metadata.priority} />
            {priorityLabel[metadata.priority]}
          </span>
        ) : null}
        {metadata.editor ? (
          <span className={styles.metadataItem}>
            <Avatar user={metadata.editor} size={18} />
            {metadata.editor.name}
          </span>
        ) : null}
        {metadata.programmeState === 'matched' ? (
          <span className={`${styles.metadataItem} ${styles.metadataProgramme}`}>Program</span>
        ) : null}
        {metadata.memeName ? <span className={styles.metadataItem}>{metadata.memeName}</span> : null}
        <span className={styles.metadataItem}>
          <CoverIndicator done={metadata.feedCoverDone} onClick={onOpenFeedCover} size={16} />
        </span>
        {metadata.verificationState ? (
          <span
            className={`${styles.metadataItem} ${metadata.verificationState === 'verified' ? styles.metadataVerified : metadata.verificationState === 'outdated' ? styles.metadataOutdated : ''}`}
          >
            {metadata.verificationState === 'verified' ? 'Zweryfikowano' : metadata.verificationState === 'outdated' ? 'Nieaktualne' : 'Nie sprawdzone'}
          </span>
        ) : null}
      </div>

      <div className={styles.contentBlock}>
        <span className={styles.sectionLabel}>Hooki</span>
        <div className={styles.hookList}>
          {hooks
            .slice()
            .sort((a, b) => a.position - b.position)
            .map((hook) => (
              <div className={styles.hookRow} key={hook.id}>
                <span className={styles.hookText}>{hook.text}</span>
                {hook.source === 'user' ? <span className={styles.hookOwnTag}>Twój hook</span> : null}
                <button
                  type="button"
                  className={styles.hookRemove}
                  onClick={() => onRemoveHook(hook.id)}
                  aria-label="Usuń hook"
                >
                  <CloseIcon size={13} />
                </button>
              </div>
            ))}
        </div>
      </div>

      <div className={styles.contentBlock}>
        <span className={styles.sectionLabel}>Scenariusz</span>
        <textarea
          className={styles.scriptField}
          aria-label="Scenariusz"
          value={script}
          onChange={(event) => onChangeScript(event.target.value)}
        />
      </div>

      <div className={styles.aiRow} role="group" aria-label="Akcje AI (niedostępne w tym etapie)">
        <button type="button" className={styles.aiButton} disabled>
          Fakty
        </button>
        <button type="button" className={styles.aiButton} disabled>
          Aa Język
        </button>
        <button type="button" className={styles.aiButton} disabled>
          ✦ Opracuj
        </button>
      </div>

      <div className={styles.secondarySections}>
        <SectionRow label="Źródła / wejście" summary={sourcesSummary} onClick={onOpenSources} />
        <SectionRow label="Materiały" summary={materialsSummary} onClick={onOpenMaterials} />
        <SectionRow label="Uwagi do montażu" summary={editingNotesSummary} onClick={onOpenEditingNotes} />
        <SectionRow label="Publikacja" onClick={onTogglePublication} />
      </div>

      {publicationExpanded ? <PublicationSection {...publication} /> : null}

      <SaveStateLine state={saveState} />
    </div>
  );
}

function SaveStateLine({ state }: { state: ReelDetailScreenProps['saveState'] }) {
  const text =
    state === 'saving' ? 'Zapisywanie' :
    state === 'saved' ? 'Zapisano' :
    state === 'offline' ? 'Brak sieci · zmiany zapisane lokalnie' :
    state === 'conflict' ? 'Konflikt zapisu · sprawdź zmiany' :
    state === 'error' ? 'Nie udało się zapisać' :
    '';
  const tone = state === 'offline' || state === 'conflict' ? 'offline' : undefined;
  return (
    <p className={styles.saveState} data-tone={tone} aria-live="polite">
      {text}
    </p>
  );
}

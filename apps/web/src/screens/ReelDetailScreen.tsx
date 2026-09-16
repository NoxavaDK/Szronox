import '../ui/tokens.css';
import type { ReelDetailScreenProps } from '../ui/screen-contracts.js';
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
    onBack, title, onChangeTitle, titlePlaceholder,
    metadata, selectors, overflow, onOpenFeedCover, restore,
    hooks, onRemoveHook,
    script, onChangeScript, scriptConflict,
    sources, editingNotes, materials,
    publicationExpanded, onTogglePublication, publication,
    saveState, conflict,
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
          // The derived label, when there is no title. A placeholder keeps the field empty,
          // so nothing here can be saved as a title the user did not write.
          placeholder={titlePlaceholder}
          onChange={(event) => onChangeTitle(event.target.value)}
        />
        <CoverIndicator done={metadata.feedCoverDone} onClick={onOpenFeedCover} />
        <ReelOverflow {...overflow} />
      </header>

      {/* Shown only when this Reel is soft-deleted. */}
      {restore ? <RestoreBanner {...restore} /> : null}

      {/* Controlled STATUS / PRIORYTET / MONTUJE (frozen batch sec. 3). */}
      <MetadataSelectors {...selectors} />

      {metadata.programmeState !== 'unchecked' ? (
        <p className={styles.metadataProgramme}>
          {metadata.programmeState === 'matched' ? 'Program: powiązane' : 'Program: brak powiązania'}
        </p>
      ) : null}
      {metadata.memeName ? <p className={styles.metadataItem}>Mem: {metadata.memeName}</p> : null}

      <section className={styles.contentBlock}>
        <h2 className={styles.sectionLabel}>Hooki</h2>
        <ul className={styles.hookList}>
          {hooks.map((hook) => (
            <li key={hook.id} className={styles.hookRow}>
              <span className={styles.hookText}>{hook.text}</span>
              {hook.source === 'user' ? <span className={styles.hookOwnTag}>własny</span> : null}
              <button
                type="button"
                className={styles.hookRemove}
                onClick={() => onRemoveHook(hook.id)}
                aria-label="Usuń hook"
              >
                <CloseIcon />
              </button>
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
          rows={8}
          onChange={(event) => onChangeScript(event.target.value)}
        />
        {scriptConflict ? <ConflictNotice conflict={scriptConflict} /> : null}
      </section>

      {/* Capability-disabled for this milestone: present, honestly inert. */}
      <div className={styles.aiRow} aria-label="Akcje AI">
        <button type="button" className={styles.aiButton} disabled>Fakty</button>
        <button type="button" className={styles.aiButton} disabled>Aa Język</button>
        <button type="button" className={styles.aiButton} disabled>✦ Opracuj</button>
      </div>

      <div className={styles.secondarySections}>
        <SourcesSection {...sources} />
        <EditingNotesSection {...editingNotes} />
        <MaterialsSection {...materials} />
        <SectionRow label="PUBLIKACJA" onClick={onTogglePublication} />
        {publicationExpanded ? <PublicationSection {...publication} /> : null}
      </div>

      {conflict ? <ConflictNotice conflict={conflict} /> : null}
      {saveState === 'saving' ? <p className={styles.saveState} role="status">Zapisywanie…</p> : null}
      {saveState === 'offline' ? <p className={styles.saveState} role="status">Brak połączenia — zapisano lokalnie</p> : null}
      {saveState === 'error' ? <p className={styles.saveState} role="alert">Nie udało się zapisać</p> : null}
    </div>
  );
}

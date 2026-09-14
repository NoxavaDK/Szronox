import '../ui/tokens.css';
import type { ReelListItemView, ReelListScreenProps } from '../ui/screen-contracts.js';
import { Avatar, AttentionStrip, CoverIndicator, FloatingAddButton, PriorityGlyph, StatusBanner } from '../ui/primitives.js';
import { StatusSelector } from '../ui/StatusSelector.js';
import styles from './ReelListScreen.module.css';

/** "Rolki" — frozen-visual-spec.md sec. 2. Controlled: all state and intents come from props. */
export function ReelListScreen(props: ReelListScreenProps) {
  const { currentUser, statusTabs, selectedStatus, onSelectStatus, attentionCount, onOpenAttention, loadState, items, onOpenReel, onAddNew, onRetry } = props;

  // "may be surfaced where operationally useful, especially Montaż/Gotowe" (sec. 2) —
  // a presentational choice, not a data decision, so it lives here rather than in props.
  const showFeedCover = selectedStatus === 'editing' || selectedStatus === 'ready';

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <h1 className={styles.title}>Rolki</h1>
        <Avatar user={currentUser} size={32} />
      </header>

      <StatusSelector tabs={statusTabs} selected={selectedStatus} onSelect={onSelectStatus} />

      {typeof attentionCount === 'number' && attentionCount > 0 ? (
        <AttentionStrip count={attentionCount} onClick={onOpenAttention ?? (() => {})} />
      ) : null}

      {loadState === 'loading' ? (
        <div className={styles.emptyOrLoading}>
          <StatusBanner tone="loading" message="Wczytywanie…" />
        </div>
      ) : loadState === 'offline' ? (
        <div className={styles.emptyOrLoading}>
          <StatusBanner tone="offline" message="Brak sieci" actionLabel={onRetry ? 'Spróbuj ponownie' : undefined} onAction={onRetry} />
        </div>
      ) : loadState === 'error' ? (
        <div className={styles.emptyOrLoading}>
          <StatusBanner tone="error" message="Nie udało się wczytać" actionLabel={onRetry ? 'Spróbuj ponownie' : undefined} onAction={onRetry} />
        </div>
      ) : items.length === 0 ? (
        <div className={styles.emptyOrLoading}>
          <StatusBanner tone="empty" message="Brak rolek w tym widoku" />
        </div>
      ) : (
        <ul className={styles.list} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {items.map((item) => (
            <li key={item.id} style={{ display: 'contents' }}>
              <ReelRow item={item} showFeedCover={showFeedCover} onOpen={() => onOpenReel(item.id)} />
            </li>
          ))}
        </ul>
      )}

      <FloatingAddButton onClick={onAddNew} label="Nowy pomysł" />
    </div>
  );
}

function ReelRow({ item, showFeedCover, onOpen }: { item: ReelListItemView; showFeedCover: boolean; onOpen: () => void }) {
  const isUrgent = item.priority === 'urgent';
  return (
    <button type="button" className={styles.row} onClick={onOpen}>
      {isUrgent ? <span className={styles.urgentRail} aria-hidden /> : null}
      <div className={styles.rowMain}>
        <div className={styles.titleLine}>
          <span className={styles.rowTitle}>{item.title}</span>
          {item.priority !== 'normal' ? <PriorityGlyph priority={item.priority} /> : null}
        </div>
        <div className={styles.metaLine}>
          {isUrgent ? (
            <span className={`${styles.metaItem} ${styles.metaUrgent}`}>Pilne</span>
          ) : item.elapsedLabel ? (
            <span className={styles.metaItem}>{item.elapsedLabel}</span>
          ) : null}
          {item.editor ? (
            <span className={styles.metaItem}>
              <Avatar user={item.editor} size={18} />
              <span className={styles.editorName}>{item.editor.name}</span>
            </span>
          ) : null}
          {item.verificationState ? (
            <span
              className={`${styles.metaItem} ${item.verificationState === 'verified' ? styles.metaVerified : item.verificationState === 'outdated' ? styles.metaOutdated : ''}`}
            >
              {item.verificationState === 'verified' ? 'Zweryfikowano' : item.verificationState === 'outdated' ? 'Nieaktualne' : 'Nie sprawdzone'}
            </span>
          ) : null}
          {item.programmeState === 'matched' ? (
            <span className={`${styles.metaItem} ${styles.metaProgramme}`}>Program</span>
          ) : null}
          {item.memeName ? (
            <span className={`${styles.metaItem} ${styles.metaMeme}`}>{item.memeName}</span>
          ) : null}
        </div>
      </div>
      {showFeedCover ? (
        <span className={styles.rowCover}>
          <CoverIndicator done={item.feedCoverDone} size={17} />
        </span>
      ) : null}
    </button>
  );
}

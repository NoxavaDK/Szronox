import { useEffect, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import '../ui/tokens.css';
import type { ReelListItemView, ReelListScreenProps, ReelQuickActionsProps } from '../ui/screen-contracts.js';
import { Avatar, AttentionStrip, CoverIndicator, FloatingAddButton, PriorityGlyph, StatusBanner } from '../ui/primitives.js';
import { StatusSelector } from '../ui/StatusSelector.js';
import { useRowGesture, prefersReducedMotion } from '../ui/gestures.js';
import { ReelQuickActionsSheet, UndoSnackbar, quickAdvanceLabel } from './ReelQuickActions.js';
import { COPY } from '../ui/screen-contracts.js';
import styles from './ReelListScreen.module.css';
import quickStyles from './ReelQuickActions.module.css';

/** "Rolki" — frozen-visual-spec.md sec. 2. Controlled: all state and intents come from props. */
export function ReelListScreen(props: ReelListScreenProps) {
  const { currentUser, statusTabs, selectedStatus, onSelectStatus, attentionCount, onOpenAttention, loadState, items, onOpenReel, onAddNew, onRetry, quickActions } = props;

  // "may be surfaced where operationally useful, especially Montaż/Gotowe" (sec. 2) —
  // a presentational choice, not a data decision, so it lives here rather than in props.
  const showFeedCover = selectedStatus === 'editing' || selectedStatus === 'ready';

  // Only one row's swipe reveal is open at a time; a new one opening closes the previous —
  // this is what LIST-01 means by closing revealed actions when opening another row.
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const openItem = quickActions && quickActions.openReelId !== null
    ? items.find((item) => item.id === quickActions.openReelId) ?? null
    : null;

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <h1 className={styles.title}>Rolki</h1>
        {/* Quiet secondary entry, per the frozen batch: never a sixth status tab. */}
        <button type="button" onClick={props.onOpenDeleted} aria-label="Usunięte">⋮</button>
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
            <ReelRow
              key={item.id}
              item={item}
              showFeedCover={showFeedCover}
              onOpen={() => onOpenReel(item.id)}
              quickActions={quickActions}
              revealed={revealedId === item.id}
              onRevealChange={setRevealedId}
            />
          ))}
        </ul>
      )}

      <FloatingAddButton onClick={onAddNew} label="Nowy pomysł" />

      {openItem && quickActions ? <ReelQuickActionsSheet item={openItem} quickActions={quickActions} /> : null}
      {quickActions?.undo ? <UndoSnackbar undo={quickActions.undo} /> : null}
    </div>
  );
}

function ReelRow({
  item, showFeedCover, onOpen, quickActions, revealed, onRevealChange,
}: {
  item: ReelListItemView;
  showFeedCover: boolean;
  onOpen: () => void;
  quickActions: ReelQuickActionsProps | undefined;
  revealed: boolean;
  onRevealChange: (id: string | null) => void;
}) {
  const isUrgent = item.priority === 'urgent';
  const gesturesEnabled = quickActions !== undefined;

  const { offset, close, handlers } = useRowGesture({
    disabled: !gesturesEnabled,
    onLongPress: () => quickActions?.onOpenSheet(item.id),
    onSwipeOpen: () => onRevealChange(item.id),
  });

  // Another row opened its own swipe reveal, or the quick-actions sheet closed the whole
  // list's interaction state (e.g. after a confirmed delete): this row's reveal, if any,
  // must close too rather than being left visually open with nothing behind it anymore.
  useEffect(() => { if (!revealed && offset !== 0) close(); }, [revealed, offset, close]);

  const reduceMotion = prefersReducedMotion();
  const dragging = offset !== 0 && !revealed;

  const advance = quickAdvanceLabel(item.status);

  const onRowClick = () => {
    if (offset !== 0) { close(); onRevealChange(null); return; }
    onOpen();
  };

  const onContextMenu = (event: ReactMouseEvent) => {
    if (!gesturesEnabled) return;
    event.preventDefault();
    quickActions?.onOpenSheet(item.id);
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (!gesturesEnabled) return;
    // Keyboard-operable, non-gesture route to every quick action (standard OS context-menu
    // key/chord) — required since long-press and swipe have no keyboard equivalent.
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      quickActions?.onOpenSheet(item.id);
    }
  };

  return (
    <li className={styles.rowWrapper}>
      <div className={quickStyles.revealTrack} data-active={offset !== 0 ? 'true' : undefined} aria-hidden={offset === 0}>
        <div className={quickStyles.revealRight}>
          {advance ? (
            <button
              type="button"
              className={quickStyles.revealButton}
              tabIndex={-1}
              onClick={() => { quickActions?.onQuickAdvanceStatus(item.id, advance.status); close(); onRevealChange(null); }}
            >
              {advance.label}
            </button>
          ) : (
            <button
              type="button"
              className={quickStyles.revealButton}
              tabIndex={-1}
              onClick={() => { quickActions?.onOpenStatus(item.id); close(); onRevealChange(null); }}
            >
              {COPY.changeStatus}
            </button>
          )}
        </div>
        <div className={quickStyles.revealLeft}>
          <button
            type="button"
            className={quickStyles.revealButton}
            tabIndex={-1}
            onClick={() => { quickActions?.onOpenSheet(item.id); close(); onRevealChange(null); }}
          >
            {COPY.moreActions}
          </button>
        </div>
      </div>

      <button
        type="button"
        className={styles.row}
        style={{
          transform: offset !== 0 ? `translateX(${offset}px)` : undefined,
          transition: dragging || reduceMotion ? 'none' : 'transform 160ms ease',
        }}
        onClick={onRowClick}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        {...handlers}
      >
        {isUrgent ? <span className={styles.urgentRail} aria-hidden /> : null}
        <div className={styles.rowMain}>
          <div className={styles.titleLine}>
            {/* A derived label sits in the same slot at the same size — only quieter, so it
                does not read as a title someone wrote. Layout and row height are unchanged. */}
            <span className={item.titleIsDerived ? `${styles.rowTitle} ${styles.rowTitleDerived}` : styles.rowTitle}>
              {item.title}
            </span>
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
    </li>
  );
}

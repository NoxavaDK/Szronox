import { useEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ReelStatus } from '@szronox/contracts';
import {
  COPY,
  STATUS_LABELS,
  STATUS_ORDER,
  nextReelStatus,
  type ReelListItemView,
  type ReelQuickActionsProps,
  type ReelUndoView,
} from '../ui/screen-contracts.js';
import { Avatar, TextAction } from '../ui/primitives.js';
import { CheckIcon } from '../ui/icons.js';
import styles from './ReelQuickActions.module.css';

/**
 * The long-press / swipe-left "Więcej" quick-actions sheet for one list row (LIST-01).
 *
 * Every action here also has a non-gesture route: the sheet itself opens from a keyboard
 * `ContextMenu` press or right-click on the row (`ReelListScreen`), and Zmień
 * status/Przypisz/Usuń are the same mutations Reel Detail already exposes. `Duplikuj` and a
 * distinct `Archiwizuj` are deliberately absent — see the LIST-01 interaction plan for why
 * neither has an approved contract to implement against.
 */
export function ReelQuickActionsSheet({
  item,
  quickActions,
}: {
  item: ReelListItemView;
  quickActions: ReelQuickActionsProps;
}) {
  const {
    open, onOpenStatus, onOpenAssign, onDismiss, editorOptions, onSelectStatus, onSelectEditor,
    onCopyLink, kdriveEnabled, onOpenKdrive, onRequestDelete, confirmingDeleteId, onCancelDelete,
    onConfirmDelete, selectionError, saveState,
  } = quickActions;

  const sheetRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const confirming = confirmingDeleteId === item.id;

  // Focus the sheet on open, and give focus back to whatever opened it on close — a
  // long-press or a right-click on the row, or the sheet's own "Więcej" swipe button.
  useEffect(() => {
    if (open === null) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    return () => { returnFocus.current?.focus(); };
  }, [open]);

  if (open === null) return null;

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); onDismiss(); }
  };

  const heading = open === 'status' ? COPY.statusHeading : open === 'assign' ? COPY.editorHeading : COPY.quickActionsHeading;

  return (
    <div className={styles.backdrop} onClick={onDismiss} role="presentation">
      <div
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label={heading}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {confirming ? (
          <>
            <h2 className={styles.heading}>{COPY.deleteConfirmTitle}</h2>
            <p className={styles.quiet}>{COPY.deleteConfirmBody}</p>
            <div className={styles.confirmActions}>
              <TextAction onClick={onCancelDelete}>{COPY.deleteCancel}</TextAction>
              <TextAction onClick={onConfirmDelete}>{COPY.deleteConfirm}</TextAction>
            </div>
            {selectionError ? <p className={styles.error} role="alert">{selectionError}</p> : null}
          </>
        ) : open === 'status' ? (
          <>
            <h2 className={styles.heading}>{heading}</h2>
            <ul className={styles.options}>
              {STATUS_ORDER.map((value) => (
                <li key={value}>
                  <button
                    type="button"
                    className={styles.option}
                    aria-pressed={value === item.status}
                    onClick={() => onSelectStatus(item.id, value)}
                  >
                    <span>{STATUS_LABELS[value]}</span>
                    {value === item.status ? <CheckIcon aria-hidden="true" /> : null}
                  </button>
                </li>
              ))}
            </ul>
            {selectionError ? <p className={styles.error} role="alert">{selectionError}</p> : null}
          </>
        ) : open === 'assign' ? (
          <>
            <h2 className={styles.heading}>{heading}</h2>
            <ul className={styles.options}>
              {editorOptions.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    className={styles.option}
                    aria-pressed={item.editor?.id === option.id}
                    onClick={() => onSelectEditor(item.id, option.id)}
                  >
                    <span className={styles.editorValue}><Avatar user={option} size={20} /> {option.name}</span>
                    {item.editor?.id === option.id ? <CheckIcon aria-hidden="true" /> : null}
                  </button>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  className={styles.option}
                  aria-pressed={item.editor === null}
                  onClick={() => onSelectEditor(item.id, null)}
                >
                  <span>{COPY.editorNone}</span>
                  {item.editor === null ? <CheckIcon aria-hidden="true" /> : null}
                </button>
              </li>
            </ul>
            {selectionError ? <p className={styles.error} role="alert">{selectionError}</p> : null}
          </>
        ) : (
          <>
            <h2 className={styles.heading}>{COPY.quickActionsHeading}</h2>
            <ul className={styles.options}>
              <li>
                <button type="button" className={styles.option} onClick={() => onOpenStatus(item.id)}>
                  {COPY.changeStatus}
                </button>
              </li>
              <li>
                <button type="button" className={styles.option} onClick={() => onOpenAssign(item.id)}>
                  {COPY.assignEditor}
                </button>
              </li>
              <li>
                <button type="button" className={styles.option} onClick={() => onCopyLink(item.id)}>
                  {COPY.copyLink}
                </button>
              </li>
              {item.hasKdriveFolder ? (
                <li>
                  <button
                    type="button"
                    className={styles.option}
                    disabled={!kdriveEnabled}
                    onClick={() => onOpenKdrive(item.id)}
                  >
                    {COPY.kdriveOpen}
                  </button>
                </li>
              ) : null}
              <li>
                <button
                  type="button"
                  className={styles.option}
                  data-tone="danger"
                  onClick={() => onRequestDelete(item.id)}
                >
                  {COPY.deleteReel}
                </button>
              </li>
            </ul>
          </>
        )}
        {saveState === 'saving' ? <p className={styles.quiet} role="status">Zapisywanie…</p> : null}
      </div>
    </div>
  );
}

/** Target-status label for the swipe-right reveal pill; `null` means the ambiguous/"never guess" case. */
export function quickAdvanceLabel(status: ReelStatus): { status: ReelStatus; label: string } | null {
  const next = nextReelStatus(status);
  return next === null ? null : { status: next, label: STATUS_LABELS[next] };
}

/** The undo snackbar shown after a successful swipe-right/quick status move. */
export function UndoSnackbar({ undo }: { undo: ReelUndoView }) {
  return (
    <div className={styles.snackbar} role="status">
      <span>{undo.message}</span>
      <button type="button" className={styles.snackbarAction} onClick={undo.onUndo} disabled={undo.saveState === 'saving'}>
        {COPY.undo}
      </button>
    </div>
  );
}

export { styles as quickActionStyles };

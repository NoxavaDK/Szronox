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
import { ActionButton, Avatar, TextAction } from '../ui/primitives.js';
import { CalendarIcon, CheckIcon, OverflowIcon } from '../ui/icons.js';
import { radialActions, radialLayout, RADIAL_ITEM_SIZE, type RadialActionId } from '../ui/radial-menu.js';
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
    onCopyLink, onOpenSchedule, kdriveEnabled, onOpenKdrive, onRequestDelete, confirmingDeleteId, onCancelDelete,
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

  if (open === null || open === 'radial') return null;

  /**
   * Contains Tab/Shift+Tab within the sheet (`aria-modal` promises this; nothing enforced
   * it). The backdrop is only a visual overlay — without this, Tab from the last control
   * would reach whatever is behind it in the list. Queried fresh on every keydown rather
   * than cached, since which view (menu/status/assign/confirm) is showing — and so which
   * elements exist — changes while the sheet stays open.
   */
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); onDismiss(); return; }
    if (event.key !== 'Tab' || !sheetRef.current) return;
    const focusable = Array.from(
      sheetRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    );
    if (focusable.length === 0) { event.preventDefault(); return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
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
              <TextAction onClick={onCancelDelete} tone="quiet">{COPY.deleteCancel}</TextAction>
              {/* Red from the first step to the final one: destruction never turns blue. */}
              <ActionButton tone="danger" onClick={onConfirmDelete}>{COPY.deleteConfirm}</ActionButton>
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
              {onOpenSchedule ? (
                <li>
                  <button type="button" className={styles.option} onClick={() => onOpenSchedule(item.id)}>
                    <span>{COPY.schedule}</span>
                    {item.planLabel ? <span className={styles.quiet}>{item.planLabel}</span> : null}
                  </button>
                </li>
              ) : null}
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

const RADIAL_GLYPH: Record<RadialActionId, JSX.Element> = {
  status: <span aria-hidden="true" className={styles.radialGlyph}>⇄</span>,
  schedule: <CalendarIcon aria-hidden="true" />,
  assign: <span aria-hidden="true" className={styles.radialGlyph}>@</span>,
  more: <OverflowIcon aria-hidden="true" />,
};

/**
 * UI-02 radial quick-action menu (mobile long-press). Small and fast: four labelled targets on
 * an arc around the touch point, repositioned so no edge clips them. Tapping outside or Escape
 * closes it with no effect. Each action only opens an existing sheet — the mutation still takes
 * that sheet's explicit choice — and `Więcej` opens the full sheet, where every radial action
 * is also listed, so the gesture is never the only route.
 */
export function RadialQuickMenu({ item, quickActions }: { item: ReelListItemView; quickActions: ReelQuickActionsProps }) {
  const { open, radialAnchor, onDismiss, onOpenStatus, onOpenAssign, onOpenSchedule, onOpenSheet } = quickActions;
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open !== 'radial') return;
    menuRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [open]);
  if (open !== 'radial' || !radialAnchor) return null;
  const actions = radialActions(item).filter((action) => action.id !== 'schedule' || onOpenSchedule);
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const layout = radialLayout(radialAnchor, viewport, actions.length);
  const run = (id: RadialActionId) => {
    if (id === 'status') onOpenStatus(item.id);
    else if (id === 'assign') onOpenAssign(item.id);
    else if (id === 'schedule') onOpenSchedule?.(item.id);
    else onOpenSheet(item.id);
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); onDismiss(); return; }
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('button') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  };
  return (
    <div className={styles.radialBackdrop} role="presentation" onClick={onDismiss} onContextMenu={(event) => { event.preventDefault(); onDismiss(); }}>
      <span className={styles.radialOrigin} style={{ left: layout.centre.x, top: layout.centre.y }} aria-hidden="true" />
      <div ref={menuRef} role="menu" aria-label={`${COPY.quickActionsHeading}: ${item.title}`} onKeyDown={onKeyDown} onClick={(event) => event.stopPropagation()}>
        {actions.map((action, index) => (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            className={styles.radialItem}
            data-action={action.id}
            style={{ left: layout.items[index].x, top: layout.items[index].y, width: RADIAL_ITEM_SIZE, height: RADIAL_ITEM_SIZE }}
            onClick={() => run(action.id)}
          >
            {RADIAL_GLYPH[action.id]}
            <span className={styles.radialLabel}>{action.label}</span>
          </button>
        ))}
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

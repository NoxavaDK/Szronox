import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { PUBLICATION_SLOTS, SLOT_LABELS, planLabel, quickDays, type Plan, type PublicationSlot } from '../data/planner.js';
import { TextAction } from '../ui/primitives.js';
import sheetStyles from './ReelQuickActions.module.css';
import styles from './ScheduleSheet.module.css';

export interface ScheduleSheetProps {
  reelTitle: string;
  /** The Reel's current plan; `date: null` means unplanned. */
  plan: Plan;
  today: string;
  onConfirm: (date: string, slot: PublicationSlot | null) => void;
  /** Only offered when the Reel is planned: returns it to NIEZAPLANOWANE. */
  onClear: () => void;
  onDismiss: () => void;
  saving: boolean;
  error: string | null;
}

/**
 * `Zaplanuj` (CONTENT-PLANNER-01): one small sheet, the same from the planner, the list's
 * Więcej sheet and Reel Detail. Choose a day → optional Rano/Popołudnie/Wieczór → Gotowe. A
 * date alone is a complete plan; the slot is never required and tapping the chosen slot again
 * clears it. Nothing here touches the Reel's status.
 */
export function ScheduleSheet({ reelTitle, plan, today, onConfirm, onClear, onDismiss, saving, error }: ScheduleSheetProps) {
  const [date, setDate] = useState<string | null>(plan.date);
  const [slot, setSlot] = useState<PublicationSlot | null>(plan.slot);
  const sheetRef = useRef<HTMLDivElement>(null);
  const days = quickDays(today);
  const otherDay = date !== null && !days.some((day) => day.date === date);

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetRef.current?.querySelector<HTMLElement>('[aria-pressed="true"], button:not(:disabled)')?.focus();
    return () => { returnFocus?.focus(); };
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') { event.stopPropagation(); onDismiss(); return; }
    if (event.key !== 'Tab' || !sheetRef.current) return;
    const focusable = Array.from(sheetRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const current = planLabel(plan, today);

  return (
    <div className={sheetStyles.backdrop} onClick={onDismiss} role="presentation">
      <div
        ref={sheetRef}
        className={sheetStyles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Zaplanuj publikację"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 className={sheetStyles.heading}>Zaplanuj publikację</h2>
        <p className={sheetStyles.subject}>{reelTitle}{current ? ` · teraz: ${current}` : ''}</p>

        <div className={styles.days} role="group" aria-label="Dzień publikacji">
          {days.map((day) => (
            <button
              key={day.date}
              type="button"
              className={styles.day}
              aria-pressed={date === day.date}
              onClick={() => setDate(day.date)}
            >
              <span className={styles.dayName}>{day.label}</span>
              <span className={styles.dayDate}>{day.shortDate}</span>
            </button>
          ))}
        </div>

        <div className={styles.fields}>
          <label className={styles.field} data-active={otherDay ? 'true' : undefined}>
            <span>Inny dzień</span>
            <input type="date" value={date ?? ''} onChange={(event) => setDate(event.target.value || null)} />
          </label>
        </div>

        <div className={styles.slotField}>
          <span className={styles.slotLabel}>Pora dnia (opcjonalnie)</span>
          <div className={styles.slots} role="group" aria-label="Pora dnia">
            {PUBLICATION_SLOTS.map((value) => (
              <button
                key={value}
                type="button"
                className={styles.slot}
                aria-pressed={slot === value}
                disabled={date === null}
                onClick={() => setSlot(slot === value ? null : value)}
              >
                {SLOT_LABELS[value]}
              </button>
            ))}
          </div>
        </div>

        {error ? <p className={sheetStyles.error} role="alert">{error}</p> : null}

        <div className={styles.actions}>
          {plan.date !== null ? (
            <button type="button" className={styles.clear} onClick={onClear} disabled={saving}>Usuń z planu</button>
          ) : <span />}
          <span className={styles.primaryActions}>
            <TextAction onClick={onDismiss}>Anuluj</TextAction>
            <button
              type="button"
              className={styles.done}
              disabled={date === null || saving}
              onClick={() => { if (date !== null) onConfirm(date, slot); }}
            >
              {saving ? 'Zapisywanie…' : 'Gotowe'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import type { DragEvent as ReactDragEvent, ReactNode } from 'react';
import '../ui/tokens.css';
import type { Reel } from '../../../../packages/contracts/src/index.js';
import { groupPlanner, planOf, weekRangeLabel } from '../data/planner.js';
import { reelLabel } from '../data/reel-label.js';
import { STATUS_LABELS } from '../ui/screen-contracts.js';
import { CoverIndicator, StatusBanner } from '../ui/primitives.js';
import { BackArrowIcon, CalendarIcon, ChevronRightIcon } from '../ui/icons.js';
import styles from './PlannerPane.module.css';

/** The drag payload type: only a SzroNox Reel card can be dropped on a day. */
const DRAG_TYPE = 'application/x-szronox-reel';

export interface PlannerPaneProps {
  /** `pane`: the persistent left column on wide layouts. `screen`: the full-width mobile PLAN view. */
  variant: 'pane' | 'screen';
  reels: readonly Reel[];
  today: string;
  weekOffset: number;
  onChangeWeek: (offset: number) => void;
  loadState: 'idle' | 'loading' | 'loaded' | 'error' | 'offline';
  onRetry: () => void;
  /** The Reel open in the centre, highlighted in the plan. */
  selectedReelId: string | null;
  onOpenReel: (id: string) => void;
  /** The explicit, touch-friendly route: opens the Zaplanuj sheet for this Reel. */
  onSchedule: (id: string) => void;
  /** Desktop drag and drop: a day's date, or `null` for NIEZAPLANOWANE. Always optional. */
  onMove?: (id: string, date: string | null) => void;
  /** Mobile header action back to the list. */
  onOpenReels?: () => void;
  headerAside?: ReactNode;
}

/**
 * PLAN — CONTENT-PLANNER-01. A calm week agenda over existing Reels: the days of the week,
 * what is planned on each, and what is still unplanned. Tapping a card opens the Reel; the
 * calendar button beside it is the explicit way to set, move or clear its plan everywhere,
 * so drag and drop on desktop is only ever a shortcut.
 */
export function PlannerPane(props: PlannerPaneProps) {
  const { variant, reels, today, weekOffset, onChangeWeek, loadState, onRetry, selectedReelId, onOpenReel, onSchedule, onMove } = props;
  const groups = groupPlanner(reels, today, weekOffset);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragEnabled = variant === 'pane' && onMove !== undefined;

  const dropHandlers = (key: string, date: string | null) => (dragEnabled ? {
    onDragOver: (event: ReactDragEvent) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (dropTarget !== key) setDropTarget(key);
    },
    onDragLeave: (event: ReactDragEvent) => {
      if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setDropTarget(null);
    },
    onDrop: (event: ReactDragEvent) => {
      const id = event.dataTransfer.getData(DRAG_TYPE);
      setDropTarget(null);
      if (!id) return;
      event.preventDefault();
      const reel = reels.find((item) => item.id === id);
      // Dropping on the day it is already on is not a change.
      if (!reel || planOf(reel).date === date) return;
      onMove?.(id, date);
    },
  } : {});

  const card = (reel: Reel) => (
    <PlannerCard
      key={reel.id}
      reel={reel}
      selected={reel.id === selectedReelId}
      draggable={dragEnabled}
      onOpen={() => onOpenReel(reel.id)}
      onSchedule={() => onSchedule(reel.id)}
    />
  );

  return (
    <section className={styles.planner} data-variant={variant} aria-label="Plan publikacji">
      <header className={styles.header}>
        <h1 className={styles.title}>Plan</h1>
        {props.onOpenReels ? (
          <button type="button" className={styles.headerLink} onClick={props.onOpenReels}>Rolki</button>
        ) : null}
        {props.headerAside}
      </header>

      <div className={styles.weekSwitcher} role="group" aria-label="Tydzień">
        <button type="button" className={styles.weekStep} onClick={() => onChangeWeek(weekOffset - 1)} aria-label="Poprzedni tydzień">
          <BackArrowIcon size={16} />
        </button>
        <span className={styles.weekLabel}>
          {weekOffset === 0 ? 'Ten tydzień' : weekOffset === 1 ? 'Następny tydzień' : weekOffset === -1 ? 'Poprzedni tydzień' : weekRangeLabel(today, weekOffset)}
          {weekOffset === 0 || weekOffset === 1 || weekOffset === -1 ? <span className={styles.weekRange}> · {weekRangeLabel(today, weekOffset)}</span> : null}
        </span>
        <button type="button" className={styles.weekStep} onClick={() => onChangeWeek(weekOffset + 1)} aria-label="Następny tydzień">
          <ChevronRightIcon size={16} />
        </button>
        {weekOffset !== 0 ? (
          <button type="button" className={styles.weekToday} onClick={() => onChangeWeek(0)}>Dziś</button>
        ) : null}
      </div>

      {loadState === 'loading' && reels.length === 0 ? (
        <StatusBanner tone="loading" message="Wczytywanie…" />
      ) : (loadState === 'error' || loadState === 'offline') && reels.length === 0 ? (
        <StatusBanner tone={loadState} message={loadState === 'offline' ? 'Brak sieci' : 'Nie udało się wczytać planu'} actionLabel="Spróbuj ponownie" onAction={onRetry} />
      ) : (
        <>
          {groups.overdue.length > 0 ? (
            <div className={styles.group} data-tone="overdue">
              <h2 className={styles.groupLabel}>Po terminie</h2>
              <ul className={styles.cards}>{groups.overdue.map(card)}</ul>
            </div>
          ) : null}

          {groups.days.map((day) => (
            <div
              key={day.date}
              className={styles.group}
              data-today={day.isToday ? 'true' : undefined}
              data-drop={dropTarget === day.date ? 'true' : undefined}
              {...dropHandlers(day.date, day.date)}
            >
              <h2 className={styles.dayLabel}>
                <span>{day.label}</span>
                <span className={styles.dayDate}>{day.shortDate}</span>
              </h2>
              {day.items.length > 0 ? (
                <ul className={styles.cards}>{day.items.map(card)}</ul>
              ) : (
                <p className={styles.emptyDay}>—</p>
              )}
            </div>
          ))}

          <div
            className={`${styles.group} ${styles.unscheduled}`}
            data-drop={dropTarget === 'unscheduled' ? 'true' : undefined}
            {...dropHandlers('unscheduled', null)}
          >
            <h2 className={styles.groupLabel}>
              Niezaplanowane{groups.unscheduled.length > 0 ? <span className={styles.count}> {groups.unscheduled.length}</span> : null}
            </h2>
            {groups.unscheduled.length > 0 ? (
              <ul className={styles.cards}>{groups.unscheduled.map(card)}</ul>
            ) : (
              <p className={styles.emptyDay}>Wszystko w produkcji ma termin.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function PlannerCard({ reel, selected, draggable, onOpen, onSchedule }: {
  reel: Reel;
  selected: boolean;
  draggable: boolean;
  onOpen: () => void;
  onSchedule: () => void;
}) {
  const label = reelLabel(reel);
  const { time } = planOf(reel);
  // Preparation readiness uses only state that already exists reliably: the workflow status
  // and the required feed cover. Nothing is inferred beyond that.
  const showCover = reel.status === 'editing' || reel.status === 'ready' || reel.status === 'published';
  return (
    <li
      className={styles.card}
      data-selected={selected ? 'true' : undefined}
      draggable={draggable}
      onDragStart={draggable ? (event) => {
        event.dataTransfer.setData(DRAG_TYPE, reel.id);
        event.dataTransfer.setData('text/plain', label.text);
        event.dataTransfer.effectAllowed = 'move';
      } : undefined}
    >
      <button type="button" className={styles.cardMain} onClick={onOpen} aria-current={selected ? 'true' : undefined}>
        <span className={label.derived ? `${styles.cardTitle} ${styles.cardTitleDerived}` : styles.cardTitle}>{label.text}</span>
        <span className={styles.cardMeta}>
          {time ? <span className={styles.cardTime}>{time}</span> : null}
          <span data-status={reel.status}>{STATUS_LABELS[reel.status]}</span>
          {showCover ? <CoverIndicator done={reel.feedCoverDone} size={14} /> : null}
        </span>
      </button>
      <button type="button" className={styles.cardSchedule} onClick={onSchedule} aria-label={`Zaplanuj: ${label.text}`} title="Zaplanuj">
        <CalendarIcon />
      </button>
    </li>
  );
}

/**
 * CONTENT-PLANNER-01: the planner is a view over existing Reels, never its own data.
 *
 * Everything here is pure and derived from `Reel.plannedPublicationDate` /
 * `plannedPublicationTime`, so the planner, the list quick action and Reel Detail can only
 * ever show one plan per Reel. Dates are local calendar days (`YYYY-MM-DD`) with a Monday
 * week start; no time zone arithmetic is involved because the stored value has no zone.
 */

import type { Reel, ReelStatus } from '../../../../packages/contracts/src/index.js';

export type PlanFields = Pick<Reel, 'plannedPublicationDate' | 'plannedPublicationTime'>;

/**
 * Which unplanned Reels belong in NIEZAPLANOWANE: work that is actually heading for
 * publication. `idea` is excluded because raw ideas are not yet content to schedule (they
 * can still be planned explicitly from the list or Detail); `published` is history. Deleted
 * Reels never reach the planner at all.
 */
export const UNSCHEDULED_STATUSES: readonly ReelStatus[] = ['to_record', 'editing', 'ready'];

const WEEKDAY_SHORT = ['ND', 'PN', 'WT', 'ŚR', 'CZW', 'PT', 'SOB'];
const WEEKDAY_LOWER = ['nd', 'pn', 'wt', 'śr', 'czw', 'pt', 'sob'];

/** A Reel cached before CONTENT-PLANNER-01 has no plan fields at all: that means unplanned. */
export function planOf(reel: Partial<PlanFields>): { date: string | null; time: string | null } {
  const date = reel.plannedPublicationDate ?? null;
  return { date, time: date === null ? null : reel.plannedPublicationTime ?? null };
}

export function localIsoDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight of a `YYYY-MM-DD` day. */
export function dateOf(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function addDays(iso: string, days: number): string {
  const date = dateOf(iso);
  date.setDate(date.getDate() + days);
  return localIsoDate(date);
}

/** Monday of the week containing `iso`. */
export function weekStartOf(iso: string): string {
  const weekday = dateOf(iso).getDay();
  return addDays(iso, weekday === 0 ? -6 : 1 - weekday);
}

function shortDate(iso: string): string {
  const [, month, day] = iso.split('-');
  return `${day}.${month}`;
}

export interface PlannerDay {
  date: string;
  /** DZIŚ / JUTRO / ŚR … */
  label: string;
  /** `24.09` */
  shortDate: string;
  isToday: boolean;
  isPast: boolean;
}

/**
 * The days a week view shows. The current week (`offset` 0) starts at today, because the
 * questions it answers are "what today" and "what next"; other weeks show Monday–Sunday.
 */
export function plannerWeek(today: string, offset: number): PlannerDay[] {
  const monday = addDays(weekStartOf(today), offset * 7);
  const days: PlannerDay[] = [];
  for (let index = 0; index < 7; index += 1) {
    const date = addDays(monday, index);
    if (offset === 0 && date < today) continue;
    days.push({ date, label: dayLabel(date, today), shortDate: shortDate(date), isToday: date === today, isPast: date < today });
  }
  return days;
}

export function dayLabel(date: string, today: string): string {
  if (date === today) return 'DZIŚ';
  if (date === addDays(today, 1)) return 'JUTRO';
  return WEEKDAY_SHORT[dateOf(date).getDay()];
}

/** `22.09 – 28.09`, the heading of the week switcher. */
export function weekRangeLabel(today: string, offset: number): string {
  const monday = addDays(weekStartOf(today), offset * 7);
  return `${shortDate(monday)} – ${shortDate(addDays(monday, 6))}`;
}

/** How a plan reads next to a Reel: `Dziś, 18:00`, `Jutro`, `czw 01.10`. */
export function planLabel(plan: { date: string | null; time: string | null }, today: string): string | null {
  if (plan.date === null) return null;
  const day = plan.date === today
    ? 'Dziś'
    : plan.date === addDays(today, 1)
      ? 'Jutro'
      : `${WEEKDAY_LOWER[dateOf(plan.date).getDay()]} ${shortDate(plan.date)}${plan.date.slice(0, 4) === today.slice(0, 4) ? '' : `.${plan.date.slice(0, 4)}`}`;
  return plan.time ? `${day}, ${plan.time}` : day;
}

export function isUnscheduledCandidate(reel: Pick<Reel, 'status' | 'deletedAt'> & Partial<PlanFields>): boolean {
  return reel.deletedAt === null && planOf(reel).date === null && UNSCHEDULED_STATUSES.includes(reel.status);
}

/** Planned for a day already gone and still not published. */
export function isOverdue(reel: Pick<Reel, 'status' | 'deletedAt'> & Partial<PlanFields>, today: string): boolean {
  const { date } = planOf(reel);
  return reel.deletedAt === null && date !== null && date < today && reel.status !== 'published';
}

/** Timed Reels in time order, then untimed ones; ties keep the incoming (list) order. */
function byTime<T extends Partial<PlanFields>>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index, time: planOf(item).time }))
    .sort((a, b) => {
      if (a.time !== b.time) {
        if (a.time === null) return 1;
        if (b.time === null) return -1;
        return a.time < b.time ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

export interface PlannerGroups<T> {
  days: Array<PlannerDay & { items: T[] }>;
  /** Only in the current week: planned before today and still not published. */
  overdue: T[];
  unscheduled: T[];
}

export function groupPlanner<T extends Pick<Reel, 'id' | 'status' | 'deletedAt'> & Partial<PlanFields>>(
  reels: readonly T[], today: string, offset: number,
): PlannerGroups<T> {
  const active = reels.filter((reel) => reel.deletedAt === null);
  const days = plannerWeek(today, offset).map((day) => ({
    ...day,
    items: byTime(active.filter((reel) => planOf(reel).date === day.date)),
  }));
  return {
    days,
    overdue: offset === 0 ? byTime(active.filter((reel) => isOverdue(reel, today))) : [],
    unscheduled: active.filter(isUnscheduledCandidate),
  };
}

/** Day shortcuts for the Zaplanuj sheet: today plus the next six days. */
export function quickDays(today: string, count = 7): Array<{ date: string; label: string; shortDate: string }> {
  return Array.from({ length: count }, (_, index) => {
    const date = addDays(today, index);
    return { date, label: dayLabel(date, today), shortDate: shortDate(date) };
  });
}

/**
 * The patch a plan change sends. Clearing the date always clears the time too, so
 * unscheduling is one action and never leaves a dangling time.
 */
export function planChanges(date: string | null, time: string | null): PlanFields {
  return { plannedPublicationDate: date, plannedPublicationTime: date === null ? null : time || null };
}

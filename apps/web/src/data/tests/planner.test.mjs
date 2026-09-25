import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addDays, groupPlanner, isOverdue, isUnscheduledCandidate, planChanges, planLabel, planOf,
  plannerWeek, quickDays, weekRangeLabel, weekStartOf,
} from '../planner.ts';

// Thursday 2026-09-24; its week is Monday 21.09 – Sunday 27.09.
const TODAY = '2026-09-24';

const reel = (over = {}) => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  status: 'editing',
  deletedAt: null,
  plannedPublicationDate: null,
  plannedPublicationTime: null,
  ...over,
});

test('dates are local calendar days with a Monday week start', () => {
  assert.equal(weekStartOf(TODAY), '2026-09-21');
  assert.equal(weekStartOf('2026-09-27'), '2026-09-21', 'Sunday belongs to the week before it');
  assert.equal(weekStartOf('2026-09-21'), '2026-09-21');
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(addDays('2026-10-25', 1), '2026-10-26', 'DST change does not skip or repeat a day');
  assert.equal(addDays('2026-03-29', 1), '2026-03-30');
});

test('the current week starts today: DZIŚ, JUTRO, then weekdays to Sunday', () => {
  const days = plannerWeek(TODAY, 0);
  assert.deepEqual(days.map((day) => day.label), ['DZIŚ', 'JUTRO', 'SOB', 'ND']);
  assert.deepEqual(days.map((day) => day.date), ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']);
  assert.equal(days[0].isToday, true);
  const monday = plannerWeek('2026-09-21', 0);
  assert.deepEqual(monday.map((day) => day.label), ['DZIŚ', 'JUTRO', 'ŚR', 'CZW', 'PT', 'SOB', 'ND']);
});

test('other weeks show Monday to Sunday and a range label', () => {
  const next = plannerWeek(TODAY, 1);
  assert.equal(next.length, 7);
  assert.equal(next[0].date, '2026-09-28');
  assert.equal(next[0].label, 'PN');
  assert.equal(next[6].date, '2026-10-04');
  assert.equal(weekRangeLabel(TODAY, 1), '28.09 – 04.10');
  const previous = plannerWeek(TODAY, -1);
  assert.equal(previous[0].date, '2026-09-14');
  assert.equal(previous.every((day) => day.isPast), true);
});

test('a scheduled Reel appears on exactly its day, timed first in time order', () => {
  const a = reel({ id: 'a', plannedPublicationDate: '2026-09-25' });
  const b = reel({ id: 'b', plannedPublicationDate: '2026-09-25', plannedPublicationTime: '18:00' });
  const c = reel({ id: 'c', plannedPublicationDate: '2026-09-25', plannedPublicationTime: '08:30' });
  const d = reel({ id: 'd', plannedPublicationDate: '2026-09-28' });
  const groups = groupPlanner([a, b, c, d], TODAY, 0);
  assert.deepEqual(groups.days.find((day) => day.label === 'JUTRO').items.map((item) => item.id), ['c', 'b', 'a']);
  assert.equal(groups.days.flatMap((day) => day.items).length, 3, 'next week is not in this week');
  assert.deepEqual(groupPlanner([a, b, c, d], TODAY, 1).days[0].items.map((item) => item.id), ['d']);
});

test('moving a Reel moves it between days; clearing it returns it to NIEZAPLANOWANE', () => {
  const planned = reel({ id: 'x', plannedPublicationDate: '2026-09-25' });
  const moved = { ...planned, ...planChanges('2026-09-26', null) };
  const groups = groupPlanner([moved], TODAY, 0);
  assert.deepEqual(groups.days.map((day) => day.items.length), [0, 0, 1, 0]);
  const cleared = { ...moved, ...planChanges(null, '10:00') };
  assert.deepEqual(planOf(cleared), { date: null, time: null }, 'unscheduling clears the time');
  assert.deepEqual(groupPlanner([cleared], TODAY, 0).unscheduled.map((item) => item.id), ['x']);
});

test('NIEZAPLANOWANE holds only active, in-production Reels without a plan', () => {
  const items = [
    reel({ id: 'rec', status: 'to_record' }),
    reel({ id: 'edit', status: 'editing' }),
    reel({ id: 'ready', status: 'ready' }),
    reel({ id: 'idea', status: 'idea' }),
    reel({ id: 'pub', status: 'published' }),
    reel({ id: 'del', status: 'ready', deletedAt: '2026-09-20T10:00:00.000Z' }),
    reel({ id: 'planned', status: 'ready', plannedPublicationDate: '2026-09-24' }),
  ];
  assert.deepEqual(groupPlanner(items, TODAY, 0).unscheduled.map((item) => item.id), ['rec', 'edit', 'ready']);
  assert.equal(isUnscheduledCandidate(items[4]), false);
  assert.equal(isUnscheduledCandidate(items[5]), false);
});

test('a Reel cached before the planner existed is valid and unplanned', () => {
  const legacy = { id: 'old', status: 'ready', deletedAt: null };
  assert.deepEqual(planOf(legacy), { date: null, time: null });
  assert.deepEqual(groupPlanner([legacy], TODAY, 0).unscheduled.map((item) => item.id), ['old']);
});

test('past unpublished plans surface as overdue in the current week only; published ones do not', () => {
  const late = reel({ id: 'late', plannedPublicationDate: '2026-09-22' });
  const done = reel({ id: 'done', status: 'published', plannedPublicationDate: '2026-09-22' });
  assert.equal(isOverdue(late, TODAY), true);
  assert.equal(isOverdue(done, TODAY), false);
  assert.deepEqual(groupPlanner([late, done], TODAY, 0).overdue.map((item) => item.id), ['late']);
  assert.deepEqual(groupPlanner([late, done], TODAY, 1).overdue, []);
  // A past week still shows what was planned on each day, published or not.
  const lastWeek = [reel({ id: 'l2', plannedPublicationDate: '2026-09-15' }), reel({ id: 'd2', status: 'published', plannedPublicationDate: '2026-09-15' })];
  assert.deepEqual(groupPlanner(lastWeek, TODAY, -1).days[1].items.map((item) => item.id), ['l2', 'd2']);
});

test('plan labels are short and Polish', () => {
  assert.equal(planLabel({ date: null, time: null }, TODAY), null);
  assert.equal(planLabel({ date: TODAY, time: '18:00' }, TODAY), 'Dziś, 18:00');
  assert.equal(planLabel({ date: '2026-09-25', time: null }, TODAY), 'Jutro');
  assert.equal(planLabel({ date: '2026-10-01', time: null }, TODAY), 'czw 01.10');
  assert.equal(planLabel({ date: '2027-01-04', time: '07:00' }, TODAY), 'pn 04.01.2027, 07:00');
});

test('quick days start today and cover a week', () => {
  const days = quickDays(TODAY);
  assert.equal(days.length, 7);
  assert.deepEqual(days.slice(0, 3).map((day) => day.label), ['DZIŚ', 'JUTRO', 'SOB']);
  assert.equal(days[6].date, '2026-09-30');
});

test('plan changes never send a time without a date and treat empty time as none', () => {
  assert.deepEqual(planChanges('2026-09-25', ''), { plannedPublicationDate: '2026-09-25', plannedPublicationTime: null });
  assert.deepEqual(planChanges('2026-09-25', '09:15'), { plannedPublicationDate: '2026-09-25', plannedPublicationTime: '09:15' });
  assert.deepEqual(planChanges(null, '09:15'), { plannedPublicationDate: null, plannedPublicationTime: null });
});

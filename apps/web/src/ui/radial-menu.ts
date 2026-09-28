/**
 * UI-02 radial quick-action menu: pure layout and action rules.
 *
 * A mobile long-press on a Reel row opens a small arc of actions around the touch point. It is
 * an accelerator only: every action here is also in the full quick-actions sheet, which the row's
 * visible `⋯` button, right-click and the ContextMenu key open. Nothing here mutates anything —
 * each action opens an existing sheet whose own explicit choice performs the existing mutation.
 */
import type { ReelStatus } from '@szronox/contracts';

export type RadialActionId = 'status' | 'schedule' | 'assign' | 'more';
export interface RadialAction { id: RadialActionId; label: string }

/**
 * The deliberately small action set, adapted to state without guessing:
 *   - planned → `Zmień termin` instead of `Zaplanuj`;
 *   - published → no scheduling (published Reels leave the agenda);
 *   - `Więcej` always closes the arc and opens the full sheet (copy link, kDrive, delete…).
 * `Archiwizuj` is intentionally absent: SzroNox has no archive state, and a radial action must
 * never silently perform an ambiguous transition such as a delete. AI actions never appear here.
 * Deleted Reels are not in the active list, so they never reach this menu.
 */
export function radialActions(item: { status: ReelStatus; planLabel?: string | null }): RadialAction[] {
  const actions: RadialAction[] = [{ id: 'status', label: 'Zmień status' }];
  if (item.status !== 'published') actions.push({ id: 'schedule', label: item.planLabel ? 'Zmień termin' : 'Zaplanuj' });
  actions.push({ id: 'assign', label: 'Przypisz' }, { id: 'more', label: 'Więcej' });
  return actions;
}

export interface RadialGeometry {
  /** Where the arc is centred, after being moved inward from any edge that would clip it. */
  centre: { x: number; y: number };
  radius: number;
  /** Top-left corner of each item's square target, in the same order as the actions. */
  items: Array<{ x: number; y: number }>;
  /** True when the arc opens below the finger because there was no room above it. */
  below: boolean;
}

export const RADIAL_ITEM_SIZE = 64;
export const RADIAL_RADIUS = 88;
export const RADIAL_MARGIN = 8;

/**
 * Lay `count` item targets on a half-circle above the touch point (the finger covers what is
 * below), flipping below when the top would clip, and shifting the centre horizontally so no
 * target leaves the viewport. On a very narrow viewport the radius shrinks rather than clipping.
 */
export function radialLayout(
  anchor: { x: number; y: number },
  viewport: { width: number; height: number },
  count: number,
  { itemSize = RADIAL_ITEM_SIZE, radius = RADIAL_RADIUS, margin = RADIAL_MARGIN } = {},
): RadialGeometry {
  const half = itemSize / 2;
  const maxRadius = Math.max(half, (viewport.width - 2 * margin - itemSize) / 2);
  const r = Math.min(radius, maxRadius);
  const reach = r + half + margin;
  const x = Math.min(Math.max(anchor.x, reach), Math.max(reach, viewport.width - reach));
  const below = anchor.y - reach < 0;
  let y = anchor.y;
  if (below) y = Math.min(Math.max(anchor.y, half + margin), viewport.height - reach);
  else y = Math.min(anchor.y, viewport.height - half - margin);
  // Evenly spread over 180°: from the left (180°) across the top (or bottom) to the right (0°).
  const items = Array.from({ length: count }, (_, index) => {
    const t = count === 1 ? 0.5 : index / (count - 1);
    const angle = Math.PI * (1 - t);
    const dy = Math.sin(angle) * r;
    return { x: Math.round(x + Math.cos(angle) * r - half), y: Math.round((below ? y + dy : y - dy) - half) };
  });
  return { centre: { x, y }, radius: r, items, below };
}

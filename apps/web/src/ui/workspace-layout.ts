import { useEffect, useState } from 'react';
import type { WorkspaceLayout } from '../controllers/useAppController.js';

/**
 * CONTENT-PLANNER-01 workspace thresholds, derived from the existing layout tokens rather than
 * from device classes (tokens.css):
 *
 *   - the centre keeps the frozen single-column content width (`--sz-content-max-width`
 *     480px) plus its 16px gutters, and is never squeezed below ~560px;
 *   - PLAN is a 320px pane (the 320px reflow width every surface already supports);
 *   - REELS is a 380px pane (the 360px reference width plus its row padding).
 *
 * 320 + 560 + 380 = 1260, so three panes start at 1280px. Two panes (PLAN | centre) need
 * 320 + 560 = 880 and start at 960px, leaving the centre room to breathe. Below that the app
 * is the unchanged mobile one-view-at-a-time layout.
 */
export const PLAN_PANE_WIDTH = 320;
export const REELS_PANE_WIDTH = 380;
export const TWO_PANE_MIN_WIDTH = 960;
export const THREE_PANE_MIN_WIDTH = 1280;

export function layoutForWidth(width: number): WorkspaceLayout {
  if (width >= THREE_PANE_MIN_WIDTH) return 'three';
  if (width >= TWO_PANE_MIN_WIDTH) return 'two';
  return 'single';
}

export function useWorkspaceLayout(): WorkspaceLayout {
  const read = () => (typeof window === 'undefined' ? 'single' : layoutForWidth(window.innerWidth));
  const [layout, setLayout] = useState<WorkspaceLayout>(read);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const queries = [TWO_PANE_MIN_WIDTH, THREE_PANE_MIN_WIDTH].map((width) => window.matchMedia(`(min-width: ${width}px)`));
    const update = () => setLayout(read());
    queries.forEach((query) => query.addEventListener('change', update));
    update();
    return () => queries.forEach((query) => query.removeEventListener('change', update));
  }, []);
  return layout;
}

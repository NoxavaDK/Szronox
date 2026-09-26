import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WorkspaceLayout } from '../controllers/useAppController.js';

/** Width is based on the usable center column, with the optional planner removed first. */
export const TWO_PANE_MIN_WIDTH = 1020;
export const THREE_PANE_MIN_WIDTH = 1500;
export const DRAWER_MIN_WIDTH = 680;
type Preference = 'two' | 'three' | 'focus';
const keyFor = (userId: string | null | undefined) => userId ? `szronox.workspace.${userId}` : null;
const readPreference = (key: string | null): Preference => {
  if (!key || typeof localStorage === 'undefined') return 'two';
  const value = localStorage.getItem(key);
  return value === 'three' || value === 'focus' ? value : 'two';
};
const readWidth = () => typeof window === 'undefined' ? 0 : window.innerWidth;
const fit = (width: number, preference: Preference): WorkspaceLayout => {
  if (width < DRAWER_MIN_WIDTH) return 'single';
  if (width < TWO_PANE_MIN_WIDTH) return 'drawer';
  if (preference === 'focus') return 'focus';
  if (preference === 'three' && width >= THREE_PANE_MIN_WIDTH) return 'three';
  return 'two';
};

/** Two panes are the wide default; three panes and focus mode are per-user device preferences. */
export function useWorkspaceLayout(userId?: string) {
  const storageKey = useMemo(() => keyFor(userId), [userId]);
  const [preference, setPreference] = useState<Preference>(() => readPreference(storageKey));
  const [width, setWidth] = useState(readWidth);
  useEffect(() => setPreference(readPreference(storageKey)), [storageKey]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const update = () => setWidth(window.innerWidth);
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  const setLayout = useCallback((layout: WorkspaceLayout) => {
    const next: Preference = layout === 'three' || layout === 'focus' ? layout : 'two';
    setPreference(next);
    if (storageKey) localStorage.setItem(storageKey, next);
  }, [storageKey]);
  return { layout: fit(width, preference), setLayout };
}

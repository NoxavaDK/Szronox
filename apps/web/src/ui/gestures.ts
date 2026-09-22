/**
 * List-row gesture recognition (LIST-01).
 *
 * A single pointer stream has to resolve into exactly one of: a tap (open Detail), a
 * stationary long-press (open the quick-actions sheet), a horizontal drag (swipe-reveal),
 * or a vertical drag (ordinary scrolling, left entirely to the browser). The decision logic
 * is kept as small, pure, synchronously-testable functions; `useRowGesture` is the thin
 * stateful wrapper that drives them from real pointer events.
 *
 * Gestures are shortcuts, never the only way to perform an action (LIST-01 brief): every
 * outcome here is also reachable without touching a pointer — see ReelListScreen's
 * `onContextMenu`/`ContextMenu`-key handling and Reel Detail's own controls.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

export interface GestureThresholds {
  /** Stationary hold duration that opens the quick-actions sheet. */
  longPressMs: number;
  /** Movement under this is still "stationary" for long-press purposes. */
  tapSlopPx: number;
  /** Movement magnitude needed before an axis (horizontal vs vertical) is decided. */
  axisLockPx: number;
  /** Release offset past which a swipe snaps open instead of springing back. */
  swipeOpenPx: number;
  /** Starting-x band reserved for the OS edge-back gesture; swipes never start inside it. */
  edgeGuardPx: number;
}

export const DEFAULT_GESTURE_THRESHOLDS: GestureThresholds = {
  longPressMs: 500,
  tapSlopPx: 10,
  axisLockPx: 8,
  swipeOpenPx: 40,
  edgeGuardPx: 24,
};

export type Axis = 'horizontal' | 'vertical' | 'undetermined';
export type SwipeDirection = 'left' | 'right';

/** Which axis a drag belongs to, once it has moved far enough to tell. */
export function resolveAxis(dx: number, dy: number, thresholds: GestureThresholds = DEFAULT_GESTURE_THRESHOLDS): Axis {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (Math.max(adx, ady) < thresholds.axisLockPx) return 'undetermined';
  return adx > ady ? 'horizontal' : 'vertical';
}

/** True once movement is too large for the pointer to still be "holding still". */
export function longPressCancelledByMove(dx: number, dy: number, thresholds: GestureThresholds = DEFAULT_GESTURE_THRESHOLDS): boolean {
  return Math.max(Math.abs(dx), Math.abs(dy)) > thresholds.tapSlopPx;
}

/** A swipe may not begin inside the edge band reserved for the browser's own back gesture. */
export function withinEdgeGuard(startX: number, thresholds: GestureThresholds = DEFAULT_GESTURE_THRESHOLDS): boolean {
  return startX < thresholds.edgeGuardPx;
}

/** Clamp a raw horizontal drag to the maximum reveal distance in either direction. */
export function clampSwipeOffset(dx: number, maxReveal: number): number {
  if (maxReveal <= 0) return 0;
  return Math.max(-maxReveal, Math.min(maxReveal, dx));
}

/** Where a released swipe settles: open in its direction, or spring back closed. */
export function resolveSwipeRelease(
  offset: number,
  thresholds: GestureThresholds = DEFAULT_GESTURE_THRESHOLDS,
): SwipeDirection | 'closed' {
  if (offset >= thresholds.swipeOpenPx) return 'right';
  if (offset <= -thresholds.swipeOpenPx) return 'left';
  return 'closed';
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface GestureRefState {
  startX: number;
  startY: number;
  axis: Axis;
  pointerId: number | null;
  longPressTimer: number;
  suppressClick: boolean;
  /** Set once we've decided this drag belongs to the OS edge-back gesture, not us. */
  yieldedToEdge: boolean;
}

export interface RowGestureOptions {
  disabled?: boolean;
  /** Stationary hold: open the quick-actions sheet for this row. */
  onLongPress: () => void;
  /** A horizontal swipe was released past the open threshold. */
  onSwipeOpen: (direction: SwipeDirection) => void;
  /** Maximum px the row may translate while revealing either side. */
  maxReveal?: number;
  thresholds?: Partial<GestureThresholds>;
}

export interface RowGestureHandlers {
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: (event: ReactPointerEvent) => void;
  onPointerCancel: (event: ReactPointerEvent) => void;
  onClickCapture: (event: ReactMouseEvent) => void;
}

/**
 * Drives one row's gesture state from real pointer events.
 *
 * Pointer Events cover touch, mouse and pen uniformly. `touch-action: pan-y` on the row
 * (set in CSS) tells the browser to keep handling vertical panning itself; this hook only
 * ever calls `preventDefault` once a horizontal drag is confirmed, so native scroll,
 * zoom and edge-back gestures are otherwise left completely alone.
 */
export function useRowGesture({ disabled, onLongPress, onSwipeOpen, maxReveal = 96, thresholds: overrides }: RowGestureOptions) {
  const thresholds = useMemo<GestureThresholds>(() => ({ ...DEFAULT_GESTURE_THRESHOLDS, ...overrides }), [overrides]);
  const [offset, setOffset] = useState(0);
  const ref = useRef<GestureRefState>({
    startX: 0, startY: 0, axis: 'undetermined', pointerId: null,
    longPressTimer: 0, suppressClick: false, yieldedToEdge: false,
  });

  const clearTimer = useCallback(() => {
    if (ref.current.longPressTimer) { window.clearTimeout(ref.current.longPressTimer); ref.current.longPressTimer = 0; }
  }, []);

  /** Snap the row back to its resting position without firing any action. */
  const close = useCallback(() => setOffset(0), []);

  const reset = useCallback(() => {
    clearTimer();
    ref.current.axis = 'undetermined';
    ref.current.pointerId = null;
    ref.current.yieldedToEdge = false;
    setOffset(0);
  }, [clearTimer]);

  const onPointerDown = useCallback((event: ReactPointerEvent) => {
    if (disabled) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    ref.current.startX = event.clientX;
    ref.current.startY = event.clientY;
    ref.current.axis = 'undetermined';
    ref.current.pointerId = event.pointerId;
    ref.current.suppressClick = false;
    ref.current.yieldedToEdge = false;
    clearTimer();
    ref.current.longPressTimer = window.setTimeout(() => {
      ref.current.suppressClick = true;
      // Progressive enhancement only: devices/browsers without vibration simply do nothing.
      navigator.vibrate?.(10);
      onLongPress();
      reset();
    }, thresholds.longPressMs);
  }, [clearTimer, disabled, onLongPress, reset, thresholds.longPressMs]);

  const onPointerMove = useCallback((event: ReactPointerEvent) => {
    if (ref.current.pointerId !== event.pointerId) return;
    if (ref.current.yieldedToEdge) return;
    const dx = event.clientX - ref.current.startX;
    const dy = event.clientY - ref.current.startY;

    if (ref.current.axis === 'undetermined') {
      if (longPressCancelledByMove(dx, dy, thresholds)) clearTimer();
      const axis = resolveAxis(dx, dy, thresholds);
      if (axis === 'undetermined') return;
      // `axisLockPx` (8px) is deliberately below `tapSlopPx` (10px), so an axis can resolve
      // — vertical scroll included — before the slop check above would itself have cleared
      // the long-press timer. Once ANY axis is determined the finger is no longer holding
      // still, and this is the only pointermove where `axis` is still 'undetermined', so the
      // timer must be cleared here unconditionally or a long vertical scroll would still open
      // the quick-actions sheet ~500ms in.
      clearTimer();
      if (axis === 'horizontal' && dx > 0 && withinEdgeGuard(ref.current.startX, thresholds)) {
        // Started inside the OS back-gesture band and moving the same way it does:
        // this pointer stream is not ours to intercept.
        ref.current.yieldedToEdge = true;
        return;
      }
      ref.current.axis = axis;
    }

    if (ref.current.axis !== 'horizontal') return; // vertical: native scroll owns this stream
    event.preventDefault();
    ref.current.suppressClick = true;
    setOffset(clampSwipeOffset(dx, maxReveal));
  }, [clearTimer, maxReveal, thresholds]);

  const onPointerUp = useCallback((event: ReactPointerEvent) => {
    if (ref.current.pointerId !== event.pointerId) return;
    clearTimer();
    if (ref.current.axis === 'horizontal') {
      const outcome = resolveSwipeRelease(offset, thresholds);
      if (outcome === 'closed') setOffset(0);
      else { setOffset(outcome === 'right' ? maxReveal : -maxReveal); onSwipeOpen(outcome); }
    }
    ref.current.axis = 'undetermined';
    ref.current.pointerId = null;
    ref.current.yieldedToEdge = false;
  }, [clearTimer, maxReveal, offset, onSwipeOpen, thresholds]);

  /** Pointer cancellation (e.g. an incoming system gesture) always cancels safely: no action fires. */
  const onPointerCancel = useCallback((event: ReactPointerEvent) => {
    if (ref.current.pointerId !== null && ref.current.pointerId !== event.pointerId) return;
    reset();
  }, [reset]);

  /**
   * A long-press or a swipe both end with a native `click` still about to fire on the
   * underlying button. Capturing it here — rather than guessing from `preventDefault` on
   * pointer events, which some browsers ignore for synthesizing `click` — is what stops a
   * long-press from also opening Detail, and a released swipe from also navigating.
   */
  const onClickCapture = useCallback((event: ReactMouseEvent) => {
    if (ref.current.suppressClick) {
      event.preventDefault();
      event.stopPropagation();
      ref.current.suppressClick = false;
    }
  }, []);

  return { offset, close, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture } as RowGestureHandlers };
}

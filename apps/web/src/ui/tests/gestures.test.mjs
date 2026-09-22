import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_GESTURE_THRESHOLDS,
  clampSwipeOffset,
  longPressCancelledByMove,
  resolveAxis,
  resolveSwipeRelease,
  withinEdgeGuard,
} from '../gestures.ts';

/**
 * Pure decision logic behind list-row gestures (LIST-01). The stateful pointer-event
 * wiring (`useRowGesture`) is exercised by hand/in-browser; what is verified here is the
 * tap/scroll/long-press/swipe boundary itself, since that is exactly where a wrong call
 * either fires the wrong action or breaks native scrolling.
 */

test('small jitter keeps the axis undetermined, so a held finger is still a long-press candidate', () => {
  assert.equal(resolveAxis(2, -3), 'undetermined');
  assert.equal(resolveAxis(0, 0), 'undetermined');
});

test('once movement crosses the lock threshold, the larger component wins the axis', () => {
  assert.equal(resolveAxis(20, 4), 'horizontal');
  assert.equal(resolveAxis(4, 20), 'vertical');
  // Exactly diagonal: ties resolve to vertical, i.e. to native scroll — the safer default,
  // since an unwanted swipe-reveal is more disruptive than an unwanted scroll.
  assert.equal(resolveAxis(15, 15), 'vertical');
});

test('a tap can wiggle a little without cancelling the long-press timer', () => {
  assert.equal(longPressCancelledByMove(3, -2), false);
  assert.equal(longPressCancelledByMove(0, 0), false);
});

test('movement past the tap slop cancels a pending long-press', () => {
  assert.equal(longPressCancelledByMove(11, 0), true);
  assert.equal(longPressCancelledByMove(0, -11), true);
});

test('a drag starting inside the edge-guard band is left to the browser back gesture', () => {
  assert.equal(withinEdgeGuard(0), true);
  assert.equal(withinEdgeGuard(23), true);
  assert.equal(withinEdgeGuard(24), false);
  assert.equal(withinEdgeGuard(200), false);
});

test('swipe offset is clamped to the configured maximum reveal in both directions', () => {
  assert.equal(clampSwipeOffset(30, 96), 30);
  assert.equal(clampSwipeOffset(500, 96), 96);
  assert.equal(clampSwipeOffset(-500, 96), -96);
  assert.equal(clampSwipeOffset(10, 0), 0);
});

test('a release short of the open threshold springs back closed, in either direction', () => {
  assert.equal(resolveSwipeRelease(0), 'closed');
  assert.equal(resolveSwipeRelease(39), 'closed');
  assert.equal(resolveSwipeRelease(-39), 'closed');
});

test('a release past the open threshold commits to that direction', () => {
  assert.equal(resolveSwipeRelease(40), 'right');
  assert.equal(resolveSwipeRelease(-40), 'left');
  assert.equal(resolveSwipeRelease(96), 'right');
  assert.equal(resolveSwipeRelease(-96), 'left');
});

test('custom thresholds are honoured rather than the module defaults', () => {
  const loose = { ...DEFAULT_GESTURE_THRESHOLDS, swipeOpenPx: 10, edgeGuardPx: 0 };
  assert.equal(resolveSwipeRelease(11, loose), 'right');
  assert.equal(withinEdgeGuard(5, loose), false);
});

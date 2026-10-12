import type { Reel } from '../../../../packages/contracts/src/index.js';

/**
 * CAPTURE-DRAFT-01: true when a refreshed Reel differs from the shown one only by what a
 * finished develop run writes (appended hooks), plus the bookkeeping that always moves with it.
 */
export function onlyHooksChanged(before: Reel, after: Reel): boolean {
  const strip = ({ hooks: _hooks, version: _version, updatedAt: _updatedAt, autoDraft: _autoDraft, ...rest }: Reel) => rest;
  return JSON.stringify(strip(before)) === JSON.stringify(strip(after));
}

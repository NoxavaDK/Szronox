/**
 * Picking up an incoming share once the app is running.
 *
 * The service worker stores the payload and redirects to `/?incoming=<id>`. This module is the
 * page half: it reads that one opaque id, derives stable identifiers, and consumes exactly that
 * share once an authoritative identity exists.
 *
 * Four constraints, each from the approved brief rather than taste:
 *
 *   - **Exactly the named share.** The quarantine store is never swept. Two queued shares stay
 *     two separate shares, and one is not merged into the other.
 *   - **Identity first.** Binding happens only after `/me` has confirmed who is signed in. A
 *     share that arrives while offline or signed out stays quarantined; nothing is bound to a
 *     guessed account.
 *   - **Derive before the transaction.** The identifiers come from an async hash, and awaiting
 *     crypto inside an IndexedDB write transaction deactivates it. So the derivation completes
 *     first and `consumeQuarantine` receives finished values.
 *   - **Never overwrite unsaved work.** If the user already has a Quick Add draft in progress,
 *     the incoming share is not opened over it.
 *
 * There is no router here and none is added. The id is read from the query string once, and the
 * URL is cleaned up with `replaceState` so a reload does not look like a second share.
 */

import type { DraftStore, CaptureDraft } from '../drafts/store.js';

/**
 * The two query parameters the worker hands back.
 *
 * Stated again here rather than imported from `receive.ts`, and the duplication is on purpose:
 * this module must have no runtime import, because Node's type stripping runs it as source and
 * cannot resolve a NodeNext `.js` specifier to a `.ts` file. Keeping it import-free is what
 * makes it directly testable. `pending.test.mjs` asserts these agree with the worker's copy,
 * so the two cannot drift silently.
 */
export const INCOMING_PARAM = 'incoming';
export const SHARE_ERROR_PARAM = 'shareError';

/** Format 16 bytes as an RFC 9562 version 8 UUID: custom generation, correct variant. */
function formatUuidV8(bytes: Uint8Array): string {
  const octets = new Uint8Array(bytes.subarray(0, 16));
  octets[6] = (octets[6] & 0x0f) | 0x80;
  octets[8] = (octets[8] & 0x3f) | 0x80;
  const hex = [...octets].map((value) => value.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

/**
 * Derive one identifier from the share id.
 *
 * Domain-separated by purpose, so the reel id and the operation id can never collide, and
 * deterministic, so a replayed share produces the same capture rather than a second one. This
 * is the same construction already shipped in `data/attachment-recovery.ts`.
 */
export async function derivedShareId(shareId: string, purpose: 'reel' | 'operation'): Promise<string> {
  const material = new TextEncoder().encode(`szronox/share/${purpose}/${shareId}`);
  return formatUuidV8(new Uint8Array(await crypto.subtle.digest('SHA-256', material)));
}

export interface ShareIdentifiers { reelId: string; operationId: string }

/** Both identifiers, fully resolved before any transaction is opened. */
export async function shareIdentifiers(shareId: string): Promise<ShareIdentifiers> {
  const [reelId, operationId] = await Promise.all([
    derivedShareId(shareId, 'reel'),
    derivedShareId(shareId, 'operation'),
  ]);
  return { reelId, operationId };
}

/** What the page found in its own URL. Read once, then cleared. */
export interface IncomingShareSignal {
  shareId: string | null;
  /** A receipt failure the worker reported, for truthful Polish feedback. */
  failure: string | null;
}

export function readIncomingSignal(search: string): IncomingShareSignal {
  const params = new URLSearchParams(search);
  const shareId = params.get(INCOMING_PARAM);
  const failure = params.get(SHARE_ERROR_PARAM);
  return {
    // Bounded and opaque: an id this app did not mint simply will not match a record.
    shareId: shareId !== null && shareId.length > 0 && shareId.length <= 64 ? shareId : null,
    failure: failure !== null && failure.length > 0 && failure.length <= 40 ? failure : null,
  };
}

/**
 * Remove the share parameters from the address bar.
 *
 * Without this, a reload would present the same id again — harmless, because consumption is
 * idempotent, but it would also re-open Quick Add over whatever the user had moved on to.
 */
export function clearIncomingSignal(): void {
  if (typeof history === 'undefined' || typeof location === 'undefined') return;
  const url = new URL(location.href);
  if (!url.searchParams.has(INCOMING_PARAM) && !url.searchParams.has(SHARE_ERROR_PARAM)) return;
  url.searchParams.delete(INCOMING_PARAM);
  url.searchParams.delete(SHARE_ERROR_PARAM);
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

export type ShareOutcome =
  | { status: 'opened'; draft: CaptureDraft }
  /** The share is gone and this account has no capture for it. Discloses nothing further. */
  | { status: 'already_consumed' }
  /** Deliberately not opened, because unsaved manual work would have been replaced. */
  | { status: 'deferred' };

/**
 * Consume one named share for the signed-in account.
 *
 * `hasUnsavedCapture` is the caller's answer to "is the user mid-capture right now"; when true
 * the share is left in quarantine and reported as deferred, so nothing is lost either way.
 */
export async function claimIncomingShare(
  store: DraftStore,
  shareId: string,
  accountId: string,
  options: { hasUnsavedCapture: boolean },
): Promise<ShareOutcome> {
  if (options.hasUnsavedCapture) return { status: 'deferred' };
  // Derivation first: no crypto await may happen inside the write transaction.
  const ids = await shareIdentifiers(shareId);
  const result = await store.consumeQuarantine(shareId, accountId, ids);
  return result.outcome === 'bound'
    ? { status: 'opened', draft: result.draft }
    : { status: 'already_consumed' };
}

/** Polish feedback for a receipt failure the worker reported. Never echoes shared content. */
export function shareFailureMessage(reason: string): string {
  switch (reason) {
    case 'body_too_large':
    case 'aggregate_too_large':
      return 'Udostępnione pliki są za duże. Nic nie zostało zapisane.';
    case 'file_too_large':
      return 'Jedno ze zdjęć jest za duże. Nic nie zostało zapisane.';
    case 'too_many_files':
      return 'Udostępniono za dużo plików. Nic nie zostało zapisane.';
    case 'nothing_usable':
      return 'Udostępniona treść nie zawierała nic, co można zapisać.';
    case 'storage_failed':
      return 'Nie udało się zapisać udostępnionej treści na tym urządzeniu.';
    // The POST reached the server, which means no service worker was installed to receive it.
    case 'worker_unavailable':
      return 'Aplikacja nie była gotowa do odbioru. Otwórz SzroNox i udostępnij ponownie.';
    default:
      return 'Nie udało się odebrać udostępnionej treści.';
  }
}

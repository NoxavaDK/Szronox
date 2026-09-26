/**
 * KDRIVE-01b: pure helpers for the kDrive folder surface. The server owns every kDrive call;
 * the browser only shows the resolved state, opens the folder's web link and sends explicit
 * create/link commands.
 */

import type { KdriveFolderState } from '../../../../packages/contracts/src/index.js';

/** Same canonical form the API returns; used where only the stored reference is at hand. */
export function kdriveWebUrl(driveId: string, folderId: string): string {
  return `https://ksuite.infomaniak.com/kdrive/app/drive/${encodeURIComponent(driveId)}/files/${encodeURIComponent(folderId)}`;
}

/**
 * What the user pastes to relink: a bare numeric folder id, or a kDrive web link to the folder
 * (either the ksuite or the older kdrive.infomaniak.com form). Anything else is `null`.
 */
export function parseKdriveFolderInput(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (/^\d{1,20}$/.test(value)) return value;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (!/(^|\.)infomaniak\.com$/i.test(url.hostname)) return null;
  const match = url.pathname.match(/\/files\/(\d{1,20})(?:\/|$)/);
  return match ? match[1] : null;
}

export type KdriveViewState = KdriveFolderState | { state: 'loading' } | { state: 'error' };

/** The Materials row for a Reel: its folder name (or id), whether to offer relink, and a note. */
export function kdriveFolderView(stored: { driveId: string; folderId: string } | null, resolved: KdriveViewState | undefined): {
  name: string | null; unavailable: boolean; note: string | null; webUrl: string | null;
} {
  if (stored === null) return { name: null, unavailable: false, note: null, webUrl: null };
  const fallbackUrl = kdriveWebUrl(stored.driveId, stored.folderId);
  const fallbackName = `Folder ${stored.folderId}`;
  if (!resolved || resolved.state === 'loading') return { name: fallbackName, unavailable: false, note: 'Sprawdzanie folderu…', webUrl: fallbackUrl };
  switch (resolved.state) {
    case 'available': return { name: resolved.name || fallbackName, unavailable: false, note: null, webUrl: resolved.webUrl };
    case 'missing': return { name: fallbackName, unavailable: true, note: 'Folder został usunięty lub przeniesiony do kosza.', webUrl: resolved.webUrl };
    case 'access_denied': return { name: fallbackName, unavailable: true, note: 'Brak dostępu do tego folderu w kDrive.', webUrl: resolved.webUrl };
    // A temporary outage keeps the link usable: kDrive in the browser may well be reachable.
    case 'unavailable': return { name: fallbackName, unavailable: false, note: 'kDrive chwilowo nie odpowiada. Link może nadal działać.', webUrl: resolved.webUrl };
    default: return { name: fallbackName, unavailable: false, note: 'Nie udało się sprawdzić folderu.', webUrl: fallbackUrl };
  }
}

/** Polish message for a failed create/link command, keyed on the shared error envelope. */
export function kdriveCommandMessage(error: { status?: number; api?: { code?: string; details?: Record<string, unknown> } } | null | undefined): string {
  const code = error?.api?.code;
  const reason = error?.api?.details?.reason;
  if (reason === 'kdrive_not_configured') return 'Integracja kDrive nie jest skonfigurowana na tym serwerze.';
  if (reason === 'already_linked') return 'Ta rolka ma już folder kDrive.';
  if (reason === 'not_a_folder') return 'Ten numer nie wskazuje folderu kDrive.';
  if (code === 'EDIT_CONFLICT') return 'Rolka zmieniła się w międzyczasie. Spróbuj ponownie.';
  if (code === 'PROVIDER_RESOURCE_MISSING') return 'Nie znaleziono tego folderu w kDrive.';
  if (code === 'PROVIDER_ACCESS_DENIED') return 'kDrive odmówił dostępu.';
  if (code === 'PROVIDER_UNAVAILABLE') return 'kDrive chwilowo nie odpowiada. Nic nie zostało zmienione — spróbuj ponownie.';
  return 'Nie udało się połączyć z kDrive. Spróbuj ponownie.';
}

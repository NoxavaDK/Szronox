/**
 * UI-02: the one contextual action shown under a Reel's metadata, as explicit rules.
 *
 * The action is a shortcut to existing work — it never changes status, selects a hook, applies
 * AI output or publishes. It must name the next sensible step for the Reel's current state, so
 * the rules run strictly in order and the first match wins:
 *
 *   1. Deleted → `Przywróć rolkę` (primary). Nothing else: a deleted Reel is not being worked on.
 *   2. Published → nothing. The work is done; a missing hook selection or plan is irrelevant.
 *   3. Empty saved script → `Opracuj` when AI is available, otherwise `Napisz skrypt` (focus).
 *   4. Montaż without an export → `Dodaj eksport`.
 *   5. Montaż with a stale verification the user can renew → `Sprawdź ponownie` (attention).
 *   6. Gotowe without a description → `Wygeneruj opis` when AI is available, else `Uzupełnij opis`.
 *   7. Gotowe with the feed cover missing → `Okładka do feedu` (attention; the publish gate).
 *   8. Publication copy exists and no plan → `Zaplanuj`.
 *   9. Planned → the date with `Zmień termin`, as quiet state rather than a call to action.
 *  10. Pomysł / Do nagrania with unselected hook candidates → `Wybierz hook` (quiet).
 *
 * `tone` carries the semantic colour role: `primary` (action), `attention` (amber, with its own
 * wording) or `quiet` (plain text action). Colour is never the only signal — the label says it.
 */
import type { Reel } from '../../../../packages/contracts/src/index.js';

export type DetailActionKind =
  | 'restore' | 'develop' | 'write_script' | 'add_export' | 'reverify_export'
  | 'generate_publication' | 'write_description' | 'feed_cover' | 'schedule' | 'reschedule' | 'select_hook';
export type DetailActionTone = 'primary' | 'attention' | 'quiet';
export interface DetailAction { kind: DetailActionKind; label: string; tone: DetailActionTone }

export interface DetailActionState {
  reel: Pick<Reel, 'status' | 'script' | 'deletedAt' | 'currentExport' | 'verificationState' | 'publicationDescription'
    | 'publicationHashtags' | 'feedCoverDone' | 'hooks' | 'selectedHookId' | 'editorId'>;
  /** AI is configured and nothing is waiting to be saved. */
  aiAvailable: boolean;
  /** The current user may mark the new export revision as checked (not its editor). */
  canVerify: boolean;
  /** Render-ready plan label, or null when unplanned. */
  planLabel: string | null;
}

export function detailPrimaryAction({ reel, aiAvailable, canVerify, planLabel }: DetailActionState): DetailAction | null {
  if (reel.deletedAt) return { kind: 'restore', label: 'Przywróć rolkę', tone: 'primary' };
  if (reel.status === 'published') return null;
  if (!reel.script.trim()) {
    return aiAvailable ? { kind: 'develop', label: 'Opracuj', tone: 'primary' } : { kind: 'write_script', label: 'Napisz skrypt', tone: 'primary' };
  }
  if (reel.status === 'editing' && !reel.currentExport) return { kind: 'add_export', label: 'Dodaj eksport', tone: 'primary' };
  if (reel.status === 'editing' && reel.verificationState === 'outdated' && canVerify && reel.editorId !== null) {
    return { kind: 'reverify_export', label: 'Eksport zmieniony · Sprawdź ponownie', tone: 'attention' };
  }
  if (reel.status === 'ready' && !reel.publicationDescription.trim()) {
    return aiAvailable ? { kind: 'generate_publication', label: 'Wygeneruj opis', tone: 'primary' } : { kind: 'write_description', label: 'Uzupełnij opis', tone: 'primary' };
  }
  if (reel.status === 'ready' && !reel.feedCoverDone) return { kind: 'feed_cover', label: 'Brak okładki do feedu', tone: 'attention' };
  const hasCopy = Boolean(reel.publicationDescription.trim() || reel.publicationHashtags.trim());
  if (hasCopy && !planLabel) return { kind: 'schedule', label: 'Zaplanuj', tone: 'primary' };
  if (planLabel) return { kind: 'reschedule', label: `Termin: ${planLabel} · Zmień termin`, tone: 'quiet' };
  if ((reel.status === 'idea' || reel.status === 'to_record') && reel.hooks.length > 0 && !reel.selectedHookId) {
    return { kind: 'select_hook', label: 'Wybierz hook', tone: 'quiet' };
  }
  return null;
}

/**
 * Deleted Reels are read-only in Detail: only restoring is offered. Editing, generation, hook
 * and meme controls are suppressed rather than shown disabled, so nothing looks available.
 */
export const isReadOnlyReel = (reel: Pick<Reel, 'deletedAt'>) => Boolean(reel.deletedAt);

/**
 * Publication action hierarchy (UI-02 F): with nothing to copy, generation leads and copying is
 * quiet; once there is copy, copying leads and regeneration is quiet. Pure, for the tests.
 */
export function publicationEmphasis(description: string, hashtags: string): { generate: 'primary' | 'quiet'; copy: 'primary' | 'quiet'; ready: boolean } {
  const hasCopy = Boolean(description.trim() || hashtags.trim());
  return { generate: description.trim() ? 'quiet' : 'primary', copy: hasCopy ? 'primary' : 'quiet', ready: Boolean(description.trim()) };
}

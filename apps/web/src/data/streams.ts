/**
 * STREAM-01 (web): pure helpers for topic labels, the D5 picker grouping and the D4
 * flush-before-switch decision. Nothing here fetches or persists — `StreamTopics.tsx` and
 * `StreamTopicPicker.tsx` own the API calls and call into these functions for the parts worth
 * testing in isolation.
 */
import type { ReelStatus, StreamTopicCandidate } from '../../../../packages/contracts/src/index.js';

const MAX_HOOK_LABEL_LENGTH = 80;
function tidyHook(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_HOOK_LABEL_LENGTH ? collapsed : `${collapsed.slice(0, MAX_HOOK_LABEL_LENGTH - 1).trimEnd()}…`;
}

/**
 * The label to show for a D5 picker row (`StreamTopicCandidate`) or a TEMATY row's live source
 * (`StreamTopicSource`), for the many Reels with no typed title.
 *
 * Order: the typed title, else the source Reel's selected hook text (the one rung the shared
 * `reelLabel()` in `reel-label.ts` does not yet cover — CAPTURE-DRAFT-01 owns adding it there,
 * so it is not duplicated into that file), else the caller's `fallback`.
 *
 * `fallback` is a parameter, computed by the caller from `reelLabel()`/`UNTITLED_LABEL`
 * (`reel-label.ts`), rather than this module importing those values itself: `reel-label.ts`'s
 * runtime (value) exports do not resolve here under plain `node --experimental-strip-types
 * --test` ESM resolution the way an `import type` does (confirmed empirically — see
 * STREAM-01b-result.md "Limitations"), even though the same `./x.js` specifier resolves fine
 * under the Vite/tsc build this module also runs under. Keeping this module free of sibling
 * *value* imports sidesteps it entirely rather than working around it per-file.
 */
export function topicLabel(input: { title: string; selectedHookText: string | null }, fallback: string): string {
  if (input.title.trim() !== '') return input.title;
  if (input.selectedHookText && input.selectedHookText.trim() !== '') return tidyHook(input.selectedHookText);
  return fallback;
}

/** D5: `ROLKI` first, in this exact status order, then `POMYSŁY` (`idea`). */
export const PICKER_ROLKI_STATUS_ORDER: ReelStatus[] = ['to_record', 'editing', 'ready', 'published'];

export interface GroupedStreamCandidates {
  rolki: Array<{ status: ReelStatus; items: StreamTopicCandidate[] }>;
  pomysly: StreamTopicCandidate[];
}

/** Groups the picker's search results exactly as D5 requires: never re-sorts within a group. */
export function groupStreamCandidates(items: readonly StreamTopicCandidate[]): GroupedStreamCandidates {
  const rolki = PICKER_ROLKI_STATUS_ORDER
    .map((status) => ({ status, items: items.filter((item) => item.status === status) }))
    .filter((group) => group.items.length > 0);
  const pomysly = items.filter((item) => item.status === 'idea');
  return { rolki, pomysly };
}

/** D4/D5: tapping a Rolka (`to_record` or later) adds it as a reference directly. */
export function isDirectLinkCandidate(status: ReelStatus): boolean {
  return status !== 'idea';
}

export type TopicDraftSaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error';

function topicsWord(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (count === 1) return 'temat';
  if (lastTwo >= 12 && lastTwo <= 14) return 'tematów';
  return last >= 2 && last <= 4 ? 'tematy' : 'tematów';
}

/**
 * D9: the stream-with-topics delete-confirmation body, verbatim —
 * `Usunąć stream „<tytuł>”? Razem z nim zostaną usunięte 2 tematy przeniesione z pomysłów.
 * Możesz je przywrócić razem ze streamem z „Usunięte”.` for the two-topic case.
 *
 * Call this only when `absorbedTopicCount > 0`; D9 says "with none, the existing Reel wording
 * applies" — the host passes `undefined` for `ReelOverflowProps.deleteConfirmBody` in that case,
 * which keeps today's `COPY.deleteConfirmBody`.
 */
export function streamDeleteConfirmBody(title: string, absorbedTopicCount: number): string {
  const verb = absorbedTopicCount === 1 ? 'zostanie usunięty' : 'zostaną usunięte';
  const adjective = absorbedTopicCount === 1 ? 'przeniesiony' : 'przeniesione';
  return `Usunąć stream „${title}”? Razem z nim ${verb} ${absorbedTopicCount} ${topicsWord(absorbedTopicCount)} ${adjective} z pomysłów. Możesz je przywrócić razem ze streamem z „Usunięte”.`;
}

/**
 * D4: "switching away from an expanded absorbed topic first flushes its pending save. If it
 * succeeds (or there was none), the switch happens. If it fails or conflicts, the switch does
 * not happen" — the topic stays expanded with its existing error/conflict state.
 *
 * `flush` performs (or waits out) the in-flight/debounced save and resolves with whether it
 * landed; it is only invoked when there is something pending (`dirty`/`saving`). An already
 * failed/conflicted state is not retried implicitly — the switch is refused outright, exactly
 * as the existing `Ponów` / `Odrzuć zmiany` choice demands.
 */
export async function flushTopicBeforeSwitch(
  saveState: TopicDraftSaveState,
  flush: () => Promise<boolean>,
): Promise<boolean> {
  if (saveState === 'idle' || saveState === 'saved') return true;
  if (saveState === 'conflict' || saveState === 'error') return false;
  return flush();
}

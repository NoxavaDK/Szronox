/**
 * STREAM-01 (web): pure helpers for topic labels, the D5 picker grouping and the D4
 * flush-before-switch decision. Nothing here fetches or persists — `StreamTopics.tsx` and
 * `StreamTopicPicker.tsx` own the API calls and call into these functions for the parts worth
 * testing in isolation.
 */
import type { CaptureInput, ReelStatus, StreamTopicCandidate, StreamTopicSource } from '../../../../packages/contracts/src/index.js';
import { MAX_LABEL_LENGTH, reelLabel, UNTITLED_LABEL } from './reel-label.js';

function tidyHook(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_LABEL_LENGTH ? collapsed : `${collapsed.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…`;
}

/**
 * The label to show for a D5 picker row (`StreamTopicCandidate`) or a TEMATY row's live source
 * (`StreamTopicSource`), for the many Reels with no typed title.
 *
 * Order: the typed title, else the source Reel's selected hook text (the one rung the shared
 * `reelLabel()` in `reel-label.ts` does not yet cover — CAPTURE-DRAFT-01 owns adding it there,
 * so it is not duplicated into that file), else `reelLabel`'s own script/capture-derived label,
 * else `Bez tytułu`.
 */
export function topicLabel(input: {
  title: string;
  originalInput: CaptureInput | null;
  script?: string | null;
  selectedHookText: string | null;
}): string {
  if (input.title.trim() !== '') return input.title;
  if (input.selectedHookText && input.selectedHookText.trim() !== '') return tidyHook(input.selectedHookText);
  if (input.originalInput === null) return UNTITLED_LABEL;
  return reelLabel({ title: '', originalInput: input.originalInput, script: input.script ?? undefined }).text;
}

/** `topicLabel` for a D5 picker row. */
export function topicCandidateLabel(candidate: Pick<StreamTopicCandidate, 'title' | 'originalInput' | 'script' | 'selectedHookText'>): string {
  return topicLabel(candidate);
}

/** `topicLabel` for a TEMATY row's live `source` (absorbed or linked). */
export function topicSourceLabel(source: Pick<StreamTopicSource, 'title' | 'originalInput' | 'selectedHookText'>): string {
  return topicLabel({ title: source.title, originalInput: source.originalInput, selectedHookText: source.selectedHookText });
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

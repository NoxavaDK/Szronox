import type { CreateReelRequest } from '../../../../packages/contracts/src/index.js';
import type { CaptureDraft } from './store.js';

/**
 * Freeze the capture intent into the create payload that is stored for online/offline replay.
 *
 * D2/STREAM-01: a stream (`draft.format === 'stream'`) sends `format: 'stream'` and the trimmed
 * `title`, and never `initialScript`/`initialHook` — the API refuses both on a stream. A reel
 * (the default, including every legacy draft with no `format` at all) never sends `title`. The
 * two branches are kept fully separate so neither field ever leaks into the other request shape.
 */
export function createRequestFromDraft(draft: CaptureDraft): CreateReelRequest {
  if (draft.format === 'stream') {
    return {
      operationId: draft.operationId,
      reelId: draft.reelId,
      input: draft.input,
      priority: draft.priority,
      format: 'stream',
      title: (draft.streamTitle ?? '').trim(),
    };
  }
  const capturedText = draft.input.text;
  const initialScript = draft.textMode === 'script' && capturedText?.trim() ? capturedText : undefined;
  return {
    operationId: draft.operationId,
    reelId: draft.reelId,
    input: draft.input,
    initialScript,
    initialHook: draft.initialHook || undefined,
    priority: draft.priority,
  };
}

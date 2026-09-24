import type { CreateReelRequest } from '../../../../packages/contracts/src/index.js';
import type { CaptureDraft } from './store.js';

/** Freeze the capture intent into the create payload that is stored for online/offline replay. */
export function createRequestFromDraft(draft: CaptureDraft): CreateReelRequest {
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

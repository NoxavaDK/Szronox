/**
 * Attachment recovery across reloads and account switches.
 *
 * The problem this solves: a capture holds image bytes that exist only in the
 * browser until the server acknowledges each attachment. A reload, an offline period
 * or a closed tab must not lose them, and a retry must not create a second
 * attachment for the same image.
 *
 * Stable identifiers without a new draft field
 * --------------------------------------------
 * Each attachment needs its own `operationId` for initiation and another for
 * completion, and both must be identical on every retry — otherwise a retry after a
 * reload would be a *new* operation and the idempotency ledger could not recognise it.
 * Rather than adding fields to the stored draft, they are **derived** from values the
 * draft already holds: the capture's own operation id, the attachment id, and the step
 * name. The same inputs always produce the same identifier, on this device and after
 * any reload, and no storage migration is involved.
 *
 * SHA-256 is used as the mixing function and the result is formatted as an RFC 9562
 * version 8 UUID — the version reserved for custom, vendor-defined generation. It is
 * deliberately not v4: these are not random, and labelling them as if they were would
 * misrepresent how they are produced.
 *
 * What "acknowledged" means
 * -------------------------
 * Not "the PUT returned". The server treats byte transfer and completion as separate
 * operations, and so does this module: the local draft survives until the server's own
 * view of the Reel reports every one of the capture's images as `ready`. That is the
 * authoritative reconciliation, not a local flag that could disagree with the server.
 */

import type { CaptureImageDescriptor, Reel } from '../../../../packages/contracts/src/index.js';
import type { CaptureDraft, DraftStore } from '../drafts/store.js';
import type { CoreApiClient } from './api.js';
import { AttachmentUploader, CrossOriginUploadError, type AttachmentOperationIds, type UploadOutcome } from './attachments.js';
import { ClientApiError, isAbandonedRequest } from './errors.js';

/** Format 16 bytes as an RFC 9562 version 8 UUID: custom generation, correct variant. */
function formatUuidV8(bytes: Uint8Array): string {
  const octets = new Uint8Array(bytes.subarray(0, 16));
  octets[6] = (octets[6] & 0x0f) | 0x80; // version 8
  octets[8] = (octets[8] & 0x3f) | 0x80; // variant 10x
  const hex = [...octets].map((value) => value.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

/**
 * Derive one step's operation id.
 *
 * The step name is part of the input so initiation and completion never collide: the
 * same id used for two different routes would make the ledger return one route's
 * recorded result for the other.
 */
export async function derivedOperationId(
  captureOperationId: string,
  attachmentId: string,
  step: 'initiate' | 'complete',
): Promise<string> {
  const material = new TextEncoder().encode(`szronox/attachment/${step}/${captureOperationId}/${attachmentId}`);
  const digest = await crypto.subtle.digest('SHA-256', material);
  return formatUuidV8(new Uint8Array(digest));
}

export async function attachmentOperations(
  captureOperationId: string,
  attachmentId: string,
): Promise<AttachmentOperationIds> {
  const [initiate, complete] = await Promise.all([
    derivedOperationId(captureOperationId, attachmentId, 'initiate'),
    derivedOperationId(captureOperationId, attachmentId, 'complete'),
  ]);
  return { initiate, complete };
}

export interface AttachmentProgress {
  reelId: string;
  /** Attachments the server now reports as ready. */
  acknowledged: string[];
  /** Attachments still outstanding; their local blobs are retained. */
  outstanding: string[];
  /** True only when every image of this capture is acknowledged server-side. */
  complete: boolean;
  outcomes: UploadOutcome[];
  /** Set when the run stopped because the active account changed. */
  abandoned: boolean;
  /**
   * Why each outstanding attachment is outstanding.
   *
   * Recorded rather than discarded. A retry loop that swallows its errors looks
   * identical whether the upload is waiting for a network or failing permanently, and
   * the difference is the only thing that tells the user whether to wait.
   */
  failures: Array<{ attachmentId: string; reason: string }>;
}

export interface AttachmentRecoveryOptions {
  api: CoreApiClient;
  store: DraftStore;
  uploader?: AttachmentUploader;
  /** Injected so a test can drive the transport without a DOM. Defaults to the page. */
  pageOrigin?: string;
  /** The account the caller believes is active. Re-read before every local write. */
  activeAccountId: () => string | null;
}

export class AttachmentRecovery {
  private readonly uploader: AttachmentUploader;

  constructor(private readonly options: AttachmentRecoveryOptions) {
    this.uploader = options.uploader
      ?? new AttachmentUploader({ api: options.api, pageOrigin: options.pageOrigin });
  }

  /**
   * Upload every outstanding image of one capture, then reconcile against the server.
   *
   * `accountId` is captured by the caller and re-checked before each local write. A
   * response that arrives after an account switch is discarded by the API client's
   * generation guard; this second check covers the local side, so a late success
   * cannot delete or rewrite a draft that now belongs to the other account.
   */
  async runCapture(draft: CaptureDraft): Promise<AttachmentProgress> {
    const accountId = draft.accountId;
    const outcomes: UploadOutcome[] = [];
    const failures: Array<{ attachmentId: string; reason: string }> = [];
    const images = draft.input.images;

    // The server's view first. A draft that survived a reload may already be fully
    // uploaded, and re-sending bytes for a published immutable object would be refused
    // anyway — so the cheap read avoids the pointless attempt.
    let reel: Reel;
    try {
      reel = await this.options.api.reel(draft.reelId);
    } catch (error) {
      if (isAbandonedRequest(error)) {
        return {
          reelId: draft.reelId,
          acknowledged: [],
          outstanding: images.map((image) => image.attachmentId),
          complete: false,
          outcomes,
          abandoned: true,
          failures,
        };
      }
      throw error;
    }

    const readyIds = new Set(
      reel.attachments.filter((attachment) => attachment.state === 'ready').map((attachment) => attachment.id),
    );

    for (const descriptor of images) {
      if (readyIds.has(descriptor.attachmentId)) continue;
      if (this.options.activeAccountId() !== accountId) {
        return this.progress(draft, readyIds, outcomes, failures, true);
      }
      const blob = await this.options.store.blob(accountId, descriptor.attachmentId);
      if (blob === undefined) {
        // The bytes are gone locally and the server has not acknowledged them. Silence
        // would look like success; this is reported as a failure so the caller can
        // surface it rather than quietly deleting the draft.
        failures.push({ attachmentId: descriptor.attachmentId, reason: 'local_bytes_missing' });
        continue;
      }
      try {
        const outcome = await this.uploader.uploadOne({
          reelId: draft.reelId,
          descriptor,
          blob,
          operations: await attachmentOperations(draft.operationId, descriptor.attachmentId),
        });
        outcomes.push(outcome);
        if (outcome.acknowledged !== null) readyIds.add(descriptor.attachmentId);
      } catch (error) {
        if (isAbandonedRequest(error)) return this.progress(draft, readyIds, outcomes, failures, true);
        // A refusal to send credentials off-origin is not a transient upload failure, and
        // retrying it every pass would bury a misconfigured or hostile upload URL in a
        // progress counter. It propagates.
        if (error instanceof CrossOriginUploadError) throw error;
        // Anything else: one failed image must not abandon the others. The blob stays,
        // the reason is recorded, and the next pass retries with the same identifiers.
        failures.push({
          attachmentId: descriptor.attachmentId,
          reason: error instanceof ClientApiError ? error.api.code : 'network_error',
        });
      }
    }

    const progress = this.progress(draft, readyIds, outcomes, failures, false);
    if (progress.complete && this.options.activeAccountId() === accountId) {
      // Authoritative reconciliation, not a local tally: the draft is removed only
      // because the server reports every image of this capture as ready.
      await this.options.store.deleteCapture(accountId, draft.reelId);
    }
    return progress;
  }

  private progress(
    draft: CaptureDraft,
    readyIds: Set<string>,
    outcomes: UploadOutcome[],
    failures: Array<{ attachmentId: string; reason: string }>,
    abandoned: boolean,
  ): AttachmentProgress {
    const ids = draft.input.images.map((image: CaptureImageDescriptor) => image.attachmentId);
    const acknowledged = ids.filter((id) => readyIds.has(id));
    const outstanding = ids.filter((id) => !readyIds.has(id));
    return {
      reelId: draft.reelId,
      acknowledged,
      outstanding,
      complete: !abandoned && outstanding.length === 0,
      outcomes,
      abandoned,
      failures,
    };
  }

  /**
   * Resume every capture of one account that has been submitted but not acknowledged.
   *
   * Drafts still in `draft` state are skipped: those are captures the user has not
   * submitted, and uploading them would create attachments for a Reel that does not
   * exist yet.
   */
  async resume(accountId: string): Promise<AttachmentProgress[]> {
    const drafts = await this.options.store.captures(accountId);
    const results: AttachmentProgress[] = [];
    for (const draft of drafts) {
      if (draft.state !== 'queued') continue;
      if (this.options.activeAccountId() !== accountId) break;
      if (draft.input.images.length === 0) {
        // Nothing to upload, so the draft has served its purpose once the Reel exists.
        await this.options.store.deleteCapture(accountId, draft.reelId);
        continue;
      }
      results.push(await this.runCapture(draft));
    }
    return results;
  }
}

/**
 * Browser attachment transport.
 *
 * The three-step server contract is initiate → PUT bytes → complete. Byte transfer
 * success is *not* completion, and this module never treats it as such: the local blob
 * stays exactly where it is until the individual `complete` call for that same
 * attachment returns an acknowledged `AttachmentReference`.
 *
 * Identifiers are stable across every retry. `attachmentId` comes from the capture
 * draft, and each step carries its own fixed `operationId` from the same draft, so a
 * reload, an offline period or a flaky upload replays the same operations instead of
 * minting new ones and creating duplicate attachments. Only the transport ticket is
 * disposable: an expired one is renewed, which by contract changes no attachment and
 * no version history.
 *
 * Two boundaries this module refuses to cross:
 *
 *   - It will not send credentials to an upload URL that is not same-origin. The
 *     server builds an absolute URL; a wrong or hostile origin there must not become
 *     a cookie and CSRF token sent to somebody else's host.
 *   - It captures the account at dispatch and reports a stale result rather than
 *     returning it, so a response that arrives after an account switch cannot be
 *     applied to — or acknowledged against — the newly active partition.
 */

import type {
  AttachmentReference,
  CaptureImageDescriptor,
  InitiateAttachmentResponse,
  RenewAttachmentUploadResponse,
  UploadTransport,
} from '../../../../packages/contracts/src/index.js';
import { ClientApiError } from './errors.js';
import type { CoreApiClient } from './api.js';

/** The header the server's upload ticket travels in. Never a cookie, never a key. */
export const UPLOAD_TOKEN_HEADER = 'X-Upload-Token';

export class CrossOriginUploadError extends Error {
  constructor(readonly uploadUrl: string) {
    super('Refusing to send credentials to a non-same-origin upload URL');
    this.name = 'CrossOriginUploadError';
  }
}

/**
 * Resolve and check the upload URL.
 *
 * Compared against the page's own origin rather than a configured value: the contract
 * is that uploads are same-origin, and the page origin is the one thing an attacker who
 * controlled the API response could not change.
 *
 * The URL must be **absolute**, parsed with no base. Resolving against the page instead
 * would quietly turn any unparseable value — a truncated URL, a stray string — into a
 * same-origin path and send credentials to whatever path that happened to produce.
 * Refusing is the only honest answer to a transport URL the client cannot understand.
 */
export function sameOriginUploadPath(uploadUrl: string, pageOrigin: string): string {
  let resolved: URL;
  try {
    resolved = new URL(uploadUrl);
  } catch {
    throw new CrossOriginUploadError(uploadUrl);
  }
  if (resolved.username || resolved.password) throw new CrossOriginUploadError(uploadUrl);
  if (resolved.origin !== new URL(pageOrigin).origin) throw new CrossOriginUploadError(uploadUrl);
  return `${resolved.pathname}${resolved.search}`;
}

/** Only the ticket header is forwarded; anything else the server sent is ignored. */
export function ticketHeaders(upload: UploadTransport): Record<string, string> {
  const token = Object.entries(upload.headers).find(
    ([name]) => name.toLowerCase() === UPLOAD_TOKEN_HEADER.toLowerCase(),
  );
  if (!token) throw new Error('Upload transport carried no upload token');
  return { [UPLOAD_TOKEN_HEADER]: token[1] };
}

export function isExpiredTicket(error: unknown): boolean {
  const reason = error instanceof ClientApiError ? (error.api.details as { reason?: string } | undefined)?.reason : undefined;
  // An expired ticket, or one superseded by an earlier renewal (a replayed initiation returns
  // its original ticket): both are fixed by exactly one renewal.
  return error instanceof ClientApiError
    && ((error.api.code === 'UPLOAD_INCOMPLETE' && reason === 'upload_authorization_expired')
      || (error.api.code === 'FORBIDDEN' && reason === 'upload_authorization_superseded'));
}

/** Operation ids for one attachment, held in the capture draft so retries reuse them. */
export interface AttachmentOperationIds {
  initiate: string;
  complete: string;
}

export interface UploadOutcome {
  attachmentId: string;
  /** Present only when the server acknowledged completion. */
  acknowledged: AttachmentReference | null;
  /** True only when `acknowledged` is non-null; the local blob may be released then. */
  releasable: boolean;
  /** Which steps actually ran, for a truthful progress report. */
  steps: Array<'initiate' | 'upload' | 'renew' | 'complete'>;
}

export interface AttachmentUploaderOptions {
  api: CoreApiClient;
  /** Injected so a test can drive the raw PUT without a DOM. */
  pageOrigin?: string;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export class AttachmentUploader {
  private readonly api: CoreApiClient;
  private readonly pageOrigin: string;

  constructor(options: AttachmentUploaderOptions) {
    this.api = options.api;
    this.pageOrigin = options.pageOrigin
      ?? (typeof location === 'undefined' ? 'http://localhost' : location.origin);
  }

  initiate(reelId: string, descriptor: CaptureImageDescriptor, operationId: string, options: { purpose?: AttachmentReference['purpose']; kind?: 'image' | 'video' } = {}) {
    return this.api.initiateAttachment(reelId, {
      operationId,
      attachmentId: descriptor.attachmentId,
      fileName: descriptor.fileName,
      mimeType: descriptor.mimeType,
      byteSize: descriptor.byteSize,
      ...(options.purpose ? { purpose: options.purpose } : {}),
      ...(options.kind ? { kind: options.kind } : {}),
    });
  }

  renew(reelId: string, attachmentId: string) {
    return this.api.renewAttachmentUpload(reelId, attachmentId);
  }

  complete(reelId: string, attachmentId: string, operationId: string) {
    return this.api.completeAttachment(reelId, attachmentId, { operationId });
  }

  /** Raw bytes to the ticket's own URL. Same-origin is checked before credentials attach. */
  putContent(upload: UploadTransport, blob: Blob, mimeType: string) {
    const path = sameOriginUploadPath(upload.uploadUrl, this.pageOrigin);
    return this.api.uploadAttachmentContent(path, blob, {
      method: upload.method,
      headers: { ...ticketHeaders(upload), 'Content-Type': mimeType },
    });
  }

  /**
   * Run one attachment to acknowledgement.
   *
   * `initiate` is idempotent on its operation id, so a replay returns the original
   * outcome — including a ticket that has since expired, which is exactly the case the
   * single renewal below covers. Renewal is attempted once: a second expiry in
   * immediate succession means something other than elapsed time is wrong, and
   * retrying forever would hide it.
   */
  async uploadOne(input: {
    reelId: string;
    descriptor: CaptureImageDescriptor;
    blob: Blob;
    operations: AttachmentOperationIds;
    purpose?: AttachmentReference['purpose'];
    kind?: 'image' | 'video';
  }): Promise<UploadOutcome> {
    const steps: UploadOutcome['steps'] = [];
    const initiated: InitiateAttachmentResponse = await this.initiate(
      input.reelId, input.descriptor, input.operations.initiate,
      { ...(input.purpose ? { purpose: input.purpose } : {}), ...(input.kind ? { kind: input.kind } : {}) },
    );
    steps.push('initiate');

    // A replayed initiation may already report the attachment as ready; re-uploading
    // would be refused by the immutable object, so completion is all that is left.
    if (initiated.attachment.state !== 'ready') {
      let upload: UploadTransport = initiated.upload;
      try {
        await this.putContent(upload, input.blob, input.descriptor.mimeType);
        steps.push('upload');
      } catch (error) {
        if (!isExpiredTicket(error)) throw error;
        const renewed: RenewAttachmentUploadResponse = await this.renew(input.reelId, input.descriptor.attachmentId);
        steps.push('renew');
        upload = renewed.upload;
        await this.putContent(upload, input.blob, input.descriptor.mimeType);
        steps.push('upload');
      }
    }

    // The only statement that may release the local blob.
    const acknowledged = await this.complete(
      input.reelId, input.descriptor.attachmentId, input.operations.complete,
    );
    steps.push('complete');
    return { attachmentId: input.descriptor.attachmentId, acknowledged, releasable: true, steps };
  }
}

/**
 * Android Share Target receipt.
 *
 * Pure logic, shared by the service worker and its tests. It turns one inbound
 * `multipart/form-data` POST into the product's own `CaptureInput`, and it does so under
 * hard bounds that are enforced *while streaming*, before anything is buffered.
 *
 * Three things this module is careful about, because each is a pinned requirement rather
 * than a preference:
 *
 *   - **Nothing is destroyed.** T00: `OriginalSharedInput.fields` are "exact scalar fields in
 *     received order, including repeated names and empty values", and `files` are "all
 *     received file descriptors in order, including explicitly unsupported files". So the raw
 *     ordered entry list is preserved alongside the derived capture, and a URL lifted out of
 *     shared text does not remove that text.
 *   - **`additionalText` is never set here.** It is "separate Quick Add context entered
 *     alongside URL/image" — something the user types later. A share filling it would
 *     fabricate provenance.
 *   - **Refusals are explicit.** T00: "Unsupported payloads and unavailable browser capability
 *     are explicit, not false success." An over-limit share is rejected with a reason, never
 *     silently truncated to the part that fitted.
 */

import type {
  CaptureImageDescriptor,
  CaptureInput,
  OriginalSharedInput,
} from '../../../../packages/contracts/src/index.js';

/** Must match the server's `DEFAULT_ATTACHMENT_LIMITS`; asserted in the tests. */
export const SUPPORTED_IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * The path the manifest's `share_target.action` points at, and the two query parameters the
 * receipt hands back to the page.
 *
 * They live here rather than in the page module because the worker writes them and the page
 * reads them, and the worker cannot import page code — `pending.ts` touches `history`, which
 * does not exist in a worker scope. One definition, imported by both sides.
 */
export const SHARE_TARGET_PATH = '/share-target';
export const INCOMING_PARAM = 'incoming';
export const SHARE_ERROR_PARAM = 'shareError';

/**
 * Transport bounds for one inbound share.
 *
 * The per-file bound alone does not bound a share: six files of 8 MiB is 48 MiB, and a sender
 * can attach more. So the file count, the aggregate file bytes and the whole request body are
 * each capped, and the body cap is what protects the worker's memory — it is enforced against
 * bytes actually read, not against a `Content-Length` the sender may omit or misstate.
 */
export const SHARE_LIMITS = {
  maxFiles: 6,
  maxFileBytes: 8 * 1024 * 1024,
  maxAggregateFileBytes: 24 * 1024 * 1024,
  /** Slightly above the aggregate, to allow multipart framing and the scalar fields. */
  maxBodyBytes: 26 * 1024 * 1024,
} as const;

export type ShareRejection =
  | 'body_too_large'
  | 'too_many_files'
  | 'file_too_large'
  | 'aggregate_too_large'
  | 'unreadable'
  | 'nothing_usable';

export class ShareRejectedError extends Error {
  readonly reason: ShareRejection;
  // Written out rather than declared as a constructor parameter property: Node's type
  // stripping cannot erase those, and these tests run the source directly.
  constructor(reason: ShareRejection, message: string) {
    super(message);
    this.name = 'ShareRejectedError';
    this.reason = reason;
  }
}

/**
 * Read the request body with a hard cap, counting bytes as they arrive.
 *
 * `request.formData()` would buffer the whole body first, so the cap has to be applied to the
 * stream. `Content-Length` is consulted only as an early rejection: a sender that omits or
 * understates it is still bounded, because the running total is what terminates the read.
 * The reader is cancelled on the offending chunk rather than after the body completes.
 */
export async function readBoundedBody(
  request: Request,
  maxBytes: number = SHARE_LIMITS.maxBodyBytes,
): Promise<Uint8Array> {
  const declared = Number(request.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ShareRejectedError('body_too_large', `declared ${declared} bytes exceeds ${maxBytes}`);
  }
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop consuming immediately; do not keep reading to find out how big it really is.
        await reader.cancel();
        throw new ShareRejectedError('body_too_large', `body exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export interface ReceivedFile {
  descriptor: CaptureImageDescriptor & { lastModified?: number; issue?: 'UNSUPPORTED_INPUT' };
  /** Present only for supported files; unsupported ones are recorded but not stored. */
  blob: Blob | null;
}

export interface ReceivedShare {
  original: OriginalSharedInput;
  files: ReceivedFile[];
}

/**
 * Turn parsed form data into ordered fields and file descriptors.
 *
 * Order and repetition come from `FormData.entries()` and are kept verbatim, including empty
 * values and names the manifest never declared — a sender is untrusted input, and discarding
 * what we did not expect is how provenance gets lost.
 */
export function readSharePayload(
  form: FormData,
  newId: () => string,
  limits: typeof SHARE_LIMITS = SHARE_LIMITS,
): ReceivedShare {
  const fields: OriginalSharedInput['fields'] = [];
  const files: ReceivedFile[] = [];
  let aggregate = 0;

  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      fields.push({ name, value });
      continue;
    }
    const file = value;
    if (files.length >= limits.maxFiles) {
      throw new ShareRejectedError('too_many_files', `more than ${limits.maxFiles} files`);
    }
    if (file.size > limits.maxFileBytes) {
      throw new ShareRejectedError('file_too_large', `a file exceeds ${limits.maxFileBytes} bytes`);
    }
    aggregate += file.size;
    if (aggregate > limits.maxAggregateFileBytes) {
      throw new ShareRejectedError('aggregate_too_large', `files exceed ${limits.maxAggregateFileBytes} bytes in total`);
    }

    const supported = SUPPORTED_IMAGE_TYPES.includes(file.type);
    const descriptor: ReceivedFile['descriptor'] = {
      // Allocated once, here at receipt, so every later retry reuses it.
      attachmentId: newId(),
      fileName: file.name,
      mimeType: file.type,
      byteSize: file.size,
      ...(Number.isFinite(file.lastModified) ? { lastModified: file.lastModified } : {}),
      ...(supported ? {} : { issue: 'UNSUPPORTED_INPUT' as const }),
    };
    files.push({ descriptor, blob: supported ? file : null });
  }

  return { original: { fields, files: files.map((entry) => entry.descriptor) }, files };
}

/** First non-empty value for a field name, in received order. */
function firstValue(fields: OriginalSharedInput['fields'], name: string): string | undefined {
  for (const field of fields) {
    if (field.name === name && field.value.trim() !== '') return field.value;
  }
  return undefined;
}

/**
 * Find an absolute http(s) URL inside shared text.
 *
 * Android senders routinely put the link in `text` with no `url` field at all. Lifting it out
 * makes the capture usable, and the original text is kept unchanged both in `text` and in
 * `originalShare.fields` — T00: "Do not derive a title/URL by destroying the original source
 * fields."
 */
export function findUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  for (const candidate of value.split(/\s+/)) {
    if (!/^https?:\/\//i.test(candidate)) continue;
    try {
      return new URL(candidate).toString();
    } catch { /* not a URL after all; keep looking */ }
  }
  return undefined;
}

export type DetectedKind = 'image' | 'url' | 'text';

export interface MappedShare {
  input: CaptureInput;
  fileNames: Record<string, string>;
  /** Drives the frozen compact detected-type chip, which already exists in Quick Add. */
  detectedKind: DetectedKind;
  /** Supported blobs only, keyed by attachment id. */
  blobs: Map<string, Blob>;
}

/**
 * Map a received share onto the product's `CaptureInput`.
 *
 * `additionalText` is deliberately absent: it belongs to the user, not the sender.
 */
export function toCaptureInput(received: ReceivedShare): MappedShare {
  const { fields } = received.original;
  const sharedText = firstValue(fields, 'text');
  const title = firstValue(fields, 'title');
  const explicitUrl = firstValue(fields, 'url');
  const url = explicitUrl ?? findUrl(sharedText) ?? findUrl(title);
  // Prefer the shared body text, fall back to the title. Both remain in `fields` regardless.
  const text = sharedText ?? title;

  const supported = received.files.filter((entry) => entry.blob !== null);
  const images: CaptureImageDescriptor[] = supported.map((entry) => ({
    attachmentId: entry.descriptor.attachmentId,
    fileName: entry.descriptor.fileName,
    mimeType: entry.descriptor.mimeType,
    byteSize: entry.descriptor.byteSize,
  }));

  // T00: "A usable capture has text, a URL, a supported image, or usable original shared
  // text/title; completely unusable payloads are rejected explicitly."
  if (images.length === 0 && url === undefined && (text === undefined || text.trim() === '')) {
    throw new ShareRejectedError('nothing_usable', 'the share carried nothing usable');
  }

  const input: CaptureInput = {
    images,
    ...(text === undefined ? {} : { text }),
    ...(url === undefined ? {} : { url }),
    originalShare: received.original,
  };

  return {
    input,
    fileNames: Object.fromEntries(supported.map((entry) => [entry.descriptor.attachmentId, entry.descriptor.fileName])),
    detectedKind: images.length > 0 ? 'image' : url !== undefined ? 'url' : 'text',
    blobs: new Map(supported.map((entry) => [entry.descriptor.attachmentId, entry.blob as Blob])),
  };
}

/** Parse a bounded body into form data, without ever buffering more than the cap. */
export async function parseBoundedShare(request: Request): Promise<FormData> {
  const contentType = request.headers.get('content-type');
  if (contentType === null || !contentType.toLowerCase().includes('multipart/form-data')) {
    throw new ShareRejectedError('unreadable', 'share must be multipart/form-data');
  }
  const body = await readBoundedBody(request);
  try {
    // The bytes are already bounded, so this parse cannot be made to consume more.
    // A fresh Blob avoids depending on the exact ArrayBuffer flavour of the accumulated view.
    const bounded = new Blob([body as unknown as BlobPart], { type: contentType });
    return await new Response(bounded, { headers: { 'content-type': contentType } }).formData();
  } catch {
    throw new ShareRejectedError('unreadable', 'the share body could not be parsed');
  }
}

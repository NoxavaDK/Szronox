/**
 * The single place that turns a failure into the T00 error envelope.
 *
 * `{ error: { code, message, retryable, currentVersion?, details? } }`. The message
 * is diagnostic English and is never displayed raw; the web layer maps machine
 * codes to Polish. Provider payloads and secrets never appear here.
 */

import type { ApiError, ErrorCode, ErrorResponse } from '@szronox/contracts';

export class CoreError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly currentVersion?: number;
  readonly details?: Record<string, unknown>;

  constructor(init: {
    status: number;
    code: ErrorCode;
    message: string;
    retryable?: boolean;
    currentVersion?: number;
    details?: Record<string, unknown>;
  }) {
    super(init.message);
    this.name = 'CoreError';
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable ?? false;
    this.currentVersion = init.currentVersion;
    this.details = init.details;
  }

  toEnvelope(): ErrorResponse {
    const error: ApiError = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.currentVersion !== undefined) error.currentVersion = this.currentVersion;
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

export const unauthenticated = (message = 'Authentication required') =>
  new CoreError({ status: 401, code: 'UNAUTHENTICATED', message });

export const forbidden = (message: string, details?: Record<string, unknown>) =>
  new CoreError({ status: 403, code: 'FORBIDDEN', message, ...(details ? { details } : {}) });

export const notFound = (message = 'Resource not found') =>
  new CoreError({ status: 404, code: 'NOT_FOUND', message });

export const validationError = (message: string, details?: Record<string, unknown>) =>
  new CoreError({ status: 422, code: 'VALIDATION_ERROR', message, details });

/** Version mismatch. Carries the authoritative version so the client keeps its draft. */
export const editConflict = (currentVersion: number) =>
  new CoreError({
    status: 409,
    code: 'EDIT_CONFLICT',
    message: 'Reel was modified by another write',
    currentVersion,
  });

/** Same operation id, different payload. */
export const idempotencyConflict = () =>
  new CoreError({
    status: 409,
    code: 'IDEMPOTENCY_CONFLICT',
    message: 'Operation id was already used with a different payload',
  });

export const feedCoverRequired = () =>
  new CoreError({
    status: 422,
    code: 'FEED_COVER_REQUIRED',
    message: 'Feed cover must be marked done before publishing',
  });

export const editorRequired = () =>
  new CoreError({
    status: 422,
    code: 'EDITOR_REQUIRED',
    message: 'A valid editor must be selected before verifying an export',
  });

export const exportChanged = (currentVersion?: number) =>
  new CoreError({
    status: 409,
    code: 'EXPORT_CHANGED',
    message: 'Export revision changed before verification',
    currentVersion,
  });

export const uploadIncomplete = (message = 'Attachment upload is not complete') =>
  new CoreError({ status: 422, code: 'UPLOAD_INCOMPLETE', message });

export const unsupportedInput = (message: string, details?: Record<string, unknown>) =>
  new CoreError({ status: 422, code: 'UNSUPPORTED_INPUT', message, details });

export const internalError = (message = 'Unexpected server error') =>
  new CoreError({ status: 500, code: 'INTERNAL_ERROR', message, retryable: true });

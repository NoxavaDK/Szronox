/**
 * Compile-time proof that `@szronox/contracts` resolves through its real package
 * export for the web workspace. Nothing here runs at runtime.
 *
 * C04 (C01 follow-up): this file previously exported
 *
 *     isErrorResponse(value): value is ErrorResponse
 *
 * which only tested `'error' in value`, so `{ error: null }` was accepted as an
 * `ErrorResponse` even though `ApiError` is not nullable. Nothing consumed it — it
 * existed to force an import — so an unsound guard was sitting in the source
 * waiting to be believed. It is replaced by a type-level exercise that fails
 * `tsc` for exactly the reason intended (the package no longer resolving), without
 * shipping a runtime validator that lies.
 *
 * If a real runtime validator is needed later, it belongs with the code that
 * parses responses and must check `error.code`/`error.message` properly.
 */

import type { ApiError, ErrorCode, ErrorResponse } from '@szronox/contracts';

/** Fails to compile if the two sides ever stop matching exactly. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

// `ErrorResponse.error` is a non-nullable `ApiError`. Asserting that here is what
// the old runtime guard got wrong.
export type ErrorResponseErrorIsApiError = Assert<Exact<ErrorResponse['error'], ApiError>>;

// `ApiError.code` is the shared machine-readable enum the web layer maps to Polish.
export type ApiErrorCodeIsErrorCode = Assert<Exact<ApiError['code'], ErrorCode>>;

// A concrete value, so the types are exercised rather than merely imported.
export const EXAMPLE_ERROR_RESPONSE: ErrorResponse = {
  error: { code: 'NOT_FOUND', message: 'Route not found', retryable: false },
};

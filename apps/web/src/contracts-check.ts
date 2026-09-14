// Narrow real-package consumption check for F5: fails typecheck if @szronox/contracts
// stops resolving via its published package export.
import type { ErrorResponse } from '@szronox/contracts';

export function isErrorResponse(value: unknown): value is ErrorResponse {
  return typeof value === 'object' && value !== null && 'error' in value;
}

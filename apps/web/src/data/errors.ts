import type { ApiError, ErrorCode } from '../../../../packages/contracts/src/index.js';

export class ClientApiError extends Error {
  constructor(public readonly status: number, public readonly api: ApiError) {
    super(api.message);
  }
}

const messages: Partial<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: 'Sesja wygasła. Zaloguj się ponownie.',
  FORBIDDEN: 'Nie masz uprawnień do tej operacji.',
  RATE_LIMITED: 'Za dużo prób. Odczekaj chwilę i spróbuj ponownie.',
  NOT_FOUND: 'Nie znaleziono rolki.',
  VALIDATION_ERROR: 'Sprawdź wprowadzone dane.',
  EDIT_CONFLICT: 'Rolka zmieniła się na innym urządzeniu. Twoje zmiany zostały zachowane.',
  IDEMPOTENCY_CONFLICT: 'Nie udało się bezpiecznie powtórzyć operacji.',
  EXPORT_CHANGED: 'Eksport zmienił się przed weryfikacją.',
  FEED_COVER_REQUIRED: 'Przed zmianą statusu na „Opublikowane” oznacz „Okładka do feedu” jako ukończoną.',
  EDITOR_REQUIRED: 'Wybierz montażystę, aby wskazać osobę sprawdzającą.',
  UPLOAD_INCOMPLETE: 'Zdjęcie nie zostało jeszcze wysłane.',
  UNSUPPORTED_INPUT: 'Ten typ pliku nie jest obsługiwany.',
  PROVIDER_UNAVAILABLE: 'Usługa jest chwilowo niedostępna.',
  PROVIDER_ACCESS_DENIED: 'Brak dostępu do pliku.',
  PROVIDER_RESOURCE_MISSING: 'Plik nie jest już dostępny.',
  INTERNAL_ERROR: 'Wystąpił błąd. Spróbuj ponownie.',
};

/**
 * True for a request that was cancelled because the active account changed.
 *
 * Callers discard these silently: the work belonged to the previous account, so it
 * is neither an error to report nor a result to apply.
 */
export function isAbandonedRequest(error: unknown): boolean {
  if (error instanceof Error && error.name === 'StaleResponseError') return true;
  return error instanceof DOMException && error.name === 'AbortError';
}

export function polishError(error: unknown): string {
  if (error instanceof ClientApiError) return messages[error.api.code] ?? error.api.message;
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'Brak miejsca na zapis lokalny.';
  // Aborted work has no user-facing meaning, but a message is still required by the
  // signature; callers are expected to filter it with `isAbandonedRequest` first.
  if (isAbandonedRequest(error)) return 'Operacja została przerwana po zmianie konta.';
  return 'Nie udało się połączyć. Zmiany zostały zachowane lokalnie.';
}

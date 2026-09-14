import type { ApiError, ErrorCode } from '../../../../packages/contracts/src/index.js';

export class ClientApiError extends Error {
  constructor(public readonly status: number, public readonly api: ApiError) {
    super(api.message);
  }
}

const messages: Partial<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: 'Sesja wygasła. Zaloguj się ponownie.',
  FORBIDDEN: 'Nie masz uprawnień do tej operacji.',
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

export function polishError(error: unknown): string {
  if (error instanceof ClientApiError) return messages[error.api.code] ?? error.api.message;
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'Brak miejsca na zapis lokalny.';
  return 'Nie udało się połączyć. Zmiany zostały zachowane lokalnie.';
}

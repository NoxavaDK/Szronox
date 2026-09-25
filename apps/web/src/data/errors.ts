import type { ApiError, ErrorCode } from '../../../../packages/contracts/src/index.js';

export class ClientApiError extends Error {
  // Plain fields rather than parameter properties, so Node's type-stripping test runner can load this module.
  readonly status: number;
  readonly api: ApiError;
  constructor(status: number, api: ApiError) {
    super(api.message);
    this.status = status;
    this.api = api;
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
  SOURCE_TOO_LARGE: 'Strona przekracza limit pobierania 2 MiB. Wklej tekst artykułu.',
  SOURCE_TEXT_TOO_LONG: 'Tekst artykułu przekracza limit 20 000 znaków. Wklej wybrany fragment.',
  SOURCE_ACCESS_DENIED: 'Witryna odmówiła dostępu do artykułu. Wklej jego tekst.',
  SOURCE_TEXT_UNAVAILABLE: 'Nie udało się odczytać treści artykułu. Wklej jego tekst.',
  SOURCE_UNSUPPORTED: 'Nie można odczytać tego adresu lub formatu strony. Wklej tekst artykułu.',
  SOURCE_UNAVAILABLE: 'Nie udało się pobrać strony. Spróbuj ponownie później lub wklej tekst.',
  UNSUPPORTED_INPUT: 'Ten typ pliku nie jest obsługiwany.',
  PROVIDER_UNAVAILABLE: 'Usługa jest chwilowo niedostępna.',
  PROVIDER_ACCESS_DENIED: 'Brak dostępu do pliku.',
  PROVIDER_RESOURCE_MISSING: 'Plik nie jest już dostępny.',
  INVALID_AI_RESULT: 'Nie udało się przygotować poprawnej propozycji. Spróbuj ponownie.',
  INSUFFICIENT_EVIDENCE: 'Brak zatwierdzonego źródła do sprawdzenia postulatu.',
  STALE_FACT_CLAIM: 'Ten fragment zmienił się od sprawdzenia. Sprawdź fakty ponownie.',
  STALE_LANGUAGE_RESULT: 'Skrypt zmienił się od sprawdzenia języka. Sprawdź ponownie.',
  STALE_PUBLICATION_RESULT: 'Skrypt, wybrany hook lub źródła zmieniły się od wygenerowania opisu. Wygeneruj opis ponownie.',
  INTERNAL_ERROR: 'Wystąpił błąd. Spróbuj ponownie.',
};

/** Shown both before a request (client check) and for the server's own refusal. */
export const SCRIPT_REQUIRED = 'Najpierw zapisz skrypt. Opis powstaje z zapisanego skryptu.';
/** Wygeneruj opis never saves or discards edits on the user's behalf. */
export const UNSAVED_BEFORE_PUBLICATION = 'Najpierw zapisz zmiany. Opis powstaje z zapisanego skryptu, a Twoje zmiany zostały zachowane.';

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
  if (error instanceof ClientApiError) {
    if (error.api.details?.reason === 'script_required') return SCRIPT_REQUIRED;
    if (error.api.details?.reason === 'wrong_action') return 'Tej propozycji nie można już zastosować. Użyj „Wygeneruj opis” w sekcji PUBLIKACJA.';
    if (error.api.details?.reason === 'programme_attached') return 'Przypięty postulat pozostaje. Odłącz go osobno, jeśli chcesz usunąć powiązanie.';
    return messages[error.api.code] ?? error.api.message;
  }
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'Brak miejsca na zapis lokalny.';
  // Aborted work has no user-facing meaning, but a message is still required by the
  // signature; callers are expected to filter it with `isAbandonedRequest` first.
  if (isAbandonedRequest(error)) return 'Operacja została przerwana po zmianie konta.';
  return 'Nie udało się połączyć. Zmiany zostały zachowane lokalnie.';
}

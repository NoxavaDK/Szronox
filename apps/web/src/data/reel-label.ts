/**
 * What to call a Reel that has no title yet.
 *
 * Capture stores the input but never writes a title: `POST /reels` inserts `original_input`
 * and `input_note` and leaves `title` to its SQL default of `''`. The list row renders
 * `reel.title` directly, so an untitled capture — every shared link, and any text or image
 * idea saved without one — produced a row that was tappable but blank.
 *
 * The fix is a label derived from the capture the Reel already carries. Two properties matter:
 *
 *   - **Nothing is written.** This is presentation only. `title` stays `''` until a person
 *     types one, and `originalInput` is read but never altered. A derived label is not a
 *     silently authored title, which is why it is returned with `derived: true` rather than
 *     substituted into the title field.
 *   - **Nothing is fetched.** The label comes from bytes already in hand. No page download, no
 *     Gemini call, no round trip — so it appears on the first render of an offline list too.
 *
 * Order of preference, and the reasoning for it:
 *
 *   1. The author's own words: `text`, or `additionalText` when there is no `text`. If those
 *      words are nothing but a bare URL — which is what an Android share of a link usually
 *      produces — it is treated as a URL rather than printed raw.
 *   2. (UI-02, `reelLabel` only) the saved script's opening sentence.
 *   3. The URL's readable slug — never an opaque platform code — else `Materiał z <host>`.
 *   4. The first image's file name. Real data the user recognises, preferred over a count.
 *   5. The image count, when the files carried no usable names.
 *   6. Any non-empty original shared field, in received order. A safety net for a payload
 *      shaped differently from what capture mapped.
 *   7. `Bez tytułu`. Honest, and still better than a blank row.
 *
 * CAPTURE-DRAFT-01 (T00 binding section) extends the chain for a Reel (not a bare capture):
 * typed title, then a selected hook's text, then an auto-draft title suggestion (once that run
 * has succeeded), then the fetched article headline, then everything above (the share's own
 * `title` field is still tried first inside `authorWords`, which is unchanged — only new rungs
 * were inserted ahead of it) — except that a photo-only capture is now labelled
 * `Zdjęcie · 11 paź` / `3 zdjęcia · 11 paź` (the Reel's own `createdAt`, Polish short month,
 * Europe/Warsaw) instead of a file name. `captureLabel` keeps the file-name/count behaviour
 * unchanged, because it runs before a Reel (and so a capture date) exists; `reelLabel` falls
 * back to the same behaviour when a caller supplies no `createdAt` (e.g. a stream topic
 * candidate, which has no capture-date field of its own).
 */

import type { AutoDraftSummary, CaptureInput, Reel, SourceMetadata } from '../../../../packages/contracts/src/index.js';

/** Enough for the row, which ellipsises anyway; the cap keeps absurd input out of the DOM. */
export const MAX_LABEL_LENGTH = 80;

/** Shown only when the capture yields nothing at all — which validation should prevent. */
export const UNTITLED_LABEL = 'Bez tytułu';

export interface ReelLabel {
  text: string;
  /** Host of an original link, shown as separate secondary source metadata. */
  sourceDomain?: string;
  /**
   * True when `text` was derived from the capture rather than typed by a person.
   *
   * The caller needs this: a derived label is presented more quietly, and it must never be
   * loaded into the editable title field, where saving the form would turn a guess into an
   * authored title.
   */
  derived: boolean;
}

/** Collapse whitespace and cut to length, appending an ellipsis only if something was cut. */
function tidy(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= MAX_LABEL_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_LABEL_LENGTH - 1).trimEnd()}…`;
}

/**
 * Shorten a URL to something readable in a 56-pixel row.
 *
 * Host without `www.`, plus the path. The query string and fragment are dropped because they
 * are usually tracking parameters and would push the meaningful part past the ellipsis. This
 * discards nothing: `originalInput.url` keeps the exact URL, and the detail screen and
 * `originalShare` still hold it in full.
 */
export function sourceDomain(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.hostname.replace(/^www\./i, '');
  } catch { return undefined; }
}

function captureUrl(input: CaptureInput): string | undefined {
  if (input.url?.trim()) return input.url;
  for (const raw of [input.text, input.additionalText, ...(input.originalShare?.fields ?? []).map((field) => field.value)]) {
    if (raw?.trim() && isBareUrl(raw.trim())) return raw;
  }
  return undefined;
}

const ROUTE_ONLY_SEGMENTS = new Set(['reel', 'reels', 'p', 'watch', 'video', 'videos', 'photo', 'photos', 'status', 'story', 'stories', 's', 'path', 'page',
  'live', 'shorts', 'post', 'posts', 'share', 'embed', 'amp', 'index', 'html', 'php', 'www', 'tv', 'clip', 'clips', 'media']);

/**
 * UI-02: platform short codes (`h7v9vwm`, `azIr67Xq2v`) are identifiers, not words. A segment
 * is readable only when every hyphen/underscore part is plain letters (or a short number such
 * as a year), at least one part is a real word, and no part mixes case inside a word.
 */
function looksLikeWords(segment: string): boolean {
  const parts = segment.split(/[-_\s.]+/).filter(Boolean);
  if (parts.length === 0) return false;
  if (!parts.some((part) => /^\p{L}{3,}$/u.test(part))) return false;
  return parts.every((part) => (/^\p{L}+$/u.test(part) && !/\p{Ll}\p{Lu}/u.test(part)) || /^\d{1,4}$/.test(part));
}

function readablePath(raw: string): string | undefined {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    const segments = parsed.pathname.split('/').filter(Boolean).map((part) => {
      try { return decodeURIComponent(part); } catch { return part; }
    });
    const candidate = segments.reverse().find((part) => {
      const lower = part.toLocaleLowerCase('pl-PL');
      if (part.length < 4 || ROUTE_ONLY_SEGMENTS.has(lower) || /^\d+$/.test(part)) return false;
      if (/^[A-Z0-9_-]{4,}$/.test(part)) return false;
      if (/^[a-f0-9]{16,}$/i.test(part) || /^[A-Za-z0-9]{20,}$/.test(part)) return false;
      return /[\p{L}]/u.test(part) && looksLikeWords(part.replace(/\.[a-z0-9]{2,5}$/i, ''));
    });
    if (!candidate) return undefined;
    return candidate.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  } catch { return undefined; }
}

export function urlLabel(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return tidy(raw);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return tidy(raw);
  const host = parsed.hostname.replace(/^www\./i, '');
  return tidy(readablePath(raw) ?? `Materiał z ${host}`);
}

/** True when the whole string is one absolute http(s) URL and nothing else. */
function isBareUrl(value: string): boolean {
  const trimmed = value.trim();
  if (/\s/.test(trimmed) || !/^https?:\/\//i.test(trimmed)) return false;
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}

/** First non-empty line, so a multi-line share is labelled by its opening line. */
function firstLine(value: string): string | undefined {
  for (const line of value.split(/\r?\n/)) {
    if (line.trim() !== '') return line;
  }
  return undefined;
}

/** `2 zdjęcia`, `5 zdjęć` — Polish counts the teens and the 12–14 exception separately. */
export function imageCountLabel(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  const plural = lastTwo >= 12 && lastTwo <= 14 ? 'zdjęć' : last >= 2 && last <= 4 ? 'zdjęcia' : 'zdjęć';
  return count === 1 ? '1 zdjęcie' : `${count} ${plural}`;
}

/** The person's own words in a capture — a share title, text or accompanying text — if any. */
function authorWords(input: CaptureInput): string | undefined {
  const title = input.originalShare?.fields.find((field) => field.name.toLocaleLowerCase('pl-PL') === 'title' && field.value.trim() !== '')?.value;
  const candidates = [
    title,
    input.text,
    input.additionalText,
    ...(input.originalShare?.fields ?? []).filter((field) => field.name.toLocaleLowerCase('pl-PL') !== 'url').map((field) => field.value),
  ];
  for (const candidate of candidates) {
    const line = candidate === undefined ? undefined : candidate.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== '' && !isBareUrl(part));
    if (line !== undefined) return tidy(line);
  }
  return undefined;
}

/**
 * UI-02: the opening sentence of the saved script, when there is one — far more recognisable
 * than a link's host or an image file name. Only the first non-empty line is considered.
 */
export function scriptLabel(script: string | undefined): string | undefined {
  const line = script ? firstLine(script)?.trim() : undefined;
  if (!line) return undefined;
  const sentence = line.split(/(?<=[.!?…])\s+/u)[0];
  return tidy(sentence.replace(/[.…]+$/u, '') || line);
}

/**
 * Rungs shared once "own words" are ruled out: a bare URL anywhere in the capture, the
 * capture's own link, then the image rung (parameterised — `captureLabel`'s image rung differs
 * from `reelLabel`'s only in whether it has a capture date to work with), then the last-resort
 * original shared field, then `UNTITLED_LABEL`.
 */
function linkThenImages(input: CaptureInput, imageLabel: (images: CaptureInput['images']) => string): string {
  for (const raw of [input.url, input.text, input.additionalText, ...(input.originalShare?.fields ?? []).map((field) => field.value)]) {
    if (raw?.trim() && isBareUrl(raw.trim())) return urlLabel(raw);
  }
  if (input.url !== undefined && input.url.trim() !== '') return urlLabel(input.url);

  if (input.images.length > 0) return imageLabel(input.images);

  for (const field of input.originalShare?.fields ?? []) {
    if (field.value.trim() === '') continue;
    return isBareUrl(field.value) ? urlLabel(field.value) : tidy(field.value);
  }

  return UNTITLED_LABEL;
}

/** The pre-CAPTURE-DRAFT-01 image rung: the first usable file name, else a pluralised count. */
function defaultImageLabel(images: CaptureInput['images']): string {
  const named = images.find((image) => image.fileName.trim() !== '');
  return named !== undefined ? tidy(named.fileName) : imageCountLabel(images.length);
}

const WARSAW_SHORT_DATE = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'short' });

/** CAPTURE-DRAFT-01 rung 9: `Zdjęcie · 11 paź` / `3 zdjęcia · 11 paź`, by capture date. */
function photoDateLabel(count: number, createdAt: string): string {
  const when = WARSAW_SHORT_DATE.format(new Date(createdAt));
  return count === 1 ? `Zdjęcie · ${when}` : `${imageCountLabel(count)} · ${when}`;
}

/** Derive a label from a capture alone. Exported for the capture-time preview and the tests. */
export function captureLabel(input: CaptureInput): string {
  const words = authorWords(input);
  if (words !== undefined) return words;
  return linkThenImages(input, defaultImageLabel);
}

/**
 * The label to show for a Reel.
 *
 * An authored title wins outright and is returned exactly as stored — no tidying, no
 * truncation, nothing that would make the list disagree with the title field.
 *
 * `inputNote` is deliberately not consulted, even though capture seeds it from the same text.
 * It is editable, so using it would make the label drift as notes are edited; `originalInput`
 * is immutable, which makes the label stable for the life of the Reel.
 *
 * UI-02: when the capture holds no words of its own (a bare link, an image), the saved script's
 * opening sentence is preferred over an opaque link token or file name. It can change as the
 * script is edited — acceptable for a label that exists only until someone writes a title.
 */
export function reelLabel(
  reel: Pick<Reel, 'title' | 'originalInput'> &
    Partial<Pick<Reel, 'script' | 'createdAt' | 'hooks' | 'selectedHookId'>> & {
      /** CAPTURE-DRAFT-01 rung 2: the selected hook's text, when there is one. */
      selectedHookText?: string | null;
      /** CAPTURE-DRAFT-01 rung 3: only consulted once that run has succeeded. */
      autoDraft?: Pick<AutoDraftSummary, 'state' | 'titleSuggestion'> | null;
      /** CAPTURE-DRAFT-01 rung 4: the fetched article headline. */
      sourceMetadata?: Pick<SourceMetadata, 'headline'> | null;
    },
): ReelLabel {
  const domain = sourceDomain(captureUrl(reel.originalInput));
  const withDomain = (text: string, derived: boolean): ReelLabel =>
    ({ text, derived, ...(domain ? { sourceDomain: domain } : {}) });

  if (reel.title.trim() !== '') return withDomain(reel.title, false);

  // Root integration: a full Reel carries hooks + selectedHookId rather than the text, so every
  // caller that passes a whole Reel gets rung 2 without having to resolve the hook itself.
  const selectedHookText = reel.selectedHookText
    ?? (reel.selectedHookId ? reel.hooks?.find((hook) => hook.id === reel.selectedHookId)?.text : undefined);

  // CAPTURE-DRAFT-01 rungs 2–4, each ahead of the share's own `title` field (rung 5), which
  // stays exactly where it already was: inside `authorWords` below. Only the chain's new rungs
  // were inserted ahead of it, not its own position.
  if (selectedHookText && selectedHookText.trim() !== '') {
    return withDomain(tidy(selectedHookText), true);
  }
  if (reel.autoDraft?.state === 'succeeded' && reel.autoDraft.titleSuggestion && reel.autoDraft.titleSuggestion.trim() !== '') {
    return withDomain(tidy(reel.autoDraft.titleSuggestion), true);
  }
  if (reel.sourceMetadata?.headline && reel.sourceMetadata.headline.trim() !== '') {
    return withDomain(tidy(reel.sourceMetadata.headline), true);
  }

  // Rungs 5–8: the share's title field (inside authorWords), its own text, the saved script's
  // opening line, then a URL slug — unchanged from before CAPTURE-DRAFT-01. Nothing is fetched.
  const text = authorWords(reel.originalInput) ?? scriptLabel(reel.script) ?? linkThenImages(
    reel.originalInput,
    // Rung 9: dated by the Reel's own createdAt once there is one; a caller without it (a
    // stream topic candidate has no capture-date field) keeps the file-name/count fallback.
    (images) => reel.createdAt !== undefined ? photoDateLabel(images.length, reel.createdAt) : defaultImageLabel(images),
  );
  return withDomain(text, true);
}

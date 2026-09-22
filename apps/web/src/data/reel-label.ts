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
 *   2. The URL, shortened to host and path.
 *   3. The first image's file name. Real data the user recognises, preferred over a count.
 *   4. The image count, when the files carried no usable names.
 *   5. Any non-empty original shared field, in received order. A safety net for a payload
 *      shaped differently from what capture mapped.
 *   6. `Bez tytułu`. Honest, and still better than a blank row.
 */

import type { CaptureInput, Reel } from '../../../../packages/contracts/src/index.js';

/** Enough for the row, which ellipsises anyway; the cap keeps absurd input out of the DOM. */
export const MAX_LABEL_LENGTH = 80;

/** Shown only when the capture yields nothing at all — which validation should prevent. */
export const UNTITLED_LABEL = 'Bez tytułu';

export interface ReelLabel {
  text: string;
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
export function urlLabel(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return tidy(raw);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return tidy(raw);
  const host = parsed.host.replace(/^www\./i, '');
  const path = parsed.pathname.replace(/\/+$/, '');
  return tidy(host + path);
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

/** Derive a label from a capture alone. Exported for the capture-time preview and the tests. */
export function captureLabel(input: CaptureInput): string {
  const words = firstLine(input.text ?? '') ?? firstLine(input.additionalText ?? '');
  if (words !== undefined) return isBareUrl(words) ? urlLabel(words) : tidy(words);

  if (input.url !== undefined && input.url.trim() !== '') return urlLabel(input.url);

  const named = input.images.find((image) => image.fileName.trim() !== '');
  if (named !== undefined) return tidy(named.fileName);
  if (input.images.length > 0) return imageCountLabel(input.images.length);

  for (const field of input.originalShare?.fields ?? []) {
    if (field.value.trim() === '') continue;
    return isBareUrl(field.value) ? urlLabel(field.value) : tidy(field.value);
  }

  return UNTITLED_LABEL;
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
 */
export function reelLabel(reel: Pick<Reel, 'title' | 'originalInput'>): ReelLabel {
  if (reel.title.trim() !== '') return { text: reel.title, derived: false };
  return { text: captureLabel(reel.originalInput), derived: true };
}

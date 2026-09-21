/**
 * Text normalization and document assembly (corpus specification §3, §4).
 *
 * Normalization happens once, here, at ingestion. What this module returns is what is
 * stored, indexed, cited and displayed; nothing normalizes again at query or render time,
 * because a second pass is how an excerpt stops matching the chunk it claims to quote.
 *
 * The permitted operations are exactly the ones §3 lists, and no others. In particular
 * nothing here corrects spelling or diacritics, reflows list items, or touches the wording
 * — a source typo stays a source typo, and is quoted as one.
 *
 * Page boundaries are joined with a single space rather than a newline so that a passage
 * which genuinely runs across a page break still matches as one contiguous string. The
 * per-page offset ranges are kept beside the text, which is what lets a chunk state every
 * physical page its own characters touch.
 */

import { createHash } from 'node:crypto';

import type { PdfPageText } from './pdf-text.js';

/** Ligatures PDF extraction produces. Expanded because they are typography, not spelling. */
const LIGATURES: Array<[RegExp, string]> = [
  [/ﬀ/g, 'ff'], [/ﬁ/g, 'fi'], [/ﬂ/g, 'fl'], [/ﬃ/g, 'ffi'], [/ﬄ/g, 'ffl'],
  [/ﬅ/g, 'st'], [/ﬆ/g, 'st'],
];

/** Whitespace forms that collapse to a plain space. Includes NBSP and the narrow spaces. */
const SPACE_LIKE = /[\t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;

/** Hyphen forms a PDF may use at a line-wrap: ASCII hyphen, soft hyphen, Unicode hyphens. */
const HYPHEN_CHARS = '\\u002d\\u00ad\\u2010\\u2011';
/**
 * A hyphen directly attached to a letter or digit, with nothing between them — the shape of
 * a genuine word-wrap break (`agencj-`, `35-`). A hyphen used as standalone punctuation
 * (` - `, a dash with a space on each side) never matches this, because the character right
 * before it is a space, not a letter or digit — so a line ending in "... hodowli -" is left
 * to join with a space, exactly as before, rather than swallowing the dash.
 */
const ENDS_WITH_ATTACHED_HYPHEN = new RegExp(`[\\p{L}\\p{N}][${HYPHEN_CHARS}]$`, 'u');
const ENDS_WITH_DIGIT_HYPHEN = new RegExp(`\\p{N}[${HYPHEN_CHARS}]$`, 'u');
const STARTS_WITH_LETTER = /^\p{L}/u;

export interface NormalizationProfile {
  id: string;
  /**
   * Operator-declared quotation/dash mapping. Empty by default, which means the source's
   * own forms are kept — §3 permits normalizing them only to forms the source uses, so
   * inventing a mapping without the operator saying so would be a silent rewrite.
   */
  punctuationMap: Record<string, string>;
}

export const DEFAULT_NORMALIZATION_PROFILE: NormalizationProfile = {
  id: 'szronox-normalization-1',
  punctuationMap: {},
};

function applyPunctuation(text: string, profile: NormalizationProfile): string {
  const entries = Object.entries(profile.punctuationMap);
  if (entries.length === 0) return text;
  let out = '';
  for (const character of text) {
    const mapped = entries.find(([from]) => from === character);
    out += mapped ? mapped[1] : character;
  }
  return out;
}

/**
 * Normalize one already-extracted passage: a page, or an operator-supplied quotation.
 *
 * Both sides of every verbatim comparison go through this function, so a passage matches
 * its source when — and only when — the characters genuinely agree.
 */
export function normalizePassage(raw: string, profile = DEFAULT_NORMALIZATION_PROFILE): string {
  let text = raw.normalize('NFC');
  for (const [pattern, replacement] of LIGATURES) text = text.replace(pattern, replacement);
  text = applyPunctuation(text, profile);
  text = text.replace(/\r\n?/g, '\n');
  // Join words hyphenated across an embedded line break, before line breaks become spaces.
  // (The PDF page-assembly path below splits page text into lines before this function ever
  // sees them, so this handles an operator-supplied passage that itself contains a literal
  // line break — the PDF-side case is `joinHyphenatedLines`.)
  text = text.replace(new RegExp(`(\\p{L})[${HYPHEN_CHARS}]\\n(\\p{L})`, 'gu'), '$1$2');
  // A hyphen after a digit (e.g. "35-krotności") is part of the token, not an inserted
  // word-wrap hyphen, so the line break is removed but the hyphen itself is kept.
  text = text.replace(new RegExp(`(\\p{N})[${HYPHEN_CHARS}]\\n(\\p{L})`, 'gu'), '$1-$2');
  text = text.replace(/\n/g, ' ');
  text = text.replace(SPACE_LIKE, ' ');
  text = text.replace(/ {2,}/g, ' ');
  return text.trim();
}

/** Keywords receive NFC, trimming, collapse and de-duplication — and nothing else. */
export function normalizeKeywords(raw: readonly string[]): { normalized: string[]; raw: string[] } {
  const normalized: string[] = [];
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const value = entry.normalize('NFC').replace(SPACE_LIKE, ' ').replace(/\s+/g, ' ').trim();
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
    kept.push(entry);
  }
  return { normalized, raw: kept };
}

/**
 * Join a page's already-normalized lines into one string.
 *
 * The PDF text stream gives each visual line as its own entry (`page.text.split('\n')`,
 * each normalized separately before this runs), so a word hyphenated across a line break
 * arrives here as two already-separate strings — the first ending in a hyphen, the second
 * starting with the resumed word — never as one string with an embedded `\n`. A blind
 * space-join between every pair of lines is right for two real sentences and wrong for a
 * mid-word break: it strands the hyphen with a trailing space and breaks the verbatim match
 * against the source dataset's un-wrapped text. So each join point is checked: a line ending
 * in a hyphen preceded by a letter joins directly with the next, and the hyphen — an
 * artefact of the line wrap, not part of the word — is dropped; a hyphen preceded by a digit
 * (e.g. "35-" before "krotności") is part of the token and is kept; anything else joins with
 * a single space, as before.
 */
export function joinHyphenatedLines(lines: readonly string[]): string {
  let body = '';
  for (const line of lines) {
    if (body === '' || line === '') { body += line; continue; }
    if (STARTS_WITH_LETTER.test(line) && ENDS_WITH_ATTACHED_HYPHEN.test(body)) {
      body = ENDS_WITH_DIGIT_HYPHEN.test(body) ? `${body}${line}` : `${body.slice(0, -1)}${line}`;
      continue;
    }
    body += ` ${line}`;
  }
  return body;
}

export interface PageSpan {
  pdfPage: number;
  /** Half-open range into the normalized document text, UTF-16 code units. */
  start: number;
  end: number;
  undecodedCount: number;
}

export interface NormalizedDocument {
  text: string;
  pages: PageSpan[];
  sha256: string;
  /** Lines removed because the operator declared them running heads, feet or page numbers. */
  droppedLines: Array<{ pdfPage: number; line: string; rule: 'declared_line' | 'printed_page_label' }>;
}

export interface HeaderFooterRules {
  /** Exact normalized lines to drop wherever they appear. Every entry must match somewhere. */
  dropExactLines: string[];
  /** Drop a line whose whole content is that page's printed label, or its physical number. */
  dropPrintedPageLabelLines: boolean;
}

export const NO_HEADER_FOOTER_RULES: HeaderFooterRules = {
  dropExactLines: [],
  dropPrintedPageLabelLines: false,
};

/**
 * Assemble the normalized document text from extracted pages.
 *
 * Running heads, feet and page numbers are excluded from indexed text (§2.6), but only
 * where the operator declared them: an automatic "this line repeats, drop it" rule would
 * silently delete a genuine recurring heading. A declared line that never matches is
 * reported by the caller as a stale declaration rather than ignored.
 */
export function assembleDocument(
  pages: readonly PdfPageText[],
  options: {
    profile?: NormalizationProfile;
    headerFooter?: HeaderFooterRules;
    printedPageLabels?: readonly string[];
  } = {},
): NormalizedDocument {
  const profile = options.profile ?? DEFAULT_NORMALIZATION_PROFILE;
  const rules = options.headerFooter ?? NO_HEADER_FOOTER_RULES;
  const dropped: NormalizedDocument['droppedLines'] = [];
  const spans: PageSpan[] = [];
  let text = '';

  for (const page of pages) {
    const label = options.printedPageLabels?.[page.pdfPage - 1] ?? '';
    const kept: string[] = [];
    for (const line of page.text.split('\n')) {
      const normalizedLine = normalizePassage(line, profile);
      if (normalizedLine === '') continue;
      if (rules.dropExactLines.includes(normalizedLine)) {
        dropped.push({ pdfPage: page.pdfPage, line: normalizedLine, rule: 'declared_line' });
        continue;
      }
      if (rules.dropPrintedPageLabelLines
        && (normalizedLine === label.trim() || normalizedLine === String(page.pdfPage))
        && normalizedLine !== '') {
        dropped.push({ pdfPage: page.pdfPage, line: normalizedLine, rule: 'printed_page_label' });
        continue;
      }
      kept.push(normalizedLine);
    }
    const body = joinHyphenatedLines(kept).replace(/ {2,}/g, ' ').trim();
    if (text !== '' && body !== '') text += ' ';
    const start = text.length;
    text += body;
    spans.push({ pdfPage: page.pdfPage, start, end: text.length, undecodedCount: page.undecodedCount });
  }

  return {
    text,
    pages: spans,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    droppedLines: dropped,
  };
}

/** Every physical page a half-open character range touches, ascending. */
export function pagesForRange(spans: readonly PageSpan[], start: number, end: number): number[] {
  const pages: number[] = [];
  for (const span of spans) {
    if (span.start < end && start < span.end && span.end > span.start) pages.push(span.pdfPage);
  }
  // A range that falls entirely inside the single space between two pages belongs to the
  // page it starts after; an empty result would otherwise claim no page at all.
  if (pages.length === 0) {
    const owner = [...spans].reverse().find((span) => span.start <= start);
    if (owner) pages.push(owner.pdfPage);
  }
  return pages;
}

/** Printed labels for the given physical pages, same order and length (§4). */
export function printedLabelsFor(pages: readonly number[], labels: readonly string[]): string[] {
  return pages.map((page) => labels[page - 1] ?? '');
}

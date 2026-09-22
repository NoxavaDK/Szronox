/**
 * Chunk generation (corpus specification §2.6).
 *
 * A chunk is the only unit whose text may be quoted as evidence, so chunks are produced
 * by the server from the normalized document text and the proposal spans located in it —
 * never supplied by an operator spreadsheet and never authored by a model. Two properties
 * follow, and both are what make a citation checkable:
 *
 *   - a chunk's text is literally `document.slice(charStart, charEnd)`, so an excerpt that
 *     claims to quote it can be verified by arithmetic;
 *   - a chunk never crosses a proposal boundary, so a citation's proposal, section and
 *     pages are unambiguous.
 *
 * Sentences are never cut. A sentence longer than the upper bound becomes an oversized
 * chunk of its own, which is the honest outcome: truncating it would quote half a claim.
 */

export interface ChunkingParameters {
  /** Preferred chunk size in normalized characters. */
  targetChars: number;
  /** Upper bound, except for a single sentence that exceeds it on its own. */
  maxChars: number;
  /** A chunk below this size is only produced when the proposal itself is that short. */
  minChars: number;
  /** Fixed per release. `none` is the default; one sentence of overlap is the alternative. */
  overlap: 'none' | 'one_sentence';
}

export const DEFAULT_CHUNKING: ChunkingParameters = {
  targetChars: 700,
  maxChars: 900,
  minChars: 400,
  overlap: 'none',
};

export interface GeneratedChunk {
  /** Half-open range into the normalized document text, UTF-16 code units. */
  charStart: number;
  charEnd: number;
  text: string;
}

/**
 * Sentence boundaries, deterministically.
 *
 * A boundary is a terminator followed by a space and the start of something new: an
 * upper-case letter, a digit, a bullet or an opening quotation mark. The rule deliberately
 * does not know about abbreviations — an abbreviation that ends up splitting a chunk costs
 * nothing, because both halves are still exact contiguous text, while a cleverer rule that
 * differed between runs would change chunk identifiers for the same source.
 */
export function sentenceStarts(text: string): number[] {
  const starts = [0];
  const pattern = /[.!?…][)”"»']*\s+/gu;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const next = match.index + match[0].length;
    if (next >= text.length) break;
    const character = text[next];
    if (/[\p{Lu}\p{N}•●◦„“"«(]/u.test(character)) starts.push(next);
  }
  // Bullets are their own boundaries even without a terminator: a list item is a unit.
  const bullets = /(?<=\s)[•●◦▪–-]\s+(?=\p{L})/gu;
  for (let match = bullets.exec(text); match !== null; match = bullets.exec(text)) {
    starts.push(match.index);
  }
  return [...new Set(starts)].sort((left, right) => left - right);
}

/**
 * Split one proposal span into chunks.
 *
 * `start` and `end` are offsets into `document`; the returned ranges are absolute offsets
 * into the same string, so a chunk can be re-read from the archived source by position.
 */
export function chunkProposal(
  document: string,
  start: number,
  end: number,
  parameters: ChunkingParameters = DEFAULT_CHUNKING,
): GeneratedChunk[] {
  const body = document.slice(start, end);
  if (body.trim() === '') return [];
  const starts = sentenceStarts(body);
  const sentences = starts.map((from, index) => ({
    from,
    to: index + 1 < starts.length ? starts[index + 1] : body.length,
  }));

  const chunks: GeneratedChunk[] = [];
  let openIndex = 0;

  const close = (from: number, to: number): void => {
    const slice = body.slice(from, to);
    const leading = slice.length - slice.replace(/^\s+/, '').length;
    const text = slice.trim();
    if (text === '') return;
    chunks.push({
      charStart: start + from + leading,
      charEnd: start + from + leading + text.length,
      text,
    });
  };

  for (let index = 0; index < sentences.length; index += 1) {
    const from = sentences[openIndex].from;
    const currentLength = sentences[index].to - from;
    const isLast = index === sentences.length - 1;
    const nextLength = isLast ? currentLength : sentences[index + 1].to - from;
    // Close on the last sentence, when the next one would overshoot the upper bound, or
    // once the target size is reached. A single oversized sentence closes as itself.
    if (!isLast && nextLength <= parameters.maxChars && currentLength < parameters.targetChars) continue;
    close(from, sentences[index].to);
    // One sentence of overlap is permitted and fixed per release; repeating the sentence
    // that just closed a chunk must still advance, or a one-sentence chunk would not end.
    openIndex = parameters.overlap === 'one_sentence' && index > openIndex ? index : index + 1;
  }

  // A trailing chunk shorter than the minimum is merged back when doing so stays within
  // the upper bound; otherwise a short final sentence would become a chunk of its own.
  if (chunks.length >= 2 && parameters.overlap === 'none') {
    const last = chunks[chunks.length - 1];
    const previous = chunks[chunks.length - 2];
    if (last.charEnd - last.charStart < parameters.minChars
      && last.charEnd - previous.charStart <= parameters.maxChars) {
      chunks.splice(chunks.length - 2, 2, {
        charStart: previous.charStart,
        charEnd: last.charEnd,
        text: document.slice(previous.charStart, last.charEnd),
      });
    }
  }
  return chunks;
}

/** A rough token count, recorded as an ingestion diagnostic only. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

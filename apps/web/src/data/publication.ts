export function composePublicationText(description: string, source: string, hashtags: string): string {
  return [description, source, hashtags].filter((part) => part !== '').join('\n\n');
}

/**
 * STREAM-01 D7/T00 "Copy composition": the unique non-empty `source.sourceLine` values of a
 * stream's topics, in topic order, joined by exactly one newline. Nothing is trimmed or
 * rewritten; exact duplicates (byte-for-byte) are removed, keeping the first occurrence's
 * position.
 */
export function composeStreamSourceSection(sourceLines: readonly string[]): string {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const line of sourceLines) {
    if (line === '' || seen.has(line)) continue;
    seen.add(line);
    unique.push(line);
  }
  return unique.join('\n');
}

/**
 * A stream's `Kopiuj opis`: Opis, then the joined topic source lines (`composeStreamSourceSection`),
 * then Hashtagi — joined by exactly two newlines, empty sections skipped. The stream's own
 * `publicationSource` is never used (T00). Reel composition (`composePublicationText`) is
 * unaffected by this function.
 */
export function composeStreamPublicationText(description: string, sourceLines: readonly string[], hashtags: string): string {
  return composePublicationText(description, composeStreamSourceSection(sourceLines), hashtags);
}

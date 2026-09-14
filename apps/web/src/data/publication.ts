export function composePublicationText(description: string, hashtags: string): string {
  if (description && hashtags) return `${description}\n\n${hashtags}`;
  return description || hashtags;
}

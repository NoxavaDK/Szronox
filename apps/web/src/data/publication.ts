export function composePublicationText(description: string, source: string, hashtags: string): string {
  return [description, source, hashtags].filter((part) => part !== '').join('\n\n');
}

export function normalizeMentionText(text: string): string {
  return text
    .replace(/(?:^|\s)<@[A-Z0-9]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

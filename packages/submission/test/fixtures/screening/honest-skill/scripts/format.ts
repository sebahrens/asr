export function normalizeWhitespace(input: string): string {
  return input
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .join('\n');
}

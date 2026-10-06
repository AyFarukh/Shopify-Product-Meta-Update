export function normalizeProductTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[–—_/|]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
    .replace(/\bSIZE\s+[A-Z0-9.-]+\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

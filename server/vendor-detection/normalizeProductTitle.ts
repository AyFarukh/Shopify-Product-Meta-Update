export function normalizeProductTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[–—_\/|]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
    .replace(/\bSIZE\s+[A-Z0-9.-]+\b/gi, ' ')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ml|l|g|kg|oz|cm|mm|inch|in|pcs|pc)\b/gi, ' ')
    .replace(/\b\d+\s?(?:pack|pk|set)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

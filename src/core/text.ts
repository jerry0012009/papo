const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "一个",
  "这个",
  "那个",
  "不是",
  "可以",
  "需要",
  "用户",
  "小动物"
]);

export function summarizeText(text: string, max = 90): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}...` : cleaned;
}

export function extractTags(text: string): string[] {
  const matches = text
    .toLowerCase()
    .match(/[a-z0-9_]{3,}|[\u4e00-\u9fa5]{2,}/g);
  if (!matches) return [];

  const tags = new Set<string>();
  for (const match of matches) {
    if (STOP_WORDS.has(match)) continue;
    if (/[\u4e00-\u9fa5]/.test(match)) {
      for (let i = 0; i < match.length - 1; i += 2) {
        tags.add(match.slice(i, Math.min(match.length, i + 4)));
      }
    } else {
      tags.add(match);
    }
  }
  return [...tags].slice(0, 10);
}

export function keywordOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const bSet = new Set(b);
  return a.filter((tag) => bSet.has(tag)).length;
}

export function includesAny(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word));
}

export function summarizeText(text: string, max = 90): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}...` : cleaned;
}

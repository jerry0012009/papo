export function audioObservationPreview(text: string) {
  const cleaned = text
    .replace(/\*\*/g, "")
    .replace(/^(?:麦克风|听到的声音|语音片段|录音|声音)\s*\d*\s*[：:]\s*/, "")
    .replace(/^生活观察\s*[：:]\s*/, "")
    .replace(/^(?:音频|这段音频|这段声音)(?:中|里)?[，,:：\s]*/, "")
    .replace(/说话者/g, "你")
    .replace(/用户/g, "你")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "这段声音里有一些现场线索。";

  const firstSentence = cleaned
    .split(/(?<=[。！？!?])\s*/)
    .map((part) => part.trim())
    .find(Boolean);
  const quote = cleaned.match(/[“"]([^”"]{2,44})[”"]/);
  const base = firstSentence && firstSentence.length <= 88 ? firstSentence : quote ? `你说了“${quote[1]}”` : cleaned;
  return `这段声音里，${compactPreviewText(base, 76)}`;
}

export function compactPreviewText(text: string, limit: number) {
  const compact = text.replace(/[。！？!?]+$/, "").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

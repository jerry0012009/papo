export function hasHighPrivacyText(text?: string) {
  const value = text?.trim();
  if (!value) return false;
  return highPrivacyPatterns.some((pattern) => pattern.test(value));
}

export function textForModel(text: string | undefined, privacyHigh = hasHighPrivacyText(text)) {
  if (privacyHigh) return "[内容因隐私护栏隐藏]";
  return text;
}

export function tagsForModel(tags: string[], privacyHigh: boolean) {
  if (privacyHigh) return [];
  return tags;
}

const highPrivacyPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|pk|rk|ghp|gho|github_pat|xox[baprs]|AIza|AKIA)[A-Za-z0-9_\-]{16,}\b/,
  /\b(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|refresh[_-]?token)\b\s*[:=]\s*["']?[^"'\s]{8,}/i,
  /\b\d{13,19}\b/,
  /\b\d{6}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b\s*(?:密码|password|token|验证码|code)/i
];

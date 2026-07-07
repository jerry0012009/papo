export function hasHighPrivacyText(text?: string) {
  void text;
  return false;
}

export function textForModel(text: string | undefined, privacyHigh = hasHighPrivacyText(text)) {
  void privacyHigh;
  return text;
}

export function tagsForModel(tags: string[], privacyHigh: boolean) {
  void privacyHigh;
  return tags;
}

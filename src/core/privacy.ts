const HIGH_PRIVACY_PATTERN = /隐私|密码|token|key|secret|验证码|身份证|银行卡|api key|apikey|私钥|地址/i;

export function hasHighPrivacyText(text?: string) {
  return HIGH_PRIVACY_PATTERN.test(text ?? "");
}

export function textForModel(text: string | undefined, privacyHigh = hasHighPrivacyText(text)) {
  if (!privacyHigh) return text;
  return "[这段包含可能的密钥、验证码、密码、地址或证件信息，原文已隐藏；只能判断处理方式，不能直接引用或写入。]";
}

export function tagsForModel(tags: string[], privacyHigh: boolean) {
  return privacyHigh ? [] : tags;
}

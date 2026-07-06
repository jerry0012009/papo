import type { CreatureProfile, FeedbackKind, FeedbackPolicyProfile } from "./types";

export function clampPolicy(policy: FeedbackPolicyProfile): FeedbackPolicyProfile {
  return {
    preferDepth: clamp(policy.preferDepth),
    preferProactivity: clamp(policy.preferProactivity),
    privacySensitivity: clamp(policy.privacySensitivity),
    saveThreshold: clamp(policy.saveThreshold),
    askThreshold: clamp(policy.askThreshold),
    recallTendency: clamp(policy.recallTendency),
    quietTendency: clamp(policy.quietTendency)
  };
}

export function updatePolicyFromFeedback(profile: CreatureProfile, kind: FeedbackKind, tags: string[] = []) {
  const policy = profile.policyProfile;
  switch (kind) {
    case "continue":
      policy.preferDepth += 8;
      policy.preferProactivity += 4;
      policy.recallTendency += 8;
      policy.quietTendency -= 3;
      break;
    case "not_now":
      policy.preferProactivity -= 8;
      policy.quietTendency += 9;
      policy.askThreshold += 5;
      break;
    case "remember":
      policy.saveThreshold -= 6;
      policy.recallTendency += 4;
      break;
    case "forget":
      policy.privacySensitivity += 10;
      policy.saveThreshold += 8;
      policy.askThreshold -= 4;
      break;
    case "understood":
      policy.preferDepth += 3;
      policy.recallTendency += 3;
      break;
  }

  profile.policyProfile = clampPolicy(policy);
  return explainPolicyShift(profile.policyProfile, kind, tags);
}

export function describeStateInfluence(profile: CreatureProfile) {
  const parts: string[] = [];
  if (profile.state.curiosity > 70) parts.push("好奇心高，提高新主题和提问倾向");
  if (profile.state.attachment > 65) parts.push("依恋度高，更容易联想到旧记忆");
  if (profile.state.energy < 35) parts.push("精力低，减少注意数量并偏向安静");
  if (profile.state.safety > 70 || profile.policyProfile.privacySensitivity > 70) parts.push("安全/隐私敏感度高，保存前更倾向询问");
  if (profile.policyProfile.preferDepth > 65) parts.push("用户反馈让它更愿意深入展开");
  if (profile.policyProfile.quietTendency > 60) parts.push("用户反馈让它更克制");
  return parts.length ? parts.join("；") : "当前状态稳定，使用基础注意预算。";
}

function explainPolicyShift(policy: FeedbackPolicyProfile, kind: FeedbackKind, tags: string[]) {
  const tagText = tags.length ? `相关主题：${tags.slice(0, 4).join("、")}。` : "";
  switch (kind) {
    case "continue":
      return `${tagText}策略改变：更愿意继续想、回忆旧主题和展开推理。`;
    case "not_now":
      return `${tagText}策略改变：降低主动性，提高安静倾向。`;
    case "remember":
      return `${tagText}策略改变：类似内容更容易建议长期保存。`;
    case "forget":
      return `${tagText}策略改变：类似内容更谨慎，保存阈值提高。`;
    case "understood":
      return `${tagText}策略改变：增强当前理解模式的自信。`;
  }
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}


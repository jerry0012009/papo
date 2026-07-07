import type { CreatureProfile, FeedbackPolicyProfile } from "./types";

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

export function describeStateInfluence(profile: CreatureProfile) {
  const parts: string[] = [];
  if (profile.state.curiosity > 70) parts.push("好奇心高，提高新主题和提问倾向");
  if (profile.state.attachment > 65) parts.push("依恋度高，更容易想起以前的小事");
  if (profile.state.energy < 35) parts.push("精力低，减少注意数量并偏向安静");
  if (profile.state.safety > 70 || profile.policyProfile.privacySensitivity > 70) parts.push("安全/隐私敏感度高，保存前更倾向询问");
  if (profile.policyProfile.preferDepth > 65) parts.push("你把我教得更愿意多想一会儿");
  if (profile.policyProfile.quietTendency > 60) parts.push("你把我教得更克制");
  return parts.length ? parts.join("；") : "当前状态稳定，使用基础注意预算。";
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

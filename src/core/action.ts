import type { ActionDecision, ActionKind, AttentionEvent, CreatureProfile, SegmentScore } from "./types";

export interface ActionSelectionInput {
  profile: CreatureProfile;
  source: AttentionEvent["source"];
  text: string;
  attentionStrength: number;
  privacyRisk: number;
  relatedMemoryIds: string[];
  score?: SegmentScore;
  llmSuggestedAction?: ActionKind;
}

export function selectAction(input: ActionSelectionInput): ActionDecision {
  const blockedActions: ActionDecision["blockedActions"] = [];
  const safetyNotes: string[] = [];
  const trace: string[] = [];
  const policy = input.profile.policyProfile;
  let action = baselineAction(input);
  let confidence = 58;

  trace.push(`baseline=${action}`);

  if (input.privacyRisk + policy.privacySensitivity * 0.35 > 72 && /长期|记住|保存|提醒|deadline|下次|未来/.test(input.text)) {
    blockedActions.push({ action: "save_long_term", reason: "文本带有保存/未来意图，但隐私风险高" });
    safetyNotes.push("高隐私内容需要用户确认是否保留。");
  }

  if (input.llmSuggestedAction) {
    trace.push(`llm_suggested=${input.llmSuggestedAction}`);
    action = input.llmSuggestedAction;
    confidence += 5;
  }

  if (input.profile.state.energy < 28 && action !== "quiet") {
    blockedActions.push({ action, reason: "energy 低，不能展开太多行动" });
    action = action === "respond" && input.attentionStrength > 55 ? "respond" : input.attentionStrength > 70 ? "observe" : "quiet";
    safetyNotes.push("精力低时保留情景，不强行展开。");
  }

  if (input.privacyRisk + policy.privacySensitivity * 0.35 > 72 && (action === "save_long_term" || action === "save_episode" || action === "draft_reminder")) {
    blockedActions.push({ action, reason: "隐私风险高，不能自动保存或生成提醒" });
    action = "ask";
    safetyNotes.push("高隐私内容需要用户确认是否保留。");
  }

  if (policy.quietTendency > 65 && input.source === "curious_stream" && action === "ask") {
    blockedActions.push({ action, reason: "用户反馈让它在信息流里更克制" });
    action = "observe";
  }

  if (!input.llmSuggestedAction && input.relatedMemoryIds.length && policy.recallTendency > 62 && input.privacyRisk < 60 && input.profile.state.energy > 32) {
    action = "recall";
    confidence += 10;
    trace.push("policy_recall_boost");
  }

  if (!input.llmSuggestedAction && (input.score?.futureValue ?? 0) >= 16 && input.privacyRisk < 55 && input.profile.state.energy > 35) {
    action = /问题|question|清单/.test(input.text) ? "draft_question_list" : "draft_reminder";
    confidence += 8;
    trace.push("future_value_action");
  }

  if (policy.quietTendency > 55 && ["ask", "review", "draft_reminder", "draft_question_list"].includes(action)) {
    blockedActions.push({ action, reason: "用户反馈让它更克制，不能每次都主动展开" });
    action = input.attentionStrength > 70 ? "observe" : "quiet";
    trace.push("policy_quiet_restraint");
  }

  if (input.profile.state.safety > 75 && input.privacyRisk > 35 && action !== "ask") {
    blockedActions.push({ action, reason: "安全感处于谨慎状态，保存或展开前先问" });
    action = "ask";
  }

  confidence += input.relatedMemoryIds.length * 4;
  confidence += input.attentionStrength > 75 ? 8 : 0;
  confidence -= blockedActions.length * 5;
  confidence = Math.max(30, Math.min(96, Math.round(confidence)));

  return {
    action,
    confidence,
    reason: explainAction(action, input),
    blockedActions,
    safetyNotes,
    llmSuggestedAction: input.llmSuggestedAction,
    ruleTrace: trace
  };
}

export function guardActionDecision(event: AttentionEvent, profile: CreatureProfile, llmSuggestedAction?: ActionKind) {
  return selectAction({
    profile,
    source: event.source,
    text: event.triggerContent,
    attentionStrength: event.attentionStrength,
    privacyRisk: event.privacyRisk,
    relatedMemoryIds: event.relatedMemoryIds,
    score: event.scoreBreakdown,
    llmSuggestedAction
  });
}

function baselineAction(input: ActionSelectionInput): ActionKind {
  if (input.privacyRisk > 65) return "ask";
  if (input.profile.state.energy < 25) return "quiet";
  if (input.relatedMemoryIds.length > 0 && input.attentionStrength > 60) return "recall";
  if (/复盘|总结|review/.test(input.text)) return "review";
  if (/提醒|deadline|下次|未来|明天|本周/.test(input.text)) return "draft_reminder";
  if (input.attentionStrength >= input.profile.policyProfile.saveThreshold) return "save_episode";
  if (input.profile.state.curiosity > 72 && input.profile.policyProfile.preferProactivity > 40) return "ask";
  return "observe";
}

function explainAction(action: ActionKind, input: ActionSelectionInput) {
  switch (action) {
    case "respond":
      return "用户在直接呼唤我或要求我说话，当前最自然的行动是回应，而不是只分析或保存。";
    case "ask":
      return "这段需要用户确认，尤其是隐私、情绪或保存意图还不够明确。";
    case "save_episode":
      return "注意强度足够高，适合先写入情景记忆。";
    case "save_long_term":
      return "这段未来价值高且风险低，可以建议巩固为长期记忆。";
    case "recall":
      return "当前片段和旧记忆共振，适合把过去经历带回工作区。";
    case "review":
      return "用户像是在整理判断，适合生成复盘。";
    case "quiet":
      return "当前精力或反馈策略更适合短回应和安静陪伴。";
    case "draft_reminder":
      return "这段有未来行动价值，适合生成提醒草稿而不是直接执行。";
    case "draft_question_list":
      return "这段像一个待拆解的问题，适合生成问题清单草稿。";
    default:
      return "先观察，不急着保存或打扰用户。";
  }
}

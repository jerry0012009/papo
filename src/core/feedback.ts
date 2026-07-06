import { makeId } from "./ids";
import { updatePolicyFromFeedback } from "./drive";
import { createLearningNote } from "./experience";
import { adjustMemoryWeight, createMemoryCandidateFromEpisode, forgetMemory, promoteEpisode } from "./memory";
import { applyStateDelta, deltaForFeedback } from "./state";
import { extractTags, summarizeText } from "./text";
import type { CreatureProfile, CreatureState, FeedbackKind, FeedbackPolicyProfile, FeedbackRecord, LongTermMemory, SegmentKind } from "./types";

export function applyFeedback(
  profile: CreatureProfile,
  input: { kind: FeedbackKind; targetId?: string; content?: string; modality?: SegmentKind | "button"; now?: string }
): FeedbackRecord {
  const now = input.now ?? new Date().toISOString();
  const inputText = input.content?.trim();
  const targetEpisode = profile.episodes.find((item) => item.id === input.targetId);
  const targetLongTerm = profile.longTermMemories.find((item) => item.id === input.targetId);
  const tags = targetEpisode?.tags ?? targetLongTerm?.tags ?? [];
  const stateBefore = structuredClone(profile.state);
  const policyBefore = structuredClone(profile.policyProfile);
  const learningNote = createLearningNote(input.kind, tags, inputText);
  const effect = `${effectText(input.kind)} ${updatePolicyFromFeedback(profile, input.kind, tags)}`;
  const record: FeedbackRecord = {
    id: makeId("feedback"),
    at: now,
    kind: input.kind,
    targetId: input.targetId,
    inputText,
    inputModality: input.modality ?? (inputText ? "text" : "button"),
    effect,
    learningNote,
    memoryCandidateIds: []
  };

  profile.feedbackHistory.unshift(record);
  profile.feedbackHistory = profile.feedbackHistory.slice(0, 60);

  if (targetEpisode) targetEpisode.feedback.push(input.kind);

  const stateChange = applyStateDelta(profile, deltaForFeedback(input.kind), effect, now);
  record.stateDeltas = stateDeltas(stateBefore, stateChange.after);
  record.policyDeltas = policyDeltas(policyBefore, profile.policyProfile);

  if (input.kind === "remember" && input.targetId) {
    const memory = promoteEpisode(profile, input.targetId, now);
    if (memory && inputText && !hasPrivacyRisk(inputText)) {
      memory.text = `${memory.text} 用户确认时补充：${summarizeText(inputText, 120)}`;
      memory.tags = unique([...memory.tags, ...extractTags(inputText)]);
    }
  }
  const forgetResult = input.kind === "forget" ? forgetMemory(profile, input.targetId) : undefined;
  if (input.kind === "understood") adjustMemoryWeight(profile, input.targetId, 8);
  if (input.kind === "continue") {
    adjustMemoryWeight(profile, input.targetId, 12);
    if (targetEpisode) {
      const candidate = createMemoryCandidateFromEpisode(profile, targetEpisode, { feedback: "continue", now });
      if (inputText && !hasPrivacyRisk(inputText)) {
        candidate.candidateText = `用户反馈这段时补充：${summarizeText(inputText, 140)}。这应该和原来的片段一起理解。`;
        candidate.tags = unique([...candidate.tags, ...extractTags(inputText)]);
      }
      record.memoryCandidateIds?.push(candidate.id);
    }
  }
  if (input.kind === "not_now") adjustMemoryWeight(profile, input.targetId, -8);
  if (input.kind === "forget" && forgetResult?.changed && !forgetResult.purged) createSafetyMemoryFromForget(profile, targetEpisode, targetLongTerm, now);

  record.responseAction = selectFeedbackResponseAction(input.kind, inputText);
  record.followUpText = createFeedbackFollowUp(record.responseAction, input.kind, inputText);
  record.replyText = composeFeedbackReplyText(record);

  return record;
}

export function composeFeedbackReplyText(feedback: FeedbackRecord) {
  return [feedback.learningNote, feedback.followUpText].filter(Boolean).join("\n");
}

function stateDeltas(before: CreatureState, after: CreatureState): FeedbackRecord["stateDeltas"] {
  return (["curiosity", "attachment", "energy", "arousal", "safety", "confidence"] as const)
    .map((key) => ({ key, before: before[key], after: after[key], delta: after[key] - before[key] }))
    .filter((item) => item.delta !== 0);
}

function policyDeltas(before: FeedbackPolicyProfile, after: FeedbackPolicyProfile): FeedbackRecord["policyDeltas"] {
  return (["preferDepth", "preferProactivity", "privacySensitivity", "saveThreshold", "askThreshold", "recallTendency", "quietTendency"] as const)
    .map((key) => ({ key, before: before[key], after: after[key], delta: after[key] - before[key] }))
    .filter((item) => item.delta !== 0);
}

function effectText(kind: FeedbackKind): string {
  switch (kind) {
    case "understood":
      return "用户说我理解对了，所以我的表达自信和依恋度上升。";
    case "continue":
      return "用户让我继续想，所以我以后会更愿意展开关联和推理。";
    case "not_now":
      return "用户说这次不用，所以我会降低打扰感，变得更克制。";
    case "remember":
      return "用户让我记住，所以这段情景会升成长记忆。";
    case "forget":
      return "用户让我忘掉，所以我会删除或降权相关记忆，并提高隐私警觉。";
  }
}

function selectFeedbackResponseAction(kind: FeedbackKind, inputText?: string) {
  if (kind === "not_now" || kind === "forget") return "quiet";
  if (kind === "remember") return "note_memory";
  if (kind === "continue" && inputText && inputText.length >= 8) return "ask_follow_up";
  if (kind === "continue") return "note_memory";
  return "acknowledge";
}

function createFeedbackFollowUp(action: NonNullable<FeedbackRecord["responseAction"]>, kind: FeedbackKind, inputText?: string) {
  if (action === "ask_follow_up") {
    return "我还想轻轻问一句：这段里你最希望我以后先注意哪一部分？";
  }
  if (action === "note_memory") {
    if (kind === "remember") {
      return inputText?.trim()
        ? "我会把你补充的这点和原来的小片段放在一起，让这条记忆更稳。"
        : "我会把这次确认放进那段经历里，让它以后更容易被我想起。";
    }
    return inputText?.trim()
      ? "我会把你补充的这点和原来的小片段放在一起，先当成候选记忆守着。"
      : "我会把这次确认放进那段经历里，让它以后更容易被我想起。";
  }
  if (action === "quiet") {
    return kind === "forget"
      ? "我会把声音收小一点，之后遇到类似内容先问你，不自己抢着记。"
      : "我会按你的意思安静一点，不继续追着这段打扰你。";
  }
  return undefined;
}

function hasPrivacyRisk(text: string) {
  return /隐私|密码|token|key|secret|验证码|身份证|银行卡|地址/i.test(text);
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function createSafetyMemoryFromForget(
  profile: CreatureProfile,
  episode: CreatureProfile["episodes"][number] | undefined,
  memory: LongTermMemory | undefined,
  now: string
) {
  const text = episode?.inputSummary ?? memory?.text;
  if (!text) return;
  profile.longTermMemories.unshift({
    id: makeId("ltm"),
    createdAt: now,
    kind: "safety_rule",
    text: `用户让我忘掉类似内容。以后遇到相关主题时，我应该先问，不要直接保存：${text.slice(0, 80)}`,
    weight: 70,
    tags: episode?.tags ?? memory?.tags ?? [],
    consolidatedBecause: "forget feedback 转化为隐私/克制规则。"
  });
}

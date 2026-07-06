import { makeId } from "./ids";
import { updatePolicyFromFeedback } from "./drive";
import { createLearningNote } from "./experience";
import { adjustMemoryWeight, createMemoryCandidateFromEpisode, forgetMemory, promoteEpisode } from "./memory";
import { applyStateDelta, deltaForFeedback } from "./state";
import type { CreatureProfile, FeedbackKind, FeedbackRecord, LongTermMemory } from "./types";

export function applyFeedback(
  profile: CreatureProfile,
  input: { kind: FeedbackKind; targetId?: string; now?: string }
): FeedbackRecord {
  const now = input.now ?? new Date().toISOString();
  const targetEpisode = profile.episodes.find((item) => item.id === input.targetId);
  const targetLongTerm = profile.longTermMemories.find((item) => item.id === input.targetId);
  const tags = targetEpisode?.tags ?? targetLongTerm?.tags ?? [];
  const learningNote = createLearningNote(input.kind, tags);
  const effect = `${effectText(input.kind)} ${updatePolicyFromFeedback(profile, input.kind, tags)}`;
  const record: FeedbackRecord = {
    id: makeId("feedback"),
    at: now,
    kind: input.kind,
    targetId: input.targetId,
    effect,
    learningNote
  };

  profile.feedbackHistory.unshift(record);
  profile.feedbackHistory = profile.feedbackHistory.slice(0, 60);

  if (targetEpisode) targetEpisode.feedback.push(input.kind);

  applyStateDelta(profile, deltaForFeedback(input.kind), effect, now);

  if (input.kind === "remember" && input.targetId) promoteEpisode(profile, input.targetId, now);
  if (input.kind === "forget") forgetMemory(profile, input.targetId);
  if (input.kind === "understood") adjustMemoryWeight(profile, input.targetId, 8);
  if (input.kind === "continue") {
    adjustMemoryWeight(profile, input.targetId, 12);
    if (targetEpisode) createMemoryCandidateFromEpisode(profile, targetEpisode, { feedback: "continue", now });
  }
  if (input.kind === "not_now") adjustMemoryWeight(profile, input.targetId, -8);
  if (input.kind === "forget") createSafetyMemoryFromForget(profile, targetEpisode, targetLongTerm, now);

  return record;
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

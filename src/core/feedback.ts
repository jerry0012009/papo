import { makeId } from "./ids";
import { adjustMemoryWeight, forgetMemory, promoteEpisode } from "./memory";
import { applyStateDelta, deltaForFeedback } from "./state";
import type { CreatureProfile, FeedbackKind, FeedbackRecord } from "./types";

export function applyFeedback(
  profile: CreatureProfile,
  input: { kind: FeedbackKind; targetId?: string; now?: string }
): FeedbackRecord {
  const now = input.now ?? new Date().toISOString();
  const effect = effectText(input.kind);
  const record: FeedbackRecord = {
    id: makeId("feedback"),
    at: now,
    kind: input.kind,
    targetId: input.targetId,
    effect
  };

  profile.feedbackHistory.unshift(record);
  profile.feedbackHistory = profile.feedbackHistory.slice(0, 60);

  const episode = profile.episodes.find((item) => item.id === input.targetId);
  if (episode) episode.feedback.push(input.kind);

  applyStateDelta(profile, deltaForFeedback(input.kind), effect, now);

  if (input.kind === "remember" && input.targetId) promoteEpisode(profile, input.targetId, now);
  if (input.kind === "forget") forgetMemory(profile, input.targetId);
  if (input.kind === "understood") adjustMemoryWeight(profile, input.targetId, 8);
  if (input.kind === "continue") adjustMemoryWeight(profile, input.targetId, 12);
  if (input.kind === "not_now") adjustMemoryWeight(profile, input.targetId, -8);

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

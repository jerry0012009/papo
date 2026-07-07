import { z } from "zod";
import { composeFeedbackReplyText } from "./feedback";
import { modelConversationContext, modelMemoryItem } from "./model-context";
import { hasHighPrivacyText, tagsForModel, textForModel } from "./privacy";
import type { ModelProvider } from "./provider";
import type { CreatureProfile, FeedbackRecord, LongTermMemory } from "./types";

const requiredText = (min: number, max: number) =>
  z.preprocess((value) => (typeof value === "string" ? value.trim() : value), z.string().min(min).max(max));
const optionalText = (max: number) =>
  z.preprocess((value) => cleanOptionalText(value, max), z.string().min(1).optional());
const optionalTextArray = (maxItems: number, maxText: number) =>
  z
    .array(z.preprocess((value) => cleanOptionalText(value, maxText), z.string().optional()))
    .transform((values) => values.filter((value): value is string => Boolean(value)))
    .pipe(z.array(z.string().min(1).max(maxText)).max(maxItems))
    .optional();

function cleanOptionalText(value: unknown, max: number) {
  if (value === null) return undefined;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

const feedbackNarrationSchema = z.object({
  learningNote: requiredText(8, 260),
  followUpText: optionalText(180),
  trace: optionalTextArray(5, 120)
});

const memoryCorrectionNarrationSchema = z.object({
  replyText: requiredText(8, 260),
  trace: optionalTextArray(5, 120)
});

export async function enrichFeedbackNarration(
  profile: CreatureProfile,
  feedback: FeedbackRecord,
  provider: ModelProvider
): Promise<FeedbackRecord> {
  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for feedback narration.");
  const targetEpisode = profile.episodes.find((episode) => episode.id === feedback.targetId);
  const targetMemory = profile.longTermMemories.find((memory) => memory.id === feedback.targetId);
  const feedbackPrivacyHigh = hasHighPrivacyText(`${feedback.inputText ?? ""} ${feedback.effect} ${feedback.learningNote} ${feedback.followUpText ?? ""}`);
  const targetPrivacyHigh = hasHighPrivacyText(
    `${targetEpisode?.inputSummary ?? ""} ${targetEpisode?.noticed ?? ""} ${targetEpisode?.tags.join(" ") ?? ""} ${targetMemory?.text ?? ""} ${targetMemory?.tags.join(" ") ?? ""}`
  );

  const raw = await provider.generateJson<unknown>(
    `请把这条反馈学习结果改写成更像 Papo 自己学到了一点东西的短句。

约束：
- 只改写 learningNote，不要改变状态、policy、记忆或动作。
- 如果 ruleFollowUpText 存在，可以改写 followUpText；不要新增规则没有给出的追问或行动。
- 不要提数据库、字段、开发过程、投资人、harness、GitHub、nginx。
- 语气要像一个弱小但认真学习的陪伴生物，不要像客服或产品说明。
- 必须以“我学到”开头。
- learningNote 120 字以内，followUpText 80 字以内。

返回严格 JSON：
{"learningNote":"...","followUpText":"...","trace":["..."]}

feedback:
${JSON.stringify({
  kind: feedback.kind,
  inputText: textForModel(feedback.inputText, feedbackPrivacyHigh),
  inputModality: feedback.inputModality,
  effect: textForModel(feedback.effect, feedbackPrivacyHigh),
  responseAction: feedback.responseAction,
  ruleLearningNote: textForModel(feedback.learningNote, feedbackPrivacyHigh),
  ruleFollowUpText: textForModel(feedback.followUpText, feedbackPrivacyHigh),
  contentHiddenForPrivacy: feedbackPrivacyHigh,
  memoryCandidateIds: feedback.memoryCandidateIds
})}

target_episode_or_memory:
${JSON.stringify(
  targetEpisode
    ? {
        type: "episode",
        inputSummary: textForModel(targetEpisode.inputSummary, targetPrivacyHigh),
        noticed: textForModel(targetEpisode.noticed, targetPrivacyHigh),
        tags: tagsForModel(targetEpisode.tags, targetPrivacyHigh),
        contentHiddenForPrivacy: targetPrivacyHigh
      }
    : targetMemory
      ? {
          type: "long_term_memory",
          text: textForModel(targetMemory.text, targetPrivacyHigh),
          tags: tagsForModel(targetMemory.tags, targetPrivacyHigh),
          contentHiddenForPrivacy: targetPrivacyHigh
        }
      : { type: "none" }
)}

current_state:
${JSON.stringify(profile.state)}
`
  );
  const parsed = feedbackNarrationSchema.safeParse(raw);
  if (!parsed.success || !isSafeCreatureText(parsed.data.learningNote) || !parsed.data.learningNote.startsWith("我学到")) {
    throw new Error("invalid feedback narration");
  }
  if (parsed.data.followUpText && (!feedback.followUpText || !isSafeCreatureText(parsed.data.followUpText))) {
    throw new Error("invalid feedback follow-up narration");
  }
  feedback.learningNote = parsed.data.learningNote;
  if (parsed.data.followUpText && feedback.followUpText) feedback.followUpText = parsed.data.followUpText;
  feedback.replyText = composeFeedbackReplyText(feedback);
  return feedback;
}

export async function narrateMemoryCorrection(
  profile: CreatureProfile,
  input: { memory: LongTermMemory; previousText: string; correctedText: string },
  provider: ModelProvider
) {
  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for memory correction narration.");
  const privacyHigh = hasHighPrivacyText(`${input.previousText} ${input.correctedText} ${input.memory.tags.join(" ")}`);
  const raw = await provider.generateJson<unknown>(
    `请作为 Papo，回应用户刚刚帮你改准了一条记忆这件事。

约束：
- 只生成 Papo 对用户说的一句短回复。
- 你可以承认自己刚才记得不够准，并说明之后会按用户改准的版本想起。

返回严格 JSON：
{"replyText":"...","trace":["..."]}

memory_after_correction:
${JSON.stringify(modelMemoryItem(input.memory, true))}

correction:
${JSON.stringify({
  previousText: textForModel(input.previousText, privacyHigh),
  correctedText: textForModel(input.correctedText, privacyHigh),
  contentHiddenForPrivacy: privacyHigh
})}

recent_conversation_newest_first:
${JSON.stringify(modelConversationContext(profile, 8))}
`
  );
  const parsed = memoryCorrectionNarrationSchema.safeParse(raw);
  if (!parsed.success || !isSafeCreatureText(parsed.data.replyText)) {
    throw new Error("invalid memory correction narration");
  }
  return parsed.data.replyText;
}

function isSafeCreatureText(text: string) {
  return Boolean(text.trim());
}

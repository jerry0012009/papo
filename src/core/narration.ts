import { z } from "zod";
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

const memoryCorrectionNarrationSchema = z.object({
  replyText: requiredText(8, 260),
  trace: optionalTextArray(5, 120)
});

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

import { z } from "zod";
import { composeFeedbackReplyText } from "./feedback";
import { modelConversationContext, modelMemoryItem } from "./model-context";
import { normalizeSharedMemoryText } from "./memory";
import { hasHighPrivacyText, tagsForModel, textForModel } from "./privacy";
import type { ModelProvider } from "./provider";
import type { CreatureProfile, EmergenceRecord, FeedbackRecord, LongTermMemory } from "./types";

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

const emergenceNarrationSchema = z.object({
  message: requiredText(16, 460),
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

export async function enrichEmergenceNarration(
  profile: CreatureProfile,
  emergence: EmergenceRecord & { text?: string; memoryId?: string },
  provider: ModelProvider
): Promise<EmergenceRecord & { text: string; memoryId?: string }> {
  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for emergence narration.");
  const memory = emergence.relatedMemoryIds[0]
    ? profile.longTermMemories.find((item) => item.id === emergence.relatedMemoryIds[0])
    : undefined;
  if (!memory) return withText(emergence);
  const memoryPrivacyHigh = hasHighPrivacyText(`${memory.text} ${memory.tags.join(" ")}`);
  const emergencePrivacyHigh = hasHighPrivacyText(`${emergence.whyNow} ${emergence.message}`);

  const feedbackSelfMemory = memory.kind === "creature_self_memory" && memory.tags.includes("被你养成");
  const narrationTarget = feedbackSelfMemory
    ? "请把这条主动浮现改写成 Papo 想起你教过它的回应习惯或边界感，不要写成普通旧事件。"
    : "请把这条主动浮现改写得更像 Papo 自己突然想起了一段真实共同经历。";
  const raw = await provider.generateJson<unknown>(
    `${narrationTarget}

约束：
- 只改写 message，不要改变 state、driveSource、relatedMemoryIds、memoryId 或任何记忆内容。
- 必须解释为什么这时想起，以及它接下来会怎样听/靠近新的片段。
- 如果有 related memory，必须引用这条真实记忆里的具体内容，不要编造新事实。
- 如果 related memory 是“被你养成”的自我记忆，只能写成被你教出来的习惯、听法或边界感，不能写成普通旧事。
- 不要提数据库、字段、开发过程、投资人、harness、GitHub、nginx。
- 不要写成提醒事项，不要使用“我浮现的是”“不是提醒”“内在倾向”“下一次你给我信息流”“不装作”“装成”。
- 220 字以内。

返回严格 JSON：
{"message":"...","trace":["..."]}

emergence_rule_record:
${JSON.stringify({
  kind: emergence.kind,
  whyNow: textForModel(emergence.whyNow, emergencePrivacyHigh),
  driveSource: emergence.driveSource,
  ruleMessage: textForModel(emergence.message, emergencePrivacyHigh),
  contentHiddenForPrivacy: emergencePrivacyHigh,
  relatedMemoryIds: emergence.relatedMemoryIds
})}

related_memory:
${JSON.stringify(memory ? {
  id: memory.id,
  kind: memory.kind,
  text: textForModel(normalizeSharedMemoryText(memory.text), memoryPrivacyHigh),
  tags: tagsForModel(memory.tags, memoryPrivacyHigh),
  contentHiddenForPrivacy: memoryPrivacyHigh
} : null)}

current_state:
${JSON.stringify(profile.state)}
`
  );
  const parsed = emergenceNarrationSchema.safeParse(raw);
  if (!parsed.success || !isSafeCreatureText(parsed.data.message) || hasTemplatedEmergenceText(parsed.data.message)) {
    throw new Error("invalid emergence narration");
  }
  if (memory && !referencesMemory(parsed.data.message, memory)) throw new Error("emergence narration did not reference selected memory");

  emergence.message = parsed.data.message;
  emergence.text = parsed.data.message;
  const historyRecord = profile.emergenceHistory.find((item) => item.id === emergence.id);
  if (historyRecord) {
    historyRecord.message = parsed.data.message;
    historyRecord.ruleTrace = [...historyRecord.ruleTrace, "llm: emergence narration enriched"];
  }
  emergence.ruleTrace = [...emergence.ruleTrace, "llm: emergence narration enriched"];
  return withText(emergence);
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
- 只生成 Papo 对用户说的一句短回复，不要输出内部过程。
- 你可以承认自己刚才记得不够准，并说明之后会按用户改准的版本想起。
- 如果 contentHiddenForPrivacy=true，不要复述具体内容，只说会按刚改准的版本处理。
- 不要提数据库、字段、开发过程、harness、prompt、语义、后台、流程、长期记忆、写入。
- 不要说“用户希望”“用户说”，要用“你/我”的自然对话。

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

function withText<T extends EmergenceRecord & { text?: string; memoryId?: string }>(emergence: T): T & { text: string; memoryId?: string } {
  emergence.text = emergence.message;
  emergence.memoryId = emergence.relatedMemoryIds[0];
  return emergence as T & { text: string; memoryId?: string };
}

function isSafeCreatureText(text: string) {
  if (hasHighPrivacyText(text)) return false;
  return !/(投资人|开发|harness|GitHub|nginx|prompt|数据库字段|字段|用户|小动物|语义|系统|后台|流程|candidate|episode|score|阈值|写入|长期记忆|情景记忆)/i.test(text);
}

function hasTemplatedEmergenceText(text: string) {
  return /(我浮现的是|不是提醒|内在倾向|下一次你给我信息流|新的信息流|不装作|装成)/.test(text);
}

function referencesMemory(message: string, memory: LongTermMemory) {
  const anchors = extractAnchors(memory);
  let hits = 0;
  for (const anchor of anchors) {
    if (message.includes(anchor)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

function extractAnchors(memory: LongTermMemory) {
  const stop = new Set(["用户", "这个", "那个", "一次", "以后", "应该", "不要", "直接", "保存", "记忆", "注意", "反馈", "内容"]);
  const anchors = new Set<string>();
  for (const tag of memory.tags) {
    if (tag.length >= 2 && !stop.has(tag) && !hasHighPrivacyText(tag)) anchors.add(tag);
  }
  const chunks = memory.text.match(/[\p{Script=Han}A-Za-z0-9]{2,}/gu) ?? [];
  for (const chunk of chunks) {
    if (chunk.length <= 8 && !stop.has(chunk)) anchors.add(chunk);
    for (let index = 0; index < chunk.length - 1; index += 1) {
      const pair = chunk.slice(index, index + 2);
      if (!stop.has(pair)) anchors.add(pair);
    }
  }
  return [...anchors].slice(0, 80);
}

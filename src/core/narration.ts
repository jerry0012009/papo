import { z } from "zod";
import { composeFeedbackReplyText } from "./feedback";
import type { ModelProvider } from "./provider";
import type { CreatureProfile, EmergenceRecord, FeedbackRecord, LongTermMemory } from "./types";

const feedbackNarrationSchema = z.object({
  learningNote: z.string().min(8).max(260),
  followUpText: z.string().min(4).max(180).optional(),
  trace: z.array(z.string().min(1).max(120)).max(5).optional()
});

const emergenceNarrationSchema = z.object({
  message: z.string().min(16).max(460),
  trace: z.array(z.string().min(1).max(120)).max(5).optional()
});

export async function enrichFeedbackNarration(
  profile: CreatureProfile,
  feedback: FeedbackRecord,
  provider: ModelProvider
): Promise<FeedbackRecord> {
  if (!provider.usesRealModel) return feedback;
  const targetEpisode = profile.episodes.find((episode) => episode.id === feedback.targetId);
  const targetMemory = profile.longTermMemories.find((memory) => memory.id === feedback.targetId);

  try {
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
  inputText: feedback.inputText,
  inputModality: feedback.inputModality,
  effect: feedback.effect,
  responseAction: feedback.responseAction,
  ruleLearningNote: feedback.learningNote,
  ruleFollowUpText: feedback.followUpText,
  memoryCandidateIds: feedback.memoryCandidateIds
})}

target_episode_or_memory:
${JSON.stringify(
  targetEpisode
    ? { type: "episode", inputSummary: targetEpisode.inputSummary, noticed: targetEpisode.noticed, tags: targetEpisode.tags }
    : targetMemory
      ? { type: "long_term_memory", text: targetMemory.text, tags: targetMemory.tags }
      : { type: "none" }
)}

current_state:
${JSON.stringify(profile.state)}
`
    );
    const parsed = feedbackNarrationSchema.safeParse(raw);
    if (!parsed.success || !isSafeCreatureText(parsed.data.learningNote) || !parsed.data.learningNote.startsWith("我学到")) {
      return feedback;
    }
    if (parsed.data.followUpText && (!feedback.followUpText || !isSafeCreatureText(parsed.data.followUpText))) {
      return feedback;
    }
    feedback.learningNote = parsed.data.learningNote;
    if (parsed.data.followUpText && feedback.followUpText) feedback.followUpText = parsed.data.followUpText;
    feedback.replyText = composeFeedbackReplyText(feedback);
    return feedback;
  } catch {
    return feedback;
  }
}

export async function enrichEmergenceNarration(
  profile: CreatureProfile,
  emergence: EmergenceRecord & { text?: string; memoryId?: string },
  provider: ModelProvider
): Promise<EmergenceRecord & { text: string; memoryId?: string }> {
  if (!provider.usesRealModel) return withText(emergence);
  const memory = emergence.relatedMemoryIds[0]
    ? profile.longTermMemories.find((item) => item.id === emergence.relatedMemoryIds[0])
    : undefined;
  if (!memory) return withText(emergence);

  try {
    const raw = await provider.generateJson<unknown>(
      `请把这条主动浮现改写得更像 Papo 自己突然想起了一段真实共同经历。

约束：
- 只改写 message，不要改变 state、driveSource、relatedMemoryIds、memoryId 或任何记忆内容。
- 必须解释为什么现在浮现，以及下一次它会带着什么倾向去注意。
- 如果有 related memory，必须引用这条真实记忆里的具体内容，不要编造新事实。
- 不要提数据库、字段、开发过程、投资人、harness、GitHub、nginx。
- 不要写成提醒事项，不要使用“我浮现的是”。
- 220 字以内。

返回严格 JSON：
{"message":"...","trace":["..."]}

emergence_rule_record:
${JSON.stringify({
  kind: emergence.kind,
  whyNow: emergence.whyNow,
  driveSource: emergence.driveSource,
  ruleMessage: emergence.message,
  relatedMemoryIds: emergence.relatedMemoryIds
})}

related_memory:
${JSON.stringify(memory ? { id: memory.id, kind: memory.kind, text: memory.text, tags: memory.tags } : null)}

current_state:
${JSON.stringify(profile.state)}
`
    );
    const parsed = emergenceNarrationSchema.safeParse(raw);
    if (!parsed.success || !isSafeCreatureText(parsed.data.message) || parsed.data.message.includes("我浮现的是")) {
      return withText(emergence);
    }
    if (memory && !referencesMemory(parsed.data.message, memory)) return withText(emergence);

    emergence.message = parsed.data.message;
    emergence.text = parsed.data.message;
    const historyRecord = profile.emergenceHistory.find((item) => item.id === emergence.id);
    if (historyRecord) {
      historyRecord.message = parsed.data.message;
      historyRecord.ruleTrace = [...historyRecord.ruleTrace, "llm: emergence narration enriched"];
    }
    emergence.ruleTrace = [...emergence.ruleTrace, "llm: emergence narration enriched"];
    return withText(emergence);
  } catch {
    return withText(emergence);
  }
}

function withText<T extends EmergenceRecord & { text?: string; memoryId?: string }>(emergence: T): T & { text: string; memoryId?: string } {
  emergence.text = emergence.message;
  emergence.memoryId = emergence.relatedMemoryIds[0];
  return emergence as T & { text: string; memoryId?: string };
}

function isSafeCreatureText(text: string) {
  return !/(投资人|开发|harness|GitHub|nginx|prompt|数据库字段|字段)/i.test(text);
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
    if (tag.length >= 2 && !stop.has(tag)) anchors.add(tag);
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

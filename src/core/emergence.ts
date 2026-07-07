import { z } from "zod";
import { makeId } from "./ids";
import { modelConversationContext, modelFeedbackContext } from "./model-context";
import { toCreatureMemoryVoice } from "./memory";
import { hasHighPrivacyText, tagsForModel, textForModel } from "./privacy";
import type { ModelProvider } from "./provider";
import type { CreatureProfile, EmergenceRecord, LongTermMemory } from "./types";

const optionalText = (max: number) =>
  z.preprocess((value) => cleanOptionalText(value, max), z.string().min(1).optional());

function cleanOptionalText(value: unknown, max: number) {
  if (value === null) return undefined;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

const semanticEmergenceSchema = z
  .object({
    shouldEmerge: z.boolean(),
    memoryId: optionalText(120),
    driveSource: z.enum(["curiosity", "attachment", "safety", "rhythm", "memory_resonance"]).optional(),
    whyNow: optionalText(320),
    message: optionalText(520),
    proactiveLevel: z.enum(["quiet", "gentle", "active"]).optional(),
    trace: z.array(z.string().min(1).max(160)).max(8).optional()
  })
  .refine((value) => !value.shouldEmerge || Boolean(value.memoryId && value.driveSource && value.whyNow && value.message), {
    message: "emergence requires memoryId, driveSource, whyNow, and message"
  });

type SemanticEmergenceSuggestion = z.infer<typeof semanticEmergenceSchema>;

export async function semanticDecideEmergence(profile: CreatureProfile, provider: ModelProvider, now = new Date().toISOString()): Promise<EmergenceRecord & { text: string; memoryId?: string }> {
  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for emergence.");

  const raw = await provider.generateJson<unknown>(buildSemanticEmergencePrompt(profile, now));
  if (!raw) throw new Error("empty emergence model result");
  const parsed = semanticEmergenceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid emergence JSON (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  }

  if (!parsed.data.shouldEmerge) {
    recordEmergenceSemanticRun(profile, provider, "applied", "llm emergence chose quiet");
    return {
      id: makeId("emergence"),
      at: now,
      kind: "rhythm",
      whyNow: safeCreatureText(parsed.data.whyNow) ?? "",
      relatedMemoryIds: [],
      driveSource: parsed.data.driveSource ?? "rhythm",
      message: "",
      text: "",
      ruleTrace: ["llm: chose quiet emergence", "guardrail: memory=none"]
    };
  }

  const semantic = createSemanticEmergenceRecord(profile, parsed.data, now);
  if (!semantic) {
    throw new Error("emergence model selected unavailable memory or unsafe message");
  }
  profile.emergenceHistory.unshift(semantic);
  profile.emergenceHistory = profile.emergenceHistory.slice(0, 30);
  const memory = semantic.relatedMemoryIds[0] ? profile.longTermMemories.find((item) => item.id === semantic.relatedMemoryIds[0]) : undefined;
  if (memory) memory.lastReferencedAt = now;
  recordEmergenceSemanticRun(profile, provider, "applied", "llm emergence decision applied");
  return { ...semantic, text: semantic.message, memoryId: semantic.relatedMemoryIds[0] };
}

function availableMemories(profile: CreatureProfile) {
  return [...profile.longTermMemories].filter((memory) => memory.weight > 0);
}

function sharedMemories(profile: CreatureProfile) {
  return availableMemories(profile).filter((memory) => memory.kind !== "creature_self_memory" || Boolean(memory.sourceEpisodeId));
}

function isFeedbackSelfMemory(memory: LongTermMemory) {
  return memory.kind === "creature_self_memory" && memory.tags.includes("被你养成");
}

function createSemanticEmergenceRecord(
  profile: CreatureProfile,
  suggestion: SemanticEmergenceSuggestion,
  now: string
): EmergenceRecord | undefined {
  const memory = suggestion.memoryId ? availableSemanticMemories(profile).find((item) => item.id === suggestion.memoryId) : undefined;
  if (!memory) return undefined;
  const message = safeCreatureText(suggestion.message);
  const whyNow = safeCreatureText(suggestion.whyNow);
  if (!message || !whyNow || !referencesMemory(message, memory)) return undefined;

  return {
    id: makeId("emergence"),
    at: now,
    kind: suggestion.driveSource === "memory_resonance" ? "memory_resonance" : suggestion.driveSource === "rhythm" ? "rhythm" : "drive_based",
    whyNow,
    relatedMemoryIds: [memory.id],
    driveSource: suggestion.driveSource ?? "curiosity",
    message,
    ruleTrace: [
      "llm: selected active emergence",
      `memory=${memory.id}`,
      `drive=${suggestion.driveSource ?? "curiosity"}`,
      `proactive=${suggestion.proactiveLevel ?? "gentle"}`
    ]
  };
}

function availableSemanticMemories(profile: CreatureProfile) {
  return sharedMemories(profile);
}

function safeCreatureText(text?: string) {
  const normalized = toCreatureMemoryVoice(text?.trim() ?? "");
  if (!normalized) return undefined;
  return normalized;
}

function referencesMemory(message: string, memory: LongTermMemory) {
  const anchors = memoryAnchors(memory);
  let hits = 0;
  for (const anchor of anchors) {
    if (message.includes(anchor)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

function memoryAnchors(memory: LongTermMemory) {
  const stop = new Set(["用户", "这个", "那个", "一次", "以后", "应该", "不要", "直接", "保存", "记忆", "注意", "反馈", "内容"]);
  const anchors = new Set<string>();
  for (const tag of memory.tags) {
    if (tag.length >= 2 && !stop.has(tag)) anchors.add(tag);
  }
  const chunks = toCreatureMemoryVoice(memory.text).match(/[\p{Script=Han}A-Za-z0-9]{2,}/gu) ?? [];
  for (const chunk of chunks) {
    if (chunk.length <= 8 && !stop.has(chunk)) anchors.add(chunk);
    for (let index = 0; index < chunk.length - 1; index += 1) {
      const pair = chunk.slice(index, index + 2);
      if (!stop.has(pair)) anchors.add(pair);
    }
  }
  return [...anchors].slice(0, 80);
}

function recordEmergenceSemanticRun(
  profile: CreatureProfile,
  provider: ModelProvider,
  status: "skipped" | "applied" | "empty" | "invalid" | "failed",
  message: string
) {
  profile.semanticBrainHistory.unshift({
    id: makeId("semantic"),
    at: new Date().toISOString(),
    source: "emergence",
    providerKind: provider.kind,
    providerName: provider.name,
    status,
    message,
    ruleTrace: [`provider=${provider.kind}`, "source=emergence", `status=${status}`]
  });
  profile.semanticBrainHistory = profile.semanticBrainHistory.slice(0, 30);
}

function buildSemanticEmergencePrompt(profile: CreatureProfile, now: string) {
  return `请作为 Papo 的主动浮现大脑，决定此刻 Papo 要不要主动想起一件事。

系统提供可用记忆、最近互动和当前状态。你负责判断：
- 现在要不要浮现。
- 如果要，选择哪一条 memoryId。
- 为什么此刻想起它。
- 这是 curiosity、attachment、safety、rhythm 还是 memory_resonance。
- Papo 应该说什么，主动程度是 quiet/gentle/active。

护栏会校验：
- memoryId 必须来自 candidate_memories。
- 不能引用 weight<=0 或不存在的记忆。
- message 必须引用被选记忆里的具体内容，不能编造。
- 普通用户只看到 Papo 的行为和话，不看规则解释。

返回严格 JSON：
{
  "shouldEmerge": true,
  "memoryId": "ltm_xxx",
  "driveSource": "curiosity",
  "whyNow": "...",
  "message": "...",
  "proactiveLevel": "gentle",
  "trace": ["..."]
}

如果不该浮现，返回：
{"shouldEmerge": false, "driveSource": "rhythm", "whyNow": "...", "message": "...", "proactiveLevel": "quiet"}

now:
${now}

current_state:
${JSON.stringify(profile.state)}

current_policy:
${JSON.stringify(profile.policyProfile)}

recent_episodes:
${JSON.stringify(profile.episodes.slice(0, 6).map((item) => {
  const privacyHigh = hasHighPrivacyText(`${item.inputSummary} ${item.noticed} ${item.creatureResponse}`);
  return {
    id: item.id,
    inputSummary: textForModel(item.inputSummary, privacyHigh),
    creatureResponse: textForModel(item.creatureResponse, privacyHigh),
    tags: tagsForModel(item.tags, privacyHigh),
    weight: item.weight,
    contentHiddenForPrivacy: privacyHigh
  };
}))}

recent_feedback:
${JSON.stringify(modelFeedbackContext(profile.feedbackHistory))}

recent_conversation_newest_first:
${JSON.stringify(modelConversationContext(profile))}

recent_emergence:
${JSON.stringify(profile.emergenceHistory.slice(0, 5).map((item) => {
  const privacyHigh = hasHighPrivacyText(`${item.whyNow} ${item.message}`);
  return {
    at: item.at,
    driveSource: item.driveSource,
    relatedMemoryIds: item.relatedMemoryIds,
    message: textForModel(item.message, privacyHigh),
    contentHiddenForPrivacy: privacyHigh
  };
}))}

candidate_memories:
${JSON.stringify(availableSemanticMemories(profile).slice(0, 12).map((memory) => ({
  id: memory.id,
  kind: memory.kind,
    text: textForModel(toCreatureMemoryVoice(memory.text), false),
    weight: memory.weight,
    tags: tagsForModel(memory.tags, false),
  lastReferencedAt: memory.lastReferencedAt,
  sourceEpisodeId: memory.sourceEpisodeId
})))}
`;
}

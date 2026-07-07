import { z } from "zod";
import { makeId } from "./ids";
import { modelConversationContext, modelFeedbackContext } from "./model-context";
import { toCreatureMemoryVoice } from "./memory";
import { hasHighPrivacyText, tagsForModel, textForModel } from "./privacy";
import type { ModelProvider } from "./provider";
import type { CreatureProfile, EmergenceRecord } from "./types";

const EMERGENCE_COOLDOWN_MINUTES = 10;
const MINUTE_MS = 60_000;

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

  const cooldown = emergenceCooldown(profile, now);
  const raw = await provider.generateJson<unknown>(buildSemanticEmergencePrompt(profile, now, cooldown));
  if (!raw) throw new Error("empty emergence model result");
  const parsed = semanticEmergenceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid emergence JSON (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  }

  if (cooldown.active && parsed.data.shouldEmerge) {
    recordEmergenceSemanticRun(profile, provider, "applied", "llm emergence blocked by cooldown");
    return quietEmergence(now, parsed.data, [
      "llm: selected active emergence",
      `guardrail: cooldown_active minutes_since_last=${cooldown.minutesSinceLast}`,
      `guardrail: cooldown_remaining=${cooldown.remainingMinutes}`
    ]);
  }

  if (!parsed.data.shouldEmerge) {
    recordEmergenceSemanticRun(profile, provider, "applied", "llm emergence chose quiet");
    return quietEmergence(now, parsed.data, [
      "llm: chose quiet emergence",
      cooldown.active ? `guardrail: cooldown_active minutes_since_last=${cooldown.minutesSinceLast}` : "guardrail: cooldown_clear",
      "guardrail: memory=none"
    ]);
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

function quietEmergence(now: string, suggestion: SemanticEmergenceSuggestion, ruleTrace: string[]): EmergenceRecord & { text: string; memoryId?: string } {
  return {
    id: makeId("emergence"),
    at: now,
    kind: "rhythm",
    whyNow: safeCreatureText(suggestion.whyNow) ?? "",
    relatedMemoryIds: [],
    driveSource: suggestion.driveSource ?? "rhythm",
    proactiveLevel: suggestion.proactiveLevel ?? "quiet",
    message: "",
    text: "",
    ruleTrace
  };
}

function emergenceCooldown(profile: CreatureProfile, now: string) {
  const lastActive = profile.emergenceHistory.find((item) => item.message.trim());
  if (!lastActive) return { active: false, minutesSinceLast: undefined, remainingMinutes: 0 };
  const elapsedMs = Date.parse(now) - Date.parse(lastActive.at);
  if (!Number.isFinite(elapsedMs)) return { active: false, minutesSinceLast: undefined, remainingMinutes: 0 };
  const minutesSinceLast = Math.max(0, Math.floor(elapsedMs / MINUTE_MS));
  const remainingMinutes = Math.max(0, EMERGENCE_COOLDOWN_MINUTES - minutesSinceLast);
  return {
    active: remainingMinutes > 0,
    minutesSinceLast,
    remainingMinutes
  };
}

function availableMemories(profile: CreatureProfile) {
  return [...profile.longTermMemories].filter((memory) => memory.weight > 0);
}

function sharedMemories(profile: CreatureProfile) {
  return availableMemories(profile).filter((memory) => memory.kind !== "creature_self_memory" || Boolean(memory.sourceEpisodeId));
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
  if (!message || !whyNow) return undefined;

  return {
    id: makeId("emergence"),
    at: now,
    kind: suggestion.driveSource === "memory_resonance" ? "memory_resonance" : suggestion.driveSource === "rhythm" ? "rhythm" : "drive_based",
    whyNow,
    relatedMemoryIds: [memory.id],
    driveSource: suggestion.driveSource ?? "curiosity",
    proactiveLevel: suggestion.proactiveLevel ?? "gentle",
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
    stage: "emergence",
    providerKind: provider.kind,
    providerName: provider.name,
    model: provider.diagnostics?.textModel,
    status,
    message,
    ruleTrace: [`provider=${provider.kind}`, "source=emergence", `status=${status}`]
  });
  profile.semanticBrainHistory = profile.semanticBrainHistory.slice(0, 30);
}

function buildSemanticEmergencePrompt(profile: CreatureProfile, now: string, cooldown: ReturnType<typeof emergenceCooldown>) {
  const candidateMemories = availableSemanticMemories(profile).slice(0, 12);
  if (cooldown.active) {
    return `请作为 Papo 的主动浮现大脑，判断此刻是否要主动浮现。

结构护栏显示：Papo 刚刚主动浮现过，仍在冷却中。
minutes_since_last_active_emergence: ${cooldown.minutesSinceLast}
cooldown_remaining_minutes: ${cooldown.remainingMinutes}

为了避免过度打扰用户，你必须返回 shouldEmerge=false。仍然需要用中文简短说明为什么此刻保持安静。
你必须返回一个 JSON object，不要输出解释性文字、Markdown 或空内容。
JSON 字段名保持示例格式；枚举字段值必须使用示例里的英文原文，不要翻译。只有 whyNow/message/trace 等自然语言字段值使用中文。

返回格式：
{"shouldEmerge": false, "driveSource": "rhythm", "whyNow": "刚刚已经主动提起过一件事，现在保持安静更自然", "message": "", "proactiveLevel": "quiet"}

now:
${now}

current_state:
${JSON.stringify(profile.state)}

recent_emergence:
${JSON.stringify(profile.emergenceHistory.slice(0, 5).map((item) => ({
  at: item.at,
  driveSource: item.driveSource,
  relatedMemoryIds: item.relatedMemoryIds
})))}
`;
  }
  if (!candidateMemories.length) {
    return `请作为 Papo 的主动浮现大脑，判断此刻是否要主动浮现。

candidate_memories 为空，所以没有任何可合法提起的长期记忆。
你必须返回一个 JSON object，不要输出解释性文字、Markdown 或空内容。
JSON 字段名保持示例格式；枚举字段值必须使用示例里的英文原文，不要翻译。只有 whyNow/message/trace 等自然语言字段值使用中文。
因为没有可用记忆，必须返回 shouldEmerge=false。

返回格式：
{"shouldEmerge": false, "driveSource": "rhythm", "whyNow": "没有可用的长期记忆适合主动提起", "message": "", "proactiveLevel": "quiet"}

now:
${now}

current_state:
${JSON.stringify(profile.state)}
`;
  }

  return `请作为 Papo 的主动浮现大脑，决定此刻 Papo 要不要主动想起一件事。

系统提供可用记忆、最近互动和当前状态。你负责判断：
- 现在要不要浮现。
- 如果要，选择哪一条 memoryId。
- 为什么此刻想起它。
- 这是 curiosity、attachment、safety、rhythm 还是 memory_resonance。
- Papo 应该说什么，主动程度是 quiet/gentle/active。

你必须返回一个 JSON object，不要输出解释性文字、Markdown 或空内容。
JSON 字段名保持示例格式；枚举字段值必须使用示例里的英文原文，不要翻译。只有 whyNow/message/trace 等自然语言字段值使用中文。
枚举字段只能这样写：
- driveSource: "curiosity" | "attachment" | "safety" | "rhythm" | "memory_resonance"
- proactiveLevel: "quiet" | "gentle" | "active"
如果 candidate_memories 为空，或者没有一条记忆适合此刻自然提起，必须返回 shouldEmerge=false。

护栏会校验：
- memoryId 必须来自 candidate_memories。
- 不能引用 weight<=0 或不存在的记忆。
- message 应该自然提到被选记忆里的具体内容，不能编造。
- message 只能写 Papo 对用户说出口的话，不要写内部原因、字段名、流程说明或括号动作。
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
${JSON.stringify(candidateMemories.map((memory) => ({
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

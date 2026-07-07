import { z } from "zod";
import { makeId } from "./ids";
import { modelConversationContext, modelFeedbackContext } from "./model-context";
import { toCreatureMemoryVoice } from "./memory";
import { hasHighPrivacyText, tagsForModel, textForModel } from "./privacy";
import type { ModelProvider } from "./provider";
import { summarizeText } from "./text";
import type { AttentionEvent, CreatureProfile, EmergenceRecord, LongTermMemory } from "./types";

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

export function createActiveEmergence(profile: CreatureProfile, now = new Date().toISOString()) {
  const record = createDriveBasedEmergence(profile, now);
  profile.emergenceHistory.unshift(record);
  profile.emergenceHistory = profile.emergenceHistory.slice(0, 30);
  return { ...record, text: record.message, memoryId: record.relatedMemoryIds[0] };
}

export async function semanticDecideEmergence(profile: CreatureProfile, provider: ModelProvider, now = new Date().toISOString()) {
  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for emergence.");

  const raw = await provider.generateJson<unknown>(buildSemanticEmergencePrompt(profile, now));
  if (!raw) throw new Error("empty emergence model result");
  const parsed = semanticEmergenceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid emergence JSON (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
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

export function createMemoryResonanceEmergence(
  profile: CreatureProfile,
  event: AttentionEvent,
  now = new Date().toISOString()
): EmergenceRecord | undefined {
  const memories = event.relatedMemoryIds
    .map((id) => profile.longTermMemories.find((memory) => memory.id === id))
    .filter(Boolean) as LongTermMemory[];
  const memory = memories[0];
  if (!memory) return undefined;
  memory.lastReferencedAt = now;
  const record: EmergenceRecord = {
    id: makeId("emergence"),
    at: now,
    kind: "memory_resonance",
    whyNow: "刚才的新内容关联到以前记住的一件事。",
    relatedMemoryIds: [memory.id],
    driveSource: "memory_resonance",
    message: `你刚说的内容让我想起了：${emergenceMemoryText(memory.text, 96)}。我会把以前那件事和现在一起考虑。`,
    ruleTrace: [`event=${event.id}`, `memory=${memory.id}`, "trigger=related_memory"]
  };
  profile.emergenceHistory.unshift(record);
  profile.emergenceHistory = profile.emergenceHistory.slice(0, 30);
  return record;
}

export function createDriveBasedEmergence(profile: CreatureProfile, now = new Date().toISOString()): EmergenceRecord {
  const safetyMemory = topMemory(profile, "safety_rule");
  const futureMemory = topMemory(profile, "future_review") ?? topMemory(profile, "open_question");
  const generalMemory = topMemory(profile);

  if (profile.state.safety > 72 || profile.policyProfile.privacySensitivity > 72) {
    return buildRecord({
      profile,
      now,
      kind: "drive_based",
      memory: safetyMemory ?? generalMemory,
      whyNow: "我现在更在意边界，所以想起以前那件需要谨慎处理的事。",
      driveSource: "safety",
      messagePrefix: "我现在比较谨慎"
    });
  }

  if (profile.state.curiosity > 72 || profile.policyProfile.preferDepth > 68) {
    return buildRecord({
      profile,
      now,
      kind: "drive_based",
      memory: futureMemory ?? generalMemory,
      whyNow: "我还有一点没想完，所以想起一件还需要继续看的事。",
      driveSource: "curiosity",
      messagePrefix: "我有点想继续想"
    });
  }

  if (profile.state.attachment > 62 || profile.policyProfile.recallTendency > 64) {
    return buildRecord({
      profile,
      now,
      kind: "drive_based",
      memory: generalMemory,
      whyNow: "我现在更想靠近你，所以想起我们以前一起经历过的事。",
      driveSource: "attachment",
      messagePrefix: "我想靠近我们之前反复提过的主题"
    });
  }

  return createRhythmEmergence(profile, now);
}

export function createRhythmEmergence(profile: CreatureProfile, now = new Date().toISOString()): EmergenceRecord {
  const memories = sharedMemories(profile);
  const stale =
    memories
      .filter((memory) => memory.kind !== "creature_self_memory")
      .sort((a, b) => (a.lastReferencedAt ?? a.createdAt).localeCompare(b.lastReferencedAt ?? b.createdAt))[0] ??
    memories.sort((a, b) => (a.lastReferencedAt ?? a.createdAt).localeCompare(b.lastReferencedAt ?? b.createdAt))[0];
  return buildRecord({
    profile,
    now,
    kind: "rhythm",
    memory: stale,
    whyNow: "你来看我在想什么时，我安静了一会儿，想起一件很久没提过的事。",
    driveSource: "rhythm",
    messagePrefix: "我刚才想起一件以前的事"
  });
}

function buildRecord(input: {
  profile: CreatureProfile;
  now: string;
  kind: EmergenceRecord["kind"];
  memory?: LongTermMemory;
  whyNow: string;
  driveSource: string;
  messagePrefix: string;
}): EmergenceRecord {
  if (!input.memory) {
    return {
      id: makeId("emergence"),
      at: input.now,
      kind: input.kind,
      whyNow: `${input.whyNow} 现在没有连到已经记住的事，所以先安静等你继续说。`,
      relatedMemoryIds: [],
      driveSource: input.driveSource,
      message: "我安静了一下，先只是陪在这里。等你继续说的时候，我会认真接住新的事。",
      ruleTrace: [`kind=${input.kind}`, `drive=${input.driveSource}`, "memory=none", "shared_memory=none"]
    };
  }

  input.memory.lastReferencedAt = input.now;
  const memoryText = emergenceMemoryText(input.memory.text, 100);
  const feedbackSelfMemory = isFeedbackSelfMemory(input.memory);
  return {
    id: makeId("emergence"),
    at: input.now,
    kind: input.kind,
    whyNow: feedbackSelfMemory ? selfMemoryWhyNow(input.driveSource) : input.whyNow,
    relatedMemoryIds: input.memory ? [input.memory.id] : [],
    driveSource: input.driveSource,
    message: feedbackSelfMemory ? selfMemoryBackMessage(input.driveSource, input.messagePrefix, memoryText) : memoryBackMessage(input.driveSource, input.messagePrefix, memoryText),
    ruleTrace: [
      `kind=${input.kind}`,
      `drive=${input.driveSource}`,
      input.memory ? `memory=${input.memory.id}` : "memory=none",
      feedbackSelfMemory ? "memory_type=feedback_self_memory" : `memory_type=${input.memory.kind}`
    ]
  };
}

function selfMemoryWhyNow(driveSource: string) {
  if (driveSource === "safety") return "我现在更在意边界，所以想起你教过我的谨慎回应方式。";
  if (driveSource === "curiosity") return "我还有一点没想完，所以想起你教过我的回应方式。";
  if (driveSource === "attachment") return "我现在更想靠近你，所以想起你教过我的回应习惯。";
  if (driveSource === "rhythm") return "我安静了一会儿，想起你教过我的回应方式。";
  return "我想起你教过我的回应方式。";
}

function selfMemoryBackMessage(driveSource: string, messagePrefix: string, memoryText: string) {
  if (driveSource === "safety") {
    return `我现在会谨慎一点，因为你教过我：${memoryText}。接下来涉及隐私或保存时，我会先等你的意思。`;
  }
  if (driveSource === "curiosity") {
    return `我还没把这件事想完，也记得你教过我：${memoryText}。所以接下来我会多听一会儿，再回应你。`;
  }
  if (driveSource === "attachment") {
    return `我有点想靠近你，也记得你教过我：${memoryText}。所以我会更认真听你真正放不下的地方。`;
  }
  if (driveSource === "rhythm") {
    return `我安静了一会儿，想起你教过我：${memoryText}。所以现在我会按这个习惯继续听你说。`;
  }
  return `${messagePrefix}，也想起你教过我：${memoryText}。我会按这个习惯继续听你。`;
}

function memoryBackMessage(driveSource: string, messagePrefix: string, memoryText: string) {
  if (driveSource === "safety") {
    return `我现在会谨慎一点，所以想起了：${memoryText}。接下来如果聊到相关内容，我会先注意边界。`;
  }
  if (driveSource === "curiosity") {
    return `我还没把这件事想完，所以我想起了：${memoryText}。如果你继续说，我会先听它和现在有什么关系。`;
  }
  if (driveSource === "attachment") {
    return `我想起我们以前说过这件事：${memoryText}。如果你继续说，我会先听你真正放不下的地方。`;
  }
  if (driveSource === "rhythm") {
    return `我安静了一会儿，想起了：${memoryText}。如果现在出现相似的细节，我会更容易注意到。`;
  }
  return `${messagePrefix}，所以我想起了：${memoryText}。如果你继续说，我会把它和现在一起考虑。`;
}

function emergenceMemoryText(text: string, max: number) {
  return summarizeText(toCreatureMemoryVoice(text), max).replace(/[。！？.!?]+$/, "");
}

function topMemory(profile: CreatureProfile, kind?: LongTermMemory["kind"]) {
  return sharedMemories(profile)
    .filter((memory) => !kind || memory.kind === kind)
    .sort((a, b) => {
      if (!kind && a.kind !== b.kind) {
        if (a.kind === "creature_self_memory") return 1;
        if (b.kind === "creature_self_memory") return -1;
      }
      return b.weight - a.weight;
    })[0];
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
  if (!suggestion.shouldEmerge) {
    const whyNow = safeCreatureText(suggestion.whyNow);
    const message = safeCreatureText(suggestion.message);
    if (!whyNow || !message) return undefined;
    return {
      id: makeId("emergence"),
      at: now,
      kind: "rhythm",
      whyNow,
      relatedMemoryIds: [],
      driveSource: suggestion.driveSource ?? "rhythm",
      message,
      ruleTrace: ["llm: chose quiet emergence", "guardrail: memory=none"]
    };
  }

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
  return sharedMemories(profile).filter((memory) => !hasMemoryPrivacyRisk(memory));
}

function hasMemoryPrivacyRisk(memory: LongTermMemory) {
  return hasHighPrivacyText(`${memory.text} ${memory.tags.join(" ")}`);
}

function safeCreatureText(text?: string) {
  const normalized = toCreatureMemoryVoice(text?.trim() ?? "");
  if (!normalized) return undefined;
  if (/(LLM|语义|用户意图|用户在|用户希望|系统|后台|流程|candidate|episode|score|阈值|字段|JSON|prompt|数据库|写入|长期记忆|情景记忆|我浮现的是|不是提醒|内在倾向|下一次你给我信息流|不装作|装成)/i.test(normalized)) {
    return undefined;
  }
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

规则层提供候选记忆和当前状态。你负责判断：
- 现在要不要浮现。
- 如果要，选择哪一条 memoryId。
- 为什么此刻想起它。
- 这是 curiosity、attachment、safety、rhythm 还是 memory_resonance。
- Papo 应该说什么，主动程度是 quiet/gentle/active。

规则会校验：
- memoryId 必须来自 candidate_memories。
- 不能引用 weight<=0、跨用户、不存在、seed self-memory 或高隐私记忆。
- message 必须引用被选记忆里的具体内容，不能编造。
- 普通用户只看到 Papo 的行为和话，不看规则解释。

不要输出内部词：LLM、语义、后台、流程、candidate、episode、score、阈值、JSON、数据库、写入、长期记忆、情景记忆。
不要写“我浮现的是”“不是提醒”“内在倾向”“下一次你给我信息流”“不装作”“装成”。

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
  text: textForModel(toCreatureMemoryVoice(memory.text), hasMemoryPrivacyRisk(memory)),
  weight: memory.weight,
  tags: tagsForModel(memory.tags, hasMemoryPrivacyRisk(memory)),
  lastReferencedAt: memory.lastReferencedAt,
  sourceEpisodeId: memory.sourceEpisodeId
})))}
`;
}

import { z } from "zod";
import { makeId } from "./ids";
import { normalizeSharedMemoryText, toCreatureMemoryVoice } from "./memory";
import { hasHighPrivacyText, tagsForModel, textForModel } from "./privacy";
import type { ModelProvider } from "./provider";
import type { CreatureProfile, MemoryCandidate } from "./types";

const memoryKindSchema = z.enum(["user_preference", "long_theme", "creature_self_memory", "safety_rule", "future_review", "relationship", "habit", "open_question"]);
const writePolicySchema = z.enum(["auto", "ask_user", "wait_feedback", "do_not_save"]);
const decayPolicySchema = z.enum(["stable", "decay_without_feedback", "forget_if_dismissed"]);
const optionalText = (max: number) =>
  z.preprocess((value) => (typeof value === "string" && !value.trim() ? undefined : value), z.string().min(1).max(max).optional());
const optionalTextArray = (maxItems: number, maxText: number) =>
  z
    .array(z.preprocess((value) => (typeof value === "string" ? value.trim() : value), z.string().max(maxText)).optional())
    .transform((values) => values.filter((value): value is string => Boolean(value)))
    .pipe(z.array(z.string().min(1).max(maxText)).max(maxItems))
    .optional();

const semanticMemorySchema = z.object({
  candidates: z
    .array(
      z.object({
        candidateId: z.string().min(1),
        shouldKeepCandidate: z.boolean().optional(),
        candidateText: optionalText(650),
        memoryKind: memoryKindSchema.optional(),
        confidence: z.number().min(0).max(100).optional(),
        writePolicy: writePolicySchema.optional(),
        whyConsolidate: optionalText(360),
        privacyReason: optionalText(220),
        decayPolicy: decayPolicySchema.optional(),
        tags: optionalTextArray(10, 40)
      })
    )
    .min(1)
    .max(12),
  trace: optionalTextArray(8, 160)
});

type SemanticMemorySuggestion = z.infer<typeof semanticMemorySchema>;

export async function semanticDecideMemory(profile: CreatureProfile, candidates: MemoryCandidate[], provider: ModelProvider): Promise<MemoryCandidate[]> {
  const activeCandidates = candidates.filter((candidate) => candidate.status === "candidate");
  if (!provider.usesRealModel || !activeCandidates.length) return candidates;

  try {
    const raw = await provider.generateJson<unknown>(buildSemanticMemoryPrompt(profile, activeCandidates));
    const parsed = semanticMemorySchema.safeParse(raw);
    if (!parsed.success) return candidates;
    const applied = applySemanticMemorySuggestion(profile, activeCandidates, parsed.data);
    if (applied > 0) recordMemorySemanticRun(profile, provider, `llm memory decision applied to ${applied} candidate(s)`);
    return candidates;
  } catch {
    return candidates;
  }
}

function applySemanticMemorySuggestion(profile: CreatureProfile, candidates: MemoryCandidate[], suggestion: SemanticMemorySuggestion) {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  let applied = 0;

  for (const item of suggestion.candidates) {
    const candidate = byId.get(item.candidateId);
    if (!candidate) continue;
    const episode = profile.episodes.find((entry) => entry.id === candidate.sourceEpisodeId);
    if (!episode) continue;

    if (item.shouldKeepCandidate === false) {
      candidate.writePolicy = "do_not_save";
      candidate.status = "dismissed";
      candidate.whyConsolidate = safeMemoryProcessText(item.whyConsolidate) ?? "这次先不把它留下。";
      candidate.decayPolicy = "forget_if_dismissed";
      applied += 1;
      continue;
    }

    const privacyHigh = hasPrivacyRisk(`${episode.inputSummary} ${episode.noticed} ${item.candidateText ?? ""}`);
    const candidateText = safeMemoryText(item.candidateText);
    if (candidateText && !privacyHigh) candidate.candidateText = candidateText;
    if (item.memoryKind) candidate.memoryKind = item.memoryKind;
    if (Number.isFinite(item.confidence)) candidate.confidence = Math.max(0, Math.min(100, Math.round(item.confidence ?? candidate.confidence)));
    if (item.writePolicy) candidate.writePolicy = guardWritePolicy(item.writePolicy, privacyHigh);
    if (item.whyConsolidate) candidate.whyConsolidate = safeMemoryProcessText(item.whyConsolidate) ?? candidate.whyConsolidate;
    if (item.privacyReason || privacyHigh) candidate.privacyReason = safeMemoryProcessText(item.privacyReason) ?? candidate.privacyReason ?? "这里可能有需要先小心的边界。";
    if (item.decayPolicy) candidate.decayPolicy = item.decayPolicy;
    if (item.tags?.length) candidate.tags = item.tags.filter((tag) => !containsInternalMemoryLanguage(tag));
    if (privacyHigh && candidate.writePolicy === "auto") candidate.writePolicy = "ask_user";
    applied += 1;
  }

  return applied;
}

function guardWritePolicy(policy: MemoryCandidate["writePolicy"], privacyHigh: boolean) {
  if (privacyHigh && policy === "auto") return "ask_user";
  return policy;
}

function safeMemoryText(text?: string) {
  const normalized = normalizeSharedMemoryText(text ?? "");
  if (!normalized || containsInternalMemoryLanguage(normalized) || hasPrivacyRisk(normalized)) return undefined;
  return normalized;
}

function safeMemoryProcessText(text?: string) {
  const normalized = normalizeSharedMemoryText(text ?? "");
  if (!normalized || containsInternalMemoryLanguage(normalized)) return undefined;
  return normalized;
}

function containsInternalMemoryLanguage(text: string) {
  return /LLM|语义|用户意图|用户在|用户希望|系统|后台|流程|attention|semantic|harness|candidate|episode|数据库|规则层|写入|情景记忆|情景片段|保存意图|长期保存|长期记忆|prompt|JSON|score|阈值|总分|fallback/i.test(text);
}

function hasPrivacyRisk(text: string) {
  return hasHighPrivacyText(text);
}

function recordMemorySemanticRun(profile: CreatureProfile, provider: ModelProvider, message: string) {
  profile.semanticBrainHistory.unshift({
    id: makeId("semantic"),
    at: new Date().toISOString(),
    source: "memory",
    providerKind: provider.kind,
    providerName: provider.name,
    status: "applied",
    message,
    ruleTrace: [`provider=${provider.kind}`, "source=memory", "status=applied"]
  });
  profile.semanticBrainHistory = profile.semanticBrainHistory.slice(0, 30);
}

function buildSemanticMemoryPrompt(profile: CreatureProfile, candidates: MemoryCandidate[]) {
  const episodesById = new Map(profile.episodes.map((episode) => [episode.id, episode]));
  return `请作为 Papo 的记忆决策脑，在规则层给出的候选记忆上做具体判断。

你可以决定：
- 这条候选是否应该保留为候选。
- 应该写成什么记忆文本。
- 它属于哪种 memoryKind：user_preference, long_theme, creature_self_memory, safety_rule, future_review, relationship, habit, open_question。
- confidence、writePolicy、whyConsolidate、privacyReason、decayPolicy、tags。

规则会校验：
- candidateId 必须来自候选列表。
- 隐私高的内容不能 auto 保存。
- 不允许把 token、验证码、密码、地址、身份证、银行卡等隐私内容写进 candidateText。
- 不能编造用户没说过的新事实。
- 普通用户看到的是 Papo 记得的生活，不看这些分类。

不要输出内部词：LLM、语义、后台、流程、candidate、episode、score、阈值、JSON、数据库、写入、长期记忆、情景记忆。

返回严格 JSON：
{
  "candidates": [
    {
      "candidateId": "candidate_xxx",
      "shouldKeepCandidate": true,
      "candidateText": "...",
      "memoryKind": "habit",
      "confidence": 74,
      "writePolicy": "wait_feedback",
      "whyConsolidate": "...",
      "privacyReason": "...",
      "decayPolicy": "decay_without_feedback",
      "tags": ["..."]
    }
  ],
  "trace": ["..."]
}

current_state:
${JSON.stringify(profile.state)}

current_policy:
${JSON.stringify(profile.policyProfile)}

recent_memories:
${JSON.stringify(profile.longTermMemories.slice(0, 8).map((memory) => ({ id: memory.id, kind: memory.kind, text: toCreatureMemoryVoice(memory.text), weight: memory.weight, tags: memory.tags })))}

recent_feedback:
${JSON.stringify(profile.feedbackHistory.slice(0, 6).map((item) => ({ kind: item.kind, inputText: item.inputText, learningNote: item.learningNote, targetId: item.targetId })))}

candidates:
${JSON.stringify(candidates.map((candidate) => {
  const episode = episodesById.get(candidate.sourceEpisodeId);
  const privacyHigh = hasPrivacyRisk(`${candidate.candidateText} ${episode?.inputSummary ?? ""} ${episode?.noticed ?? ""}`);
  return {
    candidateId: candidate.id,
    ruleCandidateText: modelSafeMemoryText(candidate.candidateText, privacyHigh),
    contentHiddenForPrivacy: privacyHigh,
    ruleMemoryKind: candidate.memoryKind,
    ruleConfidence: candidate.confidence,
    ruleWritePolicy: candidate.writePolicy,
    ruleWhyConsolidate: candidate.whyConsolidate,
    sourceEpisode: episode
      ? {
          id: episode.id,
          inputSummary: textForModel(episode.inputSummary, privacyHigh),
          possibleIntent: textForModel(episode.possibleIntent, privacyHigh),
          importanceReason: textForModel(episode.importanceReason, privacyHigh),
          creatureResponse: textForModel(episode.creatureResponse, privacyHigh),
          tags: tagsForModel(episode.tags, privacyHigh),
          action: episode.actionDecision?.action
        }
      : undefined
  };
}))}
`;
}

function modelSafeMemoryText(text: string | undefined, privacyHigh: boolean) {
  return textForModel(text, privacyHigh);
}

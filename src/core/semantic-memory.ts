import { z } from "zod";
import { makeId } from "./ids";
import { modelConversationContext, modelFeedbackContext, modelMemoryContext } from "./model-context";
import { normalizeSharedMemoryText, toCreatureMemoryVoice } from "./memory";
import { hasHighPrivacyText, tagsForModel, textForModel } from "./privacy";
import type { ModelProvider } from "./provider";
import type { CreatureProfile, MemoryCandidate } from "./types";

const memoryKindSchema = z.enum(["user_preference", "long_theme", "creature_self_memory", "safety_rule", "future_review", "relationship", "habit", "open_question"]);
const writePolicySchema = z.enum(["auto", "ask_user", "wait_feedback", "do_not_save"]);
const decayPolicySchema = z.enum(["stable", "decay_without_feedback", "forget_if_dismissed"]);
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
  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for memory decisions.");
  if (!activeCandidates.length) return candidates;

  const raw = await provider.generateJson<unknown>(buildSemanticMemoryPrompt(profile, activeCandidates));
  if (!raw) throw new Error("empty memory model result");
  const parsed = semanticMemorySchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid memory JSON (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  const applied = applySemanticMemorySuggestion(profile, activeCandidates, parsed.data);
  if (applied <= 0) throw new Error("memory model did not decide any active candidate");
  recordMemorySemanticRun(profile, provider, `llm memory decision applied to ${applied} candidate(s)`);
  return candidates;
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
      const reason = safeMemoryProcessText(item.whyConsolidate);
      if (!reason) throw new Error("memory model dismissed candidate without a usable reason");
      candidate.writePolicy = "do_not_save";
      candidate.status = "dismissed";
      candidate.whyConsolidate = reason;
      candidate.decayPolicy = "forget_if_dismissed";
      applied += 1;
      continue;
    }

    const privacyHigh = hasPrivacyRisk(`${episode.inputSummary} ${episode.noticed} ${item.candidateText ?? ""}`);
    const candidateText = safeMemoryText(item.candidateText);
    if (!candidateText) throw new Error("memory model kept candidate without a usable memory text");
    candidate.candidateText = candidateText;
    if (item.memoryKind) candidate.memoryKind = item.memoryKind;
    if (Number.isFinite(item.confidence)) candidate.confidence = Math.max(0, Math.min(100, Math.round(item.confidence ?? candidate.confidence)));
    if (item.writePolicy) candidate.writePolicy = guardWritePolicy(item.writePolicy, privacyHigh);
    if (item.whyConsolidate) candidate.whyConsolidate = safeMemoryProcessText(item.whyConsolidate) ?? candidate.whyConsolidate;
    if (privacyHigh && !safeMemoryProcessText(item.privacyReason)) throw new Error("memory model kept private candidate without a usable privacy reason");
    if (item.privacyReason) candidate.privacyReason = safeMemoryProcessText(item.privacyReason) ?? candidate.privacyReason;
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
  return /LLM|语义|用户意图|用户在|用户希望|系统|后台|流程|attention|semantic|harness|candidate|episode|数据库|规则层|写入|情景记忆|情景片段|保存意图|长期保存|长期记忆|prompt|JSON|score|阈值|总分/i.test(text);
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
- shouldKeepCandidate=true 时必须给出 candidateText；这是 Papo 真正会留下的记忆候选文本，不能依赖 ruleCandidateText。
- shouldKeepCandidate=false 时必须给出 whyConsolidate 说明为什么不留下。
- 隐私高的内容不能 auto 保存。
- 隐私高时必须给出不泄露具体秘密的 candidateText 和 privacyReason，并把 writePolicy 设为 ask_user 或 do_not_save。
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
${JSON.stringify(modelMemoryContext(profile.longTermMemories, { creatureVoice: true }))}

recent_conversation_newest_first:
${JSON.stringify(modelConversationContext(profile))}

recent_feedback:
${JSON.stringify(modelFeedbackContext(profile.feedbackHistory))}

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

import { z } from "zod";
import { makeId } from "./ids";
import { modelConversationContext, modelFeedbackContext, modelMemoryContext, modelPetContext } from "./model-context";
import { clientContextFor } from "./client-document";
import { clearCandidateVisual, memoryShortTitle, normalizeSharedMemoryText, toCreatureMemoryVoice } from "./memory";
import { hasHighPrivacyText, tagsForModel, textForModel } from "./privacy";
import type { ModelProvider } from "./provider";
import type { CognitionContext, CreatureProfile, MemoryCandidate } from "./types";

const memoryKindSchema = z.enum(["user_preference", "long_theme", "creature_self_memory", "safety_rule", "future_review", "relationship", "habit", "open_question"]);
const writePolicySchema = z.enum(["auto", "ask_user", "wait_feedback", "do_not_save"]);
const decayPolicySchema = z.enum(["stable", "decay_without_feedback", "forget_if_dismissed"]);
const optionalMemoryKind = z.preprocess((value) => cleanOptionalText(value, 80), memoryKindSchema.optional());
const optionalWritePolicy = z.preprocess((value) => cleanOptionalText(value, 40), writePolicySchema.optional());
const optionalDecayPolicy = z.preprocess((value) => cleanOptionalText(value, 40), decayPolicySchema.optional());
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
        shortTitle: optionalText(8),
        memoryKind: optionalMemoryKind,
        confidence: z.number().min(0).max(100).optional(),
        writePolicy: optionalWritePolicy,
        whyConsolidate: optionalText(360),
        privacyReason: optionalText(220),
        decayPolicy: optionalDecayPolicy,
        tags: optionalTextArray(10, 40)
      })
    )
    .min(1)
    .max(12),
  trace: optionalTextArray(8, 160)
});

type SemanticMemorySuggestion = z.infer<typeof semanticMemorySchema>;

export async function semanticDecideMemory(
  profile: CreatureProfile,
  candidates: MemoryCandidate[],
  provider: ModelProvider,
  context: CognitionContext = { inputSource: "direct" }
): Promise<MemoryCandidate[]> {
  const activeCandidates = candidates.filter((candidate) => candidate.status === "candidate");
  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for memory decisions.");
  if (!activeCandidates.length) return candidates;

  const raw = await provider.generateJson<unknown>(buildSemanticMemoryPrompt(profile, activeCandidates, context));
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
      clearCandidateVisual(candidate);
      applied += 1;
      continue;
    }

    const privacyHigh = hasHighPrivacyText(`${candidate.candidateText} ${episode.inputSummary} ${episode.noticed}`);
    const candidateText = safeMemoryText(item.candidateText);
    if (!candidateText) throw new Error("memory model kept candidate without a usable memory text");
    candidate.candidateText = candidateText;
    candidate.shortTitle = memoryShortTitle(candidateText, item.shortTitle);
    if (item.memoryKind) candidate.memoryKind = item.memoryKind;
    if (Number.isFinite(item.confidence)) candidate.confidence = Math.max(0, Math.min(100, Math.round(item.confidence ?? candidate.confidence)));
    if (item.writePolicy) candidate.writePolicy = guardWritePolicy(item.writePolicy, privacyHigh);
    if (item.whyConsolidate) candidate.whyConsolidate = safeMemoryProcessText(item.whyConsolidate) ?? candidate.whyConsolidate;
    if (item.privacyReason) candidate.privacyReason = safeMemoryProcessText(item.privacyReason) ?? candidate.privacyReason;
    if (item.decayPolicy) candidate.decayPolicy = item.decayPolicy;
    if (item.tags?.length) candidate.tags = item.tags;
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
  if (!normalized) return undefined;
  return normalized;
}

function safeMemoryProcessText(text?: string) {
  const normalized = normalizeSharedMemoryText(text ?? "");
  if (!normalized) return undefined;
  return normalized;
}

function recordMemorySemanticRun(profile: CreatureProfile, provider: ModelProvider, message: string) {
  profile.semanticBrainHistory.unshift({
    id: makeId("semantic"),
    at: new Date().toISOString(),
    source: "memory",
    stage: "memory",
    providerKind: provider.kind,
    providerName: provider.name,
    model: provider.diagnostics?.textModel,
    status: "applied",
    message,
    ruleTrace: [`provider=${provider.kind}`, "source=memory", "status=applied"]
  });
  profile.semanticBrainHistory = profile.semanticBrainHistory.slice(0, 30);
}

function buildSemanticMemoryPrompt(profile: CreatureProfile, candidates: MemoryCandidate[], context: CognitionContext) {
  const episodesById = new Map(profile.episodes.map((episode) => [episode.id, episode]));
  const originalEpisode = context.sourceEpisodeId ? episodesById.get(context.sourceEpisodeId) : undefined;
  const originalTask = context.taskId ? profile.hermes.tasks.find((task) => task.id === context.taskId) : undefined;
  return `请作为 Papo 的记忆决策脑，在这次真实互动形成的候选记忆上做具体判断。

当前认知来源：${context.inputSource}${context.taskId ? `，taskId=${context.taskId}` : ""}。
${context.inputSource === "task_result" ? "这是外部任务结果。必须结合原请求与返回结果判断，优先更新原 episode 对应的候选/记忆，不要把请求和结果各写成一条重复长期记忆。" : ""}

候选里的 sourceMaterial 只是用户原始材料或行动脑给出的草稿，不是系统结论。
initialMemoryKind、initialConfidence、initialWritePolicy 是存储结构占位，不代表规则已经判断过这件事。
你必须自己决定是否保留、怎么写、分到哪一类、是否长期保存。
JSON 字段名保持示例格式；所有自然语言字段值必须用中文。
只返回一个完整、可直接 JSON.parse 的紧凑 JSON object；不要 Markdown、代码块、注释、尾随逗号或解释文字。

你可以决定：
- 这条候选是否应该保留为候选。
- 应该写成什么记忆文本。
- 它属于哪种 memoryKind：user_preference, long_theme, creature_self_memory, safety_rule, future_review, relationship, habit, open_question。
- confidence、writePolicy、whyConsolidate、privacyReason、decayPolicy、tags。
- 如果 sourceEpisode 带 attachments，说明原始图片资产会跟随这条记忆一起保存；你看到的文本是视觉模型摘要和用户补充，不是全部信息。用户主动上传照片通常意味着照片对这次互动有意义；除非重复、无意义、误触、隐私不适合或确实没有可复用信息，应至少保留为候选。
- 照片记忆的 candidateText 必须写出图片里的关键可见内容、用户补充说明、以及可用的 observedAt/location provenance。不要写成“用户上传了一张照片”这种空泛描述；也不要只保留视觉摘要而忽略用户为什么发这张图。
- 当照片、语音或文字表达了稳定偏好、习惯、关系、真实生活事件、未来要回看的事，且不涉及高隐私和明显重复时，不要过度保守。你可以选择 writePolicy=auto 直接形成长期记忆；如果只是保存意图或隐私边界不确定，再用 ask_user 或 wait_feedback。
- 如果候选已经包含用户明确表达的喜欢/讨厌、经常做的事、重要的人或宠物、正在推进的计划、希望以后提醒或回看的内容，通常比普通闲聊更值得长期留下。
- writePolicy 的含义：
  - auto：规则会立刻写入长期记忆。用于用户明确要求记住、稳定偏好/习惯/关系、带照片的重要生活事实、未来回看线索，或非常适合长期留下的内容。
  - ask_user：需要用户确认后再长期保存。
  - wait_feedback：先作为轻量候选等后续互动。
  - do_not_save：不保留为候选。

护栏会校验：
- candidateId 必须来自候选列表。
- shouldKeepCandidate=true 时必须给出 candidateText；这是 Papo 真正会留下的记忆候选文本，不能依赖系统预填文本。
- shouldKeepCandidate=true 时必须给 shortTitle：2-8 个中文字符，根据文字和图片内容提炼，例如“泳池下午”“可乐闲聊”“Jojo 护食”；它只用于内容缩略卡，不替代完整记忆。
- candidateText 是 Papo 留给自己、也会给对方看的生活记忆：使用 Papo 小动物观察者的第一人称视角，对对方使用 relevant_client_context 中的 preferredName（没有时用“你”）。禁止写“用户”“该用户”“说话者”等系统口吻。
- shouldKeepCandidate=false 时必须给出 whyConsolidate 说明为什么不留下。
- shouldKeepCandidate=false 时不要填写 candidateText、memoryKind、writePolicy、decayPolicy；不要用空字符串占位。
- memoryKind 必须只使用：user_preference, long_theme, creature_self_memory, safety_rule, future_review, relationship, habit, open_question。
- writePolicy 必须只使用：auto, ask_user, wait_feedback, do_not_save。
- decayPolicy 必须只使用：stable, decay_without_feedback, forget_if_dismissed；不要创造 decay_immediately、delete、none 等新值。
- 不能编造用户没说过的新事实。
- writePolicy=auto 的候选会真的写入 long_term_memory。
- contentHiddenForPrivacy=true 时不能使用 writePolicy=auto；如果确实值得记住，应使用 ask_user 并说明需要用户确认。
- 普通用户看到的是 Papo 记得的生活，不看这些分类。
- 如果候选只是普通寒暄、临时问候、一次性闲聊、噪音或没有可复用意义的片段，应 shouldKeepCandidate=false。
- candidateText 控制在 160 个中文字符以内，whyConsolidate 控制在 80 个中文字符以内，trace 最多 2 条短句；不要为了说明流程写长段落。

返回严格 JSON：
{
  "candidates": [
    {
      "candidateId": "candidate_xxx",
      "shouldKeepCandidate": true,
      "candidateText": "...",
      "shortTitle": "2-8字短标题",
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

pet_context:
${JSON.stringify(modelPetContext(profile))}

current_state:
${JSON.stringify(profile.state)}

current_policy:
${JSON.stringify(profile.policyProfile)}

relevant_client_context:
${JSON.stringify(clientContextFor(profile, candidates.map((candidate) => candidate.candidateText).join(" ")))}

recent_memories:
${JSON.stringify(modelMemoryContext(profile.longTermMemories, { creatureVoice: true }))}

recent_conversation_newest_first:
${JSON.stringify(modelConversationContext(profile))}

recent_feedback:
${JSON.stringify(modelFeedbackContext(profile.feedbackHistory))}

task_result_origin:
${JSON.stringify(context.inputSource === "task_result" ? {
  taskId: context.taskId,
  task: originalTask?.task,
  sourceEventId: context.sourceEventId,
  sourceEpisode: originalEpisode ? {
    id: originalEpisode.id,
    inputSummary: originalEpisode.inputSummary,
    possibleIntent: originalEpisode.possibleIntent,
    creatureResponse: originalEpisode.creatureResponse,
    existingMemory: profile.longTermMemories.find((memory) => memory.sourceEpisodeId === originalEpisode.id && memory.weight > 0)
  } : undefined
} : undefined)}

candidates:
${JSON.stringify(candidates.map((candidate) => {
  const episode = episodesById.get(candidate.sourceEpisodeId);
  const privacyHigh = hasHighPrivacyText(`${candidate.candidateText} ${episode?.inputSummary ?? ""} ${episode?.noticed ?? ""}`);
  return {
    candidateId: candidate.id,
    sourceMaterial: modelSafeMemoryText(candidate.candidateText, privacyHigh),
    contentHiddenForPrivacy: privacyHigh,
    initialMemoryKind: candidate.memoryKind,
    initialConfidence: candidate.confidence,
    initialWritePolicy: candidate.writePolicy,
    initialWhyConsolidate: candidate.whyConsolidate,
    sourceEpisode: episode
      ? {
          id: episode.id,
          sourceSegmentId: episode.sourceSegmentId,
          sourceBatchId: episode.sourceBatchId,
          sourceObservedAt: episode.sourceObservedAt,
          sourceLocation: episode.sourceLocation,
          attachments: (episode.attachments ?? []).map((attachment) => ({
            id: attachment.id,
            kind: attachment.kind,
            label: attachment.label,
            mime: attachment.mime,
            observedAt: attachment.observedAt,
            location: attachment.location
          })),
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

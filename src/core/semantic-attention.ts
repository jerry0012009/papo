import { z } from "zod";
import { buildAttentionEvent, isHighPrivacySegmentContent } from "./attention";
import { makeId } from "./ids";
import { modelConversationContext, modelFeedbackContext, modelMemoryContext, modelPetContext } from "./model-context";
import { createEpisodeFromEvent, createMemoryCandidateFromEpisode, normalizeSharedMemoryText } from "./memory";
import { projectInputForModel } from "./model-safety";
import { isModelProviderRefusal, type ModelProvider } from "./provider";
import type { AttentionSource, CaptureResult, CognitionContext, CreatureProfile, SemanticBrainRecord } from "./types";

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

const semanticAttentionSchema = z.object({
  shouldAttend: z.boolean().optional(),
  selected: z
    .array(
      z.object({
        segmentId: z.string().min(1),
        whySelected: optionalText(360),
        noticed: optionalText(260),
        userMeaning: optionalText(360),
        memoryRelation: optionalText(360),
        addressedToPapo: z.boolean().optional(),
        expectsResponse: z.boolean().optional(),
        relatedMemoryIds: optionalTextArray(6, 80),
        tags: optionalTextArray(10, 40)
      })
    )
    .max(6)
    .optional(),
  ignored: z
    .array(
      z.object({
        segmentId: z.string().min(1),
        whyIgnored: optionalText(360)
      })
    )
    .max(12)
    .optional(),
  creatureReport: optionalText(900),
  trace: optionalTextArray(8, 160)
});

type SemanticAttentionSuggestion = z.infer<typeof semanticAttentionSchema>;
type AttentionCandidate = NonNullable<CaptureResult["attentionCandidates"]>[number];

export async function semanticDecideAttention(
  profile: CreatureProfile,
  result: CaptureResult,
  provider: ModelProvider,
  source: AttentionSource,
  context: CognitionContext = { inputSource: source === "button" ? "direct" : "ambient" }
): Promise<CaptureResult> {
  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for attention.");
  if (!result.curiousSession || !result.attentionCandidates?.length) return result;

  validateCognitionContext(context);
  const prompt = buildSemanticAttentionPrompt(profile, result, source, context);
  const raw = await generateAttentionJsonWithRecovery<unknown>(provider, prompt, result, context);
  if (!raw) throw new Error("empty attention model result");
  const parsed = semanticAttentionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid attention JSON (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  }
  const applied = applySemanticAttention(profile, result, parsed.data, source, context);
  if (!applied && parsed.data.shouldAttend !== false) {
    if (context.inputSource !== "ambient") throw new Error(`${context.inputSource} attention did not perceive a valid input`);
    clearCuriousAttentionResult(profile, result, parsed.data);
  }
  recordAttentionSemanticRun(
    profile,
    provider,
    source,
    applied ? "applied" : "empty",
    applied ? "llm attention decision applied" : "llm attention decision ignored all candidates"
  );
  return result;
}

async function generateAttentionJsonWithRecovery<T>(provider: ModelProvider, prompt: string, result: CaptureResult, context: CognitionContext) {
  try {
    return await provider.generateJson<T>(prompt);
  } catch (error) {
    if (!isModelProviderRefusal(error)) throw error;
    const retryPrompt = buildAttentionRecoveryPrompt(result, context);
    return provider.generateJsonFallback ? provider.generateJsonFallback<T>(retryPrompt) : provider.generateJson<T>(retryPrompt);
  }
}

function buildAttentionRecoveryPrompt(result: CaptureResult, context: CognitionContext) {
  const candidates = (result.attentionCandidates ?? []).map((candidate) => ({
    segmentId: candidate.segment.id,
    modality: candidate.segment.kind,
    task: projectInputForModel(candidate.segment.content),
    hasAttachments: Boolean(candidate.segment.attachments?.length)
  }));
  return `You are the attention stage for a companion app. Interpret the structured tasks below without reconstructing quoted wording from an earlier media item.
Input source: ${context.inputSource}. Direct and task_result inputs must be selected. Ambient inputs may be ignored.
Return JSON only:
{"shouldAttend":true,"selected":[{"segmentId":"...","whySelected":"中文","noticed":"中文","userMeaning":"中文","addressedToPapo":true,"expectsResponse":true,"relatedMemoryIds":[],"tags":[]}],"ignored":[],"creatureReport":"中文","trace":["provider recovery"]}
Candidates:
${JSON.stringify(candidates)}`;
}

function applySemanticAttention(profile: CreatureProfile, result: CaptureResult, suggestion: SemanticAttentionSuggestion, source: AttentionSource, context: CognitionContext) {
  const session = result.curiousSession;
  const candidates = result.attentionCandidates;
  if (!session || !candidates?.length) return false;

  const byId = new Map(candidates.map((candidate) => [candidate.segment.id, candidate]));
  const selectedFromModel = unique((suggestion.selected ?? []).map((item) => item.segmentId))
    .map((segmentId) => byId.get(segmentId))
    .filter((candidate): candidate is AttentionCandidate => Boolean(candidate))
    .slice(0, session.attentionBudget);

  if (suggestion.shouldAttend === false) {
    if (context.inputSource !== "ambient") throw new Error(`${context.inputSource} input cannot be discarded by attention`);
    clearCuriousAttentionResult(profile, result, suggestion);
    return false;
  }
  if (!selectedFromModel.length) return false;

  const selectedIds = new Set(selectedFromModel.map((candidate) => candidate.segment.id));
  const selectedDecision = new Map((suggestion.selected ?? []).map((item) => [item.segmentId, item]));
  const ignoredReason = new Map((suggestion.ignored ?? []).map((item) => [item.segmentId, safeCreatureText(item.whyIgnored)]));
  for (const candidate of selectedFromModel) {
    const decision = selectedDecision.get(candidate.segment.id);
    if (!safeCreatureText(decision?.whySelected)) throw new Error("attention model did not explain a selected segment");
    if (!safeCreatureText(decision?.noticed)) throw new Error("attention model did not say what it noticed");
    if (!safeCreatureText(decision?.userMeaning)) throw new Error("attention model did not infer user meaning");
  }

  const oldEpisodeIds = new Set(result.episodes.map((episode) => episode.id));
  profile.episodes = profile.episodes.filter((episode) => !oldEpisodeIds.has(episode.id));
  profile.memoryCandidates = profile.memoryCandidates.filter((candidate) => !oldEpisodeIds.has(candidate.sourceEpisodeId));

  const now = session.createdAt;
  const events = selectedFromModel.map((candidate) => {
    const decision = selectedDecision.get(candidate.segment.id);
    const event = buildAttentionEvent(profile, {
      source,
      triggerSegmentId: candidate.segment.id,
      triggerBatchId: candidate.segment.batchId,
      triggerObservedAt: candidate.segment.observedAt,
      triggerLocation: candidate.segment.location,
      attachments: candidate.segment.attachments,
      triggerLabel: candidate.segment.label,
      triggerContent: candidate.segment.content,
      reasonPrefix: safeCreatureText(decision?.whySelected) ?? "",
      score: candidate.score,
      now
    });
    event.cognitionSource = context.inputSource;
    event.addressedToPapo = decision?.addressedToPapo ?? context.inputSource === "task_result";
    event.expectsResponse = decision?.expectsResponse ?? context.inputSource === "task_result";
    event.sourceTaskId = context.taskId;
    event.sourceEventId = context.sourceEventId;
    event.sourceEpisodeId = context.sourceEpisodeId;
    event.noticed = safeCreatureText(decision?.noticed) ?? event.noticed;
    event.reason = safeCreatureText(decision?.userMeaning) ?? event.reason;
    event.relatedMemoryIds = validRelatedMemoryIds(profile, decision?.relatedMemoryIds);
    event.tags = decision?.tags?.length ? decision.tags : event.tags;
    event.semanticSource = "llm";
    event.decisionTrace = [
      ...(event.decisionTrace ?? []),
      "llm: selected this segment for attention",
      `noticed=${event.noticed}`,
      `user_meaning=${event.reason}`,
      `cognition_source=${context.inputSource}`,
      `addressed_to_papo=${event.addressedToPapo}`,
      `expects_response=${event.expectsResponse}`,
      decision?.expectsResponse === undefined ? "compatibility: expectsResponse omitted by model" : "guardrail: expectsResponse explicitly classified",
      decision?.memoryRelation ? `memory_relation=${safeCreatureText(decision.memoryRelation) ?? "not_shown"}` : "memory_relation=not_provided",
      `guardrail: attention_budget=${session.attentionBudget}`
    ];
    return event;
  });

  const episodes = events.map((event) => createEpisodeFromEvent(event, "", now));
  profile.episodes.unshift(...episodes);
  const memoryCandidates = episodes.map((episode) => createMemoryCandidateFromEpisode(profile, episode, { now }));

  result.events = events;
  result.episodes = episodes;
  result.memoryCandidates = memoryCandidates;
  result.attentionCandidates = candidates.map((candidate) => ({ ...candidate, selectedByModel: selectedIds.has(candidate.segment.id) }));
  session.selected = selectedFromModel.map((candidate) => ({
    segmentId: candidate.segment.id,
    label: candidate.segment.label,
    score: candidate.score,
    whySelected: safeCreatureText(selectedDecision.get(candidate.segment.id)?.whySelected) ?? ""
  }));
  session.ignored = candidates
    .filter((candidate) => !selectedIds.has(candidate.segment.id))
    .map((candidate) => ({
      segmentId: candidate.segment.id,
      label: candidate.segment.label,
      score: candidate.score,
      whyIgnored: ignoredReason.get(candidate.segment.id) ?? ""
    }));

  session.creatureReport = safeCreatureText(suggestion.creatureReport) ?? "";
  result.response = "";
  result.harnessTrace = [...(result.harnessTrace ?? []), "semantic attention: llm selection applied"];
  return true;
}

function clearCuriousAttentionResult(profile: CreatureProfile, result: CaptureResult, suggestion: SemanticAttentionSuggestion) {
  const session = result.curiousSession;
  const candidates = result.attentionCandidates ?? [];
  if (!session) return;

  const oldEpisodeIds = new Set(result.episodes.map((episode) => episode.id));
  profile.episodes = profile.episodes.filter((episode) => !oldEpisodeIds.has(episode.id));
  profile.memoryCandidates = profile.memoryCandidates.filter((candidate) => !oldEpisodeIds.has(candidate.sourceEpisodeId));

  const ignoredReason = new Map((suggestion.ignored ?? []).map((item) => [item.segmentId, safeCreatureText(item.whyIgnored)]));
  result.events = [];
  result.episodes = [];
  result.memoryCandidates = [];
  result.response = "";
  if (candidates.some((candidate) => !ignoredReason.get(candidate.segment.id)) && !safeCreatureText(suggestion.creatureReport)) {
    throw new Error("attention model chose quiet without a usable internal report or ignored reasons");
  }
  session.selected = [];
  session.ignored = candidates.map((candidate) => ({
    segmentId: candidate.segment.id,
    label: candidate.segment.label,
    score: candidate.score,
    whyIgnored: ignoredReason.get(candidate.segment.id) ?? ""
  }));
  session.creatureReport = safeCreatureText(suggestion.creatureReport) ?? "";
}

function safeCreatureText(text?: string) {
  const normalized = normalizeSharedMemoryText(text ?? "");
  if (!normalized) return undefined;
  return normalized;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function validRelatedMemoryIds(profile: CreatureProfile, ids?: string[]) {
  if (!ids?.length) return [];
  const allowed = new Set(profile.longTermMemories.filter((memory) => memory.weight > 0).map((memory) => memory.id));
  return [...new Set(ids)].filter((id) => allowed.has(id)).slice(0, 6);
}

function recordAttentionSemanticRun(
  profile: CreatureProfile,
  provider: ModelProvider,
  source: SemanticBrainRecord["source"],
  status: "skipped" | "applied" | "empty" | "invalid" | "failed",
  message: string
) {
  profile.semanticBrainHistory.unshift({
    id: makeId("semantic"),
    at: new Date().toISOString(),
    source,
    stage: "attention",
    providerKind: provider.kind,
    providerName: provider.name,
    model: provider.diagnostics?.textModel,
    status,
    message,
    ruleTrace: [`provider=${provider.kind}`, `source=${source}`, `status=${status}`, "stage=attention"]
  });
  profile.semanticBrainHistory = profile.semanticBrainHistory.slice(0, 30);
}

function buildSemanticAttentionPrompt(profile: CreatureProfile, result: CaptureResult, source: AttentionSource, context: CognitionContext) {
  return `请作为 Papo 的注意决策脑，从这一组真实输入片段里决定 Papo 此刻要认真回应哪几段。

认知输入来源：${context.inputSource}。
${sourceDescription(context)}
系统已经整理了候选片段和注意预算。你负责具体判断：
- 哪些段值得注意。
- 哪些段应该暂时略过。
- 为什么注意。
- 注意到的核心内容是什么。
- 这段内容对用户可能意味着什么。
- 它是否自然关联到 recent_memories 里的旧记忆。
- 只有 ambient 可以因为全是背景声、空白或没有可用生活信息而 shouldAttend=false。
- direct 是用户主动发送：除空白、损坏、明确重复或明确误触外，必须 selected，不能用 Attention 代替 Action 做“安静陪伴”。
- task_result 必须 selected，并依据 taskId 和原 event/episode 理解它是任务结果，不得当成无来源环境输入。
- 对每个 selected 判断 addressedToPapo 和 expectsResponse。明确提问、呼唤、求助、请求执行时 expectsResponse 必须为 true；碎碎念或情绪记录可为 false。
- Attention 只判断感知、含义、情绪、呼唤关系、记忆关系和隐私，不决定最终是否说话；是否回应由下一阶段 Action 决定。
- 如果候选带 attachments，说明原始图片资产仍然可被长期回看；不要只把它当一段普通文字摘要。图片摘要、用户补充、拍摄/上传时间和地点一起构成这次输入。
- JSON 字段名保持示例格式；所有自然语言字段值必须用中文。

护栏会校验：
- selected.segmentId 必须来自 candidates。
- selected 数量不能超过 attentionBudget。
- selected 每一项必须给 whySelected、noticed、userMeaning。
- relatedMemoryIds 只能使用 recent_memories 中已有 id，不能编造。
- 不能新增不存在的片段。
- 后续事件、episode、memory candidate 只会从最终 selected 生成。
普通用户看到的是 Papo 听见了什么、回应了什么，不看规则解释。

返回严格 JSON：
{
  "shouldAttend": true,
  "selected": [{
    "segmentId":"s1",
    "whySelected":"...",
    "noticed":"...",
    "userMeaning":"...",
    "addressedToPapo":true,
    "expectsResponse":true,
    "memoryRelation":"...",
    "relatedMemoryIds":["ltm_xxx"],
    "tags":["..."]
  }],
  "ignored": [{"segmentId":"s2","whyIgnored":"..."}],
  "creatureReport": "...",
  "trace": ["..."]
}

pet_context:
${JSON.stringify(modelPetContext(profile))}

current_state:
${JSON.stringify(profile.state)}

current_policy:
${JSON.stringify(profile.policyProfile)}

companion_continuity_context:
${JSON.stringify(context.companion ?? null)}

陪伴上下文用于理解片段属于什么持续场景，但不替代 Attention：即使决定不回应，场景归属器仍会独立更新事件。

recent_memories:
${JSON.stringify(modelMemoryContext(profile.longTermMemories))}

recent_conversation_newest_first:
${JSON.stringify(modelConversationContext(profile))}

recent_feedback:
${JSON.stringify(modelFeedbackContext(profile.feedbackHistory))}

attentionBudget:
${result.curiousSession?.attentionBudget ?? 0}

candidates:
${JSON.stringify((result.attentionCandidates ?? []).map((candidate) => ({
  segmentId: candidate.segment.id,
  label: candidate.segment.label,
  modality: candidate.segment.kind,
  batchId: candidate.segment.batchId,
  observedAt: candidate.segment.observedAt,
  location: candidate.segment.location,
  attachments: (candidate.segment.attachments ?? []).map((attachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    label: attachment.label,
    mime: attachment.mime,
    observedAt: attachment.observedAt,
    location: attachment.location
  })),
  content: modelSafeSegmentContent(candidate.segment.content),
  contentHiddenForPrivacy: isHighPrivacySegmentContent(candidate.segment.content),
  alreadySelected: candidate.selectedByModel,
  pacingScore: candidate.score.total,
  privacyRisk: candidate.score.privacyRisk
})))}
`;
}

function validateCognitionContext(context: CognitionContext) {
  if (context.inputSource !== "task_result") return;
  if (!context.taskId || !context.sourceEventId || !context.sourceEpisodeId) {
    throw new Error("task_result cognition requires taskId, sourceEventId, and sourceEpisodeId");
  }
}

function sourceDescription(context: CognitionContext) {
  if (context.inputSource === "direct") return "这是用户主动发送给 Papo 的文字、图片或语音。";
  if (context.inputSource === "ambient") return "这是陪伴模式持续观察到的环境音频、画面或场景片段。";
  return `这是外部任务回流。taskId=${context.taskId}，原 event=${context.sourceEventId}，原 episode=${context.sourceEpisodeId}。`;
}

function modelSafeSegmentContent(text: string) {
  return projectInputForModel(text).text;
}

export function perceiveDirectAfterProviderRefusal(profile: CreatureProfile, result: CaptureResult, source: AttentionSource) {
  const candidates = result.attentionCandidates ?? [];
  if (!candidates.length) return result;
  const selected = candidates.slice(0, Math.max(1, result.curiousSession?.attentionBudget ?? 1)).map((candidate) => ({
    segmentId: candidate.segment.id,
    whySelected: "这是用户主动发给 Papo 的有效输入",
    noticed: "用户在表达一个需要回应的明确请求",
    userMeaning: "原始输入已可靠收到，但模型本轮未完成语义理解",
    addressedToPapo: true,
    expectsResponse: true,
    relatedMemoryIds: [],
    tags: ["模型拒绝降级"]
  }));
  applySemanticAttention(profile, result, { shouldAttend: true, selected, ignored: [], creatureReport: "Papo 已听见，先诚实说明本轮理解受阻。" }, source, { inputSource: "direct" });
  return result;
}

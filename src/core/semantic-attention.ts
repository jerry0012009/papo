import { z } from "zod";
import { buildAttentionEvent, isHighPrivacySegmentContent } from "./attention";
import { makeId } from "./ids";
import { modelConversationContext, modelFeedbackContext, modelMemoryContext } from "./model-context";
import { createEpisodeFromEvent, createMemoryCandidateFromEpisode, normalizeSharedMemoryText } from "./memory";
import type { ModelProvider } from "./provider";
import type { AttentionSource, CaptureResult, CreatureProfile, SemanticBrainRecord } from "./types";

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
  source: AttentionSource
): Promise<CaptureResult> {
  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for attention.");
  if (!result.curiousSession || !result.attentionCandidates?.length) return result;

  const raw = await provider.generateJson<unknown>(buildSemanticAttentionPrompt(profile, result, source));
  if (!raw) throw new Error("empty attention model result");
  const parsed = semanticAttentionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid attention JSON (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  }
  const applied = applySemanticAttention(profile, result, parsed.data, source);
  if (!applied && parsed.data.shouldAttend !== false) throw new Error("attention model did not select any valid segment");
  recordAttentionSemanticRun(
    profile,
    provider,
    source,
    applied ? "applied" : "applied",
    applied ? "llm attention decision applied" : "llm attention decision ignored all candidates"
  );
  return result;
}

function applySemanticAttention(profile: CreatureProfile, result: CaptureResult, suggestion: SemanticAttentionSuggestion, source: AttentionSource) {
  const session = result.curiousSession;
  const candidates = result.attentionCandidates;
  if (!session || !candidates?.length) return false;

  const byId = new Map(candidates.map((candidate) => [candidate.segment.id, candidate]));
  const selectedFromModel = unique((suggestion.selected ?? []).map((item) => item.segmentId))
    .map((segmentId) => byId.get(segmentId))
    .filter((candidate): candidate is AttentionCandidate => Boolean(candidate))
    .slice(0, session.attentionBudget);

  if (suggestion.shouldAttend === false) {
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
      triggerLabel: candidate.segment.label,
      triggerContent: candidate.segment.content,
      reasonPrefix: safeCreatureText(decision?.whySelected) ?? "",
      score: candidate.score,
      now
    });
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

function buildSemanticAttentionPrompt(profile: CreatureProfile, result: CaptureResult, source: AttentionSource) {
  return `请作为 Papo 的注意决策脑，从这一组真实输入片段里决定 Papo 此刻要认真回应哪几段。

输入来源：${source === "button" ? "用户主动发来的一条直接消息" : "持续陪伴/多模态信息流的一组片段"}。
系统已经整理了候选片段和注意预算。你负责具体判断：
- 哪些段值得注意。
- 哪些段应该暂时略过。
- 为什么注意。
- 注意到的核心内容是什么。
- 这段内容对用户可能意味着什么。
- 它是否自然关联到 recent_memories 里的旧记忆。
- 如果都只是背景声、空白、误触或没有可用生活信息，可以 shouldAttend=false。
- 用户主动发来的直接消息通常值得注意；但仍由你判断是否只是误触、空白或无需进入后续 cognition。
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
    "memoryRelation":"...",
    "relatedMemoryIds":["ltm_xxx"],
    "tags":["..."]
  }],
  "ignored": [{"segmentId":"s2","whyIgnored":"..."}],
  "creatureReport": "...",
  "trace": ["..."]
}

current_state:
${JSON.stringify(profile.state)}

current_policy:
${JSON.stringify(profile.policyProfile)}

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
  content: modelSafeSegmentContent(candidate.segment.content),
  contentHiddenForPrivacy: isHighPrivacySegmentContent(candidate.segment.content),
  alreadySelected: candidate.selectedByModel,
  pacingScore: candidate.score.total,
  privacyRisk: candidate.score.privacyRisk
})))}
`;
}

function modelSafeSegmentContent(text: string) {
  return text;
}

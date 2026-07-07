import { z } from "zod";
import { buildAttentionEvent, composeCreatureResponse, composeStreamSummary, isHighPrivacySegmentContent } from "./attention";
import { makeId } from "./ids";
import { modelConversationContext, modelFeedbackContext, modelMemoryContext } from "./model-context";
import { createEpisodeFromEvent, createMemoryCandidateFromEpisode, normalizeSharedMemoryText } from "./memory";
import type { ModelProvider } from "./provider";
import { applyStateDelta } from "./state";
import type { CaptureResult, CreatureProfile } from "./types";

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
        whySelected: optionalText(360)
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

export async function semanticDecideAttention(profile: CreatureProfile, result: CaptureResult, provider: ModelProvider): Promise<CaptureResult> {
  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for attention.");
  if (!result.curiousSession || !result.attentionCandidates?.length) return result;

  const raw = await provider.generateJson<unknown>(buildSemanticAttentionPrompt(profile, result));
  if (!raw) throw new Error("empty attention model result");
  const parsed = semanticAttentionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid attention JSON (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  }
  const applied = applySemanticAttention(profile, result, parsed.data);
  if (!applied && parsed.data.shouldAttend !== false) throw new Error("attention model did not select any valid segment");
  recordAttentionSemanticRun(
    profile,
    provider,
    applied ? "applied" : "applied",
    applied ? "llm attention decision applied" : "llm attention decision ignored all candidates"
  );
  return result;
}

function applySemanticAttention(profile: CreatureProfile, result: CaptureResult, suggestion: SemanticAttentionSuggestion) {
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
  const selectedReason = new Map((suggestion.selected ?? []).map((item) => [item.segmentId, safeCreatureText(item.whySelected)]));
  const ignoredReason = new Map((suggestion.ignored ?? []).map((item) => [item.segmentId, safeCreatureText(item.whyIgnored)]));
  for (const candidate of selectedFromModel) {
    if (!selectedReason.get(candidate.segment.id)) throw new Error("attention model did not explain a selected segment");
  }

  const oldEpisodeIds = new Set(result.episodes.map((episode) => episode.id));
  profile.episodes = profile.episodes.filter((episode) => !oldEpisodeIds.has(episode.id));
  profile.memoryCandidates = profile.memoryCandidates.filter((candidate) => !oldEpisodeIds.has(candidate.sourceEpisodeId));

  const now = session.createdAt;
  const events = selectedFromModel.map((candidate) => {
    const event = buildAttentionEvent(profile, {
      source: "curious_stream",
      triggerSegmentId: candidate.segment.id,
      triggerBatchId: candidate.segment.batchId,
      triggerObservedAt: candidate.segment.observedAt,
      triggerLocation: candidate.segment.location,
      triggerLabel: candidate.segment.label,
      triggerContent: candidate.segment.content,
      reasonPrefix: selectedReason.get(candidate.segment.id) ?? "",
      score: candidate.score,
      now
    });
    event.semanticSource = "llm";
    event.decisionTrace = [
      ...(event.decisionTrace ?? []),
      "llm: selected this segment for attention",
      `guardrail: attention_budget=${session.attentionBudget}`
    ];
    return event;
  });

  const episodes = events.map((event) => createEpisodeFromEvent(event, composeCreatureResponse(profile, event), now));
  profile.episodes.unshift(...episodes);
  if (events.length) {
    applyStateDelta(
      profile,
      { curiosity: 5, energy: -4 - Math.max(0, events.length - 1), arousal: events.length > 1 ? 4 : 1, attachment: 1 },
      "model selected curious stream attention",
      now
    );
  }
  const memoryCandidates = episodes.map((episode) => createMemoryCandidateFromEpisode(profile, episode, { now }));

  result.events = events;
  result.episodes = episodes;
  result.memoryCandidates = memoryCandidates;
  result.attentionCandidates = candidates.map((candidate) => ({ ...candidate, selectedByModel: selectedIds.has(candidate.segment.id) }));
  session.selected = selectedFromModel.map((candidate) => ({
    segmentId: candidate.segment.id,
    label: candidate.segment.label,
    score: candidate.score,
    whySelected: selectedReason.get(candidate.segment.id) ?? ""
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
  result.response = composeStreamSummary(events, session);
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
  result.response = safeCreatureText(suggestion.creatureReport) ?? "";
  if (!result.response && candidates.some((candidate) => !ignoredReason.get(candidate.segment.id))) {
    throw new Error("attention model chose quiet without a usable report or ignored reasons");
  }
  session.selected = [];
  session.ignored = candidates.map((candidate) => ({
    segmentId: candidate.segment.id,
    label: candidate.segment.label,
    score: candidate.score,
    whyIgnored: ignoredReason.get(candidate.segment.id) ?? ""
  }));
  session.creatureReport = result.response;
}

function safeCreatureText(text?: string) {
  const normalized = normalizeSharedMemoryText(text ?? "");
  if (!normalized) return undefined;
  return normalized;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function recordAttentionSemanticRun(profile: CreatureProfile, provider: ModelProvider, status: "skipped" | "applied" | "empty" | "invalid" | "failed", message: string) {
  profile.semanticBrainHistory.unshift({
    id: makeId("semantic"),
    at: new Date().toISOString(),
    source: "curious_stream",
    providerKind: provider.kind,
    providerName: provider.name,
    status,
    message,
    ruleTrace: [`provider=${provider.kind}`, "source=curious_stream", `status=${status}`, "stage=attention"]
  });
  profile.semanticBrainHistory = profile.semanticBrainHistory.slice(0, 30);
}

function buildSemanticAttentionPrompt(profile: CreatureProfile, result: CaptureResult) {
  return `请作为 Papo 的注意决策脑，从这一组真实输入片段里决定 Papo 此刻要认真回应哪几段。

系统已经整理了候选片段和注意预算。你负责具体判断：
- 哪些段值得注意。
- 哪些段应该暂时略过。
- 为什么。
- 如果都只是背景声，可以 shouldAttend=false。

护栏会校验：
- selected.segmentId 必须来自 candidates。
- selected 数量不能超过 attentionBudget。
- 不能新增不存在的片段。
- 后续事件、episode、memory candidate 只会从最终 selected 生成。
普通用户看到的是 Papo 听见了什么、回应了什么，不看规则解释。

返回严格 JSON：
{
  "shouldAttend": true,
  "selected": [{"segmentId":"s1","whySelected":"..."}],
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
  content: modelSafeSegmentContent(candidate.segment.content),
  contentHiddenForPrivacy: isHighPrivacySegmentContent(candidate.segment.content),
  alreadySelected: candidate.selectedByModel,
  pacingScore: candidate.score.total,
  privacyRisk: candidate.score.privacyRisk,
  relatedIds: candidate.score.relatedIds,
  tags: modelSafeTags(candidate.segment.content, candidate.score.tags)
})))}
`;
}

function modelSafeSegmentContent(text: string) {
  return text;
}

function modelSafeTags(text: string, tags: string[]) {
  void text;
  return tags;
}

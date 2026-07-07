import { z } from "zod";
import { buildAttentionEvent, composeCreatureResponse, composeStreamSummary, isHighPrivacySegmentContent } from "./attention";
import { createCuriousCreatureReport } from "./experience";
import { makeId } from "./ids";
import { createEpisodeFromEvent, createMemoryCandidateFromEpisode, normalizeSharedMemoryText } from "./memory";
import type { ModelProvider } from "./provider";
import type { CaptureResult, CreatureProfile } from "./types";

const optionalText = (max: number) =>
  z.preprocess((value) => (typeof value === "string" && !value.trim() ? undefined : value), z.string().min(1).max(max).optional());
const optionalTextArray = (maxItems: number, maxText: number) =>
  z
    .array(z.preprocess((value) => (typeof value === "string" ? value.trim() : value), z.string().max(maxText)).optional())
    .transform((values) => values.filter((value): value is string => Boolean(value)))
    .pipe(z.array(z.string().min(1).max(maxText)).max(maxItems))
    .optional();

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
  if (!provider.usesRealModel || !result.curiousSession || !result.attentionCandidates?.length) return result;

  try {
    const raw = await provider.generateJson<unknown>(buildSemanticAttentionPrompt(profile, result));
    const parsed = semanticAttentionSchema.safeParse(raw);
    if (!parsed.success) {
      recordAttentionSemanticRun(profile, provider, "invalid", `invalid attention JSON (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
      return result;
    }
    const applied = applySemanticAttention(profile, result, parsed.data);
    recordAttentionSemanticRun(
      profile,
      provider,
      applied ? "applied" : parsed.data.shouldAttend === false ? "skipped" : "empty",
      applied
        ? "llm attention decision applied"
        : parsed.data.shouldAttend === false
          ? "llm attention decision skipped all candidates"
          : "llm attention decision had no valid selectable segment"
    );
    return result;
  } catch (error) {
    recordAttentionSemanticRun(profile, provider, "failed", `attention model failed (${error instanceof Error ? error.message : "unknown"})`);
    return result;
  }
}

function applySemanticAttention(profile: CreatureProfile, result: CaptureResult, suggestion: SemanticAttentionSuggestion) {
  const session = result.curiousSession;
  const candidates = result.attentionCandidates;
  if (!session || !candidates?.length) return false;

  const byId = new Map(candidates.map((candidate) => [candidate.segment.id, candidate]));
  const selectedFromModel = unique((suggestion.selected ?? []).map((item) => item.segmentId))
    .map((segmentId) => byId.get(segmentId))
    .filter((candidate): candidate is AttentionCandidate => Boolean(candidate))
    .filter((candidate) => candidate.score.privacyRisk <= 82 && !isHighPrivacySegmentContent(candidate.segment.content))
    .slice(0, session.attentionBudget);

  if (suggestion.shouldAttend !== false && !selectedFromModel.length) return false;

  const selectedIds = new Set(selectedFromModel.map((candidate) => candidate.segment.id));
  const selectedReason = new Map((suggestion.selected ?? []).map((item) => [item.segmentId, safeCreatureText(item.whySelected)]));
  const ignoredReason = new Map((suggestion.ignored ?? []).map((item) => [item.segmentId, safeCreatureText(item.whyIgnored)]));

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
      reasonPrefix: selectedReason.get(candidate.segment.id) ?? "我在这一组里更想先回应这件事。",
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
  const memoryCandidates = episodes.map((episode) => createMemoryCandidateFromEpisode(profile, episode, { now }));

  result.events = events;
  result.episodes = episodes;
  result.memoryCandidates = memoryCandidates;
  result.attentionCandidates = candidates.map((candidate) => ({ ...candidate, selectedByRules: selectedIds.has(candidate.segment.id) }));
  session.selected = selectedFromModel.map((candidate) => ({
    segmentId: candidate.segment.id,
    label: candidate.segment.label,
    score: candidate.score,
    whySelected: selectedReason.get(candidate.segment.id) ?? "我在这一组里更想先回应这件事。"
  }));
  session.ignored = candidates
    .filter((candidate) => !selectedIds.has(candidate.segment.id))
    .map((candidate) => ({
      segmentId: candidate.segment.id,
      label: candidate.segment.label,
      score: candidate.score,
      whyIgnored: ignoredReason.get(candidate.segment.id) ?? defaultIgnoredReason(candidate)
    }));

  session.creatureReport = safeCreatureText(suggestion.creatureReport) ?? createCuriousCreatureReport(session);
  result.response = composeStreamSummary(events, session);
  result.harnessTrace = [...(result.harnessTrace ?? []), "semantic attention: llm selection applied"];
  return true;
}

function defaultIgnoredReason(candidate: AttentionCandidate) {
  if (isHighPrivacySegmentContent(candidate.segment.content)) return "这里可能有隐私内容，我先等你的意思。";
  if (candidate.score.privacyRisk > 45) return "这里可能有隐私内容，我先等你的意思。";
  if (candidate.score.redundancyPenalty > 0) return "它和刚才的事太像，我先不重复打断。";
  return "这次我先不打断，等你继续说。";
}

function safeCreatureText(text?: string) {
  const normalized = normalizeSharedMemoryText(text ?? "");
  if (!normalized || containsInternalLanguage(normalized)) return undefined;
  return normalized;
}

function containsInternalLanguage(text: string) {
  return /LLM|语义|用户意图|用户在|用户希望|系统|后台|流程|attention|semantic|harness|candidate|episode|数据库|规则层|写入|情景记忆|情景片段|保存意图|长期保存|长期记忆|prompt|JSON|score|阈值|总分|fallback|选中|忽略/i.test(text);
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
  return `请作为 Papo 的注意决策脑，从这一组候选生活片段里决定 Papo 此刻要认真回应哪几段。

规则层已经整理了候选、基础分数、隐私线索、旧记忆关系和注意预算。你负责具体判断：
- 哪些段值得注意。
- 哪些段应该暂时略过。
- 为什么。
- 如果都只是背景声，可以 shouldAttend=false。

规则会校验：
- selected.segmentId 必须来自 candidates。
- selected 数量不能超过 attentionBudget。
- 高隐私片段不能被强行选中。
- 不能新增不存在的片段。
- 后续事件、episode、memory candidate 只会从最终 selected 生成。

不要输出内部词：LLM、语义、后台、流程、candidate、episode、score、阈值、JSON、数据库、写入、长期记忆、情景记忆。
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
${JSON.stringify(profile.longTermMemories.slice(0, 8).map((memory) => ({ id: memory.id, kind: memory.kind, text: memory.text, weight: memory.weight, tags: memory.tags })))}

recent_feedback:
${JSON.stringify(profile.feedbackHistory.slice(0, 6).map((item) => ({ kind: item.kind, inputText: item.inputText, learningNote: item.learningNote, targetId: item.targetId })))}

attentionBudget:
${result.curiousSession?.attentionBudget ?? 0}

candidates:
${JSON.stringify((result.attentionCandidates ?? []).map((candidate) => ({
  segmentId: candidate.segment.id,
  label: candidate.segment.label,
  content: modelSafeSegmentContent(candidate.segment.content),
  contentHiddenForPrivacy: isHighPrivacySegmentContent(candidate.segment.content),
  selectedByRules: candidate.selectedByRules,
  scoreTotal: candidate.score.total,
  privacyRisk: candidate.score.privacyRisk,
  relatedIds: candidate.score.relatedIds,
  tags: modelSafeTags(candidate.segment.content, candidate.score.tags)
})))}
`;
}

function modelSafeSegmentContent(text: string) {
  if (!isHighPrivacySegmentContent(text)) return text;
  return "[这段包含可能的密钥、验证码、密码、地址或证件信息，原文已隐藏；只能把它留在安静等待里，不能选择为注意事件。]";
}

function modelSafeTags(text: string, tags: string[]) {
  if (!isHighPrivacySegmentContent(text)) return tags;
  return [];
}

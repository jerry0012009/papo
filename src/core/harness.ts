import { z } from "zod";
import { guardActionDecision } from "./action";
import { createMemoryResonanceEmergence } from "./emergence";
import { handleButtonCapture, handleCuriousStream } from "./attention";
import { createCuriousCreatureReport } from "./experience";
import { makeId } from "./ids";
import { normalizeSharedMemoryText } from "./memory";
import type { ModelProvider } from "./provider";
import type { CaptureResult, CreatureProfile, SemanticBrainRecord, StreamSegment } from "./types";

const actionSchema = z.enum(["observe", "respond", "ask", "save_episode", "save_long_term", "recall", "review", "quiet", "draft_reminder", "draft_question_list"]);

const brainSuggestionSchema = z.object({
  response: z.string().min(1).max(900).optional(),
  interaction: z
    .object({
      userIntent: z.string().min(1).max(260).optional(),
      emotionalTone: z.string().min(1).max(160).optional(),
      shouldReply: z.boolean().optional(),
      suggestedAction: actionSchema.optional(),
      reply: z.string().min(1).max(700).optional(),
      memoryCandidateText: z.string().min(1).max(500).optional(),
      memoryTags: z.array(z.string().min(1).max(40)).max(8).optional()
    })
    .optional(),
  events: z
    .array(
      z.object({
        id: z.string(),
        noticed: z.string().min(1).max(260).optional(),
        reason: z.string().min(1).max(420).optional(),
        suggestedAction: actionSchema.optional()
      })
    )
    .optional(),
  episodes: z
    .array(
      z.object({
        eventId: z.string(),
        possibleIntent: z.string().min(1).max(260).optional(),
        importanceReason: z.string().min(1).max(360).optional(),
        creatureResponse: z.string().min(1).max(700).optional()
      })
    )
    .optional(),
  curiousSession: z
    .object({
      creatureReport: z.string().min(1).max(900).optional(),
      selected: z
        .array(
          z.object({
            segmentId: z.string(),
            whySelected: z.string().min(1).max(360)
          })
        )
        .max(8)
        .optional(),
      ignored: z
        .array(
          z.object({
            segmentId: z.string(),
            whyIgnored: z.string().min(1).max(360)
          })
        )
        .max(12)
        .optional()
    })
    .optional(),
  trace: z.array(z.string().min(1).max(160)).max(8).optional()
}).refine(
  (value) =>
    Boolean(
      value.response ||
        value.interaction ||
        value.events?.length ||
        value.episodes?.length ||
        value.curiousSession?.creatureReport ||
        value.curiousSession?.selected?.length ||
        value.curiousSession?.ignored?.length ||
        value.trace?.length
    ),
  "semantic brain result must contain at least one useful field"
);

type BrainSuggestion = z.infer<typeof brainSuggestionSchema>;
type SemanticBrainAskResult =
  | { status: "applied"; suggestion: BrainSuggestion; message: string }
  | { status: "empty" | "invalid"; message: string };

export async function runButtonHarness(
  profile: CreatureProfile,
  text: string,
  provider: ModelProvider,
  now = new Date().toISOString()
): Promise<CaptureResult> {
  const result = handleButtonCapture(profile, text, now);
  return enrichWithSemanticBrain(profile, result, provider, "button");
}

export async function runCuriousHarness(
  profile: CreatureProfile,
  segments: StreamSegment[],
  provider: ModelProvider,
  now = new Date().toISOString()
): Promise<CaptureResult> {
  const result = handleCuriousStream(profile, segments, now);
  return enrichWithSemanticBrain(profile, result, provider, "curious_stream");
}

async function enrichWithSemanticBrain(
  profile: CreatureProfile,
  result: CaptureResult,
  provider: ModelProvider,
  source: "button" | "curious_stream"
): Promise<CaptureResult> {
  const trace = [
    `sense: ${source}`,
    "rules: generated candidate attention events",
    `provider: ${provider.kind}`
  ];

  if (!provider.usesRealModel || !result.events.length) {
    applyFallbackInteractionUnderstanding(profile, result, source);
    recordMemoryResonance(profile, result);
    result.harnessTrace = [...trace, "semantic: fallback/rules only"];
    recordSemanticBrainRun(profile, provider, source, "skipped", provider.usesRealModel ? "no attention events to enrich" : "fallback provider; rules handled the loop");
    return result;
  }

  try {
    const semantic = await askSemanticBrain(profile, result, provider, source);
    if (semantic.status !== "applied") {
      applyFallbackInteractionUnderstanding(profile, result, source);
      recordMemoryResonance(profile, result);
      result.harnessTrace = [...trace, `semantic: ${semantic.message}`];
      recordSemanticBrainRun(profile, provider, source, semantic.status, semantic.message);
      return result;
    }

    const suggestion = semantic.suggestion;
    applySuggestion(profile, result, suggestion);
    result.harnessTrace = [...trace, "semantic: llm interpretation applied", ...(suggestion.trace ?? [])];
    recordSemanticBrainRun(profile, provider, source, "applied", semantic.message);
    return result;
  } catch (error) {
    const message = `model failed (${error instanceof Error ? error.message : "unknown"})`;
    applyFallbackInteractionUnderstanding(profile, result, source);
    recordMemoryResonance(profile, result);
    result.harnessTrace = [...trace, `semantic: ${message}`];
    recordSemanticBrainRun(profile, provider, source, "failed", message);
    return result;
  }
}

function applyFallbackInteractionUnderstanding(
  profile: CreatureProfile,
  result: CaptureResult,
  source: "button" | "curious_stream"
) {
  if (source !== "button") return;
  const event = result.events[0];
  const episode = result.episodes[0];
  if (!event || !episode) return;
  if (!looksLikeDirectCall(event.triggerContent)) return;

  event.actionDecision = guardActionDecision(event, profile, "respond");
  event.suggestedAction = event.actionDecision.action;
  event.semanticSource = "fallback";
  event.decisionTrace = [
    ...(event.decisionTrace ?? []),
    "fallback: direct-call heuristic used because semantic model was unavailable",
    `guardrail: action=${event.actionDecision.action}`
  ];

  const reply = "我在，听见了。我会把这次你叫我说话的小片段先记成一段情景记忆。";
  result.response = reply;
  episode.creatureResponse = reply;
  episode.actionDecision = event.actionDecision;
  episode.decisionTrace = event.decisionTrace;
  episode.creatureExperience = {
    ...event.creatureExperience,
    earReason: "我刚才竖起耳朵，是因为你在对我发出一个需要回应的小信号。",
    actionFeeling: "我选择先回应你，让这次互动往前走一步。",
    saveFeeling: "这会先成为一条轻量情景记忆，等你的反馈决定要不要长久留下。"
  };
  updateMemoryCandidate(result, episode.id, `你曾经对我说：${event.triggerContent.trim()}。当时我回应你：${reply}`, ["回应", "共同经历"]);
}

function looksLikeDirectCall(text: string) {
  return /说句话|说话|回复|回答|你在吗|你好|hello|汪|打招呼|叫你|听见|听到|回应/i.test(text);
}

async function askSemanticBrain(
  profile: CreatureProfile,
  result: CaptureResult,
  provider: ModelProvider,
  source: "button" | "curious_stream"
): Promise<SemanticBrainAskResult> {
  const suggestion = await provider.generateJson<unknown>(buildPrompt(profile, result, source));
  if (!suggestion) return { status: "empty", message: "empty model result" };
  const parsed = brainSuggestionSchema.safeParse(suggestion);
  if (!parsed.success) {
    return {
      status: "invalid",
      message: `invalid model JSON (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`
    };
  }
  return { status: "applied", suggestion: parsed.data, message: "llm interpretation applied" };
}

function applySuggestion(profile: CreatureProfile, result: CaptureResult, suggestion: BrainSuggestion) {
  const eventById = new Map(result.events.map((event) => [event.id, event]));
  const episodeByEventId = new Map(result.events.map((event, index) => [event.id, result.episodes[index]]));
  const primaryEvent = result.events[0];
  const primaryEpisode = primaryEvent ? episodeByEventId.get(primaryEvent.id) : undefined;

  if (suggestion.interaction && primaryEvent) {
    const interaction = suggestion.interaction;
    const suggestedAction = interaction.suggestedAction ?? (interaction.shouldReply ? "respond" : undefined);
    if (suggestedAction) {
      primaryEvent.actionDecision = guardActionDecision(primaryEvent, profile, suggestedAction);
      primaryEvent.suggestedAction = primaryEvent.actionDecision.action;
    }
    primaryEvent.semanticSource = "llm";
    primaryEvent.decisionTrace = [
      ...(primaryEvent.decisionTrace ?? []),
      "llm: structured interaction understood",
      interaction.userIntent ? `intent=${interaction.userIntent}` : "intent=not_provided",
      `guardrail: action=${primaryEvent.actionDecision.action}`
    ];
    if (primaryEpisode) {
      if (interaction.userIntent) primaryEpisode.possibleIntent = interaction.userIntent;
      if (interaction.reply) primaryEpisode.creatureResponse = interaction.reply;
      if (interaction.memoryTags?.length) primaryEpisode.tags = interaction.memoryTags;
      updateMemoryCandidate(result, primaryEpisode.id, interaction.memoryCandidateText, interaction.memoryTags);
    }
    if (interaction.reply) result.response = interaction.reply;
  }

  for (const eventSuggestion of suggestion.events ?? []) {
    const event = eventById.get(eventSuggestion.id);
    if (!event) continue;

    if (eventSuggestion.noticed) event.noticed = eventSuggestion.noticed;
    if (eventSuggestion.reason) event.reason = eventSuggestion.reason;
    if (eventSuggestion.suggestedAction) {
      event.actionDecision = guardActionDecision(event, profile, eventSuggestion.suggestedAction);
      event.suggestedAction = event.actionDecision.action;
    }
    event.semanticSource = "llm";
    event.decisionTrace = [
      ...(event.decisionTrace ?? []),
      "llm: semantic interpretation proposed",
      `guardrail: action=${event.actionDecision.action}`
    ];
  }

  for (const episodeSuggestion of suggestion.episodes ?? []) {
    const episode = episodeByEventId.get(episodeSuggestion.eventId);
    if (!episode) continue;
    if (episodeSuggestion.possibleIntent) episode.possibleIntent = episodeSuggestion.possibleIntent;
    if (episodeSuggestion.importanceReason) episode.importanceReason = episodeSuggestion.importanceReason;
    if (episodeSuggestion.creatureResponse) episode.creatureResponse = episodeSuggestion.creatureResponse;
    episode.decisionTrace = [
      ...(episode.decisionTrace ?? []),
      "llm: episode wording enriched"
    ];
  }

  applyCuriousSessionSuggestion(result, suggestion);

  for (const event of result.events) {
    const episode = episodeByEventId.get(event.id);
    if (!episode) continue;
    episode.noticed = event.noticed;
    episode.importanceReason = event.reason;
    episode.decisionTrace = event.decisionTrace;
    episode.actionDecision = event.actionDecision;
    episode.creatureExperience = event.creatureExperience;
  }

  if (suggestion.interaction && primaryEvent && primaryEpisode) {
    primaryEvent.creatureExperience = interactionExperience(suggestion.interaction, primaryEvent);
    primaryEpisode.creatureExperience = primaryEvent.creatureExperience;
  }

  recordMemoryResonance(profile, result);

  if (suggestion.response) result.response = suggestion.response;
  if (primaryEpisode && result.response) {
    primaryEpisode.creatureResponse = result.response;
  }
}

function applyCuriousSessionSuggestion(result: CaptureResult, suggestion: BrainSuggestion) {
  const session = result.curiousSession;
  const narrative = suggestion.curiousSession;
  if (!session || !narrative) return;

  const selectedById = new Map(session.selected.map((item) => [item.segmentId, item]));
  for (const item of narrative.selected ?? []) {
    const selected = selectedById.get(item.segmentId);
    if (selected) selected.whySelected = item.whySelected.trim();
  }

  const ignoredById = new Map(session.ignored.map((item) => [item.segmentId, item]));
  for (const item of narrative.ignored ?? []) {
    const ignored = ignoredById.get(item.segmentId);
    if (ignored) ignored.whyIgnored = item.whyIgnored.trim();
  }

  session.creatureReport = narrative.creatureReport?.trim() || createCuriousCreatureReport(session);
}

function interactionExperience(interaction: NonNullable<BrainSuggestion["interaction"]>, event: CaptureResult["events"][number]) {
  const intent = interaction.userIntent?.trim();
  const action = event.actionDecision.action;
  return {
    ...event.creatureExperience,
    earReason: intent ? `我刚才竖起耳朵，是因为${trimSentence(intent)}。` : event.creatureExperience.earReason,
    actionFeeling: interaction.reply
      ? action === "respond"
        ? "我选择先回应你，让这次互动往前走一步。"
        : "我已经根据这次理解选择了下一步行动，并把回应放在行动后面。"
      : event.creatureExperience.actionFeeling,
    saveFeeling: interaction.memoryCandidateText
      ? "这会先成为一条轻量情景记忆，等你的反馈决定要不要长久留下。"
      : event.creatureExperience.saveFeeling
  };
}

function trimSentence(text: string) {
  return text.replace(/[。.!！]+$/, "");
}

function updateMemoryCandidate(result: CaptureResult, sourceEpisodeId: string, text?: string, tags?: string[]) {
  const candidate = result.memoryCandidates?.find((item) => item.sourceEpisodeId === sourceEpisodeId);
  if (!candidate) return;
  if (text?.trim()) candidate.candidateText = normalizeSharedMemoryText(text);
  if (tags?.length) candidate.tags = tags;
}

function recordMemoryResonance(profile: CreatureProfile, result: CaptureResult) {
  for (const event of result.events) {
    if (event.relatedMemoryIds.length) createMemoryResonanceEmergence(profile, event);
  }
}

function recordSemanticBrainRun(
  profile: CreatureProfile,
  provider: ModelProvider,
  source: SemanticBrainRecord["source"],
  status: SemanticBrainRecord["status"],
  message: string
) {
  profile.semanticBrainHistory.unshift({
    id: makeId("semantic"),
    at: new Date().toISOString(),
    source,
    providerKind: provider.kind,
    providerName: provider.name,
    status,
    message,
    ruleTrace: [`provider=${provider.kind}`, `source=${source}`, `status=${status}`]
  });
  profile.semanticBrainHistory = profile.semanticBrainHistory.slice(0, 30);
}

function buildPrompt(profile: CreatureProfile, result: CaptureResult, source: "button" | "curious_stream") {
  return `请作为 Papo 的语义脑，读取规则层产生的候选 attention events，改进语义理解和表达。

你可以：
- 先判断这是不是一次互动：用户是在呼唤、要求回应、倾诉、要求记住、要求提醒，还是只是给环境素材。
- 改写 noticed/reason，让它更像小动物真的注意到了什么。
- 给出 suggestedAction，但只能从 observe, respond, ask, save_episode, save_long_term, recall, review, quiet, draft_reminder, draft_question_list 选择。
- 改写 episode 的 possibleIntent/importanceReason/creatureResponse。
- 如果 source 是 curious_stream，可以改写 curiousSession.selected/ignored 的 whySelected/whyIgnored 和 creatureReport；只能解释规则层已经选中或放过的片段，不能新增、删除、排序或改变分数。
- 给出一条 memoryCandidateText，必须是这次真实互动可记住的小回忆，不要写流程说明。
- 写一段 response，给用户展示这次小动物的整体回应。

你不能：
- 改状态数值。
- 删除用户记忆。
- 在高隐私风险时建议直接长期保存。
- 输出数据库解释或产品说明口吻。

返回严格 JSON：
{
  "response": "...",
  "interaction": {"userIntent":"...", "emotionalTone":"...", "shouldReply":true, "suggestedAction":"respond", "reply":"...", "memoryCandidateText":"...", "memoryTags":["..."]},
  "events": [{"id":"...", "noticed":"...", "reason":"...", "suggestedAction":"..."}],
  "episodes": [{"eventId":"...", "possibleIntent":"...", "importanceReason":"...", "creatureResponse":"..."}],
  "curiousSession": {"creatureReport":"...", "selected":[{"segmentId":"...", "whySelected":"..."}], "ignored":[{"segmentId":"...", "whyIgnored":"..."}]},
  "trace": ["短审计线索"]
}

profile_state:
${JSON.stringify(profile.state)}

recent_long_term_memories:
${JSON.stringify(profile.longTermMemories.slice(0, 6).map((memory) => ({ id: memory.id, kind: memory.kind, text: memory.text, weight: memory.weight, tags: memory.tags })))}

source:
${source}

candidate_events:
${JSON.stringify(result.events.map((event) => ({
  id: event.id,
  source: event.source,
  triggerLabel: event.triggerLabel,
  triggerContent: event.triggerContent,
  noticed: event.noticed,
  reason: event.reason,
  relatedMemoryIds: event.relatedMemoryIds,
  attentionStrength: event.attentionStrength,
  privacyRisk: event.privacyRisk,
  suggestedAction: event.suggestedAction,
  tags: event.tags
})))}

curious_session_rule_audit:
${JSON.stringify(result.curiousSession ? {
  totalSegments: result.curiousSession.totalSegments,
  attentionBudget: result.curiousSession.attentionBudget,
  stateInfluence: result.curiousSession.stateInfluence,
  selected: result.curiousSession.selected.map((item) => ({
    segmentId: item.segmentId,
    label: item.label,
    whySelected: item.whySelected,
    scoreTotal: item.score.total,
    privacyRisk: item.score.privacyRisk,
    relatedIds: item.score.relatedIds,
    tags: item.score.tags
  })),
  ignored: result.curiousSession.ignored.map((item) => ({
    segmentId: item.segmentId,
    label: item.label,
    whyIgnored: item.whyIgnored,
    scoreTotal: item.score.total,
    privacyRisk: item.score.privacyRisk,
    redundancyPenalty: item.score.redundancyPenalty,
    tags: item.score.tags
  }))
} : null)}
`;
}

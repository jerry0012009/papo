import { z } from "zod";
import { guardActionDecision } from "./action";
import { buildAttentionEvent, handleButtonCapture, handleCuriousStream, isHighPrivacySegmentContent } from "./attention";
import { makeId } from "./ids";
import { modelConversationContext, modelMemoryContext } from "./model-context";
import { createEpisodeFromEvent, createMemoryCandidateFromEpisode, normalizeSharedMemoryText } from "./memory";
import type { ModelProvider } from "./provider";
import { semanticSelectAction } from "./semantic-action";
import { semanticDecideAttention } from "./semantic-attention";
import { semanticDecideMemory } from "./semantic-memory";
import type { ActionKind, CaptureResult, CreatureProfile, SemanticBrainRecord, StreamSegment } from "./types";

const actionSchema = z.enum(["observe", "respond", "ask", "save_episode", "save_long_term", "recall", "review", "quiet", "draft_reminder", "draft_question_list"]);
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

const brainSuggestionSchema = z.object({
  response: optionalText(900),
  interaction: z
    .object({
      userIntent: optionalText(260),
      emotionalTone: optionalText(160),
      visibleReaction: optionalText(260),
      shouldReply: z.boolean().optional(),
      suggestedAction: actionSchema.optional(),
      reply: optionalText(700),
      memoryCandidateText: optionalText(500),
      memoryTags: optionalTextArray(8, 40)
    })
    .optional(),
  events: z
    .array(
      z.object({
        id: z.string(),
        noticed: optionalText(260),
        reason: optionalText(420),
        suggestedAction: actionSchema.optional()
      })
    )
    .optional(),
  episodes: z
    .array(
      z.object({
        eventId: z.string(),
        possibleIntent: optionalText(260),
        importanceReason: optionalText(360),
        creatureResponse: optionalText(700)
      })
    )
    .optional(),
  curiousSession: z
    .object({
      creatureReport: optionalText(900),
      selected: z
        .array(
          z.object({
            segmentId: z.string(),
            whySelected: optionalText(360)
          })
        )
        .max(8)
        .optional(),
      ignored: z
        .array(
          z.object({
            segmentId: z.string(),
            whyIgnored: optionalText(360)
          })
        )
        .max(12)
        .optional()
    })
    .optional(),
  trace: optionalTextArray(8, 160)
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
type SemanticBrainAskResult = { suggestion: BrainSuggestion; message: string };

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

  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for cognition.");
  if (!result.events.length) throw new Error("Papo did not produce any attention event to interpret.");

  if (source === "curious_stream") {
    await semanticDecideAttention(profile, result, provider);
    if (!result.events.length) {
      result.harnessTrace = [...trace, "semantic: llm ignored all candidates"];
      recordSemanticBrainRun(profile, provider, source, "applied", "llm attention decision ignored all candidates");
      return result;
    }
  }
  clearRuleVisibleDrafts(result);
  await semanticSelectAction(profile, result, provider, source);
  const semantic = await askSemanticBrain(profile, result, provider, source);
  const suggestion = semantic.suggestion;
  applySuggestion(profile, result, suggestion, source);
  ensureVisibleOutputContract(result);
  if (result.memoryCandidates?.length) {
    await semanticDecideMemory(profile, result.memoryCandidates, provider);
  }
  result.harnessTrace = [...trace, "semantic: llm interpretation applied", ...(suggestion.trace ?? [])];
  recordSemanticBrainRun(profile, provider, source, "applied", semantic.message);
  return result;
}

async function askSemanticBrain(
  profile: CreatureProfile,
  result: CaptureResult,
  provider: ModelProvider,
  source: "button" | "curious_stream"
): Promise<SemanticBrainAskResult> {
  const suggestion = await provider.generateJson<unknown>(buildPrompt(profile, result, source));
  if (!suggestion) throw new Error("empty model result");
  const parsed = brainSuggestionSchema.safeParse(suggestion);
  if (!parsed.success) {
    throw new Error(`invalid model JSON (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  }
  return { suggestion: parsed.data, message: "llm interpretation applied" };
}

function applySuggestion(profile: CreatureProfile, result: CaptureResult, suggestion: BrainSuggestion, source: "button" | "curious_stream") {
  const eventById = new Map(result.events.map((event) => [event.id, event]));
  const episodeByEventId = new Map(result.events.map((event, index) => [event.id, result.episodes[index]]));
  const primaryEvent = result.events[0];
  const primaryEpisode = primaryEvent ? episodeByEventId.get(primaryEvent.id) : undefined;

  if (suggestion.interaction && primaryEvent) {
    const interaction = suggestion.interaction;
    const suggestedAction = semanticActionFromInteraction(interaction, profile);
    const actionConflict = hasAppliedSemanticAction(primaryEvent) && Boolean(suggestedAction) && suggestedAction !== primaryEvent.actionDecision.action;
    if (suggestedAction && !hasAppliedSemanticAction(primaryEvent)) {
      primaryEvent.actionDecision = guardActionDecision(primaryEvent, profile, suggestedAction);
      primaryEvent.suggestedAction = primaryEvent.actionDecision.action;
    }
    primaryEvent.semanticSource = "llm";
    primaryEvent.decisionTrace = [
      ...(primaryEvent.decisionTrace ?? []),
      "llm: structured interaction understood",
      interaction.userIntent ? `intent=${interaction.userIntent}` : "intent=not_provided",
      interaction.suggestedAction ? "llm_action=explicit" : suggestedAction ? `llm_default_action=${suggestedAction}` : "llm_action=not_provided",
      `guardrail: action=${primaryEvent.actionDecision.action}`
    ];
    if (primaryEpisode) {
      if (interaction.userIntent) primaryEpisode.possibleIntent = safeProcessText(interaction.userIntent, primaryEpisode.possibleIntent) ?? primaryEpisode.possibleIntent;
      const safeReply = actionConflict ? undefined : safeExternalReplyText(interaction.reply, primaryEvent.triggerContent);
      if (safeReply) primaryEpisode.creatureResponse = safeReply;
      if (interaction.memoryTags?.length) primaryEpisode.tags = interaction.memoryTags;
      updateMemoryCandidate(result, primaryEpisode.id, interaction.memoryCandidateText, interaction.memoryTags);
    }
    const safeReply = actionConflict ? undefined : safeExternalReplyText(interaction.reply, primaryEvent.triggerContent);
    if (safeReply && interaction.reply) {
      result.response = safeReply;
    } else if (!actionConflict && interaction.shouldReply === false && suggestedAction) {
      result.response = "";
      if (primaryEpisode) primaryEpisode.creatureResponse = "";
    }
  }

  for (const eventSuggestion of suggestion.events ?? []) {
    const event = eventById.get(eventSuggestion.id);
    if (!event) continue;

    if (eventSuggestion.noticed) event.noticed = safeProcessText(eventSuggestion.noticed, event.noticed) ?? event.noticed;
    if (eventSuggestion.reason) event.reason = safeProcessText(eventSuggestion.reason, event.reason) ?? event.reason;
    if (eventSuggestion.suggestedAction) {
      if (!hasAppliedSemanticAction(event)) {
        event.actionDecision = guardActionDecision(event, profile, eventSuggestion.suggestedAction);
        event.suggestedAction = event.actionDecision.action;
      }
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
    if (episodeSuggestion.possibleIntent) episode.possibleIntent = safeProcessText(episodeSuggestion.possibleIntent, episode.possibleIntent) ?? episode.possibleIntent;
    if (episodeSuggestion.importanceReason) episode.importanceReason = safeProcessText(episodeSuggestion.importanceReason, episode.importanceReason) ?? episode.importanceReason;
    if (episodeSuggestion.creatureResponse) {
      const event = result.events.find((item) => item.id === episodeSuggestion.eventId);
      episode.creatureResponse = safeExternalReplyText(episodeSuggestion.creatureResponse, event?.triggerContent) ?? episode.creatureResponse;
    }
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

  if (suggestion.response && !shouldSuppressTopLevelResponse(suggestion.interaction) && !hasConflictingAppliedAction(primaryEvent, suggestion, profile)) {
    result.response = safeExternalReplyText(suggestion.response, primaryEvent?.triggerContent) ?? result.response;
  }
  if (primaryEpisode && result.response) {
    primaryEpisode.creatureResponse = result.response;
  }
}

function semanticActionFromInteraction(
  interaction: NonNullable<BrainSuggestion["interaction"]>,
  profile: CreatureProfile
): ActionKind | undefined {
  if (interaction.suggestedAction) return interaction.suggestedAction;
  if (interaction.shouldReply === true) return "respond";
  if (interaction.shouldReply === false) {
    if (profile.state.energy < 30 || profile.policyProfile.quietTendency > 58) return "quiet";
    return "observe";
  }
  return undefined;
}

function shouldSuppressTopLevelResponse(interaction?: BrainSuggestion["interaction"]) {
  return interaction?.shouldReply === false && !interaction.reply;
}

function hasAppliedSemanticAction(event: CaptureResult["events"][number]) {
  return event.decisionTrace?.some((item) => item === "llm: action selected") ?? false;
}

function hasConflictingAppliedAction(primaryEvent: CaptureResult["events"][number] | undefined, suggestion: BrainSuggestion, profile: CreatureProfile) {
  if (!primaryEvent || !suggestion.interaction || !hasAppliedSemanticAction(primaryEvent)) return false;
  const suggestedAction = semanticActionFromInteraction(suggestion.interaction, profile);
  return Boolean(suggestedAction) && suggestedAction !== primaryEvent.actionDecision.action;
}

function applyCuriousSessionSuggestion(result: CaptureResult, suggestion: BrainSuggestion) {
  const session = result.curiousSession;
  const narrative = suggestion.curiousSession;
  if (!session || !narrative) return;

  const selectedById = new Map(session.selected.map((item) => [item.segmentId, item]));
  const ignoredById = new Map(session.ignored.map((item) => [item.segmentId, item]));
  for (const item of narrative.selected ?? []) {
    const selected = selectedById.get(item.segmentId);
    const whySelected = safeCreatureFacingText(item.whySelected)?.trim();
    if (selected) {
      if (whySelected) selected.whySelected = whySelected;
      continue;
    }
    if (whySelected) promoteCuriousCandidate(result, item.segmentId, whySelected);
  }

  for (const item of narrative.ignored ?? []) {
    const ignored = ignoredById.get(item.segmentId);
    const whyIgnored = safeCreatureFacingText(item.whyIgnored)?.trim();
    if (ignored && whyIgnored) ignored.whyIgnored = whyIgnored;
  }

  if (narrative.creatureReport) session.creatureReport = safeCreatureFacingText(narrative.creatureReport) ?? session.creatureReport;
}

function promoteCuriousCandidate(result: CaptureResult, segmentId: string, whySelected: string) {
  const session = result.curiousSession;
  if (!session) return;
  if (session.selected.some((item) => item.segmentId === segmentId)) return;
  if (session.selected.length >= session.attentionBudget) return;
  const candidate = result.attentionCandidates?.find((item) => item.segment.id === segmentId);
  const ignored = session.ignored.find((item) => item.segmentId === segmentId);
  if (!candidate || !ignored) return;
  if (!canPromoteCuriousCandidate(candidate.score, candidate.segment.content)) return;

  const now = result.events[0]?.createdAt ?? new Date().toISOString();
  const event = buildAttentionEvent(result.profile, {
    source: "curious_stream",
    triggerSegmentId: candidate.segment.id,
    triggerBatchId: candidate.segment.batchId,
    triggerObservedAt: candidate.segment.observedAt,
    triggerLocation: candidate.segment.location,
    triggerLabel: candidate.segment.label,
    triggerContent: candidate.segment.content,
    reasonPrefix: whySelected,
    score: candidate.score,
    now
  });
  event.semanticSource = "llm";
  event.decisionTrace = [
    ...(event.decisionTrace ?? []),
    "llm: promoted near-threshold curious segment",
    `guardrail: attention_budget=${session.attentionBudget}`,
    `guardrail: score_total=${candidate.score.total}`
  ];
  const episode = createEpisodeFromEvent(event, "", now);
  const memoryCandidate = createMemoryCandidateFromEpisode(result.profile, episode, { now });

  result.events.push(event);
  result.episodes.push(episode);
  result.memoryCandidates ??= [];
  result.memoryCandidates.push(memoryCandidate);
  result.profile.episodes.unshift(episode);
  session.selected.push({
    segmentId: ignored.segmentId,
    label: ignored.label,
    score: ignored.score,
    whySelected
  });
  session.ignored = session.ignored.filter((item) => item.segmentId !== segmentId);
}

function canPromoteCuriousCandidate(score: NonNullable<CaptureResult["attentionCandidates"]>[number]["score"], content: string) {
  if (score.total < 32) return false;
  if (score.privacyRisk > 82) return false;
  if (isHighPrivacySegmentContent(content)) return false;
  return true;
}

function interactionExperience(interaction: NonNullable<BrainSuggestion["interaction"]>, event: CaptureResult["events"][number]) {
  const visibleReaction = safeVisibleReaction(interaction.visibleReaction);
  return {
    ...event.creatureExperience,
    earReason: visibleReaction ?? event.creatureExperience.earReason,
    actionFeeling: "",
    saveFeeling: ""
  };
}

function clearRuleVisibleDrafts(result: CaptureResult) {
  result.response = "";
  for (const episode of result.episodes) {
    episode.creatureResponse = "";
  }
}

function ensureVisibleOutputContract(result: CaptureResult) {
  const primaryAction = result.events[0]?.actionDecision.action;
  if (!primaryAction || primaryAction === "observe" || primaryAction === "quiet") return;
  if (!result.response.trim()) throw new Error("model selected a visible action without a visible reply");
}

function safeVisibleReaction(text?: string) {
  const normalized = safeCreatureFacingText(text);
  return normalized ? `${trimSentence(normalized)}。` : undefined;
}

function safeCreatureFacingText(text?: string) {
  const raw = text?.trim();
  if (!raw) return undefined;
  if (containsInternalProcessLanguage(raw)) throw new Error("model returned internal process language for visible text");
  const normalized = normalizeSharedMemoryText(raw).trim();
  if (!normalized || containsInternalProcessLanguage(normalized)) throw new Error("model returned invalid visible text");
  return normalized;
}

function safeExternalReplyText(text?: string, sourceText?: string) {
  const normalized = safeCreatureFacingText(text);
  if (!normalized) return undefined;
  if (containsFullInputEcho(normalized, sourceText)) throw new Error("model echoed the full user input in visible reply");
  return normalized;
}

function safeProcessText(text?: string, previousText?: string) {
  const raw = text?.trim();
  if (!raw) return previousText;
  const normalized = normalizeSharedMemoryText(raw).trim();
  if (!normalized || containsInternalProcessLanguage(normalized)) return previousText;
  return normalized;
}

function containsInternalProcessLanguage(text: string) {
  return /LLM|语义|用户意图|用户在|用户希望|用户可能|用户主动|用户确认|系统|后台|流程|attention|semantic|harness|candidate|episode|数据库|规则层|写入|情景记忆|情景片段|保存意图|长期保存|长期记忆|长期留下|要不要长期记|prompt|JSON|score|阈值|总分|小动物|我注意到这段|我注意到这个片段|片段可能|认真理解|路过的背景声|我先听你说完|这件事我会先当作|确认我有没有听对|我为什么注意|我想起了什么|我猜你在做|我当时的状态|我选择|显著性|记忆策略|你刚才是在叫我说话|先回应你|先回答你|他\/她|他希望|她希望|他说|她说|他准备|她准备/i.test(text);
}

function containsFullInputEcho(reply: string, sourceText?: string) {
  const input = compactText(sourceText);
  const output = compactText(reply);
  if (input.length < 22 || output.length < 80) return false;
  if (output.includes(input)) return true;
  const head = input.slice(0, 18);
  const tail = input.slice(-10);
  return output.includes(head) && output.includes(tail);
}

function compactText(text?: string) {
  return (text ?? "").replace(/[，。！？、\s:：,.!?]/g, "");
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
  const highPrivacySegmentIds = new Set((result.attentionCandidates ?? []).filter((item) => isHighPrivacySegmentContent(item.segment.content)).map((item) => item.segment.id));
  return `请作为 Papo 的语义脑，读取规则层产生的候选 attention events，改进语义理解和表达。

你可以：
- 先判断这是不是一次互动：用户是在呼唤、要求回应、倾诉、要求记住、要求提醒，还是只是给环境素材。
- 改写 noticed/reason，作为内隐理解记录；它们可以解释注意原因，但不要把这些句子当成 Papo 的台词。
- 给出 suggestedAction，但只能从 observe, respond, ask, save_episode, save_long_term, recall, review, quiet, draft_reminder, draft_question_list 选择。
- 改写 episode 的 possibleIntent/importanceReason/creatureResponse。creatureResponse 是外显回应，只能写 Papo 最终对用户说的话。
- 在 interaction.visibleReaction 里写一句外显行为语言，像 Papo 真的做了什么或准备怎么回应；不要写“用户意图是/语义判断/后台流程/记忆写入”。
- 如果 source 是 curious_stream，可以改写 curiousSession.selected/ignored 的 whySelected/whyIgnored 和 creatureReport；也可以在 selected 里放入 attention_candidates 中一个被规则忽略但语义上重要的 segmentId。规则会限制预算、阈值、隐私和最终 action，不能新增不存在的片段。
- 给出一条 memoryCandidateText，必须是这次真实互动可记住的小回忆，不要写流程说明。
- 写一段 response，给用户展示这次小动物的整体回应。
- response/reply/creatureResponse 必须像自然对话，不要说“我注意到这段...”“这件事我会先当作...”“确认我有没有听对”“要不要长期记”。这些属于内隐认知，不是外显台词。
- 如果用户追问 Papo 刚才为什么那样说，应该直接解释“我刚才说得别扭，我只是想让你知道我听见了”，不要复读原句，也不要装作没听懂。
- 明确区分说话者和被指代对象：用户消息里的“我”通常是用户，“你”通常是 Papo；Papo 回复里的“我”才是 Papo 自己。不要把用户对 Papo 的描述误写成用户自己的经历。
- noticed/reason/possibleIntent/importanceReason 可以记录内隐理解，但也不要使用“用户意图/后台流程/语义判断”等工程词。
- 所有会展示给用户的字段（response, reply, creatureResponse, visibleReaction, creatureReport, whySelected, whyIgnored）都必须是可直接展示的自然语言；不要出现 LLM、语义脑、score、阈值、candidate、episode、后台流程等内部词。
- 如果 contentHiddenForPrivacy=true，只能说这类内容会先等用户确认，不能声称看到了具体内容，也不要说“我看到啦”。

你不能：
- 改状态数值。
- 删除用户记忆。
- 在高隐私风险时建议直接长期保存。
- 输出数据库解释或产品说明口吻。

返回严格 JSON：
{
  "response": "...",
  "interaction": {"userIntent":"...", "emotionalTone":"...", "visibleReaction":"我抬头回应你，让你知道我听见了。", "shouldReply":true, "suggestedAction":"respond", "reply":"...", "memoryCandidateText":"...", "memoryTags":["..."]},
  "events": [{"id":"...", "noticed":"...", "reason":"...", "suggestedAction":"..."}],
  "episodes": [{"eventId":"...", "possibleIntent":"...", "importanceReason":"...", "creatureResponse":"..."}],
  "curiousSession": {"creatureReport":"...", "selected":[{"segmentId":"...", "whySelected":"..."}], "ignored":[{"segmentId":"...", "whyIgnored":"..."}]},
  "trace": ["短审计线索"]
}

profile_state:
${JSON.stringify(profile.state)}

recent_long_term_memories:
${JSON.stringify(modelMemoryContext(profile.longTermMemories, { limit: 6 }))}

recent_conversation_newest_first:
${JSON.stringify(modelConversationContext(profile))}

source:
${source}

candidate_events:
${JSON.stringify(result.events.map((event) => ({
  id: event.id,
  source: event.source,
  triggerLabel: event.triggerLabel,
  triggerContent: modelSafeSegmentContent(event.triggerContent),
  contentHiddenForPrivacy: isHighPrivacySegmentContent(event.triggerContent),
  noticed: modelSafeSegmentContent(event.noticed),
  reason: modelSafeSegmentContent(event.reason),
  relatedMemoryIds: event.relatedMemoryIds,
  attentionStrength: event.attentionStrength,
  privacyRisk: event.privacyRisk,
  suggestedAction: event.suggestedAction,
  tags: isHighPrivacySegmentContent(event.triggerContent) ? [] : event.tags
})))}

attention_candidates:
${JSON.stringify(result.attentionCandidates?.map((item) => ({
  segmentId: item.segment.id,
  label: item.segment.label,
  content: modelSafeSegmentContent(item.segment.content),
  contentHiddenForPrivacy: isHighPrivacySegmentContent(item.segment.content),
  selectedByRules: item.selectedByRules,
  scoreTotal: item.score.total,
  privacyRisk: item.score.privacyRisk,
  redundancyPenalty: item.score.redundancyPenalty,
  relatedIds: item.score.relatedIds,
  tags: modelSafeTags(item.segment.content, item.score.tags)
})) ?? [])}

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
    tags: highPrivacySegmentIds.has(item.segmentId) ? [] : item.score.tags
  })),
  ignored: result.curiousSession.ignored.map((item) => ({
    segmentId: item.segmentId,
    label: item.label,
    whyIgnored: item.whyIgnored,
    scoreTotal: item.score.total,
    privacyRisk: item.score.privacyRisk,
    redundancyPenalty: item.score.redundancyPenalty,
    tags: highPrivacySegmentIds.has(item.segmentId) ? [] : item.score.tags
  }))
} : null)}
`;
}

function modelSafeSegmentContent(text: string) {
  if (!isHighPrivacySegmentContent(text)) return text;
  return "[这段包含可能的密钥、验证码、密码、地址或证件信息，原文已隐藏；不能直接引用、保存或选择为注意事件。]";
}

function modelSafeTags(text: string, tags: string[]) {
  if (!isHighPrivacySegmentContent(text)) return tags;
  return [];
}

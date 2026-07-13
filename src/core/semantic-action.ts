import { z } from "zod";
import { guardActionDecision } from "./action";
import { isHighPrivacySegmentContent } from "./attention";
import { makeId } from "./ids";
import { modelConversationContext, modelFeedbackContext, modelMemoryContext, modelPetContext } from "./model-context";
import { clientContextFor } from "./client-document";
import { normalizeSharedMemoryText } from "./memory";
import { projectInputForModel } from "./model-safety";
import { isModelProviderRefusal, type ModelProvider } from "./provider";
import { applyStateDelta } from "./state";
import type { ActionResult, CaptureResult, CognitionContext, CreatureProfile, SemanticBrainRecord } from "./types";
import { DOG_STATE_CATALOG } from "./dog-states";

const actionSchema = z.enum(["observe", "respond", "acknowledge", "listen_silently", "continue_own_activity", "defer", "ask", "save_episode", "save_long_term", "recall", "review", "quiet", "draft_reminder", "draft_question_list", "use_hermes", "generate_illustration", "generate_action_card", "update_pet_profile"]);
const backgroundActionSchema = z.enum(["use_hermes", "generate_illustration", "generate_action_card"]);
const actionResultKindSchema = z.enum(["none", "visible_reply", "memory_intent", "reminder_draft", "question_list_draft", "hermes_task", "illustration_draft", "action_card_draft", "pet_profile_update"]);
const stateDeltaSchema = z
  .object({
    curiosity: z.number().min(-12).max(12).optional(),
    attachment: z.number().min(-12).max(12).optional(),
    energy: z.number().min(-12).max(12).optional(),
    arousal: z.number().min(-12).max(12).optional(),
    safety: z.number().min(-12).max(12).optional(),
    confidence: z.number().min(-12).max(12).optional()
  })
  .partial();
const optionalText = (max: number) =>
  z.preprocess((value) => cleanOptionalText(value, max), z.string().min(1).optional());
const optionalTextArray = (maxItems: number, maxTextLength: number) =>
  z.array(z.preprocess((value) => cleanOptionalText(value, maxTextLength), z.string().optional()))
    .transform((values) => values.filter((value): value is string => Boolean(value)))
    .pipe(z.array(z.string().min(1).max(maxTextLength)).max(maxItems));

const petProfilePatchSchema = z.object({
  displaySpecies: optionalText(120),
  appearance: optionalText(700),
  personality: optionalText(500),
  habits: optionalText(500),
  visualStyle: optionalText(500),
  imagePrompt: optionalText(1400),
  motionStyle: optionalText(700),
  userGuidance: optionalText(700)
}).partial();

const structuredActionResultSchema = z.object({
  kind: actionResultKindSchema,
  title: optionalText(120),
  text: optionalText(500),
  dueText: optionalText(160),
  items: optionalTextArray(8, 180).optional(),
  prompt: optionalText(1600),
  caption: optionalText(220),
  style: optionalText(160),
  durationSeconds: z.number().min(4).max(20).optional(),
  replacesActionCardId: optionalText(120),
  stateId: optionalText(80),
  statusText: optionalText(220),
  sourceIds: optionalTextArray(10, 120).optional(),
  petProfile: petProfilePatchSchema.optional()
});

function cleanOptionalText(value: unknown, max: number) {
  if (value === null) return undefined;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

const semanticActionSchema = z.object({
  decisions: z
    .array(
      z.object({
        eventId: z.string().min(1),
        action: actionSchema,
        noticed: optionalText(260),
        userIntent: optionalText(260),
        emotionalTone: optionalText(160),
        reason: optionalText(420),
        stateDeltas: stateDeltaSchema,
        shouldCreateEpisode: z.boolean(),
        shouldConsiderMemory: z.boolean(),
        shouldReply: z.boolean().optional(),
        reply: optionalText(700),
        visibleReaction: optionalText(260),
        actionResult: structuredActionResultSchema.optional(),
        actions: z.array(z.object({
          action: backgroundActionSchema,
          reason: optionalText(420),
          actionResult: structuredActionResultSchema
        })).max(4).optional(),
        memoryCandidateText: optionalText(650),
        memoryTags: optionalTextArray(10, 40).optional(),
        relatedMemoryIds: optionalTextArray(6, 80).optional(),
        tone: optionalText(120)
      })
    )
    .max(4)
});

type SemanticActionSuggestion = z.infer<typeof semanticActionSchema>;
type ActionDecisionSuggestion = SemanticActionSuggestion["decisions"][number];

export async function semanticSelectAction(
  profile: CreatureProfile,
  result: CaptureResult,
  provider: ModelProvider,
  source: SemanticBrainRecord["source"],
  context: CognitionContext = { inputSource: source === "button" ? "direct" : "ambient" }
): Promise<CaptureResult> {
  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for action selection.");
  if (!result.events.length) return result;

  const prompt = buildSemanticActionPrompt(profile, result, context);
  let raw: unknown;
  try {
    raw = await provider.generateJson<unknown>(prompt);
  } catch (error) {
    if (!isModelProviderRefusal(error)) throw error;
    const retryPrompt = buildSemanticActionRecoveryPrompt(profile, result, context);
    raw = provider.generateJsonFallback ? await provider.generateJsonFallback<unknown>(retryPrompt) : await provider.generateJson<unknown>(retryPrompt);
  }
  if (!raw) throw new Error("empty action model result");
  const parsed = semanticActionSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid action JSON (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  const applied = applySemanticAction(profile, result, parsed.data, context);
  if (applied <= 0) throw new Error("action model did not select any known event");
  recordActionSemanticRun(profile, provider, source, applied);
  return result;
}

function applySemanticAction(profile: CreatureProfile, result: CaptureResult, suggestion: SemanticActionSuggestion, context: CognitionContext) {
  const eventById = new Map(result.events.map((event) => [event.id, event]));
  const episodeByEventId = new Map(result.events.map((event, index) => [event.id, result.episodes[index]]));
  let applied = 0;

  for (const decision of suggestion.decisions) {
    const event = eventById.get(decision.eventId);
    if (!event) continue;

    validateSourceAction(event, decision, context);
    const guarded = guardActionDecision(event, profile, decision.action);
    const relatedMemoryIds = validRelatedMemoryIds(profile, decision.relatedMemoryIds);
    const stateDeltas = cleanStateDeltas(decision.stateDeltas);
    event.actionDecision = guarded;
    event.suggestedAction = guarded.action;
    if (decision.noticed) event.noticed = safeProcessText(decision.noticed, event.noticed) ?? event.noticed;
    if (decision.reason) event.reason = safeProcessText(decision.reason, event.reason) ?? event.reason;
    if (relatedMemoryIds.length) event.relatedMemoryIds = relatedMemoryIds;
    const actionResult = normalizeActionResult(decision, profile);
    event.actionResult = actionResult;
    event.backgroundActions = (decision.actions ?? []).map((planned) => {
      const actionDecision = { ...decision, action: planned.action, actionResult: planned.actionResult };
      validatePersistenceDecision(actionDecision, profile);
      return {
        action: planned.action,
        actionResult: normalizeActionResult(actionDecision, profile),
        reason: safeProcessText(planned.reason)
      };
    });
    event.semanticSource = "llm";
    event.decisionTrace = [
      ...(event.decisionTrace ?? []),
      "llm: action selected",
      decision.userIntent ? `intent=${safeProcessText(decision.userIntent) ?? "not_shown"}` : "intent=not_provided",
      decision.reason ? `action_reason=${safeProcessText(decision.reason) ?? "not_shown"}` : "action_reason=not_provided",
      `episode=${decision.shouldCreateEpisode}`,
      `memory_candidate=${decision.shouldConsiderMemory}`,
      decision.shouldReply === undefined ? "should_reply=not_provided" : `should_reply=${decision.shouldReply}`,
      `action_result=${actionResult.kind}`,
      `background_actions=${event.backgroundActions.map((planned) => planned.action).join(",") || "none"}`,
      `state_delta=${stateDeltaTrace(stateDeltas)}`,
      `guardrail: action=${guarded.action}`
    ];

    const episode = episodeByEventId.get(event.id);
    if (episode) {
      episode.actionDecision = guarded;
      episode.decisionTrace = event.decisionTrace;
      episode.noticed = event.noticed;
      episode.importanceReason = event.reason;
      if (relatedMemoryIds.length) episode.relatedMemoryIds = relatedMemoryIds;
      episode.actionResult = actionResult;
      if (decision.userIntent) episode.possibleIntent = safeProcessText(decision.userIntent, episode.possibleIntent) ?? episode.possibleIntent;
      if (decision.reason) episode.importanceReason = safeProcessText(decision.reason, episode.importanceReason) ?? episode.importanceReason;
      const reply = safeExternalText(decision.reply);
      if (reply && decision.reply) episode.creatureResponse = reply;
      if (decision.memoryTags?.length) episode.tags = decision.memoryTags;
      const reaction = safeExternalText(decision.visibleReaction);
      if (reaction) {
        const baseExperience = episode.creatureExperience ?? event.creatureExperience;
        episode.creatureExperience = {
          ...baseExperience,
          earReason: `${trimSentence(reaction)}。`
        };
        event.creatureExperience = episode.creatureExperience;
      }
      updateMemoryCandidate(result, episode.id, decision.memoryCandidateText, decision.memoryTags);
    }

    if (event.id === result.events[0]?.id) {
      const reply = safeExternalText(decision.reply);
      if (reply && decision.reply && decision.shouldReply !== false) result.response = reply;
      if (decision.shouldReply === false && !decision.reply) {
        result.response = "";
        if (episode) episode.creatureResponse = "";
      }
    }
    validatePersistenceDecision(decision, profile);
    if (Object.keys(stateDeltas).length) {
      const change = applyStateDelta(profile, stateDeltas, `llm action ${guarded.action}`, event.createdAt);
      event.actionStateDeltas = stateChangeDeltas(change);
      if (episode) episode.stateSnapshot = structuredClone(profile.state);
    }
    applyPersistenceDecision(profile, result, episode, decision, context, event);
    applied += 1;
  }

  return applied;
}

function validatePersistenceDecision(decision: ActionDecisionSuggestion, profile: CreatureProfile) {
  if (isSilentAction(decision.action) && (decision.shouldReply || decision.reply)) {
    throw new Error("action model selected a quiet/non-speaking action with a visible reply");
  }
  if (decision.shouldConsiderMemory && !decision.shouldCreateEpisode) {
    throw new Error("action model requested memory consideration without an episode");
  }
  if ((decision.action === "save_episode" || decision.action === "save_long_term") && !decision.shouldCreateEpisode) {
    throw new Error("action model selected a save action without an episode");
  }
  if (decision.action === "save_long_term" && !decision.shouldConsiderMemory) {
    throw new Error("action model selected long-term save without a memory candidate");
  }
  if (decision.action === "draft_reminder") {
    if (decision.actionResult?.kind !== "reminder_draft") throw new Error("action model selected draft_reminder without a reminder_draft actionResult");
    if (!decision.actionResult.title || !decision.actionResult.text) throw new Error("reminder_draft actionResult requires title and text");
  }
  if (decision.action === "draft_question_list") {
    if (decision.actionResult?.kind !== "question_list_draft") throw new Error("action model selected draft_question_list without a question_list_draft actionResult");
    if (!decision.actionResult.items?.length) throw new Error("question_list_draft actionResult requires items");
  }
  if (decision.action === "use_hermes") {
    if (decision.actionResult?.kind !== "hermes_task") throw new Error("action model selected use_hermes without a hermes_task actionResult");
    if (!decision.actionResult.title || !decision.actionResult.text) throw new Error("hermes_task actionResult requires title and text");
    if (!decision.reply || decision.shouldReply === false) throw new Error("use_hermes requires a visible reply so the user knows Papo handed the task off");
  }
  if (decision.action === "generate_illustration") {
    if (decision.actionResult?.kind !== "illustration_draft") throw new Error("action model selected generate_illustration without an illustration_draft actionResult");
    if (!decision.actionResult.title || !decision.actionResult.prompt) throw new Error("illustration_draft actionResult requires title and prompt");
    if (!decision.reply || decision.shouldReply === false) throw new Error("generate_illustration requires a visible reply so the user knows Papo is drawing");
  }
  if (decision.action === "generate_action_card") {
    if (decision.actionResult?.kind !== "action_card_draft") throw new Error("action model selected generate_action_card without an action_card_draft actionResult");
    if (!decision.actionResult.title || !decision.actionResult.prompt || !decision.actionResult.stateId || !decision.actionResult.statusText) throw new Error("action_card_draft actionResult requires title, prompt, stateId, and statusText");
    if (!decision.reply || decision.shouldReply === false) throw new Error("generate_action_card requires a visible reply so the user knows the action is being made");
    if (decision.actionResult.replacesActionCardId && !profile.actionCards?.some((card) => card.id === decision.actionResult?.replacesActionCardId && !card.deleted)) throw new Error("action_card_draft replacesActionCardId must reference an existing action card");
  }
  if (decision.action === "update_pet_profile") {
    if (decision.actionResult?.kind !== "pet_profile_update") throw new Error("action model selected update_pet_profile without a pet_profile_update actionResult");
    if (!decision.actionResult.petProfile || !Object.keys(decision.actionResult.petProfile).length) throw new Error("pet_profile_update actionResult requires petProfile fields");
    if (!decision.reply || decision.shouldReply === false) throw new Error("update_pet_profile requires a visible reply so the user knows Papo learned the profile change");
  }
}

function validateSourceAction(event: CaptureResult["events"][number], decision: ActionDecisionSuggestion, context: CognitionContext) {
  if (context.inputSource === "direct" && event.expectsResponse && isSilentAction(decision.action)) {
    throw new Error("direct input that expects a response cannot select a silent action");
  }
  if (context.inputSource === "task_result" && isSilentAction(decision.action)) {
    throw new Error("task_result must be summarized, relayed, followed up, or update its task");
  }
  if (context.inputSource === "task_result" && !decision.shouldCreateEpisode) {
    throw new Error("task_result must keep a result episode linked to its source task");
  }
}

function isSilentAction(action: ActionDecisionSuggestion["action"]) {
  return ["observe", "quiet", "listen_silently", "continue_own_activity", "defer"].includes(action);
}

function normalizeActionResult(decision: ActionDecisionSuggestion, profile: CreatureProfile): ActionResult {
  const raw = decision.actionResult;
  if (decision.action === "draft_reminder") {
    return {
      kind: "reminder_draft",
      title: safeProcessText(raw?.title) ?? "",
      text: safeProcessText(raw?.text) ?? "",
      dueText: safeProcessText(raw?.dueText),
      items: undefined
    };
  }
  if (decision.action === "draft_question_list") {
    return {
      kind: "question_list_draft",
      title: safeProcessText(raw?.title),
      text: safeProcessText(raw?.text),
      dueText: undefined,
      items: raw?.items?.map((item) => safeProcessText(item)).filter((item): item is string => Boolean(item)).slice(0, 8) ?? []
    };
  }
  if (raw?.kind === "reminder_draft" || raw?.kind === "question_list_draft") {
    throw new Error("action model returned a draft actionResult for a non-draft action");
  }
  if (decision.action === "use_hermes") {
    return {
      kind: "hermes_task",
      title: safeProcessText(raw?.title) ?? "",
      text: safeProcessText(raw?.text) ?? "",
      dueText: undefined,
      items: undefined
    };
  }
  if (raw?.kind === "hermes_task") {
    throw new Error("action model returned a hermes_task actionResult for a non-hermes action");
  }
  if (decision.action === "generate_illustration") {
    return {
      kind: "illustration_draft",
      title: safeProcessText(raw?.title) ?? "",
      text: safeProcessText(raw?.text),
      prompt: safeProcessText(raw?.prompt) ?? "",
      caption: safeProcessText(raw?.caption),
      style: safeProcessText(raw?.style),
      sourceIds: raw?.sourceIds?.map((item) => safeProcessText(item)).filter((item): item is string => Boolean(item)).slice(0, 10),
      dueText: undefined,
      items: undefined
    };
  }
  if (raw?.kind === "illustration_draft") {
    throw new Error("action model returned an illustration_draft actionResult for a non-illustration action");
  }
  if (decision.action === "generate_action_card") {
    return {
      kind: "action_card_draft",
      title: safeProcessText(raw?.title) ?? "",
      text: safeProcessText(raw?.text),
      prompt: safeProcessText(raw?.prompt) ?? "",
      caption: safeProcessText(raw?.caption),
      style: safeProcessText(raw?.style),
      sourceIds: raw?.sourceIds?.map((item) => safeProcessText(item)).filter((item): item is string => Boolean(item)).slice(0, 10),
      durationSeconds: clampDuration(raw?.durationSeconds),
      replacesActionCardId: validActionCardId(profile, raw?.replacesActionCardId),
      stateId: validDogStateId(raw?.stateId),
      statusText: safeProcessText(raw?.statusText),
      dueText: undefined,
      items: undefined
    };
  }
  if (raw?.kind === "action_card_draft") {
    throw new Error("action model returned an action_card_draft actionResult for a non-action-card action");
  }
  if (decision.action === "update_pet_profile") {
    return {
      kind: "pet_profile_update",
      title: safeProcessText(raw?.title),
      text: safeProcessText(raw?.text),
      petProfile: cleanPetProfilePatch(raw?.petProfile),
      dueText: undefined,
      items: undefined
    };
  }
  if (raw?.kind === "pet_profile_update") {
    throw new Error("action model returned a pet_profile_update actionResult for a non-profile action");
  }
  if ((decision.action === "save_episode" || decision.action === "save_long_term") && raw?.kind === "memory_intent") {
    return {
      kind: "memory_intent",
      title: safeProcessText(raw.title),
      text: safeProcessText(raw.text),
      dueText: undefined,
      items: undefined
    };
  }
  return decision.reply ? { kind: "visible_reply", text: safeProcessText(decision.reply) } : { kind: "none" };
}

function cleanPetProfilePatch(input: unknown): ActionResult["petProfile"] {
  if (!input || typeof input !== "object") return undefined;
  const patch = input as Record<string, unknown>;
  const clean = {
    displaySpecies: safeProcessText(stringField(patch.displaySpecies)),
    appearance: safeProcessText(stringField(patch.appearance)),
    personality: safeProcessText(stringField(patch.personality)),
    habits: safeProcessText(stringField(patch.habits)),
    visualStyle: safeProcessText(stringField(patch.visualStyle)),
    imagePrompt: safeProcessText(stringField(patch.imagePrompt)),
    motionStyle: safeProcessText(stringField(patch.motionStyle)),
    userGuidance: safeProcessText(stringField(patch.userGuidance))
  };
  return Object.fromEntries(Object.entries(clean).filter(([, value]) => Boolean(value))) as ActionResult["petProfile"];
}

function stringField(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function clampDuration(value: unknown) {
  const numeric = typeof value === "number" ? value : 4;
  if (!Number.isFinite(numeric)) return 4;
  return Math.max(4, Math.min(5, Math.round(numeric)));
}

function applyPersistenceDecision(
  profile: CreatureProfile,
  result: CaptureResult,
  episode: CaptureResult["episodes"][number] | undefined,
  decision: ActionDecisionSuggestion,
  context: CognitionContext,
  event: CaptureResult["events"][number]
) {
  if (!episode) return;
  if (context.inputSource === "ambient" && context.companion) {
    removeEpisodeAndCandidates(profile, result, episode.id);
    event.decisionTrace = [
      ...(event.decisionTrace ?? []),
      `guardrail: companion observation belongs to session ${context.companion.sessionId}; event consolidation owns episode and memory creation`
    ];
    return;
  }
  if (!decision.shouldCreateEpisode) {
    if (context.inputSource === "ambient") {
      removeMemoryCandidatesForEpisode(profile, result, episode.id);
      event.decisionTrace = [...(event.decisionTrace ?? []), "guardrail: selected ambient input keeps an episode even when the action is silent"];
      episode.decisionTrace = event.decisionTrace;
      episode.memoryCandidateIds = [];
      return;
    }
    removeEpisodeAndCandidates(profile, result, episode.id);
    return;
  }
  if (!decision.shouldConsiderMemory) {
    removeMemoryCandidatesForEpisode(profile, result, episode.id);
  }
}

function removeEpisodeAndCandidates(profile: CreatureProfile, result: CaptureResult, episodeId: string) {
  profile.episodes = profile.episodes.filter((episode) => episode.id !== episodeId);
  result.episodes = result.episodes.filter((episode) => episode.id !== episodeId);
  removeMemoryCandidatesForEpisode(profile, result, episodeId);
}

function removeMemoryCandidatesForEpisode(profile: CreatureProfile, result: CaptureResult, episodeId: string) {
  profile.memoryCandidates = profile.memoryCandidates.filter((candidate) => candidate.sourceEpisodeId !== episodeId);
  result.memoryCandidates = result.memoryCandidates?.filter((candidate) => candidate.sourceEpisodeId !== episodeId) ?? [];
  const episode = profile.episodes.find((item) => item.id === episodeId) ?? result.episodes.find((item) => item.id === episodeId);
  if (episode) episode.memoryCandidateIds = [];
}

function updateMemoryCandidate(result: CaptureResult, sourceEpisodeId: string, text?: string, tags?: string[]) {
  const candidate = result.memoryCandidates?.find((item) => item.sourceEpisodeId === sourceEpisodeId);
  if (!candidate) return;
  if (text?.trim()) candidate.candidateText = normalizeSharedMemoryText(text);
  if (tags?.length) candidate.tags = tags;
}

function validRelatedMemoryIds(profile: CreatureProfile, ids?: string[]) {
  if (!ids?.length) return [];
  const allowed = new Set(profile.longTermMemories.filter((memory) => memory.weight > 0).map((memory) => memory.id));
  return [...new Set(ids)].filter((id) => allowed.has(id)).slice(0, 6);
}

function cleanStateDeltas(deltas: ActionDecisionSuggestion["stateDeltas"]) {
  const cleaned: Partial<Record<"curiosity" | "attachment" | "energy" | "arousal" | "safety" | "confidence", number>> = {};
  for (const [key, value] of Object.entries(deltas ?? {})) {
    if (!Number.isFinite(value)) continue;
    const rounded = Math.round(Number(value));
    if (rounded !== 0) cleaned[key as keyof typeof cleaned] = rounded;
  }
  return cleaned;
}

function stateDeltaTrace(deltas: ReturnType<typeof cleanStateDeltas>) {
  const entries = Object.entries(deltas);
  return entries.length ? entries.map(([key, value]) => `${key}:${value}`).join(",") : "none";
}

function stateChangeDeltas(change: ReturnType<typeof applyStateDelta>) {
  const keys = ["curiosity", "attachment", "energy", "arousal", "safety", "confidence"] as const;
  return keys
    .map((key) => ({
      key,
      before: change.before[key],
      after: change.after[key],
      delta: change.after[key] - change.before[key]
    }))
    .filter((item) => item.delta !== 0);
}

function safeExternalText(text?: string) {
  const normalized = safeProcessText(text);
  if (!normalized) {
    if (text?.trim()) throw new Error("model returned invalid visible text");
    return undefined;
  }
  return normalized;
}

function validActionCardId(profile: CreatureProfile, id?: string) {
  const value = safeProcessText(id);
  return value && profile.actionCards?.some((card) => card.id === value && !card.deleted) ? value : undefined;
}

function validDogStateId(id?: string) {
  const value = safeProcessText(id);
  return value && DOG_STATE_CATALOG.some((state) => state.id === value) ? value : undefined;
}

function safeProcessText(text?: string, previousText?: string) {
  const raw = text?.trim();
  if (!raw) return previousText;
  const normalized = normalizeSharedMemoryText(raw).trim();
  if (!normalized) return previousText;
  return normalized;
}

function trimSentence(text: string) {
  return text.replace(/[。.!！]+$/, "");
}

function recordActionSemanticRun(profile: CreatureProfile, provider: ModelProvider, source: SemanticBrainRecord["source"], applied: number) {
  profile.semanticBrainHistory.unshift({
    id: makeId("semantic"),
    at: new Date().toISOString(),
    source,
    stage: "action",
    providerKind: provider.kind,
    providerName: provider.name,
    model: provider.diagnostics?.textModel,
    status: "applied",
    message: `llm action decision applied to ${applied} event(s)`,
    ruleTrace: [`provider=${provider.kind}`, `source=${source}`, "status=applied", "stage=action"]
  });
  profile.semanticBrainHistory = profile.semanticBrainHistory.slice(0, 30);
}

function buildSemanticActionPrompt(profile: CreatureProfile, result: CaptureResult, context: CognitionContext) {
  return `请作为 Papo 的行动选择脑，为已经被注意到的事件选择下一步动作。

系统提供可选动作和护栏。你负责判断此刻最自然的小动物行动：
- observe：听见但先不打断。
- respond：直接回应用户。
- ask：轻轻问一句确认。
- save_episode：留下这次经历，等待后续反馈。
- save_long_term：建议长期记住。
- recall：带着旧记忆回应。
- review：陪用户整理/复盘。
- acknowledge：用动作、表情或一句很短的反馈轻量回应。
- listen_silently：确实听见并陪伴，但不产生可见回复。
- observe：继续观察用户状态。
- continue_own_activity：Papo 继续当前正在做的事情，不产生可见回复。
- defer：当前不回应，但保留后续主动提及的可能。
- quiet：旧数据兼容动作；新决策优先使用 listen_silently。
- draft_reminder：形成提醒草稿。
- draft_question_list：形成问题清单草稿。
- use_hermes：把 Papo 自己无法完成、但外部 Hermes/虾虾可能能完成的任务交出去。
- generate_illustration：把一个当前事件、照片、回忆或一天里的几个真实片段画成手绘/漫画风格插画。
- generate_action_card：把当前小动物做某个具体动作生成一张动作关键帧，并渲染成 10 秒左右可播放动作卡。
- update_pet_profile：当用户在对话里明确教 Papo 自己的小动物外观、性格、习惯、行为偏好或形象设定时，更新小动物 profile。

当前认知来源是 ${context.inputSource}${context.taskId ? `，taskId=${context.taskId}` : ""}。
${context.companion ? `当前还处于 companion session ${context.companion.sessionId}；连续场景上下文是：${JSON.stringify(context.companion)}。行动可以保持安静，但不要误以为安静会停止场景理解。` : ""}
每个 event 只能返回一条 decision。decision.action 是主要对话/记忆动作，reply 是可以立刻显示的主回复；如同一请求还需要画图、动作卡或 Hermes，在 actions 数组中同时返回 0..N 个后台动作。不要为同一 event 重复 decision，也不要为了后台动作牺牲快速文字回答。例如“回答问题并画一幅图”应使用 action=respond、reply=直接回答、actions=[generate_illustration]。

护栏会再次校验：
- action 必须在白名单内。
- stateDeltas 每项必须在 -12 到 12 之间，规则会负责 clamp、保存和记录 before/after。
- 你不能直接写长期记忆，只能通过 shouldCreateEpisode、shouldConsiderMemory 和 memoryCandidateText 把材料交给记忆脑。
- JSON 字段名保持示例格式；所有自然语言字段值必须用中文。

判断口径：
- conversation timeline 会保存用户和 Papo 的对话；这不等于每句话都要形成 episode。
- stateDeltas 必须返回。由你判断这次行动对 Papo 当下状态的真实影响；如果确实没有变化，返回 {}。不要用固定模板，每项只写小幅变化。
- shouldCreateEpisode 由你判断：只有之后回看仍有意义的经历、上下文或互动才需要留下 episode。
- shouldConsiderMemory 由你判断：它比 episode 更窄，只用于可能值得进入后续记忆模型判断的内容。
- 如果用户明确要求 Papo 记住、保存、以后记得、把某事当成偏好/习惯，除非内容不可用或不应保存，必须 shouldCreateEpisode=true，并且通常 shouldConsiderMemory=true；action 应优先选择 save_episode、save_long_term 或带记忆意图的 respond。
- direct 图片或事件带 user_upload attachment，说明用户主动把照片发给 Papo，且原始图片资产可回看；除非重复、无意义、不可用、误触或不适合保存，否则应倾向 shouldCreateEpisode=true，并在内容值得日后回看时 shouldConsiderMemory=true。
- ambient 图片要看 captureIntent：user_initiated 表示用户主动从陪伴通知选择了这一时刻和镜头，应作为事件的重要证据认真处理；可以安静地 observe/listen_silently，但应保留 episode 并让持续事件聚合器看到。scheduled 只是系统定时取帧，不得伪装成用户主动分享，也不得仅因有画面就逐片进入长期记忆。
- audioSourceType=device_playback 的内容来自用户手机正在播放的视频/播客/音乐，不是用户本人陈述。可以把它理解为用户当时接触的媒体内容，但 reply、noticed、memoryCandidateText 都不得写成“用户说/用户认为”；mixed 无法可靠分离时必须注明来源不确定。
- 对带图片的事件形成 memoryCandidateText 时，要覆盖图片可见内容、用户给的说明、照片时间和地点；不要只写“用户上传了一张照片”。
- 如果你只是想当下陪用户聊一句，不要把它送进记忆候选；如果这段输入没有可用生活信息，也可以选择不说话。
- listen_silently、observe、continue_own_activity、defer 和旧 quiet 都是合法处理结果，表示不说话，不能同时填写 reply 或 shouldReply=true。
- direct 中 expectsResponse=true 表示明确提问、呼唤、求助或任务请求，必须 reply/acknowledge/execute，不得选择静默动作。expectsResponse=false 的碎碎念、情绪记录可以 listen_silently，但这不等于 Attention 忽略。
- task_result 默认必须进入可见转述、追问或任务更新；结合原请求与结果判断，不得作为环境背景静默丢弃。
- task_result 必须 shouldCreateEpisode=true，使结果 episode 可通过 taskId/parentEpisodeId 追溯原任务；是否考虑长期记忆仍独立判断。
- 普通碎碎念应保留 episode，但 shouldConsiderMemory=false；只有稳定偏好、重要经历、持续情绪或明确要求记住才考虑长期记忆。
- ambient 是连续陪伴流：普通片段默认 shouldConsiderMemory=false，持续事件由独立的 companion event 聚合器在事件结束时统一创建 episode/Memory，不能逐片形成长期记忆；默认不要逐片回复。只有明确呼唤、紧急风险或用户明确要求实时反馈时才外显回复。
- draft_reminder 和 draft_question_list 是有结构化产物的动作，不能只写 reply。必须在 actionResult 里返回草稿内容；reply 是 Papo 对用户说出口的自然短回应。
- use_hermes 是外部任务动作。当用户需要实时搜索、查网页/论文/新闻/天气、执行服务器或文件任务、定时发邮件、查询外部系统、长时间研究，且 Papo 内置 LLM 无法可靠完成时使用。必须在 actionResult 里返回 hermes_task，title 写任务标题，text 写给虾虾/Hermes 的清晰任务说明；reply 写 Papo 对用户说出口的短句，例如“我去问问虾虾，稍等哦”。不要把 Hermes 的任务说明直接当成 Papo 对用户说的话。
- generate_illustration 是图像动作。当用户明确想要图、今天的片段很适合被画下来、或 Papo 想把一段真实回忆变成一张小画时使用。必须在 actionResult 里返回 illustration_draft：title 是图片标题，prompt 是给图像模型的具体绘图提示词，caption 是给用户看的短说明，style 是手绘/漫画/明信片/多分镜等风格建议，sourceIds 是你依据的 episode/memory/segment/attachment id。prompt 应优先使用真实照片附件、真实对话、音频观察和记忆里的事实，不要编造未发生的情节；可以要求“一张图多个分镜”或“像明信片的一幅画”。reply 只写 Papo 对用户说的短句，例如“我想把这件小事画下来给你看。”，不要把 prompt 直接说给用户。
- generate_action_card 是动作视频卡动作。当用户要求“让它动起来”、要求小动物做动作，或 Papo 根据状态/记忆很适合外显成一个短动作时使用。必须在 actionResult 里返回 action_card_draft：title 是动作卡标题，prompt 是给图像/视频生成流程的具体视觉提示词，caption 是生成后给用户看的短说明，stateId 来自 dog_state_catalog，statusText 是与画面同步的首页状态句，style 是角色一致性、镜头和画风建议，durationSeconds 通常为 4，复杂动作最多 5 秒。prompt 必须包含当前小动物的名字、物种、外观一致性、动作、场景、镜头运动，并基于真实上下文；不要把内部提示词直接说给用户。
- 如果用户是在修订或重做 existing_action_cards 中的旧卡，必须在 actionResult.replacesActionCardId 返回对应真实卡片 id。新卡生成成功后系统才停用旧卡；不能编造 id，也不能在生成前删除旧卡。
- 涉及用户本人时，必须服从结构化输入中的已确认年龄和身份事实；视觉 prompt 应明确实际年龄、对应人生阶段、体态比例和用户要求的视觉调性。
- update_pet_profile 是用户养成小动物的动作。当用户说“它应该更像...”“它的性格是...”“它喜欢/习惯...”“以后把它设定成...”这类关于小动物自身设定的话时使用。必须在 actionResult 里返回 pet_profile_update：petProfile 可包含 displaySpecies、appearance、personality、habits、visualStyle、imagePrompt、motionStyle、userGuidance。只写用户确实表达或可由其要求合理提炼的设定，不要编造无关设定；reply 只短短确认 Papo 学会了什么。
- 不要默认复述整段用户输入；但如果用户明确要求重复、确认原话或询问上一句话，可以自然引用必要原文。

返回严格 JSON：
{
  "decisions": [
    {
      "eventId": "attention_xxx",
      "action": "respond",
      "noticed": "...",
      "userIntent": "...",
      "emotionalTone": "...",
      "reason": "...",
      "stateDeltas": {"curiosity": 2, "attachment": 1, "energy": -1, "arousal": 0, "safety": 0, "confidence": 1},
      "shouldCreateEpisode": true,
      "shouldConsiderMemory": false,
      "shouldReply": true,
      "reply": "...",
      "visibleReaction": "...",
      "actionResult": {
        "kind": "visible_reply",
        "title": "...",
        "text": "...",
        "dueText": "...",
        "items": ["..."],
        "prompt": "...",
        "caption": "...",
        "style": "...",
        "petProfile": {"appearance":"...","personality":"...","habits":"...","visualStyle":"...","imagePrompt":"...","motionStyle":"..."},
        "sourceIds": ["episode_xxx", "img_xxx"]
      },
      "actions": [
        {
          "action": "generate_illustration",
          "reason": "为什么这个后台动作有价值",
          "actionResult": {"kind":"illustration_draft","title":"...","prompt":"...","caption":"...","sourceIds":["attention_xxx"]}
        }
      ],
      "memoryCandidateText": "...",
      "memoryTags": ["..."],
      "relatedMemoryIds": ["ltm_xxx"],
      "tone": "..."
    }
  ]
}

noticed、userIntent、reason、memoryCandidateText 是内部理解和记忆材料。
reply 只能写 Papo 直接说出口的话，不要写括号动作、舞台指令、内部流程解释、字段名或阈值。
visibleReaction 只写可以外显成动作的短行为，例如“抬头看你”“靠近一点”；不要把动作混进 reply。
actionResult 是这一步行动真实产出的结构化结果：
- 普通回应可以省略 actionResult，或返回 {"kind":"visible_reply","text":"和 reply 同义的外显结果"}。
- action=save_episode 或 save_long_term 时，可以返回 {"kind":"memory_intent","text":"为什么交给记忆流程"}；不能返回 memory_saved，因为真正是否写入长期记忆由后续 memory stage 决定。save_long_term 只是行动脑的强建议，不会绕过记忆脑的 writePolicy。
- action=draft_reminder 时，必须返回 {"kind":"reminder_draft","title":"...","text":"...","dueText":"..."}；title 和 text 必填，dueText 不确定时可以省略。
- action=draft_question_list 时，必须返回 {"kind":"question_list_draft","title":"...","items":["..."]}；items 至少一条。
- action=use_hermes 时，必须返回 {"kind":"hermes_task","title":"...","text":"..."}，title 和 text 必填。
- action=generate_illustration 时，必须返回 {"kind":"illustration_draft","title":"...","prompt":"...","caption":"...","style":"...","sourceIds":["..."]}，title 和 prompt 必填。caption 是图生成后可展示给用户的短句；sourceIds 必须来自当前事件、附件、episode 或 memory 的真实 id，不能编造。
- action=generate_action_card 时，必须返回 {"kind":"action_card_draft","title":"...","prompt":"...","caption":"...","style":"...","durationSeconds":4,"stateId":"dog_state_catalog 中的 id","statusText":"首页与这段动作同步显示的当下状态句","sourceIds":["..."],"replacesActionCardId":"vid_xxx"}，title、prompt、stateId、statusText 必填。仅在修订旧卡时填写 replacesActionCardId，且必须来自 existing_action_cards；caption 是动作卡生成后可展示给用户的短句；statusText 必须描述视频里正在发生的动作或状态，不能写生成过程；sourceIds 必须来自当前事件、附件、episode 或 memory 的真实 id，不能编造。
- action=update_pet_profile 时，必须返回 {"kind":"pet_profile_update","text":"...","petProfile":{"appearance":"...","personality":"...","habits":"...","visualStyle":"...","imagePrompt":"...","motionStyle":"...","userGuidance":"..."}}。petProfile 至少一项；不要把用户的生活记忆误写进小动物形象 profile。
- observe/quiet 应省略 actionResult，或返回 {"kind":"none"}。
actions 只放可独立后台执行的 use_hermes、generate_illustration、generate_action_card。每项 actionResult 遵守同样字段约束；复合意图必须放在同一条 decision 的 actions 中，不能复制 eventId 创建第二条 decision。后台动作失败不能改变 reply 或主行动的成功结果。
shouldCreateEpisode 决定这次是否应该留下为一条经历。
shouldConsiderMemory 决定这次是否进入后续记忆判断；只有值得被之后记住、反馈、回忆或整理的事件才为 true。shouldConsiderMemory=true 时 shouldCreateEpisode 必须为 true。
如果 action 是 save_episode 或 save_long_term，shouldCreateEpisode 必须为 true；如果 action 是 save_long_term，shouldConsiderMemory 必须为 true。
如果 action 是 listen_silently、observe、continue_own_activity、defer 或 quiet，shouldReply 必须为 false 或省略，reply 必须省略。
如果 action 是 use_hermes，shouldReply 必须为 true，reply 必须是给用户看的短回复，actionResult.text 才是给 Hermes 的任务。
如果 action 是 generate_illustration，shouldReply 必须为 true，reply 必须是给用户看的短回复，actionResult.prompt 才是给图像模型的提示词。
如果 action 是 generate_action_card，shouldReply 必须为 true，reply 必须是给用户看的短回复，actionResult.prompt 才是给媒体生成流程的提示词。
如果 action 是 update_pet_profile，shouldReply 必须为 true，reply 必须是给用户看的短确认，actionResult.petProfile 才是结构化设定。
如果 recent_memories 里有自然联想到的旧记忆，可以在 relatedMemoryIds 里返回对应 id；不能编造不存在的 id。

pet_context:
${JSON.stringify(modelPetContext(profile))}

current_state:
${JSON.stringify(profile.state)}

current_policy:
${JSON.stringify(profile.policyProfile)}

relevant_client_context:
${JSON.stringify(clientContextFor(profile, result.events.map((event) => `${event.triggerContent} ${event.noticed}`).join(" ")))}

recent_memories:
${JSON.stringify(modelMemoryContext(profile.longTermMemories))}

recent_conversation_newest_first:
${JSON.stringify(modelConversationContext(profile))}

recent_feedback:
${JSON.stringify(modelFeedbackContext(profile.feedbackHistory))}

existing_action_cards:
${JSON.stringify((profile.actionCards ?? []).filter((card) => !card.deleted).slice(0, 12).map((card) => ({ id: card.id, title: card.title, caption: card.caption, displayMode: card.displayMode, stateId: card.stateId, statusText: card.statusText, sourceIds: card.sourceIds })))}

dog_state_catalog:
${JSON.stringify(DOG_STATE_CATALOG.map((state) => ({ id: state.id, label: state.label, actionText: state.actionText, animation: state.animation, tags: state.tags })))}

events:
${JSON.stringify(result.events.map((event) => ({
  id: event.id,
  source: event.source,
  sourceSegmentId: event.triggerSegmentId,
  sourceBatchId: event.triggerBatchId,
  captureIntent: event.captureIntent,
  audioSourceType: event.audioSourceType,
  sourceObservedAt: event.triggerObservedAt,
  sourceLocation: event.triggerLocation,
  attachments: (event.attachments ?? []).map((attachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    label: attachment.label,
    mime: attachment.mime,
    observedAt: attachment.observedAt,
    location: attachment.location
  })),
  label: event.triggerLabel,
  content: modelSafeEventContent(event.triggerContent),
  contentHiddenForPrivacy: isHighPrivacySegmentContent(event.triggerContent),
  noticed: event.semanticSource === "llm" ? modelSafeEventContent(event.noticed) : undefined,
  reason: event.semanticSource === "llm" ? modelSafeEventContent(event.reason) : undefined,
  relatedMemoryIds: event.relatedMemoryIds,
  attentionStrength: event.attentionStrength,
  privacyRisk: event.privacyRisk,
  tags: isHighPrivacySegmentContent(event.triggerContent) ? [] : event.tags
})))}
`;
}

function modelSafeEventContent(text: string) {
  return projectInputForModel(text).text;
}

function buildSemanticActionRecoveryPrompt(profile: CreatureProfile, result: CaptureResult, context: CognitionContext) {
  const events = result.events.map((event) => ({
    id: event.id,
    source: context.inputSource,
    task: projectInputForModel(event.triggerContent),
    noticed: projectInputForModel(event.noticed).text,
    attachments: (event.attachments ?? []).map((attachment) => ({ id: attachment.id, kind: attachment.kind, label: attachment.label }))
  }));
  const cards = (profile.actionCards ?? []).filter((card) => !card.deleted).slice(0, 12).map((card) => ({
    id: card.id,
    title: card.title,
    caption: card.caption,
    disabled: card.disabled
  }));
  return `You are the action-planning stage for Papo. Use the structured task facts as authoritative. The user-facing reply and all creative media prompts must be written by you, not copied from a template.
Return JSON only with one decision per event. A decision has: eventId, action, shouldCreateEpisode, shouldConsiderMemory, shouldReply, reply, visibleReaction, reason, and actionResult. Independent work belongs in actions[].
For a media revision, choose generate_action_card or a visible reply plus a generate_action_card background action. Its actionResult must be {"kind":"action_card_draft","title":"...","prompt":"a detailed creative prompt authored from the task facts","caption":"...","style":"...","durationSeconds":4,"stateId":"an id from dog_state_catalog","statusText":"a concise Chinese home status matching the video","sourceIds":["real ids"],"replacesActionCardId":"an existing card id"}. Preserve the confirmed identity facts. Only use a replacement id from existing_action_cards.
Pet:
${JSON.stringify(modelPetContext(profile))}
Existing action cards:
${JSON.stringify(cards)}
Events:
${JSON.stringify(events)}`;
}

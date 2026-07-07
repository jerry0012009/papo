import { z } from "zod";
import { guardActionDecision } from "./action";
import { isHighPrivacySegmentContent } from "./attention";
import { makeId } from "./ids";
import { modelConversationContext, modelFeedbackContext, modelMemoryContext } from "./model-context";
import { normalizeSharedMemoryText } from "./memory";
import type { ModelProvider } from "./provider";
import type { CaptureResult, CreatureProfile, SemanticBrainRecord } from "./types";

const actionSchema = z.enum(["observe", "respond", "ask", "save_episode", "save_long_term", "recall", "review", "quiet", "draft_reminder", "draft_question_list"]);
const optionalText = (max: number) =>
  z.preprocess((value) => cleanOptionalText(value, max), z.string().min(1).optional());

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
        shouldCreateEpisode: z.boolean(),
        shouldConsiderMemory: z.boolean(),
        shouldReply: z.boolean().optional(),
        reply: optionalText(700),
        visibleReaction: optionalText(260),
        memoryCandidateText: optionalText(650),
        memoryTags: z.array(z.preprocess((value) => cleanOptionalText(value, 40), z.string().optional()))
          .transform((values) => values.filter((value): value is string => Boolean(value)))
          .pipe(z.array(z.string().min(1).max(40)).max(10))
          .optional(),
        relatedMemoryIds: z.array(z.preprocess((value) => cleanOptionalText(value, 80), z.string().optional()))
          .transform((values) => values.filter((value): value is string => Boolean(value)))
          .pipe(z.array(z.string().min(1).max(80)).max(6))
          .optional(),
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
  source: SemanticBrainRecord["source"]
): Promise<CaptureResult> {
  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for action selection.");
  if (!result.events.length) return result;

  const raw = await provider.generateJson<unknown>(buildSemanticActionPrompt(profile, result));
  if (!raw) throw new Error("empty action model result");
  const parsed = semanticActionSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid action JSON (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  const applied = applySemanticAction(profile, result, parsed.data);
  if (applied <= 0) throw new Error("action model did not select any known event");
  recordActionSemanticRun(profile, provider, source, applied);
  return result;
}

function applySemanticAction(profile: CreatureProfile, result: CaptureResult, suggestion: SemanticActionSuggestion) {
  const eventById = new Map(result.events.map((event) => [event.id, event]));
  const episodeByEventId = new Map(result.events.map((event, index) => [event.id, result.episodes[index]]));
  let applied = 0;

  for (const decision of suggestion.decisions) {
    const event = eventById.get(decision.eventId);
    if (!event) continue;

    const guarded = guardActionDecision(event, profile, decision.action);
    const relatedMemoryIds = validRelatedMemoryIds(profile, decision.relatedMemoryIds);
    event.actionDecision = guarded;
    event.suggestedAction = guarded.action;
    if (decision.noticed) event.noticed = safeProcessText(decision.noticed, event.noticed) ?? event.noticed;
    if (decision.reason) event.reason = safeProcessText(decision.reason, event.reason) ?? event.reason;
    if (relatedMemoryIds.length) event.relatedMemoryIds = relatedMemoryIds;
    event.semanticSource = "llm";
    event.decisionTrace = [
      ...(event.decisionTrace ?? []),
      "llm: action selected",
      decision.userIntent ? `intent=${safeProcessText(decision.userIntent) ?? "not_shown"}` : "intent=not_provided",
      decision.reason ? `action_reason=${safeProcessText(decision.reason) ?? "not_shown"}` : "action_reason=not_provided",
      `episode=${decision.shouldCreateEpisode}`,
      `memory_candidate=${decision.shouldConsiderMemory}`,
      decision.shouldReply === undefined ? "should_reply=not_provided" : `should_reply=${decision.shouldReply}`,
      `guardrail: action=${guarded.action}`
    ];

    const episode = episodeByEventId.get(event.id);
    if (episode) {
      episode.actionDecision = guarded;
      episode.decisionTrace = event.decisionTrace;
      episode.noticed = event.noticed;
      episode.importanceReason = event.reason;
      if (relatedMemoryIds.length) episode.relatedMemoryIds = relatedMemoryIds;
      if (decision.userIntent) episode.possibleIntent = safeProcessText(decision.userIntent, episode.possibleIntent) ?? episode.possibleIntent;
      if (decision.reason) episode.importanceReason = safeProcessText(decision.reason, episode.importanceReason) ?? episode.importanceReason;
      const reply = safeExternalText(decision.reply, event.triggerContent);
      if (reply && decision.reply) episode.creatureResponse = reply;
      if (decision.memoryTags?.length) episode.tags = decision.memoryTags;
      const reaction = safeExternalText(decision.visibleReaction, event.triggerContent);
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
      const reply = safeExternalText(decision.reply, event.triggerContent);
      if (reply && decision.reply && decision.shouldReply !== false) result.response = reply;
      if (decision.shouldReply === false && !decision.reply) {
        result.response = "";
        if (episode) episode.creatureResponse = "";
      }
      }
      validatePersistenceDecision(decision);
      applyPersistenceDecision(profile, result, episode, decision);
      applied += 1;
  }

  return applied;
}

function validatePersistenceDecision(decision: ActionDecisionSuggestion) {
  if (decision.shouldConsiderMemory && !decision.shouldCreateEpisode) {
    throw new Error("action model requested memory consideration without an episode");
  }
  if ((decision.action === "save_episode" || decision.action === "save_long_term") && !decision.shouldCreateEpisode) {
    throw new Error("action model selected a save action without an episode");
  }
  if (decision.action === "save_long_term" && !decision.shouldConsiderMemory) {
    throw new Error("action model selected long-term save without a memory candidate");
  }
}

function applyPersistenceDecision(
  profile: CreatureProfile,
  result: CaptureResult,
  episode: CaptureResult["episodes"][number] | undefined,
  decision: ActionDecisionSuggestion
) {
  if (!episode) return;
  if (!decision.shouldCreateEpisode) {
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

function safeExternalText(text?: string, sourceText?: string) {
  const normalized = safeProcessText(text);
  if (!normalized) {
    if (text?.trim()) throw new Error("model returned invalid visible text");
    return undefined;
  }
  if (containsFullInputEcho(normalized, sourceText)) throw new Error("model echoed the full user input in visible reply");
  return normalized;
}

function safeProcessText(text?: string, previousText?: string) {
  const raw = text?.trim();
  if (!raw) return previousText;
  const normalized = normalizeSharedMemoryText(raw).trim();
  if (!normalized) return previousText;
  return normalized;
}

function containsFullInputEcho(reply: string, sourceText?: string) {
  const input = compactText(sourceText);
  const output = compactText(reply);
  if (input.length < 22 || output.length < 80) return false;
  if (output.includes(input)) return true;
  return output.includes(input.slice(0, 18)) && output.includes(input.slice(-10));
}

function compactText(text?: string) {
  return (text ?? "").replace(/[，。！？、\s:：,.!?]/g, "");
}

function trimSentence(text: string) {
  return text.replace(/[。.!！]+$/, "");
}

function recordActionSemanticRun(profile: CreatureProfile, provider: ModelProvider, source: SemanticBrainRecord["source"], applied: number) {
  profile.semanticBrainHistory.unshift({
    id: makeId("semantic"),
    at: new Date().toISOString(),
    source,
    providerKind: provider.kind,
    providerName: provider.name,
    status: "applied",
    message: `llm action decision applied to ${applied} event(s)`,
    ruleTrace: [`provider=${provider.kind}`, `source=${source}`, "status=applied", "stage=action"]
  });
  profile.semanticBrainHistory = profile.semanticBrainHistory.slice(0, 30);
}

function buildSemanticActionPrompt(profile: CreatureProfile, result: CaptureResult) {
  return `请作为 Papo 的行动选择脑，为已经被注意到的事件选择下一步动作。

系统提供可选动作和护栏。你负责判断此刻最自然的小动物行动：
- observe：听见但先不打断。
- respond：直接回应用户。
- ask：轻轻问一句确认。
- save_episode：留下这次经历，等待后续反馈。
- save_long_term：建议长期记住。
- recall：带着旧记忆回应。
- review：陪用户整理/复盘。
- quiet：安静陪着。
- draft_reminder：形成提醒草稿。
- draft_question_list：形成问题清单草稿。

护栏会再次校验：
- action 必须在白名单内。
- 你不能改状态数值或直接写记忆。

判断口径：
- conversation timeline 会保存用户和 Papo 的对话；这不等于每句话都要形成 episode。
- shouldCreateEpisode 只用于以后回看仍有意义的片段，例如用户分享了正在发生的事、偏好、习惯、情绪、计划、关系变化、明确训练或明确要求记住。
- shouldConsiderMemory 比 shouldCreateEpisode 更窄，只用于可能值得进入后续记忆判断的片段。
- 普通寒暄、单纯打招呼、误触、空白/嘈杂声音，通常 reply/observe 即可，shouldCreateEpisode=false，shouldConsiderMemory=false。
- 用户明确说“记住”、表达稳定习惯/偏好/重要事实时，通常 shouldCreateEpisode=true，shouldConsiderMemory=true。
- 如果你只是想当下陪用户聊一句，不要把它送进记忆候选。

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
      "shouldCreateEpisode": true,
      "shouldConsiderMemory": false,
      "shouldReply": true,
      "reply": "...",
      "visibleReaction": "...",
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
shouldCreateEpisode 决定这次是否应该留下为一条经历；普通寒暄、误触、无意义噪音通常为 false。
shouldConsiderMemory 决定这次是否进入后续记忆判断；只有值得被之后记住、反馈、回忆或整理的事件才为 true。shouldConsiderMemory=true 时 shouldCreateEpisode 必须为 true。
如果 action 是 save_episode 或 save_long_term，shouldCreateEpisode 必须为 true；如果 action 是 save_long_term，shouldConsiderMemory 必须为 true。
如果 recent_memories 里有自然联想到的旧记忆，可以在 relatedMemoryIds 里返回对应 id；不能编造不存在的 id。

例子：
- 用户说“你好呀 Papo”：action=respond, shouldCreateEpisode=false, shouldConsiderMemory=false, reply 写一句自然问候。
- 用户说“我准备去游泳，但游泳馆人太多让我有点烦”：action 可以 respond/ask/review, shouldCreateEpisode=true, shouldConsiderMemory=true 或 false 由你判断它是否值得以后记住。
- 用户说“请记住：我每周二晚上都会游泳”：action=save_long_term, shouldCreateEpisode=true, shouldConsiderMemory=true。

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

events:
${JSON.stringify(result.events.map((event) => ({
  id: event.id,
  source: event.source,
  label: event.triggerLabel,
  content: modelSafeEventContent(event.triggerContent),
  contentHiddenForPrivacy: isHighPrivacySegmentContent(event.triggerContent),
  noticed: modelSafeEventContent(event.noticed),
  reason: modelSafeEventContent(event.reason),
  relatedMemoryIds: event.relatedMemoryIds,
  attentionStrength: event.attentionStrength,
  privacyRisk: event.privacyRisk,
  currentGuardedAction: event.actionDecision.action,
  blockedActions: event.actionDecision.blockedActions,
  safetyNotes: event.actionDecision.safetyNotes,
  tags: isHighPrivacySegmentContent(event.triggerContent) ? [] : event.tags
})))}
`;
}

function modelSafeEventContent(text: string) {
  return text;
}

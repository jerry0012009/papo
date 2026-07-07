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
    applied += 1;
  }

  return applied;
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

noticed、userIntent、reason、memoryCandidateText 是内部理解和记忆材料；reply 和 visibleReaction 是可能给用户看的外显语言。不要把内部流程解释写进 reply。
如果 recent_memories 里有自然联想到的旧记忆，可以在 relatedMemoryIds 里返回对应 id；不能编造不存在的 id。

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

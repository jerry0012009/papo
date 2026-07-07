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
        reason: optionalText(420),
        shouldReply: z.boolean().optional(),
        reply: optionalText(700),
        visibleReaction: optionalText(260),
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
    event.actionDecision = guarded;
    event.suggestedAction = guarded.action;
    event.semanticSource = "llm";
    event.decisionTrace = [
      ...(event.decisionTrace ?? []),
      "llm: action selected",
      decision.reason ? `action_reason=${safeProcessText(decision.reason) ?? "not_shown"}` : "action_reason=not_provided",
      decision.shouldReply === undefined ? "should_reply=not_provided" : `should_reply=${decision.shouldReply}`,
      `guardrail: action=${guarded.action}`
    ];

    const episode = episodeByEventId.get(event.id);
    if (episode) {
      episode.actionDecision = guarded;
      episode.decisionTrace = event.decisionTrace;
      if (decision.reason) episode.importanceReason = safeProcessText(decision.reason, episode.importanceReason) ?? episode.importanceReason;
      const reply = safeExternalText(decision.reply, event.triggerContent);
      if (reply && decision.reply) episode.creatureResponse = reply;
      const reaction = safeExternalText(decision.visibleReaction, event.triggerContent);
      if (reaction) {
        const baseExperience = episode.creatureExperience ?? event.creatureExperience;
        episode.creatureExperience = {
          ...baseExperience,
          earReason: `${trimSentence(reaction)}。`
        };
        event.creatureExperience = episode.creatureExperience;
      }
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

function safeExternalText(text?: string, sourceText?: string) {
  if (text?.trim() && containsInternalProcessLanguage(text)) throw new Error("model returned internal process language for visible text");
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
  if (!normalized || containsInternalProcessLanguage(normalized)) return previousText;
  return normalized;
}

function containsInternalProcessLanguage(text: string) {
  return /LLM|语义|用户意图|用户在|用户希望|系统|后台|流程|attention|semantic|harness|candidate|episode|数据库|规则层|写入|情景记忆|长期保存|长期记忆|prompt|JSON|score|阈值|行动选择脑|决策脑|你刚才是在叫我说话|先回应你|先回答你/i.test(text);
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

规则层提供可选动作和护栏。你负责判断此刻最自然的小动物行动：
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

规则会再次校验：
- action 必须在白名单内。
- 高隐私内容不能自动长期保存、提醒或直接引用。
- 低精力、安静倾向、隐私敏感度会限制动作。
- 你不能改状态数值或直接写记忆。

返回严格 JSON：
{
  "decisions": [
    {
      "eventId": "attention_xxx",
      "action": "respond",
      "reason": "...",
      "shouldReply": true,
      "reply": "...",
      "visibleReaction": "...",
      "tone": "..."
    }
  ]
}

不要输出内部词：LLM、语义、后台、流程、candidate、episode、score、阈值、JSON、数据库、写入、长期记忆、情景记忆。
reply 和 visibleReaction 是可能给用户看的外显语言，只写 Papo 真实会说/会做的短句。
如果 contentHiddenForPrivacy=true，reply 不能声称看到了具体内容，也不要说“我看到啦”；只能表达“这类内容我先不直接留下，等你确认怎么处理”。
如果用户追问 Papo 刚才为什么那样说，应该直接解释“我刚才说得别扭，我只是想让你知道我听见了”，不要复读原句，也不要装作没听懂。
明确区分说话者和被指代对象：用户消息里的“我”通常是用户，“你”通常是 Papo；Papo 回复里的“我”才是 Papo 自己。不要把用户对 Papo 的描述误写成用户自己的经历。

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
  currentRuleAction: event.actionDecision.action,
  blockedActions: event.actionDecision.blockedActions,
  safetyNotes: event.actionDecision.safetyNotes,
  tags: isHighPrivacySegmentContent(event.triggerContent) ? [] : event.tags
})))}
`;
}

function modelSafeEventContent(text: string) {
  if (!isHighPrivacySegmentContent(text)) return text;
  return "[这段包含可能的密钥、验证码、密码、地址或证件信息，原文已隐藏；行动上只能先询问或安静等待，不能直接引用或保存。]";
}

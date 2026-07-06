import { z } from "zod";
import { guardActionDecision } from "./action";
import { createMemoryResonanceEmergence } from "./emergence";
import { handleButtonCapture, handleCuriousStream } from "./attention";
import type { ModelProvider } from "./provider";
import type { CaptureResult, CreatureProfile, StreamSegment } from "./types";

const actionSchema = z.enum(["observe", "ask", "save_episode", "save_long_term", "recall", "review", "quiet", "draft_reminder", "draft_question_list"]);

const brainSuggestionSchema = z.object({
  response: z.string().min(1).max(900).optional(),
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
  trace: z.array(z.string().min(1).max(160)).max(8).optional()
}).refine(
  (value) => Boolean(value.response || value.events?.length || value.episodes?.length || value.trace?.length),
  "semantic brain result must contain at least one useful field"
);

type BrainSuggestion = z.infer<typeof brainSuggestionSchema>;

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
    recordMemoryResonance(profile, result);
    result.harnessTrace = [...trace, "semantic: fallback/rules only"];
    return result;
  }

  try {
    const suggestion = await askSemanticBrain(profile, result, provider, source);
    if (!suggestion) {
      recordMemoryResonance(profile, result);
      result.harnessTrace = [...trace, "semantic: empty model result"];
      return result;
    }

    applySuggestion(profile, result, suggestion);
    result.harnessTrace = [...trace, "semantic: llm interpretation applied", ...(suggestion.trace ?? [])];
    return result;
  } catch (error) {
    recordMemoryResonance(profile, result);
    result.harnessTrace = [...trace, `semantic: model failed (${error instanceof Error ? error.message : "unknown"})`];
    return result;
  }
}

async function askSemanticBrain(
  profile: CreatureProfile,
  result: CaptureResult,
  provider: ModelProvider,
  source: "button" | "curious_stream"
) {
  const suggestion = await provider.generateJson<unknown>(buildPrompt(profile, result, source));
  const parsed = brainSuggestionSchema.safeParse(suggestion);
  return parsed.success ? parsed.data : undefined;
}

function applySuggestion(profile: CreatureProfile, result: CaptureResult, suggestion: BrainSuggestion) {
  const eventById = new Map(result.events.map((event) => [event.id, event]));
  const episodeByEventId = new Map(result.events.map((event, index) => [event.id, result.episodes[index]]));

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

  for (const event of result.events) {
    const episode = episodeByEventId.get(event.id);
    if (!episode) continue;
    episode.noticed = event.noticed;
    episode.importanceReason = event.reason;
    episode.decisionTrace = event.decisionTrace;
    episode.actionDecision = event.actionDecision;
  }

  recordMemoryResonance(profile, result);

  if (suggestion.response) result.response = suggestion.response;
}

function recordMemoryResonance(profile: CreatureProfile, result: CaptureResult) {
  for (const event of result.events) {
    if (event.relatedMemoryIds.length) createMemoryResonanceEmergence(profile, event);
  }
}

function buildPrompt(profile: CreatureProfile, result: CaptureResult, source: "button" | "curious_stream") {
  return `请作为 Papo 的语义脑，读取规则层产生的候选 attention events，改进语义理解和表达。

你可以：
- 改写 noticed/reason，让它更像小动物真的注意到了什么。
- 给出 suggestedAction，但只能从 observe, ask, save_episode, save_long_term, recall, review, quiet, draft_reminder, draft_question_list 选择。
- 改写 episode 的 possibleIntent/importanceReason/creatureResponse。
- 写一段 response，给用户展示这次小动物的整体回应。

你不能：
- 改状态数值。
- 删除用户记忆。
- 在高隐私风险时建议直接长期保存。
- 输出数据库解释或产品说明口吻。

返回严格 JSON：
{
  "response": "...",
  "events": [{"id":"...", "noticed":"...", "reason":"...", "suggestedAction":"..."}],
  "episodes": [{"eventId":"...", "possibleIntent":"...", "importanceReason":"...", "creatureResponse":"..."}],
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
`;
}

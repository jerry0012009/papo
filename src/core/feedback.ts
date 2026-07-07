import { z } from "zod";
import { clampPolicy } from "./drive";
import { makeId } from "./ids";
import { adjustMemoryWeight, forgetMemory, normalizeSharedMemoryText, promoteEpisode } from "./memory";
import { modelConversationContext, modelFeedbackContext, modelMemoryContext } from "./model-context";
import { hasHighPrivacyText, tagsForModel, textForModel } from "./privacy";
import type { ModelProvider } from "./provider";
import { applyStateDelta } from "./state";
import { summarizeText } from "./text";
import type { CreatureProfile, CreatureState, FeedbackKind, FeedbackPolicyProfile, FeedbackRecord, LongTermMemory, SegmentKind } from "./types";

const stateDeltaSchema = z
  .object({
    curiosity: z.number().min(-15).max(15).optional(),
    attachment: z.number().min(-15).max(15).optional(),
    energy: z.number().min(-15).max(15).optional(),
    arousal: z.number().min(-15).max(15).optional(),
    safety: z.number().min(-15).max(15).optional(),
    confidence: z.number().min(-15).max(15).optional()
  })
  .partial();

const policyDeltaSchema = z
  .object({
    preferDepth: z.number().min(-15).max(15).optional(),
    preferProactivity: z.number().min(-15).max(15).optional(),
    privacySensitivity: z.number().min(-15).max(15).optional(),
    saveThreshold: z.number().min(-15).max(15).optional(),
    askThreshold: z.number().min(-15).max(15).optional(),
    recallTendency: z.number().min(-15).max(15).optional(),
    quietTendency: z.number().min(-15).max(15).optional()
  })
  .partial();

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

const semanticFeedbackSchema = z
  .object({
    responseAction: z.enum(["acknowledge", "ask_follow_up", "quiet", "note_memory"]).optional(),
    stateDeltas: stateDeltaSchema.optional(),
    policyDeltas: policyDeltaSchema.optional(),
    memoryWeightDelta: z.number().min(-30).max(30).optional(),
    learningNote: optionalText(260),
    followUpText: optionalText(180),
    effect: optionalText(260),
    creatureSelfMemory: z
      .object({
        text: optionalText(420),
        tags: optionalTextArray(8, 40)
      })
      .optional(),
    trace: z.array(z.string().min(1).max(160)).max(8).optional()
  })
  .refine(
    (value) =>
      Boolean(
        Object.keys(value.stateDeltas ?? {}).length ||
          Object.keys(value.policyDeltas ?? {}).length ||
          value.memoryWeightDelta ||
          value.learningNote ||
          value.followUpText ||
          value.effect ||
          value.creatureSelfMemory ||
          value.responseAction
      ),
    "semantic feedback result must contain at least one useful field"
  );

type SemanticFeedbackSuggestion = z.infer<typeof semanticFeedbackSchema>;

export function applyFeedback(
  profile: CreatureProfile,
  input: { kind: FeedbackKind; targetId?: string; content?: string; modality?: SegmentKind | "button"; now?: string }
): FeedbackRecord {
  const now = input.now ?? new Date().toISOString();
  const inputText = input.content?.trim();
  const targetEpisode = profile.episodes.find((item) => item.id === input.targetId);
  const targetLongTerm = profile.longTermMemories.find((item) => item.id === input.targetId);
  const record: FeedbackRecord = {
    id: makeId("feedback"),
    at: now,
    kind: input.kind,
    targetId: input.targetId,
    inputText,
    inputModality: input.modality ?? (inputText ? "text" : "button"),
    effect: "",
    learningNote: "",
    memoryCandidateIds: []
  };

  profile.feedbackHistory.unshift(record);
  profile.feedbackHistory = profile.feedbackHistory.slice(0, 60);

  if (targetEpisode) targetEpisode.feedback.push(input.kind);

  if (input.kind === "remember" && input.targetId) {
    const memory = promoteEpisode(profile, input.targetId, now);
    if (memory && inputText) {
      memory.text = `${memory.text} 你确认时还补充：${summarizeText(inputText, 120)}`;
    }
    if (!memory && targetLongTerm && inputText) {
      targetLongTerm.text = normalizeSharedMemoryText(`${targetLongTerm.text} 你确认时还补充：${summarizeText(inputText, 120)}`);
      targetLongTerm.lastReferencedAt = now;
    }
  }
  const forgetResult = input.kind === "forget" ? forgetMemory(profile, input.targetId) : undefined;
  void forgetResult;

  return record;
}

export async function semanticReflectFeedback(
  profile: CreatureProfile,
  feedback: FeedbackRecord,
  provider: ModelProvider
): Promise<FeedbackRecord> {
  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for feedback reflection.");

  const raw = await provider.generateJson<unknown>(buildSemanticFeedbackPrompt(profile, feedback));
  if (!raw) throw new Error("empty feedback model result");
  const parsed = semanticFeedbackSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid feedback JSON (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  }
  assertSemanticFeedbackVisibleOutput(parsed.data);
  applySemanticFeedbackSuggestion(profile, feedback, parsed.data);
  recordFeedbackSemanticRun(profile, provider, "applied", "llm feedback reflection applied");
  return feedback;
}

export function composeFeedbackReplyText(feedback: FeedbackRecord) {
  return [feedback.learningNote, feedback.followUpText].filter(Boolean).join("\n");
}

function stateDeltas(before: CreatureState, after: CreatureState): FeedbackRecord["stateDeltas"] {
  return (["curiosity", "attachment", "energy", "arousal", "safety", "confidence"] as const)
    .map((key) => ({ key, before: before[key], after: after[key], delta: after[key] - before[key] }))
    .filter((item) => item.delta !== 0);
}

function policyDeltas(before: FeedbackPolicyProfile, after: FeedbackPolicyProfile): FeedbackRecord["policyDeltas"] {
  return (["preferDepth", "preferProactivity", "privacySensitivity", "saveThreshold", "askThreshold", "recallTendency", "quietTendency"] as const)
    .map((key) => ({ key, before: before[key], after: after[key], delta: after[key] - before[key] }))
    .filter((item) => item.delta !== 0);
}

function applySemanticFeedbackSuggestion(profile: CreatureProfile, feedback: FeedbackRecord, suggestion: SemanticFeedbackSuggestion) {
  const targetEpisode = profile.episodes.find((item) => item.id === feedback.targetId);
  const targetLongTerm = profile.longTermMemories.find((item) => item.id === feedback.targetId);

  const stateBefore = structuredClone(profile.state);
  const stateDeltasInput = cleanNumberDeltas(suggestion.stateDeltas);
  if (Object.keys(stateDeltasInput).length) {
    const change = applyStateDelta(profile, stateDeltasInput, "LLM reflected feedback inside guardrails", feedback.at);
    feedback.stateDeltas = mergeStateDeltas(feedback.stateDeltas, stateDeltas(stateBefore, change.after));
  }

  const policyBefore = structuredClone(profile.policyProfile);
  const policyDeltasInput = cleanNumberDeltas(suggestion.policyDeltas);
  if (Object.keys(policyDeltasInput).length) {
    profile.policyProfile = clampPolicy({
      ...profile.policyProfile,
      preferDepth: profile.policyProfile.preferDepth + (policyDeltasInput.preferDepth ?? 0),
      preferProactivity: profile.policyProfile.preferProactivity + (policyDeltasInput.preferProactivity ?? 0),
      privacySensitivity: profile.policyProfile.privacySensitivity + (policyDeltasInput.privacySensitivity ?? 0),
      saveThreshold: profile.policyProfile.saveThreshold + (policyDeltasInput.saveThreshold ?? 0),
      askThreshold: profile.policyProfile.askThreshold + (policyDeltasInput.askThreshold ?? 0),
      recallTendency: profile.policyProfile.recallTendency + (policyDeltasInput.recallTendency ?? 0),
      quietTendency: profile.policyProfile.quietTendency + (policyDeltasInput.quietTendency ?? 0)
    });
    feedback.policyDeltas = mergePolicyDeltas(feedback.policyDeltas, policyDeltas(policyBefore, profile.policyProfile));
  }

  if (Number.isFinite(suggestion.memoryWeightDelta) && feedback.targetId) {
    adjustMemoryWeight(profile, feedback.targetId, Math.round(suggestion.memoryWeightDelta ?? 0));
  }

  const effect = safeCreatureText(suggestion.effect);
  if (effect) feedback.effect = effect;
  const learningNote = safeCreatureText(suggestion.learningNote);
  if (learningNote && learningNote.startsWith("我学到")) feedback.learningNote = learningNote;
  const followUpText = safeCreatureText(suggestion.followUpText);
  if (followUpText) feedback.followUpText = followUpText;
  if (suggestion.responseAction) feedback.responseAction = suggestion.responseAction;
  if (suggestion.creatureSelfMemory) {
    upsertSemanticFeedbackSelfMemory(profile, feedback, suggestion.creatureSelfMemory, targetEpisode, targetLongTerm);
  }

  feedback.replyText = composeFeedbackReplyText(feedback);
}

function assertSemanticFeedbackVisibleOutput(suggestion: SemanticFeedbackSuggestion) {
  const learningNote = safeCreatureText(suggestion.learningNote);
  if (!learningNote || !learningNote.startsWith("我学到")) throw new Error("feedback model did not provide a usable learning note");
  const effect = safeCreatureText(suggestion.effect);
  if (!effect) throw new Error("feedback model did not provide a usable effect");
}

function cleanNumberDeltas<T extends Record<string, number | undefined> | undefined>(deltas: T) {
  const cleaned: Record<string, number> = {};
  for (const [key, value] of Object.entries(deltas ?? {})) {
    if (!Number.isFinite(value)) continue;
    const rounded = Math.round(Number(value));
    if (rounded !== 0) cleaned[key] = rounded;
  }
  return cleaned;
}

function mergeStateDeltas(
  existing: FeedbackRecord["stateDeltas"] = [],
  semantic: FeedbackRecord["stateDeltas"] = []
): FeedbackRecord["stateDeltas"] {
  return mergeDeltas(existing, semantic) as FeedbackRecord["stateDeltas"];
}

function mergePolicyDeltas(
  existing: FeedbackRecord["policyDeltas"] = [],
  semantic: FeedbackRecord["policyDeltas"] = []
): FeedbackRecord["policyDeltas"] {
  return mergeDeltas(existing, semantic) as FeedbackRecord["policyDeltas"];
}

function mergeDeltas<T extends { key: string; before: number; after: number; delta: number }>(existing: T[], semantic: T[]): T[] {
  const byKey = new Map(existing.map((item) => [item.key, { ...item }]));
  for (const item of semantic) {
    const current = byKey.get(item.key);
    byKey.set(item.key, current ? { ...current, after: item.after, delta: item.after - current.before } : { ...item });
  }
  return [...byKey.values()].filter((item) => item.delta !== 0) as T[];
}

function upsertSemanticFeedbackSelfMemory(
  profile: CreatureProfile,
  feedback: FeedbackRecord,
  memory: NonNullable<SemanticFeedbackSuggestion["creatureSelfMemory"]>,
  targetEpisode?: CreatureProfile["episodes"][number],
  targetLongTerm?: LongTermMemory
) {
  const safeText = safeCreatureText(memory.text);
  if (!safeText) return;
  const tags = safeStoredTags(["被你养成", "模型反馈学习", ...(memory.tags ?? [])]);
  const sourceEpisodeId = targetEpisode?.id ?? targetLongTerm?.sourceEpisodeId;
  const existing = profile.longTermMemories.find(
    (item) => item.kind === "creature_self_memory" && item.tags.includes("模型反馈学习") && sourceEpisodeId && item.sourceEpisodeId === sourceEpisodeId
  );
  if (existing) {
    existing.text = normalizeSharedMemoryText(safeText);
    existing.weight = Math.min(100, existing.weight + 8);
    existing.tags = safeStoredTags([...existing.tags, ...tags]);
    existing.lastReferencedAt = feedback.at;
    return;
  }
  profile.longTermMemories.unshift({
    id: makeId("ltm"),
    createdAt: feedback.at,
    kind: "creature_self_memory",
    text: normalizeSharedMemoryText(safeText),
    sourceEpisodeId,
    weight: 68,
    tags,
    consolidatedBecause: "这次反馈让我更认识自己该怎么靠近你。"
  });
}

function safeCreatureText(text?: string) {
  const normalized = normalizeSharedMemoryText(text?.trim() ?? "");
  if (!normalized) return undefined;
  return normalized;
}

function recordFeedbackSemanticRun(
  profile: CreatureProfile,
  provider: ModelProvider,
  status: "skipped" | "applied" | "empty" | "invalid" | "failed",
  message: string
) {
  profile.semanticBrainHistory.unshift({
    id: makeId("semantic"),
    at: new Date().toISOString(),
    source: "feedback",
    providerKind: provider.kind,
    providerName: provider.name,
    status,
    message,
    ruleTrace: [`provider=${provider.kind}`, "source=feedback", `status=${status}`]
  });
  profile.semanticBrainHistory = profile.semanticBrainHistory.slice(0, 30);
}

function buildSemanticFeedbackPrompt(profile: CreatureProfile, feedback: FeedbackRecord) {
  const targetEpisode = profile.episodes.find((item) => item.id === feedback.targetId);
  const targetLongTerm = profile.longTermMemories.find((item) => item.id === feedback.targetId);
  const feedbackPrivacyHigh = false;
  const targetPrivacyHigh = false;
  return `请作为 Papo 的反馈反思脑，根据这次用户反馈，决定 Papo 应该怎样被养成。

系统只记录了这次反馈和目标对象。你可以在护栏内决定：
- stateDeltas：curiosity, attachment, energy, arousal, safety, confidence，每项 -15 到 15。
- policyDeltas：preferDepth, preferProactivity, privacySensitivity, saveThreshold, askThreshold, recallTendency, quietTendency，每项 -15 到 15。
- memoryWeightDelta：目标 episode 或 memory 的权重变化，-30 到 30。
- responseAction：acknowledge, ask_follow_up, quiet, note_memory。
- learningNote：用户可见的一句话，必须以“我学到”开头。
- followUpText：如果确实需要，可以给一句短回应。
- creatureSelfMemory：如果这次反馈体现了用户正在训练 Papo 的长期回应习惯，写成一条 Papo 自己的成长记忆。

你不能：
- 使用未列出的字段。
- 编造用户没有说过的新事实。

返回严格 JSON：
{
  "responseAction":"acknowledge",
  "stateDeltas":{"curiosity":0},
  "policyDeltas":{"preferDepth":0},
  "memoryWeightDelta":0,
  "learningNote":"我学到...",
  "followUpText":"...",
  "effect":"...",
  "creatureSelfMemory":{"text":"...", "tags":["..."]},
  "trace":["..."]
}

feedback:
${JSON.stringify({
  ...feedback,
  inputText: textForModel(feedback.inputText, feedbackPrivacyHigh),
  effect: textForModel(feedback.effect, feedbackPrivacyHigh),
  learningNote: textForModel(feedback.learningNote, feedbackPrivacyHigh),
  followUpText: textForModel(feedback.followUpText, feedbackPrivacyHigh),
  replyText: textForModel(feedback.replyText, feedbackPrivacyHigh),
  contentHiddenForPrivacy: feedbackPrivacyHigh
})}

target:
${JSON.stringify(
  targetEpisode
    ? {
        type: "episode",
        inputSummary: textForModel(targetEpisode.inputSummary, targetPrivacyHigh),
        creatureResponse: textForModel(targetEpisode.creatureResponse, targetPrivacyHigh),
        tags: tagsForModel(targetEpisode.tags, targetPrivacyHigh),
        feedback: targetEpisode.feedback,
        contentHiddenForPrivacy: targetPrivacyHigh
      }
    : targetLongTerm
      ? {
          type: "memory",
          kind: targetLongTerm.kind,
          text: textForModel(targetLongTerm.text, targetPrivacyHigh),
          weight: targetLongTerm.weight,
          tags: tagsForModel(targetLongTerm.tags, targetPrivacyHigh),
          contentHiddenForPrivacy: targetPrivacyHigh
        }
      : { type: "none" }
)}

current_state:
${JSON.stringify(profile.state)}

current_policy:
${JSON.stringify(profile.policyProfile)}

recent_feedback:
${JSON.stringify(modelFeedbackContext(profile.feedbackHistory))}

recent_conversation_newest_first:
${JSON.stringify(modelConversationContext(profile))}

recent_memories:
${JSON.stringify(modelMemoryContext(profile.longTermMemories))}
`;
}

function usefulFeedbackTag(tag: string) {
  const clean = tag.trim();
  if (clean.length < 2) return false;
  if (/续想|请继续/.test(clean)) return false;
  return !/^(请|帮我|继续|这次|这个|这一|刚才|用户)/.test(clean);
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function safeStoredTags(tags: string[]) {
  return unique(tags);
}

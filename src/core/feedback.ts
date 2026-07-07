import { z } from "zod";
import { clampPolicy } from "./drive";
import { makeId } from "./ids";
import { adjustMemoryWeight, forgetMemory, normalizeSharedMemoryText } from "./memory";
import { modelConversationContext, modelFeedbackContext, modelMemoryContext } from "./model-context";
import { hasHighPrivacyText, tagsForModel, textForModel } from "./privacy";
import type { ModelProvider } from "./provider";
import { applyStateDelta } from "./state";
import type { CreatureProfile, CreatureState, FeedbackKind, FeedbackPolicyProfile, FeedbackRecord, LongTermMemory, SegmentKind } from "./types";

const memoryKindSchema = z.enum(["user_preference", "long_theme", "creature_self_memory", "safety_rule", "future_review", "relationship", "habit", "open_question"]);

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
  z.preprocess(
    nullToUndefined,
    z
      .array(z.preprocess((value) => cleanOptionalText(value, maxText), z.string().optional()))
      .transform((values) => values.filter((value): value is string => Boolean(value)))
      .pipe(z.array(z.string().min(1).max(maxText)).max(maxItems))
      .optional()
  );

const optionalObject = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(nullToUndefined, schema.optional());

function nullToUndefined(value: unknown) {
  return value === null ? undefined : value;
}

function cleanOptionalText(value: unknown, max: number) {
  if (value === null) return undefined;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

const semanticFeedbackSchema = z
  .object({
    responseAction: z.enum(["acknowledge", "ask_follow_up", "quiet", "note_memory"]).optional(),
    stateDeltas: optionalObject(stateDeltaSchema),
    policyDeltas: optionalObject(policyDeltaSchema),
    memoryWeightDelta: z.number().min(-30).max(30).optional(),
    learningNote: optionalText(260),
    followUpText: optionalText(180),
    replyText: optionalText(260),
    effect: optionalText(260),
    creatureSelfMemory: optionalObject(z
      .object({
        text: optionalText(420),
        tags: optionalTextArray(8, 40),
        consolidatedBecause: optionalText(360),
        weight: z.number().min(0).max(100).optional()
      })),
    memoryOperation: optionalObject(z
      .object({
        type: z.enum(["none", "promote_episode", "update_memory", "dismiss_target"]),
        text: optionalText(650),
        kind: memoryKindSchema.optional(),
        tags: optionalTextArray(10, 40),
        consolidatedBecause: optionalText(360),
        weight: z.number().min(0).max(100).optional()
      })),
    trace: z.preprocess(nullToUndefined, z.array(z.string().min(1).max(160)).max(8).optional())
  })
  .refine(
    (value) =>
      Boolean(
        Object.keys(value.stateDeltas ?? {}).length ||
          Object.keys(value.policyDeltas ?? {}).length ||
          value.memoryWeightDelta ||
          value.learningNote ||
          value.followUpText ||
          value.replyText ||
          value.effect ||
          value.creatureSelfMemory ||
          (value.memoryOperation && value.memoryOperation.type !== "none") ||
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
  assertSemanticFeedbackVisibleOutput(profile, feedback, parsed.data);
  applySemanticFeedbackSuggestion(profile, feedback, parsed.data);
  recordFeedbackSemanticRun(profile, provider, "applied", "llm feedback reflection applied");
  return feedback;
}

export function composeFeedbackReplyText(feedback: FeedbackRecord) {
  return [feedback.replyText].filter(Boolean).join("\n");
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
  if (learningNote) feedback.learningNote = learningNote;
  const followUpText = safeCreatureText(suggestion.followUpText);
  if (followUpText) feedback.followUpText = followUpText;
  const replyText = safeCreatureText(suggestion.replyText);
  if (replyText && suggestion.responseAction !== "quiet") feedback.replyText = replyText;
  if (suggestion.responseAction) feedback.responseAction = suggestion.responseAction;
  if (suggestion.creatureSelfMemory) {
    upsertSemanticFeedbackSelfMemory(profile, feedback, suggestion.creatureSelfMemory, targetEpisode, targetLongTerm);
  }
  if (suggestion.memoryOperation) {
    applySemanticMemoryOperation(profile, feedback, suggestion.memoryOperation, targetEpisode, targetLongTerm);
  }

  if (!feedback.replyText) feedback.replyText = "";
}

function assertSemanticFeedbackVisibleOutput(profile: CreatureProfile, feedback: FeedbackRecord, suggestion: SemanticFeedbackSuggestion) {
  const learningNote = safeCreatureText(suggestion.learningNote);
  if (!learningNote) throw new Error("feedback model did not provide a usable learning note");
  const effect = safeCreatureText(suggestion.effect);
  if (!effect) throw new Error("feedback model did not provide a usable effect");
  if (suggestion.responseAction && suggestion.responseAction !== "quiet") {
    const replyText = safeCreatureText(suggestion.replyText);
    if (!replyText) throw new Error("feedback model selected a visible feedback response without replyText");
  }
  if (feedback.kind === "correct" && feedback.targetId && feedback.inputText?.trim()) {
    const targetLongTerm = profile.longTermMemories.find((item) => item.id === feedback.targetId);
    const targetEpisode = profile.episodes.find((item) => item.id === feedback.targetId);
    const operation = suggestion.memoryOperation;
    if (targetLongTerm && suggestion.memoryOperation?.type !== "update_memory") {
      throw new Error("feedback model received a memory correction without update_memory");
    }
    if (targetLongTerm && !safeCreatureText(operation?.text)) {
      throw new Error("feedback model received a memory correction without corrected memory text");
    }
    if (targetEpisode && operation?.type !== "promote_episode") {
      throw new Error("feedback model received an episode correction without promote_episode");
    }
  }
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
  const tags = safeStoredTags(memory.tags ?? []);
  const sourceEpisodeId = targetEpisode?.id ?? targetLongTerm?.sourceEpisodeId;
  const normalizedText = normalizeSharedMemoryText(safeText);
  const existing = profile.longTermMemories.find(
    (item) =>
      item.kind === "creature_self_memory" &&
      ((sourceEpisodeId && item.sourceEpisodeId === sourceEpisodeId) || normalizeSharedMemoryText(item.text) === normalizedText)
  );
  if (existing) {
    existing.text = normalizedText;
    existing.weight = Math.max(0, Math.min(100, Math.round(memory.weight ?? Math.min(100, existing.weight + 8))));
    if (tags.length) existing.tags = safeStoredTags([...existing.tags, ...tags]);
    if (memory.consolidatedBecause) existing.consolidatedBecause = safeCreatureText(memory.consolidatedBecause) ?? existing.consolidatedBecause;
    existing.lastReferencedAt = feedback.at;
    return;
  }
  profile.longTermMemories.unshift({
    id: makeId("ltm"),
    createdAt: feedback.at,
    kind: "creature_self_memory",
    text: normalizedText,
    sourceEpisodeId,
    weight: Math.max(0, Math.min(100, Math.round(memory.weight ?? 68))),
    tags,
    consolidatedBecause: safeCreatureText(memory.consolidatedBecause)
  });
}

function applySemanticMemoryOperation(
  profile: CreatureProfile,
  feedback: FeedbackRecord,
  operation: NonNullable<SemanticFeedbackSuggestion["memoryOperation"]>,
  targetEpisode?: CreatureProfile["episodes"][number],
  targetLongTerm?: LongTermMemory
) {
  if (operation.type === "none") return;
  if (operation.type === "dismiss_target") {
    if (feedback.kind === "forget") return;
    forgetMemory(profile, feedback.targetId);
    return;
  }
  if (operation.type === "promote_episode") {
    if (!targetEpisode) throw new Error("feedback model requested episode promotion without an episode target");
    const text = safeCreatureText(operation.text);
    if (!text) throw new Error("feedback model requested episode promotion without memory text");
    if (!operation.kind) throw new Error("feedback model requested episode promotion without memory kind");
    const existing = profile.longTermMemories.find((memory) => memory.sourceEpisodeId === targetEpisode.id);
    const tags = operation.tags?.length ? safeStoredTags(operation.tags) : [];
    if (existing) {
      existing.kind = operation.kind;
      existing.text = normalizeSharedMemoryText(text);
      existing.consolidatedBecause = safeCreatureText(operation.consolidatedBecause) ?? existing.consolidatedBecause;
      existing.weight = Math.max(0, Math.min(100, Math.round(operation.weight ?? Math.max(existing.weight, targetEpisode.weight + 18))));
      if (tags.length) existing.tags = tags;
      existing.lastReferencedAt = feedback.at;
    } else {
      profile.longTermMemories.unshift({
        id: makeId("ltm"),
        createdAt: feedback.at,
        kind: operation.kind,
        text: normalizeSharedMemoryText(text),
        sourceEpisodeId: targetEpisode.id,
        consolidatedBecause: safeCreatureText(operation.consolidatedBecause),
        weight: Math.max(0, Math.min(100, Math.round(operation.weight ?? targetEpisode.weight + 18))),
        tags
      });
    }
    targetEpisode.promotedToLongTerm = true;
    for (const candidate of profile.memoryCandidates.filter((item) => item.sourceEpisodeId === targetEpisode.id)) {
      candidate.status = "promoted";
    }
    return;
  }
  if (operation.type === "update_memory") {
    if (!targetLongTerm) throw new Error("feedback model requested memory update without a memory target");
    const text = safeCreatureText(operation.text);
    if (text) targetLongTerm.text = normalizeSharedMemoryText(text);
    if (operation.kind) targetLongTerm.kind = operation.kind;
    if (operation.tags?.length) targetLongTerm.tags = safeStoredTags(operation.tags);
    if (operation.consolidatedBecause) targetLongTerm.consolidatedBecause = safeCreatureText(operation.consolidatedBecause) ?? targetLongTerm.consolidatedBecause;
    if (Number.isFinite(operation.weight)) targetLongTerm.weight = Math.max(0, Math.min(100, Math.round(operation.weight ?? targetLongTerm.weight)));
    targetLongTerm.lastReferencedAt = feedback.at;
  }
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
    stage: "feedback",
    providerKind: provider.kind,
    providerName: provider.name,
    model: provider.diagnostics?.textModel,
    status,
    message,
    ruleTrace: [`provider=${provider.kind}`, "source=feedback", `status=${status}`]
  });
  profile.semanticBrainHistory = profile.semanticBrainHistory.slice(0, 30);
}

function buildSemanticFeedbackPrompt(profile: CreatureProfile, feedback: FeedbackRecord) {
  const targetEpisode = profile.episodes.find((item) => item.id === feedback.targetId);
  const targetLongTerm = profile.longTermMemories.find((item) => item.id === feedback.targetId);
  const previousFeedback = profile.feedbackHistory.filter((item) => item.id !== feedback.id);
  const feedbackPrivacyHigh = hasHighPrivacyText(feedback.inputText);
  const targetPrivacyHigh = targetEpisode
    ? hasHighPrivacyText(`${targetEpisode.inputSummary} ${targetEpisode.possibleIntent} ${targetEpisode.importanceReason} ${targetEpisode.creatureResponse}`)
    : targetLongTerm
      ? hasHighPrivacyText(targetLongTerm.text)
      : false;
  return `请作为 Papo 的反馈反思脑，根据这次用户反馈，决定 Papo 应该怎样被养成。

系统只记录了这次反馈和目标对象。你可以在护栏内决定：
JSON 字段名保持示例格式；所有自然语言字段值必须用中文。

- stateDeltas：curiosity, attachment, energy, arousal, safety, confidence，每项 -15 到 15。
- policyDeltas：preferDepth, preferProactivity, privacySensitivity, saveThreshold, askThreshold, recallTendency, quietTendency，每项 -15 到 15。
- memoryWeightDelta：目标 episode 或 memory 的权重变化，-30 到 30。
- memoryOperation：none, promote_episode, update_memory, dismiss_target。
- responseAction：acknowledge, ask_follow_up, quiet, note_memory。
- learningNote：内部学习记录，不给普通用户直接展示；不要写成前端说明或字段解释。
- followUpText：内部追问意图记录，不给普通用户直接展示。
- replyText：如果 responseAction 不是 quiet，写一句 Papo 可以直接对用户说的自然短回应；不要解释内部状态、字段、阈值或流程。
- creatureSelfMemory：如果这次反馈体现了用户正在训练 Papo 的长期回应习惯，写成一条 Papo 自己的成长记忆；text、tags、consolidatedBecause、weight 都由你决定。

memoryOperation 使用口径：
- promote_episode：用户明确要求记住某个 episode，或反馈文本把某个经历补准到值得长期记住。必须给 text 和 kind。
- update_memory：用户纠正、补充或改写某条长期记忆。可以给 text、kind、tags、weight。
- dismiss_target：用户通过文本/语音表达这件事不该留、不要再提、放下它。显式 forget 按钮已经会先执行一次存储层放下；你可以继续用 dismiss_target 表示语义上也应该放下。
- none：反馈只是在教 Papo 以后怎么回应，或者只是轻微鼓励/安抚，不需要改记忆。
- 即使 feedback.inputText 为空，feedback.kind 也代表用户的明确按钮反馈。
  - kind=remember 表示用户希望这件事被记住或从 episode 进入长期记忆。
  - kind=important 表示用户认为这条记忆更重要，通常应提高目标权重，必要时调整记忆文字或标签。
  - kind=remind 表示用户希望以后能被这件事提醒或回到这件事上，通常应考虑 future_review、open_question、标签或 consolidatedBecause 的调整；不要编造具体提醒时间。
  - kind=correct 表示用户正在把目标记忆或经历改准。target.type="memory" 时必须使用 memoryOperation.update_memory，并把用户给出的修正内容整理成新的记忆文本；target.type="episode" 时必须使用 promote_episode。
  - kind=forget 表示用户要求放下目标。
- 当前系统还没有定时通知调度器。kind=remind 的 replyText 不能承诺“以后会提醒你”“到时通知你”，只能说 Papo 会把这件事放得更靠前、之后更容易想起或一起回到这件事。

你不能：
- 使用未列出的字段。
- 编造用户没有说过的新事实。
- promote_episode 只能用于 target.type="episode"。
- update_memory 只能用于 target.type="memory"。

返回严格 JSON，最外层必须是对象，不能返回被引号包住的 JSON 字符串：
{
  "responseAction":"acknowledge",
  "stateDeltas":{"curiosity":0},
  "policyDeltas":{"preferDepth":0},
  "memoryWeightDelta":0,
  "learningNote":"...",
  "followUpText":"...",
  "replyText":"...",
  "effect":"...",
  "creatureSelfMemory":{"text":"...", "tags":["..."], "consolidatedBecause":"...", "weight":68},
  "memoryOperation":{
    "type":"promote_episode",
    "text":"...",
    "kind":"habit",
    "tags":["..."],
    "consolidatedBecause":"...",
    "weight":82
  },
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
        id: targetEpisode.id,
        inputSummary: textForModel(targetEpisode.inputSummary, targetPrivacyHigh),
        possibleIntent: textForModel(targetEpisode.possibleIntent, targetPrivacyHigh),
        importanceReason: textForModel(targetEpisode.importanceReason, targetPrivacyHigh),
        creatureResponse: textForModel(targetEpisode.creatureResponse, targetPrivacyHigh),
        promotedToLongTerm: targetEpisode.promotedToLongTerm,
        tags: tagsForModel(targetEpisode.tags, targetPrivacyHigh),
        feedback: targetEpisode.feedback,
        contentHiddenForPrivacy: targetPrivacyHigh
      }
    : targetLongTerm
      ? {
          type: "memory",
          id: targetLongTerm.id,
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
${JSON.stringify(modelFeedbackContext(previousFeedback))}

recent_conversation_newest_first:
${JSON.stringify(modelConversationContext(profile))}

recent_memories:
${JSON.stringify(modelMemoryContext(profile.longTermMemories))}
`;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function safeStoredTags(tags: string[]) {
  return unique(tags);
}

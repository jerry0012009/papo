import { z } from "zod";
import { clampPolicy, updatePolicyFromFeedback } from "./drive";
import { makeId } from "./ids";
import { createLearningNote } from "./experience";
import { adjustMemoryWeight, createMemoryCandidateFromEpisode, forgetMemory, normalizeSharedMemoryText, promoteEpisode } from "./memory";
import { modelConversationContext, modelFeedbackContext, modelMemoryContext } from "./model-context";
import { hasHighPrivacyText, tagsForModel, textForModel } from "./privacy";
import type { ModelProvider } from "./provider";
import { applyStateDelta, deltaForFeedback } from "./state";
import { extractTags, summarizeText } from "./text";
import type { CreatureProfile, CreatureState, FeedbackKind, FeedbackPolicyProfile, FeedbackRecord, LongTermMemory, SegmentKind } from "./types";

interface FeedbackReplyContext {
  tags: string[];
  targetEpisode?: CreatureProfile["episodes"][number];
  targetLongTerm?: LongTermMemory;
  forgetResult?: { changed: boolean; purged: boolean };
}

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
        text: z.string().min(8).max(420),
        tags: z.array(z.string().min(1).max(40)).max(8).optional()
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
  const tags = targetEpisode?.tags ?? targetLongTerm?.tags ?? [];
  const stateBefore = structuredClone(profile.state);
  const policyBefore = structuredClone(profile.policyProfile);
  const learningNote = createLearningNote(input.kind, tags, inputText);
  const effect = `${effectText(input.kind)} ${updatePolicyFromFeedback(profile, input.kind, tags)}`;
  const record: FeedbackRecord = {
    id: makeId("feedback"),
    at: now,
    kind: input.kind,
    targetId: input.targetId,
    inputText,
    inputModality: input.modality ?? (inputText ? "text" : "button"),
    effect,
    learningNote,
    memoryCandidateIds: []
  };

  profile.feedbackHistory.unshift(record);
  profile.feedbackHistory = profile.feedbackHistory.slice(0, 60);

  if (targetEpisode) targetEpisode.feedback.push(input.kind);

  const stateChange = applyStateDelta(profile, deltaForFeedback(input.kind), effect, now);
  record.stateDeltas = stateDeltas(stateBefore, stateChange.after);
  record.policyDeltas = policyDeltas(policyBefore, profile.policyProfile);

  if (input.kind === "remember" && input.targetId) {
    const memory = promoteEpisode(profile, input.targetId, now);
    if (memory && inputText && !hasPrivacyRisk(inputText)) {
      memory.text = `${memory.text} 你确认时还补充：${summarizeText(inputText, 120)}`;
      memory.tags = unique([...memory.tags, ...extractTags(inputText)]);
    }
    if (!memory && targetLongTerm && inputText && !hasPrivacyRisk(inputText)) {
      targetLongTerm.text = normalizeSharedMemoryText(`${targetLongTerm.text} 你确认时还补充：${summarizeText(inputText, 120)}`);
      targetLongTerm.tags = unique([...targetLongTerm.tags, ...extractTags(inputText)]);
      targetLongTerm.lastReferencedAt = now;
    }
  }
  const forgetResult = input.kind === "forget" ? forgetMemory(profile, input.targetId) : undefined;
  if (input.kind === "understood") adjustMemoryWeight(profile, input.targetId, 8);
  if (input.kind === "continue") {
    adjustMemoryWeight(profile, input.targetId, 12);
    if (targetEpisode) {
      const candidate = createMemoryCandidateFromEpisode(profile, targetEpisode, { feedback: "continue", now });
      if (inputText && !hasPrivacyRisk(inputText)) {
        candidate.candidateText = `你后来教我补上这一点：${summarizeText(inputText, 140)}。我会把它和原来的事放在一起理解。`;
        candidate.tags = unique([...candidate.tags, ...extractTags(inputText)]);
      }
      record.memoryCandidateIds?.push(candidate.id);
    }
  }
  if (input.kind === "not_now") adjustMemoryWeight(profile, input.targetId, -8);
  if (input.kind === "forget" && forgetResult?.changed && !forgetResult.purged) createSafetyMemoryFromForget(profile, targetEpisode, targetLongTerm, now);
  upsertFeedbackSelfMemory(profile, {
    kind: input.kind,
    tags,
    targetEpisode,
    targetLongTerm,
    inputText,
    now
  });

  const replyContext: FeedbackReplyContext = { tags, targetEpisode, targetLongTerm, forgetResult };
  record.responseAction = selectFeedbackResponseAction(input.kind, inputText, replyContext);
  record.followUpText = createFeedbackFollowUp(record.responseAction, input.kind, inputText, replyContext);
  record.replyText = composeFeedbackReplyText(record);

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
  removeRuleCreatedFeedbackSelfMemories(profile, feedback);
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

function removeRuleCreatedFeedbackSelfMemories(profile: CreatureProfile, feedback: FeedbackRecord) {
  profile.longTermMemories = profile.longTermMemories.filter(
    (memory) =>
      !(
        memory.kind === "creature_self_memory" &&
        memory.createdAt === feedback.at &&
        memory.tags.includes("被你养成") &&
        !memory.tags.includes("LLM理解反馈")
      )
  );
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
  if (!safeText || hasPrivacyRisk(safeText)) return;
  const tags = safeStoredTags(["被你养成", "LLM理解反馈", ...(memory.tags ?? []), ...extractTags(safeText)]);
  const sourceEpisodeId = targetEpisode?.id ?? targetLongTerm?.sourceEpisodeId;
  const existing = profile.longTermMemories.find(
    (item) => item.kind === "creature_self_memory" && item.tags.includes("LLM理解反馈") && sourceEpisodeId && item.sourceEpisodeId === sourceEpisodeId
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
  if (hasPrivacyRisk(normalized)) return undefined;
  if (/(LLM|语义|用户意图|用户在|用户希望|系统|后台|流程|candidate|episode|score|阈值|字段|JSON|prompt|数据库|写入|长期记忆|情景记忆)/i.test(normalized)) {
    return undefined;
  }
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
  const feedbackPrivacyHigh = hasPrivacyRisk(feedback.inputText ?? "");
  const targetPrivacyHigh = hasPrivacyRisk(
    `${targetEpisode?.inputSummary ?? ""} ${targetEpisode?.noticed ?? ""} ${targetEpisode?.creatureResponse ?? ""} ${targetEpisode?.tags.join(" ") ?? ""} ${targetLongTerm?.text ?? ""} ${targetLongTerm?.tags.join(" ") ?? ""}`
  );
  return `请作为 Papo 的反馈反思脑，根据这次用户反馈，决定 Papo 应该怎样被养成。

规则层已经做了一个保守 baseline。你可以在护栏内追加或修正：
- stateDeltas：curiosity, attachment, energy, arousal, safety, confidence，每项 -15 到 15。
- policyDeltas：preferDepth, preferProactivity, privacySensitivity, saveThreshold, askThreshold, recallTendency, quietTendency，每项 -15 到 15。
- memoryWeightDelta：目标 episode 或 memory 的权重变化，-30 到 30。
- responseAction：acknowledge, ask_follow_up, quiet, note_memory。
- learningNote：用户可见的一句话，必须以“我学到”开头。
- followUpText：如果确实需要，可以给一句短回应。
- creatureSelfMemory：如果这次反馈体现了用户正在训练 Papo 的长期回应习惯，写成一条 Papo 自己的成长记忆。

你不能：
- 使用未列出的字段。
- 输出内部词：LLM、语义、后台、流程、candidate、episode、score、阈值、JSON、数据库、写入、长期记忆、情景记忆。
- 把隐私、token、验证码、密码、地址等内容写进 creatureSelfMemory。
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

function effectText(kind: FeedbackKind): string {
  switch (kind) {
    case "understood":
      return "你说我这次懂对了，我会更敢把这种理解方式轻轻说出来。";
    case "continue":
      return "你让我再想一会儿，我以后会更愿意把相近的小事连起来多停一下。";
    case "not_now":
      return "你说这次先不用，我会把声音收小一点，学会不急着打扰你。";
    case "remember":
      return "你让我帮你记住，我会把这件事记得更准一点。";
    case "forget":
      return "你让我放下它，我会让这段变轻，也更小心守住边界。";
  }
}

function selectFeedbackResponseAction(kind: FeedbackKind, inputText: string | undefined, context: FeedbackReplyContext) {
  if (kind === "not_now" || kind === "forget") return "quiet";
  if (kind === "remember") return "note_memory";
  if (kind === "continue" && inputText && inputText.length >= 8 && hasFeedbackTarget(context)) return "ask_follow_up";
  if (kind === "continue") return "note_memory";
  return "acknowledge";
}

function createFeedbackFollowUp(
  action: NonNullable<FeedbackRecord["responseAction"]>,
  kind: FeedbackKind,
  inputText: string | undefined,
  context: FeedbackReplyContext
) {
  const topic = feedbackTopic(context);
  if (action === "ask_follow_up") {
    return `我还想轻轻问一句：下次再碰到${topic}时，我先帮你想起以前的小事，还是先问你一句确认？`;
  }
  if (action === "note_memory") {
    if (kind === "remember") {
      return inputText?.trim()
        ? `我会把你刚补的这点和${topic}放在一起，之后更容易接上。`
        : `我会把${topic}记稳一点，之后更容易接上。`;
    }
    return inputText?.trim()
      ? `我会先把你补的这点和${topic}放在一起，当成还没完全记稳的想法守着。`
      : `我会把${topic}再放近一点，之后更容易从这里继续想。`;
  }
  if (action === "quiet") {
    if (kind === "forget" && context.forgetResult?.purged) {
      return `我已经把${topic}彻底放下，只留下边界：下次类似内容先问你。`;
    }
    if (kind === "forget") {
      return `我先把${topic}放轻到最低，之后不把它当成会自己冒出来的小事。`;
    }
    return `我会先安静，把${topic}放轻一点；下次类似内容不急着追问。`;
  }
  return `我会按你这次教的方式靠近${topic}。`;
}

function hasFeedbackTarget(context: FeedbackReplyContext) {
  return Boolean(context.targetEpisode || context.targetLongTerm || context.tags.length);
}

function feedbackTopic(context: FeedbackReplyContext) {
  const tag = context.tags.find((item) => usefulFeedbackTag(item));
  if (tag) return `「${summarizeText(tag, 18)}」`;
  const text = context.targetEpisode?.inputSummary ?? context.targetEpisode?.noticed ?? context.targetLongTerm?.text;
  if (text) return `「${summarizeText(text, 18)}」`;
  return "这类事";
}

function usefulFeedbackTag(tag: string) {
  const clean = tag.trim();
  if (clean.length < 2) return false;
  if (hasPrivacyRisk(clean)) return false;
  if (/续想|请继续/.test(clean)) return false;
  return !/^(请|帮我|继续|这次|这个|这一|刚才|用户)/.test(clean);
}

function hasPrivacyRisk(text: string) {
  return hasHighPrivacyText(text);
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function safeStoredTags(tags: string[]) {
  return unique(tags.filter((tag) => !hasPrivacyRisk(tag)));
}

function createSafetyMemoryFromForget(
  profile: CreatureProfile,
  episode: CreatureProfile["episodes"][number] | undefined,
  memory: LongTermMemory | undefined,
  now: string
) {
  const text = episode?.inputSummary ?? memory?.text;
  if (!text) return;
  const privacyHigh = hasPrivacyRisk(text);
  profile.longTermMemories.unshift({
    id: makeId("ltm"),
    createdAt: now,
    kind: "safety_rule",
    text: privacyHigh
      ? "你让我放下一段需要保护的内容。以后遇到类似内容时，我应该先问，不要自己急着留下具体细节。"
      : `你让我放下类似内容。以后遇到相关主题时，我应该先问，不要自己急着留下：${text.slice(0, 80)}`,
    weight: 70,
    tags: privacyHigh ? [] : safeStoredTags(episode?.tags ?? memory?.tags ?? []),
    consolidatedBecause: "你用放下这一下教我先小心边界。"
  });
}

function upsertFeedbackSelfMemory(
  profile: CreatureProfile,
  input: {
    kind: FeedbackKind;
    tags: string[];
    targetEpisode?: CreatureProfile["episodes"][number];
    targetLongTerm?: LongTermMemory;
    inputText?: string;
    now: string;
  }
) {
  const trait = selfMemoryTrait(input.kind);
  const topic = selfMemoryTopic(input);
  const extra = input.inputText && !hasPrivacyRisk(input.inputText) ? ` 你还用自己的话教我：${summarizeText(input.inputText, 80)}。` : "";
  const text = normalizeSharedMemoryText(`${trait.text(topic)}${extra}`);
  const topicPrivacyHigh = hasPrivacyRisk(`${input.inputText ?? ""} ${input.targetEpisode?.inputSummary ?? ""} ${input.targetLongTerm?.text ?? ""} ${input.tags.join(" ")}`);
  const tags = safeStoredTags(["被你养成", trait.tag, ...(topicPrivacyHigh ? [] : input.tags), ...extractTags(topic)]);
  const sourceEpisodeId = input.targetEpisode?.id ?? input.targetLongTerm?.sourceEpisodeId;
  const existing = profile.longTermMemories.find((memory) => memory.kind === "creature_self_memory" && memory.tags.includes(trait.tag));

  if (existing) {
    existing.text = text;
    existing.weight = Math.min(100, existing.weight + 10);
    existing.tags = safeStoredTags([...existing.tags, ...tags]);
    existing.lastReferencedAt = input.now;
    existing.sourceEpisodeId ??= sourceEpisodeId;
    existing.consolidatedBecause = "你反复用反馈教我，我更认识自己该怎么靠近你。";
    return;
  }

  profile.longTermMemories.unshift({
    id: makeId("ltm"),
    createdAt: input.now,
    kind: "creature_self_memory",
    text,
    sourceEpisodeId,
    weight: 64,
    tags,
    consolidatedBecause: "你刚才的反馈让我更认识自己该怎么靠近你。"
  });
}

function selfMemoryTrait(kind: FeedbackKind) {
  switch (kind) {
    case "understood":
      return {
        tag: "被确认",
        text: (topic: string) => `你告诉我这次懂对了，我更敢相信这种听法。以后遇到${topic}，我会先照着这次的理解靠近。`
      };
    case "continue":
      return {
        tag: "更愿意多想",
        text: (topic: string) => `你教我不要浅浅带过。以后遇到${topic}，我会多停一下，先想起以前的小事再回应。`
      };
    case "not_now":
      return {
        tag: "更安静",
        text: (topic: string) => `你教我不是每次注意到都要插话。以后遇到${topic}，我会先轻声陪着，不急着追问。`
      };
    case "remember":
      return {
        tag: "更愿意记稳",
        text: (topic: string) => `你教我被确认的内容值得记稳。以后遇到${topic}，我会更愿意把它和以前的事连起来。`
      };
    case "forget":
      return {
        tag: "更小心边界",
        text: (topic: string) => `你教我这类内容要先小心边界。以后遇到${topic}，我会先问你，再决定要不要记。`
      };
  }
}

function selfMemoryTopic(input: {
  tags: string[];
  targetEpisode?: CreatureProfile["episodes"][number];
  targetLongTerm?: LongTermMemory;
  inputText?: string;
}) {
  const contextPrivacyHigh = hasPrivacyRisk(`${input.inputText ?? ""} ${input.targetEpisode?.inputSummary ?? ""} ${input.targetLongTerm?.text ?? ""} ${input.tags.join(" ")}`);
  if (contextPrivacyHigh) return "这类需要保护的内容";
  const tag = input.tags.find((item) => usefulFeedbackTag(item));
  if (tag) return `「${summarizeText(tag, 18)}」`;
  const text = input.targetEpisode?.inputSummary ?? input.targetEpisode?.noticed ?? input.targetLongTerm?.text ?? input.inputText;
  if (hasPrivacyRisk(text ?? "")) return "这类需要保护的内容";
  if (text) return `「${summarizeText(text, 22)}」`;
  return "这类事";
}

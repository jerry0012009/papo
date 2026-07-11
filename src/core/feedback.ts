import { z } from "zod";
import { clampPolicy } from "./drive";
import { makeId } from "./ids";
import { adjustMemoryWeight, forgetMemory, memoryShortTitle, mergeAttachments, normalizeSharedMemoryText, promoteMemoryCandidate } from "./memory";
import { modelConversationContext, modelFeedbackContext, modelMemoryContext } from "./model-context";
import { hasHighPrivacyText, tagsForModel, textForModel } from "./privacy";
import type { ModelProvider } from "./provider";
import { applyStateDelta } from "./state";
import type { CreatureProfile, CreatureState, FeedbackKind, FeedbackPolicyProfile, FeedbackRecord, FeedbackTargetSnapshot, LongTermMemory, MemoryCandidate, SegmentKind } from "./types";

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
const requiredText = (max: number) =>
  z.preprocess((value) => cleanOptionalText(value, max), z.string().min(1).max(max));
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
    learningNote: requiredText(260),
    followUpText: optionalText(180),
    replyText: optionalText(260),
    effect: requiredText(260),
    creatureSelfMemory: optionalObject(z
      .object({
        text: optionalText(420),
        tags: optionalTextArray(8, 40),
        consolidatedBecause: optionalText(360),
        weight: z.number().min(0).max(100).optional()
      })),
    memoryOperation: optionalObject(z
      .object({
        type: z.enum(["none", "promote_episode", "promote_candidate", "update_memory", "update_candidate", "dismiss_target"]),
        text: optionalText(650),
        shortTitle: optionalText(8),
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
  const targetCandidate = profile.memoryCandidates.find((item) => item.id === input.targetId);
  const targetLongTerm = profile.longTermMemories.find((item) => item.id === input.targetId);
  const record: FeedbackRecord = {
    id: makeId("feedback"),
    at: now,
    kind: input.kind,
    targetId: input.targetId,
    targetSnapshot: snapshotFeedbackTarget(targetEpisode, targetLongTerm, targetCandidate),
    inputText,
    inputModality: input.modality ?? (inputText ? "text" : "button"),
    effect: "",
    learningNote: "",
    memoryCandidateIds: []
  };

  profile.feedbackHistory.unshift(record);
  profile.feedbackHistory = profile.feedbackHistory.slice(0, 60);

  if (targetEpisode) targetEpisode.feedback.push(input.kind);
  if (targetCandidate) record.memoryCandidateIds = [targetCandidate.id];
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

  const basePrompt = buildSemanticFeedbackPrompt(profile, feedback);
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await provider.generateJson<unknown>(lastError ? `${basePrompt}\n\n上一次输出没有通过结构护栏，错误是：${lastError}\n请只返回修正后的严格 JSON。` : basePrompt);
    if (!raw) throw new Error("empty feedback model result");
    const parsed = semanticFeedbackSchema.safeParse(raw);
    if (!parsed.success) {
      lastError = `invalid feedback JSON (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`;
      if (attempt === 0) continue;
      throw new Error(lastError);
    }
    const suggestion = normalizeUnavailableTargetMemoryOperation(profile, feedback, parsed.data);
    try {
      assertSemanticFeedbackVisibleOutput(profile, feedback, suggestion);
      assertSemanticFeedbackMemoryOperation(profile, feedback, suggestion);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === 0) continue;
      throw error;
    }
    applySemanticFeedbackSuggestion(profile, feedback, suggestion);
    recordFeedbackSemanticRun(profile, provider, "applied", attempt ? "llm feedback reflection applied after repair" : "llm feedback reflection applied");
    return feedback;
  }
  throw new Error(lastError || "feedback model did not produce a valid result");
}

function normalizeUnavailableTargetMemoryOperation(profile: CreatureProfile, feedback: FeedbackRecord, suggestion: SemanticFeedbackSuggestion): SemanticFeedbackSuggestion {
  const operation = suggestion.memoryOperation;
  if (!operation || operation.type === "none" || operation.type === "dismiss_target") return suggestion;
  const targetExists = Boolean(
    profile.longTermMemories.some((item) => item.id === feedback.targetId) ||
      profile.episodes.some((item) => item.id === feedback.targetId) ||
      profile.memoryCandidates.some((item) => item.id === feedback.targetId)
  );
  if (targetExists || !feedback.targetSnapshot) return suggestion;

  suggestion.memoryOperation = { type: feedback.kind === "forget" ? "dismiss_target" : "none" };
  suggestion.trace = [
    ...(suggestion.trace ?? []),
    `blocked unavailable target operation: ${operation.type}`
  ].slice(0, 8);
  return suggestion;
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

function snapshotFeedbackTarget(
  episode?: CreatureProfile["episodes"][number],
  memory?: LongTermMemory,
  candidate?: MemoryCandidate
): FeedbackTargetSnapshot | undefined {
  if (memory) {
    return {
      id: memory.id,
      type: "memory",
      text: memory.text,
      kind: memory.kind,
      weight: memory.weight,
      sourceEpisodeId: memory.sourceEpisodeId,
      tags: memory.tags,
      attachments: memory.attachments ?? []
    };
  }
  if (candidate) {
    return {
      id: candidate.id,
      type: "candidate",
      text: candidate.candidateText,
      kind: candidate.memoryKind,
      weight: candidate.confidence,
      status: candidate.status,
      sourceEpisodeId: candidate.sourceEpisodeId,
      tags: candidate.tags,
      attachments: candidate.attachments ?? []
    };
  }
  if (episode) {
    return {
      id: episode.id,
      type: "episode",
      text: episode.inputSummary,
      weight: episode.weight,
      sourceEpisodeId: episode.id,
      tags: episode.tags,
      attachments: episode.attachments ?? []
    };
  }
  return undefined;
}

function applySemanticFeedbackSuggestion(profile: CreatureProfile, feedback: FeedbackRecord, suggestion: SemanticFeedbackSuggestion) {
  const targetEpisode = profile.episodes.find((item) => item.id === feedback.targetId);
  const targetLongTerm = profile.longTermMemories.find((item) => item.id === feedback.targetId);
  const targetCandidate = profile.memoryCandidates.find((item) => item.id === feedback.targetId);

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
    applySemanticMemoryOperation(profile, feedback, suggestion.memoryOperation, targetEpisode, targetLongTerm, targetCandidate);
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
    const targetCandidate = profile.memoryCandidates.find((item) => item.id === feedback.targetId);
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
    if (targetCandidate && operation?.type !== "update_candidate" && operation?.type !== "promote_candidate") {
      throw new Error("feedback model received a candidate correction without update_candidate or promote_candidate");
    }
  }
}

function assertSemanticFeedbackMemoryOperation(profile: CreatureProfile, feedback: FeedbackRecord, suggestion: SemanticFeedbackSuggestion) {
  const operation = suggestion.memoryOperation;
  if (!operation || operation.type === "none") return;
  const targetLongTerm = profile.longTermMemories.find((item) => item.id === feedback.targetId);
  const targetEpisode = profile.episodes.find((item) => item.id === feedback.targetId);
  const targetCandidate = profile.memoryCandidates.find((item) => item.id === feedback.targetId);
  if (operation.type === "update_memory" && !targetLongTerm) {
    throw new Error(`target.type=${targetEpisode ? "episode" : targetCandidate ? "candidate" : "none"} cannot use update_memory; use promote_episode for episode targets, update_candidate/promote_candidate for candidate targets, or none`);
  }
  if (operation.type === "promote_episode" && !targetEpisode) {
    throw new Error(`target.type=${targetLongTerm ? "memory" : targetCandidate ? "candidate" : "none"} cannot use promote_episode; use update_memory for memory targets, promote_candidate for candidate targets, or none`);
  }
  if (operation.type === "promote_candidate" && !targetCandidate) {
    throw new Error(`target.type=${targetLongTerm ? "memory" : targetEpisode ? "episode" : "none"} cannot use promote_candidate; use promote_episode for episode targets, update_memory for memory targets, or none`);
  }
  if (operation.type === "update_candidate" && !targetCandidate) {
    throw new Error(`target.type=${targetLongTerm ? "memory" : targetEpisode ? "episode" : "none"} cannot use update_candidate; use update_memory for memory targets, promote_episode for episode targets, or none`);
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
    shortTitle: memoryShortTitle(normalizedText),
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
  targetLongTerm?: LongTermMemory,
  targetCandidate?: MemoryCandidate
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
      existing.shortTitle = memoryShortTitle(existing.text, operation.shortTitle);
      existing.consolidatedBecause = safeCreatureText(operation.consolidatedBecause) ?? existing.consolidatedBecause;
      existing.weight = Math.max(0, Math.min(100, Math.round(operation.weight ?? Math.max(existing.weight, targetEpisode.weight + 18))));
      if (tags.length) existing.tags = tags;
      existing.attachments = mergeAttachments(existing.attachments, targetEpisode.attachments);
      existing.lastReferencedAt = feedback.at;
    } else {
      profile.longTermMemories.unshift({
        id: makeId("ltm"),
        createdAt: feedback.at,
        kind: operation.kind,
        text: normalizeSharedMemoryText(text),
        shortTitle: memoryShortTitle(text, operation.shortTitle),
        sourceEpisodeId: targetEpisode.id,
        consolidatedBecause: safeCreatureText(operation.consolidatedBecause),
        weight: Math.max(0, Math.min(100, Math.round(operation.weight ?? targetEpisode.weight + 18))),
        tags,
        attachments: targetEpisode.attachments ?? []
      });
    }
    targetEpisode.promotedToLongTerm = true;
    for (const candidate of profile.memoryCandidates.filter((item) => item.sourceEpisodeId === targetEpisode.id)) {
      candidate.status = "promoted";
    }
    return;
  }
  if (operation.type === "promote_candidate") {
    if (!targetCandidate) throw new Error("feedback model requested candidate promotion without a candidate target");
    const text = safeCreatureText(operation.text);
    if (!text) throw new Error("feedback model requested candidate promotion without memory text");
    if (!operation.kind) throw new Error("feedback model requested candidate promotion without memory kind");
    const memory = promoteMemoryCandidate(profile, targetCandidate.id, {
      text,
      shortTitle: operation.shortTitle,
      kind: operation.kind,
      tags: operation.tags?.length ? safeStoredTags(operation.tags) : targetCandidate.tags,
      consolidatedBecause: safeCreatureText(operation.consolidatedBecause) ?? targetCandidate.whyConsolidate,
      weight: operation.weight,
      now: feedback.at
    });
    if (!memory) throw new Error("feedback model requested candidate promotion but promotion failed");
    feedback.memoryCandidateIds = [...new Set([...(feedback.memoryCandidateIds ?? []), targetCandidate.id])];
    return;
  }
  if (operation.type === "update_candidate") {
    if (!targetCandidate) throw new Error("feedback model requested candidate update without a candidate target");
    const text = safeCreatureText(operation.text);
    if (text) targetCandidate.candidateText = normalizeSharedMemoryText(text);
    targetCandidate.shortTitle = memoryShortTitle(targetCandidate.candidateText, operation.shortTitle ?? targetCandidate.shortTitle);
    if (operation.kind) targetCandidate.memoryKind = operation.kind;
    if (operation.tags?.length) targetCandidate.tags = safeStoredTags(operation.tags);
    if (operation.consolidatedBecause) targetCandidate.whyConsolidate = safeCreatureText(operation.consolidatedBecause) ?? targetCandidate.whyConsolidate;
    if (Number.isFinite(operation.weight)) targetCandidate.confidence = Math.max(0, Math.min(100, Math.round(operation.weight ?? targetCandidate.confidence)));
    feedback.memoryCandidateIds = [...new Set([...(feedback.memoryCandidateIds ?? []), targetCandidate.id])];
    return;
  }
  if (operation.type === "update_memory") {
    if (!targetLongTerm) throw new Error("feedback model requested memory update without a memory target");
    const text = safeCreatureText(operation.text);
    if (text) targetLongTerm.text = normalizeSharedMemoryText(text);
    targetLongTerm.shortTitle = memoryShortTitle(targetLongTerm.text, operation.shortTitle ?? targetLongTerm.shortTitle);
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
  const targetCandidate = profile.memoryCandidates.find((item) => item.id === feedback.targetId);
  const candidateEpisode = targetCandidate ? profile.episodes.find((item) => item.id === targetCandidate.sourceEpisodeId) : undefined;
  const previousFeedback = profile.feedbackHistory.filter((item) => item.id !== feedback.id);
  const feedbackPrivacyHigh = hasHighPrivacyText(feedback.inputText);
  const targetPrivacyHigh = targetEpisode
    ? hasHighPrivacyText(`${targetEpisode.inputSummary} ${targetEpisode.possibleIntent} ${targetEpisode.importanceReason} ${targetEpisode.creatureResponse}`)
    : targetLongTerm
      ? hasHighPrivacyText(targetLongTerm.text)
      : targetCandidate
        ? hasHighPrivacyText(`${targetCandidate.candidateText} ${candidateEpisode?.inputSummary ?? ""}`)
        : hasHighPrivacyText(feedback.targetSnapshot?.text);
  const targetContext = feedbackTargetPromptContext({
    targetEpisode,
    targetLongTerm,
    targetCandidate,
    candidateEpisode,
    snapshot: feedback.targetSnapshot,
    targetPrivacyHigh
  });
  return `请作为 Papo 的反馈反思脑，根据这次用户反馈，决定 Papo 应该怎样被养成。

系统只记录了这次反馈和目标对象。你可以在护栏内决定：
JSON 字段名保持示例格式；所有自然语言字段值必须用中文。

- stateDeltas：curiosity, attachment, energy, arousal, safety, confidence，每项 -15 到 15。
- policyDeltas：preferDepth, preferProactivity, privacySensitivity, saveThreshold, askThreshold, recallTendency, quietTendency，每项 -15 到 15。
- memoryWeightDelta：目标 episode 或 memory 的权重变化，-30 到 30。
- memoryOperation：none, promote_episode, promote_candidate, update_memory, update_candidate, dismiss_target。
- 当 memoryOperation 会保存或更新记忆时，给出 shortTitle：2-8 个中文字符，根据文字/图片核心内容提炼，用于“我的”缩略卡。
- memoryOperation.kind 只能使用这些内部枚举 ID：user_preference, long_theme, creature_self_memory, safety_rule, future_review, relationship, habit, open_question。不要输出 preference、preference_memory、preference_user 等别名。
- creatureSelfMemory.weight 和 memoryOperation.weight 都是绝对权重，只能在 0 到 100 之间；即使用户说“很重要”，也不能超过 100。
- responseAction：acknowledge, ask_follow_up, quiet, note_memory。
- learningNote：必填。内部学习记录，不给普通用户直接展示；不要写成前端说明或字段解释。
- followUpText：内部追问意图记录，不给普通用户直接展示。
- replyText：如果 responseAction 不是 quiet，写一句 Papo 可以直接对用户说的自然短回应；不要解释内部状态、字段、阈值或流程。
- effect：必填。准确说明这次反馈实际改变了什么；如果没有改变记忆或状态，也要写明“只理解了反馈，未改变存储或状态”的实际结果。
- creatureSelfMemory：如果这次反馈体现了用户正在训练 Papo 的长期回应习惯，写成一条 Papo 自己的成长记忆；text、tags、consolidatedBecause、weight 都由你决定。

memoryOperation 使用口径：
- promote_episode：用户明确要求记住某个 episode，或反馈文本把某个经历补准到值得长期记住。必须给 text 和 kind。
- promote_candidate：用户明确要求把某条候选记忆长期留下，或反馈文本表明这条候选值得成为长期记忆。必须给 text 和 kind。
- update_memory：用户纠正、补充或改写某条长期记忆。可以给 text、kind、tags、weight。
- update_candidate：用户纠正、补充或改写某条候选记忆，但还不一定长期保存。可以给 text、kind、tags、weight；weight 会落到 candidate confidence。
- dismiss_target：用户通过文本/语音表达这件事不该留、不要再提、放下它。显式 forget 按钮已经会先执行一次存储层放下；你可以继续用 dismiss_target 表示语义上也应该放下。
- none：反馈只是在教 Papo 以后怎么回应，或者只是轻微鼓励/安抚，不需要改记忆。
- 即使 feedback.inputText 为空，feedback.kind 也代表用户的明确按钮反馈。
  - kind=remember 表示用户希望这件事被记住或从 episode 进入长期记忆。
  - kind=important 表示用户认为这条记忆更重要，通常应提高目标权重，必要时调整记忆文字或标签。
  - kind=remind 表示用户希望以后能被这件事提醒或回到这件事上，通常应考虑 future_review、open_question、标签或 consolidatedBecause 的调整；不要编造具体提醒时间。
  - kind=correct 表示用户正在把目标记忆、候选或经历改准。target.type="memory" 时必须使用 update_memory；target.type="candidate" 时使用 update_candidate 或 promote_candidate；target.type="episode" 时使用 promote_episode。
  - kind=forget 表示用户要求放下目标。
- 当前系统还没有定时通知调度器。kind=remind 的 replyText 不能承诺“以后会提醒你”“到时通知你”，只能说 Papo 会把这件事放得更靠前、之后更容易想起或一起回到这件事。

你不能：
- 使用未列出的字段。
- 编造用户没有说过的新事实。
- 使用未列出的枚举值。所有 type、kind、responseAction 必须逐字使用上面列出的 ID。
- 输出超过字段范围的数字。所有 weight 最大 100；memoryWeightDelta 最大 30。
- promote_episode 只能用于 target.type="episode"。
- promote_candidate 只能用于 target.type="candidate"。
- update_memory 只能用于 target.type="memory"。
- update_candidate 只能用于 target.type="candidate"。
- 如果 target.unavailableAfterStorageOperation=true，说明按钮操作已经让目标不在当前存储里；不要使用 update_memory、promote_episode、promote_candidate 或 update_candidate。只能使用 none 或 dismiss_target，并在 effect 里准确说明目标已经被放下或当前无可修改对象。
- 如果 target 带 attachments，说明这条经历或记忆有原始图片资产；当你把 episode 提升为长期记忆或改写记忆时，要结合图片内容、用户补充和可用时间地点，不要把照片当成一句普通文本。
- 当 target.type="episode" 且用户要求 remember、important、remind 或 correct 时，如果需要产生或修改长期记忆，必须使用 memoryOperation.type="promote_episode"；即使你认为是在“更新记忆文字”，也不能对 episode 目标返回 update_memory。
- 当 target.type="candidate" 且用户要求 remember 或 important 时，如果你判断应该长期留下，使用 memoryOperation.type="promote_candidate"；如果只是改准候选但继续等待，使用 update_candidate。
- 当 target.type="memory" 时，如果要改已有长期记忆，必须使用 memoryOperation.type="update_memory"，不能使用 promote_episode。

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
    "shortTitle":"2-8字标题",
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
  targetSnapshot: feedback.targetSnapshot
    ? {
        ...feedback.targetSnapshot,
        text: textForModel(feedback.targetSnapshot.text, targetPrivacyHigh),
        tags: tagsForModel(feedback.targetSnapshot.tags ?? [], targetPrivacyHigh),
        attachments: attachmentPromptMetadata(feedback.targetSnapshot.attachments)
      }
    : undefined,
  contentHiddenForPrivacy: feedbackPrivacyHigh
})}

target:
${JSON.stringify(targetContext)}

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

function feedbackTargetPromptContext(input: {
  targetEpisode?: CreatureProfile["episodes"][number];
  targetLongTerm?: LongTermMemory;
  targetCandidate?: MemoryCandidate;
  candidateEpisode?: CreatureProfile["episodes"][number];
  snapshot?: FeedbackTargetSnapshot;
  targetPrivacyHigh: boolean;
}) {
  const { targetEpisode, targetLongTerm, targetCandidate, candidateEpisode, snapshot, targetPrivacyHigh } = input;
  if (targetEpisode) {
    return {
      type: "episode",
      id: targetEpisode.id,
      inputSummary: textForModel(targetEpisode.inputSummary, targetPrivacyHigh),
      possibleIntent: textForModel(targetEpisode.possibleIntent, targetPrivacyHigh),
      importanceReason: textForModel(targetEpisode.importanceReason, targetPrivacyHigh),
      creatureResponse: textForModel(targetEpisode.creatureResponse, targetPrivacyHigh),
      promotedToLongTerm: targetEpisode.promotedToLongTerm,
      attachments: attachmentPromptMetadata(targetEpisode.attachments),
      tags: tagsForModel(targetEpisode.tags, targetPrivacyHigh),
      feedback: targetEpisode.feedback,
      contentHiddenForPrivacy: targetPrivacyHigh
    };
  }
  if (targetLongTerm) {
    return {
      type: "memory",
      id: targetLongTerm.id,
      kind: targetLongTerm.kind,
      text: textForModel(targetLongTerm.text, targetPrivacyHigh),
      weight: targetLongTerm.weight,
      sourceEpisodeId: targetLongTerm.sourceEpisodeId,
      attachments: attachmentPromptMetadata(targetLongTerm.attachments),
      tags: tagsForModel(targetLongTerm.tags, targetPrivacyHigh),
      contentHiddenForPrivacy: targetPrivacyHigh
    };
  }
  if (targetCandidate) {
    return {
      type: "candidate",
      id: targetCandidate.id,
      candidateText: textForModel(targetCandidate.candidateText, targetPrivacyHigh),
      memoryKind: targetCandidate.memoryKind,
      confidence: targetCandidate.confidence,
      writePolicy: targetCandidate.writePolicy,
      whyConsolidate: textForModel(targetCandidate.whyConsolidate, targetPrivacyHigh),
      decayPolicy: targetCandidate.decayPolicy,
      status: targetCandidate.status,
      tags: tagsForModel(targetCandidate.tags, targetPrivacyHigh),
      sourceEpisode: candidateEpisode
        ? {
            id: candidateEpisode.id,
            inputSummary: textForModel(candidateEpisode.inputSummary, targetPrivacyHigh),
            creatureResponse: textForModel(candidateEpisode.creatureResponse, targetPrivacyHigh),
            sourceObservedAt: candidateEpisode.sourceObservedAt,
            sourceLocation: candidateEpisode.sourceLocation
          }
        : undefined,
      attachments: attachmentPromptMetadata(targetCandidate.attachments),
      contentHiddenForPrivacy: targetPrivacyHigh
    };
  }
  if (snapshot) {
    return {
      type: snapshot.type,
      id: snapshot.id,
      text: textForModel(snapshot.text, targetPrivacyHigh),
      kind: snapshot.kind,
      weight: snapshot.weight,
      status: snapshot.status,
      sourceEpisodeId: snapshot.sourceEpisodeId,
      tags: tagsForModel(snapshot.tags ?? [], targetPrivacyHigh),
      attachments: attachmentPromptMetadata(snapshot.attachments),
      unavailableAfterStorageOperation: true,
      contentHiddenForPrivacy: targetPrivacyHigh
    };
  }
  return { type: "none" };
}

function attachmentPromptMetadata(attachments?: FeedbackTargetSnapshot["attachments"]) {
  return (attachments ?? []).map((attachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    label: attachment.label,
    mime: attachment.mime,
    observedAt: attachment.observedAt,
    location: attachment.location
  }));
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function safeStoredTags(tags: string[]) {
  return unique(tags);
}

import { z } from "zod";
import { makeId } from "./ids";
import { mergeAttachments, normalizeSharedMemoryText, promoteMemoryCandidate } from "./memory";
import { modelFeedbackContext, modelMemoryContext } from "./model-context";
import type { ModelProvider } from "./provider";
import { applyStateDelta } from "./state";
import type { CreatureProfile, DreamRecord, LongTermMemory } from "./types";

const memoryKindSchema = z.enum(["user_preference", "long_theme", "creature_self_memory", "safety_rule", "future_review", "relationship", "habit", "open_question"]);

const dreamSchema = z.object({
  shouldDream: z.boolean(),
  summary: z.string().min(1).max(420),
  operations: z
    .array(
      z.object({
        type: z.enum(["update_memory", "merge_memories", "dismiss_candidate", "promote_candidate", "adjust_state"]),
        targetId: z.string().min(1).optional(),
        sourceIds: z.array(z.string().min(1)).max(8).optional(),
        text: z.string().min(1).max(650).optional(),
        kind: memoryKindSchema.optional(),
        tags: z.array(z.string().min(1).max(40)).max(10).optional(),
        consolidatedBecause: z.string().min(1).max(360).optional(),
        weight: z.number().min(0).max(100).optional(),
        stateDeltas: z
          .object({
            curiosity: z.number().min(-10).max(10).optional(),
            attachment: z.number().min(-10).max(10).optional(),
            energy: z.number().min(-10).max(10).optional(),
            arousal: z.number().min(-10).max(10).optional(),
            safety: z.number().min(-10).max(10).optional(),
            confidence: z.number().min(-10).max(10).optional()
          })
          .partial()
          .optional(),
        reason: z.string().min(1).max(260)
      })
    )
    .max(12),
  trace: z.array(z.string().min(1).max(160)).max(6).optional()
});

type DreamSuggestion = z.infer<typeof dreamSchema>;
type DreamOperation = DreamSuggestion["operations"][number];

const DREAMING_COOLDOWN_MS = 12 * 60 * 60 * 1000;

export async function semanticDreamMemories(
  profile: CreatureProfile,
  provider: ModelProvider,
  input: { force?: boolean; now?: string; recordQuiet?: boolean } = {}
): Promise<DreamRecord | undefined> {
  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for dreaming.");
  if (!input.force && !shouldDreamStructurally(profile)) return undefined;

  const now = input.now ?? new Date().toISOString();
  const raw = await provider.generateJson<unknown>(buildDreamPrompt(profile, Boolean(input.force)));
  if (!raw) throw new Error("empty dreaming model result");
  const parsed = dreamSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid dreaming JSON (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  if (!parsed.data.shouldDream) {
    const quietDream = quietDreamRecord(parsed.data, now);
    if (input.recordQuiet || input.force) {
      profile.dreamHistory.unshift(quietDream);
      profile.dreamHistory = profile.dreamHistory.slice(0, 20);
    }
    recordDreamSemanticRun(profile, provider, "llm dreaming chose no operation");
    return input.recordQuiet || input.force ? quietDream : undefined;
  }

  const applied = applyDreamSuggestion(profile, parsed.data, now);
  if (!applied.operations.length) throw new Error("dreaming model returned no applicable operation");
  profile.dreamHistory.unshift(applied);
  profile.dreamHistory = profile.dreamHistory.slice(0, 20);
  recordDreamSemanticRun(profile, provider, `llm dreaming applied ${applied.operations.length} operation(s)`);
  return applied;
}

export function shouldDreamStructurally(profile: CreatureProfile) {
  const activeLongTerm = profile.longTermMemories.filter((memory) => memory.weight > 0).length;
  const activeCandidates = profile.memoryCandidates.filter((candidate) => candidate.status === "candidate").length;
  return activeLongTerm > 35 || activeCandidates > 55;
}

export function isDreamingDue(profile: CreatureProfile, now = new Date().toISOString()) {
  if (!shouldDreamStructurally(profile)) return { due: false, reason: "below_threshold" as const };
  const latestDreamAt = newestDreamAt(profile);
  if (!latestDreamAt) return { due: true, reason: "threshold_reached" as const };
  const nextCheckAt = new Date(latestDreamAt + DREAMING_COOLDOWN_MS).toISOString();
  if (Date.parse(now) < Date.parse(nextCheckAt)) return { due: false, reason: "cooldown" as const, nextCheckAt };
  return { due: true, reason: "cooldown_elapsed" as const };
}

export function recordDreamingFailure(profile: CreatureProfile, provider: ModelProvider, now: string, reason: string) {
  profile.dreamHistory.unshift({
    id: makeId("dream"),
    at: now,
    summary: "后台记忆整理没有完成，稍后再试。",
    operations: [],
    ruleTrace: ["provider_error: dreaming deferred", reason.slice(0, 180)]
  });
  profile.dreamHistory = profile.dreamHistory.slice(0, 20);
  profile.semanticBrainHistory.unshift({
    id: makeId("semantic"),
    at: now,
    source: "dreaming",
    stage: "dreaming",
    providerKind: provider.kind,
    providerName: provider.name,
    model: provider.diagnostics?.textModel,
    status: "failed",
    message: "dreaming provider call failed; deferred by cooldown record",
    ruleTrace: [`provider=${provider.kind}`, "source=dreaming", "status=failed", reason.slice(0, 180)]
  });
  profile.semanticBrainHistory = profile.semanticBrainHistory.slice(0, 30);
}

function applyDreamSuggestion(profile: CreatureProfile, suggestion: DreamSuggestion, now: string): DreamRecord {
  const operations: DreamRecord["operations"] = [];
  let stateDeltas: DreamRecord["stateDeltas"] = [];
  for (const operation of suggestion.operations) {
    const applied = applyDreamOperation(profile, operation, now);
    if (applied.operation) operations.push(applied.operation);
    if (applied.stateDeltas?.length) stateDeltas = mergeStateDeltas(stateDeltas, applied.stateDeltas);
  }
  return {
    id: makeId("dream"),
    at: now,
    summary: normalizeSharedMemoryText(suggestion.summary),
    operations,
    stateDeltas,
    ruleTrace: ["llm: dreaming plan parsed", `applied=${operations.length}`]
  };
}

function quietDreamRecord(suggestion: DreamSuggestion, now: string): DreamRecord {
  return {
    id: makeId("dream"),
    at: now,
    summary: normalizeSharedMemoryText(suggestion.summary),
    operations: [],
    ruleTrace: ["llm: dreaming plan parsed", "applied=0", ...(suggestion.trace ?? []).map((item) => `llm: ${item}`)]
  };
}

function applyDreamOperation(profile: CreatureProfile, operation: DreamOperation, now: string) {
  if (operation.type === "update_memory") {
    const memory = operation.targetId ? profile.longTermMemories.find((item) => item.id === operation.targetId && item.weight > 0) : undefined;
    if (!memory) return {};
    const text = normalizeSharedMemoryText(operation.text ?? "");
    if (text) memory.text = text;
    if (operation.kind) memory.kind = operation.kind;
    if (operation.tags?.length) memory.tags = operation.tags;
    if (operation.consolidatedBecause) memory.consolidatedBecause = normalizeSharedMemoryText(operation.consolidatedBecause);
    if (Number.isFinite(operation.weight)) memory.weight = clampWeight(operation.weight ?? memory.weight);
    memory.lastReferencedAt = now;
    return { operation: dreamOperationRecord(operation, memory.id, memory.text) };
  }
  if (operation.type === "merge_memories") {
    const target = operation.targetId ? profile.longTermMemories.find((item) => item.id === operation.targetId && item.weight > 0) : undefined;
    const sources = (operation.sourceIds ?? []).map((id) => profile.longTermMemories.find((item) => item.id === id && item.weight > 0)).filter((item): item is LongTermMemory => Boolean(item));
    if (!target || !sources.length) return {};
    const text = normalizeSharedMemoryText(operation.text ?? target.text);
    target.text = text || target.text;
    if (operation.kind) target.kind = operation.kind;
    if (operation.tags?.length) target.tags = [...new Set([...target.tags, ...operation.tags])];
    if (operation.consolidatedBecause) target.consolidatedBecause = normalizeSharedMemoryText(operation.consolidatedBecause);
    if (Number.isFinite(operation.weight)) target.weight = clampWeight(operation.weight ?? target.weight);
    for (const source of sources) {
      if (source.id === target.id) continue;
      target.attachments = mergeAttachments(target.attachments, source.attachments);
      source.weight = 0;
      source.lastReferencedAt = now;
    }
    target.lastReferencedAt = now;
    return { operation: dreamOperationRecord(operation, target.id, target.text) };
  }
  if (operation.type === "dismiss_candidate") {
    const candidate = operation.targetId ? profile.memoryCandidates.find((item) => item.id === operation.targetId && item.status === "candidate") : undefined;
    if (!candidate) return {};
    candidate.status = "dismissed";
    candidate.writePolicy = "do_not_save";
    candidate.decayPolicy = "forget_if_dismissed";
    candidate.whyConsolidate = normalizeSharedMemoryText(operation.reason);
    return { operation: dreamOperationRecord(operation, candidate.id, candidate.candidateText) };
  }
  if (operation.type === "promote_candidate") {
    if (!operation.targetId) return {};
    const memory = promoteMemoryCandidate(profile, operation.targetId, {
      text: operation.text,
      kind: operation.kind,
      tags: operation.tags,
      consolidatedBecause: operation.consolidatedBecause ?? operation.reason,
      weight: operation.weight,
      now
    });
    if (!memory) return {};
    return { operation: dreamOperationRecord(operation, memory.id, memory.text) };
  }
  if (operation.type === "adjust_state") {
    const deltas = cleanStateDeltas(operation.stateDeltas);
    if (!Object.keys(deltas).length) return {};
    const change = applyStateDelta(profile, deltas, "LLM dreaming integrated memories", now);
    return {
      operation: dreamOperationRecord(operation, operation.targetId, operation.text),
      stateDeltas: (["curiosity", "attachment", "energy", "arousal", "safety", "confidence"] as const)
        .map((key) => ({ key, before: change.before[key], after: change.after[key], delta: change.after[key] - change.before[key] }))
        .filter((item) => item.delta !== 0)
    };
  }
  return {};
}

function dreamOperationRecord(operation: DreamOperation, targetId?: string, text?: string): DreamRecord["operations"][number] {
  return {
    type: operation.type,
    targetId,
    sourceIds: operation.sourceIds,
    text,
    reason: normalizeSharedMemoryText(operation.reason)
  };
}

function cleanStateDeltas(deltas: DreamOperation["stateDeltas"]) {
  const cleaned: Record<string, number> = {};
  for (const [key, value] of Object.entries(deltas ?? {})) {
    if (!Number.isFinite(value)) continue;
    const rounded = Math.round(Number(value));
    if (rounded !== 0) cleaned[key] = rounded;
  }
  return cleaned;
}

function mergeStateDeltas(left: DreamRecord["stateDeltas"] = [], right: DreamRecord["stateDeltas"] = []) {
  const byKey = new Map(left.map((item) => [item.key, item]));
  for (const item of right) byKey.set(item.key, byKey.has(item.key) ? { ...byKey.get(item.key)!, after: item.after, delta: item.after - byKey.get(item.key)!.before } : item);
  return [...byKey.values()].filter((item) => item.delta !== 0);
}

function clampWeight(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function recordDreamSemanticRun(profile: CreatureProfile, provider: ModelProvider, message: string) {
  profile.semanticBrainHistory.unshift({
    id: makeId("semantic"),
    at: new Date().toISOString(),
    source: "dreaming",
    stage: "dreaming",
    providerKind: provider.kind,
    providerName: provider.name,
    model: provider.diagnostics?.textModel,
    status: "applied",
    message,
    ruleTrace: [`provider=${provider.kind}`, "source=dreaming", "status=applied"]
  });
  profile.semanticBrainHistory = profile.semanticBrainHistory.slice(0, 30);
}

function newestDreamAt(profile: CreatureProfile) {
  const timestamps = profile.dreamHistory.map((record) => Date.parse(record.at)).filter((value) => Number.isFinite(value));
  return timestamps.length ? Math.max(...timestamps) : undefined;
}

function buildDreamPrompt(profile: CreatureProfile, force: boolean) {
  return `请作为 Papo 的 dreaming 记忆整理脑，整理长期记忆和候选记忆。

规则只负责执行你返回的合法操作；你负责判断是否需要整理、如何合并、保留、放下、升级，以及重要记忆是否影响 Papo 当下状态。
不要根据关键词机械合并；只在语义上确实重复、互补、过时、太碎或已经稳定时操作。
如果不需要整理，返回 shouldDream=false 和空 operations。
所有自然语言字段用中文。只返回严格 JSON object，不要 Markdown。

可用操作：
- update_memory：改写一条长期记忆。
- merge_memories：把 sourceIds 中重复/互补的长期记忆合并到 targetId；被合并来源会降权为 0。
- dismiss_candidate：放下不值得继续保留的候选。
- promote_candidate：把候选升级为长期记忆。
- adjust_state：重要记忆整合后对 Papo 状态产生小幅影响；每项 -10 到 10。

约束：
- 所有 targetId/sourceIds 必须来自输入列表。
- 不要编造用户没有提供过的新事实。
- 不要为了减少数量而牺牲重要细节。
- 只有真的有必要才操作；宁可少做。
- force=${force}

返回格式：
{
  "shouldDream": true,
  "summary": "...",
  "operations": [
    {"type":"merge_memories","targetId":"ltm_x","sourceIds":["ltm_y"],"text":"...","kind":"habit","tags":["..."],"consolidatedBecause":"...","weight":80,"reason":"..."},
    {"type":"dismiss_candidate","targetId":"candidate_x","reason":"..."},
    {"type":"adjust_state","stateDeltas":{"confidence":1},"reason":"..."}
  ],
  "trace":["..."]
}

current_state:
${JSON.stringify(profile.state)}

recent_feedback:
${JSON.stringify(modelFeedbackContext(profile.feedbackHistory))}

memory_context:
${JSON.stringify(modelMemoryContext(profile.longTermMemories, { limit: 40, creatureVoice: true }))}

long_term_memories:
${JSON.stringify(profile.longTermMemories.filter((memory) => memory.weight > 0).slice(0, 80).map((memory) => ({
  id: memory.id,
  kind: memory.kind,
  text: memory.text,
  weight: memory.weight,
  tags: memory.tags,
  sourceEpisodeId: memory.sourceEpisodeId,
  lastReferencedAt: memory.lastReferencedAt
})))}

memory_candidates:
${JSON.stringify(profile.memoryCandidates.filter((candidate) => candidate.status === "candidate").slice(0, 80).map((candidate) => ({
  id: candidate.id,
  text: candidate.candidateText,
  memoryKind: candidate.memoryKind,
  confidence: candidate.confidence,
  writePolicy: candidate.writePolicy,
  whyConsolidate: candidate.whyConsolidate,
  sourceEpisodeId: candidate.sourceEpisodeId,
  tags: candidate.tags
})))}
`;
}

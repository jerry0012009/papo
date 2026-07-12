import { handleButtonCapture, handleCuriousStream } from "./attention";
import { makeId } from "./ids";
import { applyMemoryWritePolicies, enqueueCandidateVisualJobs, upsertLongTermMemory } from "./memory";
import type { ModelProvider } from "./provider";
import { semanticSelectAction } from "./semantic-action";
import { semanticDecideAttention } from "./semantic-attention";
import { semanticDecideMemory } from "./semantic-memory";
import type { CaptureResult, CognitionContext, CreatureProfile, SemanticBrainRecord, StreamSegment } from "./types";

export async function runButtonHarness(
  profile: CreatureProfile,
  text: string,
  provider: ModelProvider,
  now = new Date().toISOString(),
  context: CognitionContext = { inputSource: "direct" }
): Promise<CaptureResult> {
  const result = handleButtonCapture(profile, text, now);
  return enrichWithSemanticBrain(profile, result, provider, "button", context);
}

export async function runCuriousHarness(
  profile: CreatureProfile,
  segments: StreamSegment[],
  provider: ModelProvider,
  now = new Date().toISOString(),
  context: CognitionContext = { inputSource: "ambient" }
): Promise<CaptureResult> {
  const result = handleCuriousStream(profile, segments, now);
  return enrichWithSemanticBrain(profile, result, provider, "curious_stream", context);
}

async function enrichWithSemanticBrain(
  profile: CreatureProfile,
  result: CaptureResult,
  provider: ModelProvider,
  source: "button" | "curious_stream",
  context: CognitionContext
): Promise<CaptureResult> {
  const trace = [
    `sense: ${source}`,
    `cognition_source: ${context.inputSource}`,
    "sense: prepared structural candidates",
    `provider: ${provider.kind}`
  ];

  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for cognition.");

  if (!result.attentionCandidates?.length) {
    result.harnessTrace = [...trace, "sense: no content candidates"];
    return result;
  }
  await semanticDecideAttention(profile, result, provider, source, context);
  if (!result.events.length) {
    result.harnessTrace = [...trace, "semantic: llm ignored all candidates"];
    recordSemanticBrainRun(profile, provider, source, "applied", "llm attention decision ignored all candidates");
    return result;
  }
  clearRuleVisibleDrafts(result);
  await semanticSelectAction(profile, result, provider, source, context);
  ensureVisibleOutputContract(result);
  if (result.memoryCandidates?.length) {
    await semanticDecideMemory(profile, result.memoryCandidates, provider, context);
    if (context.inputSource === "task_result") mergeTaskResultMemoryOwnership(profile, result, context);
    const promoted = applyMemoryWritePolicies(profile, result.memoryCandidates);
    enqueueCandidateVisualJobs(profile);
    if (promoted.length) {
      result.harnessTrace = [...(result.harnessTrace ?? []), `memory: auto_promoted=${promoted.length}`];
    }
  }
  result.harnessTrace = [...trace, "semantic: llm cognition applied"];
  recordSemanticBrainRun(profile, provider, source, "applied", "llm cognition applied");
  return result;
}

function mergeTaskResultMemoryOwnership(profile: CreatureProfile, result: CaptureResult, context: CognitionContext) {
  if (!context.sourceEpisodeId) return;
  const originalEpisode = profile.episodes.find((episode) => episode.id === context.sourceEpisodeId);
  if (!originalEpisode) throw new Error("task_result source episode disappeared before memory commit");
  const existingMemory = profile.longTermMemories.find((memory) => memory.sourceEpisodeId === originalEpisode.id && memory.weight > 0);
  for (const candidate of result.memoryCandidates ?? []) {
    if (candidate.status !== "candidate") continue;
    const resultEpisode = profile.episodes.find((episode) => episode.id === candidate.sourceEpisodeId);
    if (resultEpisode) resultEpisode.memoryCandidateIds = resultEpisode.memoryCandidateIds.filter((id) => id !== candidate.id);
    candidate.sourceEpisodeId = originalEpisode.id;
    originalEpisode.memoryCandidateIds = [...new Set([...originalEpisode.memoryCandidateIds, candidate.id])];
    if (!existingMemory || candidate.writePolicy !== "auto") continue;
    upsertLongTermMemory(profile, {
      ...existingMemory,
      text: candidate.candidateText,
      shortTitle: candidate.shortTitle,
      kind: candidate.memoryKind,
      tags: [...new Set([...existingMemory.tags, ...candidate.tags])],
      consolidatedBecause: candidate.whyConsolidate || existingMemory.consolidatedBecause,
      lastReferencedAt: new Date().toISOString()
    }, { sourceIds: [context.taskId ?? "", context.sourceEpisodeId] });
    candidate.status = "promoted";
    originalEpisode.promotedToLongTerm = true;
  }
}

function clearRuleVisibleDrafts(result: CaptureResult) {
  result.response = "";
  for (const episode of result.episodes) {
    episode.creatureResponse = "";
  }
}

function ensureVisibleOutputContract(result: CaptureResult) {
  const primaryAction = result.events[0]?.actionDecision.action;
  if (!primaryAction || ["observe", "quiet", "listen_silently", "continue_own_activity", "defer"].includes(primaryAction)) return;
  if (!result.response.trim()) throw new Error("model selected a visible action without a visible reply");
}

function recordSemanticBrainRun(
  profile: CreatureProfile,
  provider: ModelProvider,
  source: SemanticBrainRecord["source"],
  status: SemanticBrainRecord["status"],
  message: string
) {
  profile.semanticBrainHistory.unshift({
    id: makeId("semantic"),
    at: new Date().toISOString(),
    source,
    stage: "harness",
    providerKind: provider.kind,
    providerName: provider.name,
    model: provider.diagnostics?.textModel,
    status,
    message,
    ruleTrace: [`provider=${provider.kind}`, `source=${source}`, `status=${status}`]
  });
  profile.semanticBrainHistory = profile.semanticBrainHistory.slice(0, 30);
}

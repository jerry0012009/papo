import { handleButtonCapture, handleCuriousStream } from "./attention";
import { makeId } from "./ids";
import { applyMemoryWritePolicies } from "./memory";
import type { ModelProvider } from "./provider";
import { semanticSelectAction } from "./semantic-action";
import { semanticDecideAttention } from "./semantic-attention";
import { semanticDecideMemory } from "./semantic-memory";
import type { CaptureResult, CreatureProfile, SemanticBrainRecord, StreamSegment } from "./types";

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
    "sense: prepared structural candidates",
    `provider: ${provider.kind}`
  ];

  if (!provider.usesRealModel) throw new Error("Papo requires a real model provider for cognition.");

  if (source === "curious_stream") {
    if (!result.attentionCandidates?.length) {
      result.harnessTrace = [...trace, "sense: no content candidates"];
      return result;
    }
    await semanticDecideAttention(profile, result, provider);
    if (!result.events.length) {
      result.harnessTrace = [...trace, "semantic: llm ignored all candidates"];
      recordSemanticBrainRun(profile, provider, source, "applied", "llm attention decision ignored all candidates");
      return result;
    }
  } else if (!result.events.length) {
    throw new Error("Papo did not produce any attention event to interpret.");
  }
  clearRuleVisibleDrafts(result);
  await semanticSelectAction(profile, result, provider, source);
  ensureVisibleOutputContract(result);
  if (result.memoryCandidates?.length) {
    await semanticDecideMemory(profile, result.memoryCandidates, provider);
    const promoted = applyMemoryWritePolicies(profile, result.memoryCandidates);
    if (promoted.length) {
      result.harnessTrace = [...(result.harnessTrace ?? []), `memory: auto_promoted=${promoted.length}`];
    }
  }
  result.harnessTrace = [...trace, "semantic: llm cognition applied"];
  recordSemanticBrainRun(profile, provider, source, "applied", "llm cognition applied");
  return result;
}

function clearRuleVisibleDrafts(result: CaptureResult) {
  result.response = "";
  for (const episode of result.episodes) {
    episode.creatureResponse = "";
  }
}

function ensureVisibleOutputContract(result: CaptureResult) {
  const primaryAction = result.events[0]?.actionDecision.action;
  if (!primaryAction || primaryAction === "observe" || primaryAction === "quiet") return;
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
    providerKind: provider.kind,
    providerName: provider.name,
    status,
    message,
    ruleTrace: [`provider=${provider.kind}`, `source=${source}`, `status=${status}`]
  });
  profile.semanticBrainHistory = profile.semanticBrainHistory.slice(0, 30);
}

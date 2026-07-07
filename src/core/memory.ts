import { makeId } from "./ids";
import { extractTags, summarizeText } from "./text";
import type { AttentionEvent, CreatureProfile, EpisodeMemory, LongTermMemory, MemoryCandidate } from "./types";

export function createEpisodeFromEvent(
  event: AttentionEvent,
  response: string,
  now = new Date().toISOString()
): EpisodeMemory {
  const candidateIds: string[] = [];
  return {
    id: makeId("episode"),
    createdAt: now,
    source: event.source,
    sourceSegmentId: event.triggerSegmentId,
    sourceBatchId: event.triggerBatchId,
    sourceObservedAt: event.triggerObservedAt,
    sourceLocation: event.triggerLocation,
    inputSummary: summarizeText(event.triggerContent, 140),
    noticed: event.noticed,
    possibleIntent: inferIntent(event.triggerContent),
    importanceReason: event.reason,
    relatedMemoryIds: event.relatedMemoryIds,
    stateSnapshot: structuredClone(event.stateSnapshot),
    creatureResponse: response,
    feedback: [],
    promotedToLongTerm: false,
    memoryCandidateIds: candidateIds,
    actionDecision: event.actionDecision,
    creatureExperience: event.creatureExperience,
    weight: Math.max(20, Math.round(event.attentionStrength)),
    tags: event.tags,
    decisionTrace: event.decisionTrace
  };
}

export function createMemoryCandidateFromEpisode(
  profile: CreatureProfile,
  episode: EpisodeMemory,
  input: { now?: string } = {}
): MemoryCandidate {
  const now = input.now ?? new Date().toISOString();
  const sourceMaterial = buildMemoryCandidateText(episode);

  const candidate: MemoryCandidate = {
    id: makeId("candidate"),
    createdAt: now,
    candidateText: sourceMaterial,
    memoryKind: "open_question",
    confidence: 0,
    sourceEpisodeId: episode.id,
    whyConsolidate: "",
    writePolicy: "wait_feedback",
    decayPolicy: "decay_without_feedback",
    status: "candidate",
    tags: []
  };

  profile.memoryCandidates.unshift(candidate);
  profile.memoryCandidates = profile.memoryCandidates.slice(0, 80);
  episode.memoryCandidateIds.push(candidate.id);
  return candidate;
}

export function promoteEpisode(profile: CreatureProfile, episodeId: string, now = new Date().toISOString()) {
  const episode = profile.episodes.find((item) => item.id === episodeId);
  if (!episode) return undefined;
  if (episode.promotedToLongTerm) {
    return profile.longTermMemories.find((memory) => memory.sourceEpisodeId === episodeId);
  }

  const candidate = profile.memoryCandidates.find((item) => item.sourceEpisodeId === episode.id && item.status === "candidate");
  if (!candidate) return undefined;
  const memory: LongTermMemory = {
    id: makeId("ltm"),
    createdAt: now,
    kind: candidate.memoryKind,
    text: candidate.candidateText,
    sourceEpisodeId: episode.id,
    consolidatedBecause: candidate.whyConsolidate,
    weight: Math.min(100, episode.weight + 18),
    tags: candidate.tags.length ? candidate.tags : extractTags(episode.inputSummary)
  };
  episode.promotedToLongTerm = true;
  candidate.status = "promoted";
  profile.longTermMemories.unshift(memory);
  return memory;
}

export function applyMemoryWritePolicies(
  profile: CreatureProfile,
  candidates: MemoryCandidate[],
  now = new Date().toISOString()
) {
  const promoted: LongTermMemory[] = [];
  for (const candidate of candidates) {
    if (candidate.status !== "candidate") continue;
    if (candidate.writePolicy === "ask_user" || candidate.writePolicy === "do_not_save") continue;
    const episode = profile.episodes.find((item) => item.id === candidate.sourceEpisodeId);
    const actionSavesLongTerm = episode?.actionDecision?.action === "save_long_term";
    if (candidate.writePolicy !== "auto" && !actionSavesLongTerm) continue;
    const memory = promoteEpisode(profile, candidate.sourceEpisodeId, now);
    if (memory) promoted.push(memory);
  }
  return promoted;
}

export function forgetMemory(profile: CreatureProfile, targetId?: string): { changed: boolean; purged: boolean } {
  if (!targetId) return { changed: false, purged: false };

  const longTerm = profile.longTermMemories.find((memory) => memory.id === targetId);
  if (longTerm) {
    if (longTerm.weight <= 0) {
      profile.longTermMemories = profile.longTermMemories.filter((memory) => memory.id !== targetId);
      return { changed: true, purged: true };
    }
    longTerm.weight = 0;
    return { changed: true, purged: false };
  }

  const episode = profile.episodes.find((item) => item.id === targetId);
  if (!episode) return { changed: false, purged: false };
  if (episode.weight <= 0) {
    profile.episodes = profile.episodes.filter((item) => item.id !== targetId);
    profile.memoryCandidates = profile.memoryCandidates.filter((item) => item.sourceEpisodeId !== targetId);
    return { changed: true, purged: true };
  }
  episode.weight = 0;
  episode.feedback.push("forget");
  for (const candidate of profile.memoryCandidates.filter((item) => item.sourceEpisodeId === episode.id)) {
    candidate.status = "dismissed";
  }
  return { changed: true, purged: false };
}

export function updateLongTermMemory(profile: CreatureProfile, memoryId: string, text: string) {
  const memory = profile.longTermMemories.find((item) => item.id === memoryId);
  if (!memory) return undefined;
  memory.text = text.trim();
  memory.tags = extractTags(memory.text);
  return memory;
}

export function adjustMemoryWeight(profile: CreatureProfile, targetId: string | undefined, amount: number) {
  if (!targetId) return;
  const episode = profile.episodes.find((item) => item.id === targetId);
  if (episode) episode.weight = Math.max(0, Math.min(100, episode.weight + amount));
  const longTerm = profile.longTermMemories.find((item) => item.id === targetId);
  if (longTerm) longTerm.weight = Math.max(0, Math.min(100, longTerm.weight + amount));
}

function inferIntent(text: string): string {
  void text;
  return "";
}

function buildMemoryCandidateText(episode: EpisodeMemory): string {
  const input = stripSourceMetadata(episode.inputSummary);
  if (input.length > 0) return input;
  const noticed = stripSourceMetadata(episode.noticed);
  return noticed.length > 0 ? noticed : "";
}

export function normalizeSharedMemoryText(text: string) {
  return text
    .trim()
    .replace(/(\p{Script=Han})\s+(\p{Script=Han})/gu, "$1$2")
    .replace(/[。！？.!?]+$/, "");
}

export function toCreatureMemoryVoice(text: string) {
  return normalizeSharedMemoryText(text)
    .replace(/(\p{Script=Han})\s+(\p{Script=Han})/gu, "$1$2")
    .replace(/[。！？.!?]+$/, "");
}

export function memoryKeepReasonToCreatureVoice(reason: string) {
  return toCreatureMemoryVoice(reason);
}

function stripSourceMetadata(text: string) {
  return text
    .replace(/30秒批次[：:]\s*\S+/g, "")
    .replace(/观察地点[：:][^\n。！？.!?]*/g, "")
    .replace(/照片时间[：:]\s*\S+/g, "")
    .replace(/音频片段时间[：:]\s*\S+/g, "")
    .replace(/观察时间[：:]\s*\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

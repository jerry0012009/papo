import { makeId } from "./ids";
import { summarizeText } from "./text";
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
    attachments: event.attachments ?? [],
    inputSummary: summarizeText(event.triggerContent, 140),
    noticed: event.noticed,
    possibleIntent: "",
    importanceReason: event.reason,
    relatedMemoryIds: event.relatedMemoryIds,
    stateSnapshot: structuredClone(event.stateSnapshot),
    creatureResponse: response,
    feedback: [],
    promotedToLongTerm: false,
    memoryCandidateIds: candidateIds,
    actionDecision: event.actionDecision,
    actionResult: event.actionResult,
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
    shortTitle: memoryShortTitle(sourceMaterial),
    memoryKind: "open_question",
    confidence: 0,
    sourceEpisodeId: episode.id,
    whyConsolidate: "",
    writePolicy: "wait_feedback",
    decayPolicy: "decay_without_feedback",
    status: "candidate",
    tags: [],
    attachments: episode.attachments ?? []
  };

  profile.memoryCandidates.unshift(candidate);
  profile.memoryCandidates = profile.memoryCandidates.slice(0, 80);
  episode.memoryCandidateIds.push(candidate.id);
  return candidate;
}

function promoteEpisode(profile: CreatureProfile, episodeId: string, now = new Date().toISOString()) {
  const episode = profile.episodes.find((item) => item.id === episodeId);
  if (!episode) return undefined;
  if (episode.promotedToLongTerm) {
    return profile.longTermMemories.find((memory) => memory.sourceEpisodeId === episodeId);
  }

  const candidate = profile.memoryCandidates.find((item) => item.sourceEpisodeId === episode.id && item.status === "candidate");
  if (!candidate) return undefined;
  const duplicate = findActiveDuplicateMemory(profile, candidate);
  if (duplicate) {
    episode.promotedToLongTerm = true;
    candidate.status = "promoted";
    duplicate.weight = Math.min(100, Math.max(duplicate.weight + 8, episode.weight + 18));
    duplicate.tags = unique([...duplicate.tags, ...candidate.tags]);
    duplicate.attachments = mergeAttachments(duplicate.attachments, candidate.attachments);
    duplicate.lastReferencedAt = now;
    if (!duplicate.consolidatedBecause && candidate.whyConsolidate) duplicate.consolidatedBecause = candidate.whyConsolidate;
    return duplicate;
  }
  const memory: LongTermMemory = {
    id: makeId("ltm"),
    createdAt: now,
    kind: candidate.memoryKind,
    text: candidate.candidateText,
    shortTitle: candidate.shortTitle ?? memoryShortTitle(candidate.candidateText),
    sourceEpisodeId: episode.id,
    consolidatedBecause: candidate.whyConsolidate,
    weight: Math.min(100, episode.weight + 18),
    tags: candidate.tags,
    attachments: candidate.attachments ?? []
  };
  episode.promotedToLongTerm = true;
  candidate.status = "promoted";
  profile.longTermMemories.unshift(memory);
  return memory;
}

export function promoteMemoryCandidate(
  profile: CreatureProfile,
  candidateId: string,
  input: {
    text?: string;
    shortTitle?: string;
    kind?: LongTermMemory["kind"];
    tags?: string[];
    consolidatedBecause?: string;
    weight?: number;
    now?: string;
  } = {}
) {
  const now = input.now ?? new Date().toISOString();
  const candidate = profile.memoryCandidates.find((item) => item.id === candidateId && item.status === "candidate");
  if (!candidate) return undefined;
  const episode = profile.episodes.find((item) => item.id === candidate.sourceEpisodeId);
  const text = normalizeSharedMemoryText(input.text ?? candidate.candidateText);
  if (!text) return undefined;
  const duplicate = findActiveDuplicateMemory(profile, { ...candidate, candidateText: text });
  const tags = input.tags?.length ? input.tags : candidate.tags;
  if (duplicate) {
    candidate.status = "promoted";
    if (episode) episode.promotedToLongTerm = true;
    duplicate.kind = input.kind ?? candidate.memoryKind;
    duplicate.text = text;
    duplicate.shortTitle = memoryShortTitle(text, input.shortTitle ?? candidate.shortTitle);
    duplicate.weight = Math.max(0, Math.min(100, Math.round(input.weight ?? Math.max(duplicate.weight, (episode?.weight ?? 45) + 18))));
    duplicate.tags = unique([...duplicate.tags, ...tags]);
    duplicate.attachments = mergeAttachments(duplicate.attachments, candidate.attachments);
    duplicate.consolidatedBecause = input.consolidatedBecause ?? candidate.whyConsolidate ?? duplicate.consolidatedBecause;
    duplicate.lastReferencedAt = now;
    return duplicate;
  }
  const memory: LongTermMemory = {
    id: makeId("ltm"),
    createdAt: now,
    kind: input.kind ?? candidate.memoryKind,
    text,
    shortTitle: memoryShortTitle(text, input.shortTitle ?? candidate.shortTitle),
    sourceEpisodeId: candidate.sourceEpisodeId,
    consolidatedBecause: input.consolidatedBecause ?? candidate.whyConsolidate,
    weight: Math.max(0, Math.min(100, Math.round(input.weight ?? (episode?.weight ?? 45) + 18))),
    tags,
    attachments: candidate.attachments ?? []
  };
  candidate.status = "promoted";
  if (episode) episode.promotedToLongTerm = true;
  profile.longTermMemories.unshift(memory);
  return memory;
}

export function memoryShortTitle(text: string, suggested?: string) {
  const compact = (value: string) => value.replace(/[\s，。！？、；：,.!?;:'"“”‘’（）()【】\[\]]/g, "").trim();
  const cleanSuggested = compact(suggested ?? "");
  if ([...cleanSuggested].length >= 2) return [...cleanSuggested].slice(0, 8).join("");
  const clean = compact(normalizeSharedMemoryText(text).replace(/^(?:用户|你|我|Papo|它)(?:曾经|最近|今天|提到|说|觉得|希望|喜欢|想要|正在)?/i, ""));
  return [...(clean || "一段记忆")].slice(0, 8).join("");
}

function findActiveDuplicateMemory(profile: CreatureProfile, candidate: MemoryCandidate) {
  const candidateText = normalizeSharedMemoryText(candidate.candidateText);
  if (!candidateText) return undefined;
  return profile.longTermMemories.find((memory) => memory.weight > 0 && normalizeSharedMemoryText(memory.text) === candidateText);
}

export function applyMemoryWritePolicies(
  profile: CreatureProfile,
  candidates: MemoryCandidate[],
  now = new Date().toISOString()
) {
  const promoted: LongTermMemory[] = [];
  for (const candidate of candidates) {
    if (candidate.status !== "candidate") continue;
    if (candidate.writePolicy !== "auto") continue;
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

  const candidate = profile.memoryCandidates.find((item) => item.id === targetId);
  if (candidate) {
    if (candidate.status === "dismissed") {
      profile.memoryCandidates = profile.memoryCandidates.filter((item) => item.id !== targetId);
      const episode = profile.episodes.find((item) => item.id === candidate.sourceEpisodeId);
      if (episode) episode.memoryCandidateIds = episode.memoryCandidateIds.filter((id) => id !== candidate.id);
      return { changed: true, purged: true };
    }
    candidate.status = "dismissed";
    candidate.writePolicy = "do_not_save";
    candidate.decayPolicy = "forget_if_dismissed";
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

export function adjustMemoryWeight(profile: CreatureProfile, targetId: string | undefined, amount: number) {
  if (!targetId) return;
  const episode = profile.episodes.find((item) => item.id === targetId);
  if (episode) episode.weight = Math.max(0, Math.min(100, episode.weight + amount));
  const longTerm = profile.longTermMemories.find((item) => item.id === targetId);
  if (longTerm) longTerm.weight = Math.max(0, Math.min(100, longTerm.weight + amount));
  const candidate = profile.memoryCandidates.find((item) => item.id === targetId);
  if (candidate) candidate.confidence = Math.max(0, Math.min(100, candidate.confidence + amount));
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

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

export function mergeAttachments<T extends { id: string }>(left: T[] | undefined, right: T[] | undefined): T[] {
  const byId = new Map<string, T>();
  for (const attachment of [...(left ?? []), ...(right ?? [])]) {
    byId.set(attachment.id, attachment);
  }
  return [...byId.values()];
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

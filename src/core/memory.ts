import { makeId } from "./ids";
import { hasHighPrivacyText } from "./privacy";
import { summarizeText } from "./text";
import type { AttentionEvent, ConversationJobRecord, CreatureProfile, EpisodeMemory, LongTermMemory, MemoryCandidate } from "./types";

export const MEMORY_VISUAL_POLICY_VERSION = 5;

export function memoryVisualNeedsPolicyMigration(memory: LongTermMemory) {
  const version = memory.visualPolicyVersion ?? 1;
  if (version < 4) return true;
  if (version >= MEMORY_VISUAL_POLICY_VERSION) return false;
  return hasForbiddenVisualContent(memory.visualPrompt ?? "");
}

function hasForbiddenVisualContent(prompt: string) {
  const withoutNegativeGuards = prompt
    .replace(/\b(?:no|without|avoid|exclude)\s+(?:any\s+)?(?:readable\s+)?(?:icons?|pictograms?|symbols?|text|letters?|words?|labels?|captions?|typography|infographics?|diagrams?|logos?)(?:\s*(?:,|and|or)\s*(?:no\s+|without\s+)?(?:any\s+)?(?:readable\s+)?(?:icons?|pictograms?|symbols?|text|letters?|words?|labels?|captions?|typography|infographics?|diagrams?|logos?))*\b/gi, "")
    .replace(/(?:无|不要|禁止|不出现|避免)(?:任何)?(?:可读的)?(?:图标|符号|文字|字母|单词|标签|标题|字幕|排版|信息图|示意图|标识)(?:[、，和或]*(?:无|不要|禁止|不出现|避免)?(?:任何)?(?:可读的)?(?:图标|符号|文字|字母|单词|标签|标题|字幕|排版|信息图|示意图|标识))*/g, "");
  return /\b(?:icons?|pictograms?|symbols?|text|letters?|words?|labels?|captions?|typography|infographic|diagram|logo|AI[- ]related)\b|图标|符号|文字|字母|单词|标签|标题|字幕|排版|信息图|示意图|标识/i.test(withoutNegativeGuards);
}

export function upsertLongTermMemory(
  profile: CreatureProfile,
  incoming: LongTermMemory,
  options: { now?: string; sourceIds?: string[]; scheduleEnrichment?: boolean } = {}
) {
  const now = options.now ?? new Date().toISOString();
  const existing = profile.longTermMemories.find((memory) => memory.id === incoming.id);
  const previousFingerprint = existing ? memoryContentFingerprint(existing) : undefined;
  const merged: LongTermMemory = {
    ...existing,
    ...incoming,
    visual: incoming.visual ?? existing?.visual,
    visualPrompt: incoming.visualPrompt ?? existing?.visualPrompt,
    visualUpdatedAt: incoming.visualUpdatedAt ?? existing?.visualUpdatedAt,
    visualStatus: incoming.visualStatus ?? existing?.visualStatus,
    visualError: incoming.visualError ?? existing?.visualError,
    visualMode: incoming.visualMode ?? existing?.visualMode,
    papoPresence: incoming.papoPresence ?? existing?.papoPresence,
    visualPlanReason: incoming.visualPlanReason ?? existing?.visualPlanReason,
    visualPolicyVersion: incoming.visualPolicyVersion ?? existing?.visualPolicyVersion ?? MEMORY_VISUAL_POLICY_VERSION,
    narrative: incoming.narrative ?? existing?.narrative,
    attachments: incoming.attachments ?? existing?.attachments ?? [],
    tags: incoming.tags ?? existing?.tags ?? []
  };
  const nextFingerprint = memoryContentFingerprint(merged);
  const changed = !existing || previousFingerprint !== nextFingerprint;
  const revision = changed ? Math.max(0, existing?.contentRevision ?? 0) + 1 : Math.max(1, existing?.contentRevision ?? 1);
  merged.contentRevision = revision;
  merged.contentFingerprint = nextFingerprint;
  if (changed) {
    merged.enrichmentStatus = "pending";
    merged.enrichmentError = undefined;
    merged.visualError = undefined;
    if (!merged.visual) merged.visualStatus = "pending";
  }
  profile.longTermMemories = [merged, ...profile.longTermMemories.filter((memory) => memory.id !== merged.id)].slice(0, 80);
  if (changed && options.scheduleEnrichment !== false && merged.weight > 0) {
    enqueueMemoryEnrichmentJob(profile, merged, { now, sourceIds: options.sourceIds });
  }
  return { memory: merged, changed, revision };
}

export function enqueueMemoryEnrichmentJob(
  profile: CreatureProfile,
  memory: LongTermMemory,
  options: { now?: string; sourceIds?: string[] } = {}
) {
  const now = options.now ?? new Date().toISOString();
  const revision = Math.max(1, memory.contentRevision ?? 1);
  const id = `memory_enrichment_${safeJobPart(memory.id)}_r${revision}`;
  const existing = profile.jobs?.find((job) => job.id === id);
  if (existing) return existing;
  const turnId = `memory_lifecycle_${safeJobPart(memory.id)}`.slice(0, 100);
  const job: ConversationJobRecord = {
    id,
    turnId,
    requestId: turnId,
    type: "memory_enrichment",
    stage: "action",
    status: "queued",
    attempt: 0,
    maxAttempts: 3,
    retryable: true,
    createdAt: now,
    updatedAt: now,
    sourceIds: unique([memory.id, memory.sourceEpisodeId ?? "", ...(memory.attachments ?? []).map((item) => item.id), ...(options.sourceIds ?? [])]),
    memoryId: memory.id,
    memoryRevision: revision
  };
  profile.jobs = [job, ...(profile.jobs ?? [])].slice(0, 240);
  return job;
}

export function enqueueCandidateVisualJobs(profile: CreatureProfile, now = new Date().toISOString()) {
  const jobs: ConversationJobRecord[] = [];
  let available = Math.max(0, 2 - (profile.jobs ?? []).filter((job) => job.type === "candidate_visual" && (job.status === "queued" || job.status === "running")).length);
  const budgetPool = profile.memoryCandidates.filter((candidate) => candidate.status === "candidate").slice(0, 6);
  for (const candidate of budgetPool) {
    if (available <= 0) break;
    if (candidate.status !== "candidate" || candidate.confidence < 70 || candidate.previewVisual || candidate.previewStatus === "not_needed") continue;
    if (candidate.attachments?.some((attachment) => attachment.kind === "image")) continue;
    if (hasHighPrivacyText(`${candidate.candidateText} ${candidate.privacyReason ?? ""}`)) continue;
    const id = `candidate_visual_${safeJobPart(candidate.id)}`;
    if (profile.jobs?.some((job) => job.id === id)) continue;
    const turnId = `candidate_lifecycle_${safeJobPart(candidate.id)}`.slice(0, 100);
    const job: ConversationJobRecord = {
      id, turnId, requestId: turnId, type: "candidate_visual", stage: "action", status: "queued",
      attempt: 0, maxAttempts: 2, retryable: true, createdAt: now, updatedAt: now,
      sourceIds: unique([candidate.id, candidate.sourceEpisodeId]), candidateId: candidate.id
    };
    candidate.previewStatus = "pending";
    profile.jobs = [job, ...(profile.jobs ?? [])].slice(0, 240);
    jobs.push(job);
    available -= 1;
  }
  return jobs;
}

export function clearCandidateVisual(candidate: MemoryCandidate) {
  candidate.previewVisual = undefined;
  candidate.previewStatus = "not_needed";
  candidate.previewError = undefined;
  candidate.previewPrompt = undefined;
  candidate.previewMode = "no_visual";
  candidate.previewPapoPresence = "absent";
  candidate.previewPlanReason = undefined;
  candidate.previewNarrative = undefined;
  candidate.previewUpdatedAt = new Date().toISOString();
}

export function memoryContentFingerprint(memory: LongTermMemory) {
  const value = JSON.stringify({
    text: normalizeSharedMemoryText(memory.text),
    kind: memory.kind,
    sourceEpisodeId: memory.sourceEpisodeId ?? "",
    consolidatedBecause: normalizeSharedMemoryText(memory.consolidatedBecause ?? ""),
    tags: [...new Set(memory.tags)].sort(),
    attachments: (memory.attachments ?? []).map((item) => item.id).sort()
  });
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `memfp_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

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
    cognitionSource: event.cognitionSource,
    sourceTaskId: event.sourceTaskId,
    parentEventId: event.sourceEventId,
    parentEpisodeId: event.sourceEpisodeId,
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
  const previewPending = candidate.previewStatus === "pending" || profile.jobs?.some((job) => job.type === "candidate_visual" && job.candidateId === candidate.id && (job.status === "queued" || job.status === "running"));
  const duplicate = findActiveDuplicateMemory(profile, candidate);
  if (duplicate) {
    episode.promotedToLongTerm = true;
    candidate.status = "promoted";
    return upsertLongTermMemory(profile, {
      ...duplicate,
      weight: Math.min(100, Math.max(duplicate.weight + 8, episode.weight + 18)),
      tags: unique([...duplicate.tags, ...candidate.tags]),
      attachments: mergeAttachments(duplicate.attachments, candidate.attachments),
      lastReferencedAt: now,
      consolidatedBecause: duplicate.consolidatedBecause || candidate.whyConsolidate
    }, { now, sourceIds: [episode.id, candidate.id] }).memory;
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
    attachments: candidate.attachments ?? [],
    visual: candidate.previewVisual,
    visualPrompt: candidate.previewPrompt,
    visualMode: candidate.previewMode,
    papoPresence: candidate.previewPapoPresence,
    visualPlanReason: candidate.previewPlanReason,
    visualPolicyVersion: candidate.previewVisual ? MEMORY_VISUAL_POLICY_VERSION : undefined,
    visualStatus: candidate.previewVisual ? "ready" : candidate.previewStatus === "not_needed" ? "not_needed" : undefined,
    visualUpdatedAt: candidate.previewUpdatedAt,
    narrative: candidate.previewNarrative ?? candidate.candidateText,
    enrichedRevision: candidate.previewVisual || candidate.previewStatus === "not_needed" || previewPending ? 1 : undefined,
    enrichmentStatus: candidate.previewVisual || candidate.previewStatus === "not_needed" ? "completed" : previewPending ? "pending" : undefined,
    ...(previewPending && !candidate.previewVisual ? { visualStatus: "pending" as const } : {})
  };
  episode.promotedToLongTerm = true;
  candidate.status = "promoted";
  return upsertLongTermMemory(profile, memory, { now, sourceIds: [episode.id, candidate.id], scheduleEnrichment: !previewPending && !candidate.previewVisual && candidate.previewStatus !== "not_needed" }).memory;
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
  const previewPending = candidate.previewStatus === "pending" || profile.jobs?.some((job) => job.type === "candidate_visual" && job.candidateId === candidate.id && (job.status === "queued" || job.status === "running"));
  if (duplicate) {
    candidate.status = "promoted";
    if (episode) episode.promotedToLongTerm = true;
    return upsertLongTermMemory(profile, {
      ...duplicate,
      kind: input.kind ?? candidate.memoryKind,
      text,
      shortTitle: memoryShortTitle(text, input.shortTitle ?? candidate.shortTitle),
      weight: Math.max(0, Math.min(100, Math.round(input.weight ?? Math.max(duplicate.weight, (episode?.weight ?? 45) + 18)))),
      tags: unique([...duplicate.tags, ...tags]),
      attachments: mergeAttachments(duplicate.attachments, candidate.attachments),
      consolidatedBecause: input.consolidatedBecause ?? candidate.whyConsolidate ?? duplicate.consolidatedBecause,
      lastReferencedAt: now
    }, { now, sourceIds: [candidate.id, candidate.sourceEpisodeId] }).memory;
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
    attachments: candidate.attachments ?? [],
    visual: candidate.previewVisual,
    visualPrompt: candidate.previewPrompt,
    visualMode: candidate.previewMode,
    papoPresence: candidate.previewPapoPresence,
    visualPlanReason: candidate.previewPlanReason,
    visualPolicyVersion: candidate.previewVisual ? MEMORY_VISUAL_POLICY_VERSION : undefined,
    visualStatus: candidate.previewVisual ? "ready" : candidate.previewStatus === "not_needed" ? "not_needed" : undefined,
    visualUpdatedAt: candidate.previewUpdatedAt,
    narrative: candidate.previewNarrative ?? candidate.candidateText,
    enrichedRevision: candidate.previewVisual || candidate.previewStatus === "not_needed" || previewPending ? 1 : undefined,
    enrichmentStatus: candidate.previewVisual || candidate.previewStatus === "not_needed" ? "completed" : previewPending ? "pending" : undefined,
    ...(previewPending && !candidate.previewVisual ? { visualStatus: "pending" as const } : {})
  };
  candidate.status = "promoted";
  if (episode) episode.promotedToLongTerm = true;
  return upsertLongTermMemory(profile, memory, { now, sourceIds: [candidate.id, candidate.sourceEpisodeId], scheduleEnrichment: !previewPending && !candidate.previewVisual && candidate.previewStatus !== "not_needed" }).memory;
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
    upsertLongTermMemory(profile, { ...longTerm, weight: 0 }, { scheduleEnrichment: false });
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
    clearCandidateVisual(candidate);
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
    clearCandidateVisual(candidate);
  }
  return { changed: true, purged: false };
}

export function adjustMemoryWeight(profile: CreatureProfile, targetId: string | undefined, amount: number) {
  if (!targetId) return;
  const episode = profile.episodes.find((item) => item.id === targetId);
  if (episode) episode.weight = Math.max(0, Math.min(100, episode.weight + amount));
  const longTerm = profile.longTermMemories.find((item) => item.id === targetId);
  if (longTerm) upsertLongTermMemory(profile, {
    ...longTerm,
    weight: Math.max(0, Math.min(100, longTerm.weight + amount))
  });
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

function safeJobPart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
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

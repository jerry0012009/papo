import { makeId } from "./ids";
import { extractTags, keywordOverlap, summarizeText } from "./text";
import type { AttentionEvent, CreatureProfile, EpisodeMemory, LongTermMemory, MemoryCandidate } from "./types";

export function findRelatedMemories(profile: CreatureProfile, tags: string[], limit = 3): LongTermMemory[] {
  return [...profile.longTermMemories]
    .map((memory) => ({
      memory,
      overlap: keywordOverlap(tags, memory.tags),
      score: keywordOverlap(tags, memory.tags) * 2 + memory.weight / 100
    }))
    .filter((item) => item.overlap > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.memory);
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
  input: { feedback?: "continue" | "remember"; now?: string } = {}
): MemoryCandidate {
  const now = input.now ?? new Date().toISOString();
  const privacyHigh = /隐私|密码|token|key|secret|地址/.test(`${episode.inputSummary} ${episode.noticed}`);
  const repeatedThemeCount = countSimilarEpisodes(profile, episode.tags);
  const kind = classifyLongTermKind(episode);
  const confidence = Math.min(96, Math.max(35, episode.weight + repeatedThemeCount * 8 + (input.feedback === "remember" ? 18 : 0) - (privacyHigh ? 25 : 0)));
  const writePolicy = decideWritePolicy({
    privacyHigh,
    confidence,
    feedback: input.feedback,
    repeatedThemeCount,
    saveThreshold: profile.policyProfile.saveThreshold
  });

  const candidate: MemoryCandidate = {
    id: makeId("candidate"),
    createdAt: now,
    candidateText: buildLongTermText(episode),
    memoryKind: input.feedback === "continue" && kind === "long_theme" ? "open_question" : kind,
    confidence,
    sourceEpisodeId: episode.id,
    whyConsolidate: repeatedThemeCount >= 3
      ? "同一主题已经多次出现，海马体建议形成长期主题。"
      : "这条 episode 有足够的注意强度，先形成待巩固候选。",
    writePolicy,
    privacyReason: privacyHigh ? "包含隐私或密钥线索，默认不自动长期保存。" : undefined,
    decayPolicy: input.feedback === "continue" ? "stable" : "decay_without_feedback",
    status: "candidate",
    tags: episode.tags
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

  const candidate = profile.memoryCandidates.find((item) => item.sourceEpisodeId === episode.id && item.status === "candidate")
    ?? createMemoryCandidateFromEpisode(profile, episode, { feedback: "remember", now });
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
  if (/提醒|待办|deadline|todo/i.test(text)) return "用户可能希望把这件事变成之后可回来的提醒。";
  if (/复盘|总结|review|why/i.test(text)) return "用户可能正在整理一次经历，希望我帮它形成可复盘的片段。";
  if (/不像工具|活物|小脑袋|companion|生命/.test(text)) return "用户可能在校准这个小动物应该长成什么样。";
  return "你把这一小段递给我，我先把它当成我们刚一起经过的情景来听。";
}

function classifyLongTermKind(episode: EpisodeMemory): LongTermMemory["kind"] {
  const text = `${episode.inputSummary} ${episode.noticed}`;
  if (/隐私|安全|谨慎|删除|忘掉/.test(text)) return "safety_rule";
  if (/我应该|我曾经|小动物|脑功能|注意/.test(text)) return "creature_self_memory";
  if (/提醒|未来|下次|之后/.test(text)) return "future_review";
  if (/问题|不确定|继续想/.test(text)) return "open_question";
  if (/习惯|经常|总是/.test(text)) return "habit";
  if (/关系|陪伴|靠近/.test(text)) return "relationship";
  if (/喜欢|偏好|更愿意/.test(text)) return "user_preference";
  return "long_theme";
}

function buildLongTermText(episode: EpisodeMemory): string {
  if (episode.noticed.length > 8) return episode.noticed;
  return `我和用户经历过这件事：${episode.inputSummary}`;
}

function countSimilarEpisodes(profile: CreatureProfile, tags: string[]) {
  return profile.episodes.filter((episode) => keywordOverlap(episode.tags, tags) > 0).length;
}

function decideWritePolicy(input: {
  privacyHigh: boolean;
  confidence: number;
  feedback?: "continue" | "remember";
  repeatedThemeCount: number;
  saveThreshold: number;
}): MemoryCandidate["writePolicy"] {
  if (input.privacyHigh) return "ask_user";
  if (input.feedback === "remember") return "auto";
  if (input.feedback === "continue") return "wait_feedback";
  if (input.repeatedThemeCount >= 3 && input.confidence >= input.saveThreshold) return "ask_user";
  if (input.confidence >= 88) return "ask_user";
  return "wait_feedback";
}

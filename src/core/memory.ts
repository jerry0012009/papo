import { makeId } from "./ids";
import { extractTags, keywordOverlap, summarizeText } from "./text";
import type { AttentionEvent, CreatureProfile, EpisodeMemory, LongTermMemory } from "./types";

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
  return {
    id: makeId("episode"),
    createdAt: now,
    source: event.source,
    inputSummary: summarizeText(event.triggerContent, 140),
    noticed: event.noticed,
    possibleIntent: inferIntent(event.triggerContent),
    importanceReason: event.reason,
    relatedMemoryIds: event.relatedMemoryIds,
    stateSnapshot: structuredClone(event.stateSnapshot),
    creatureResponse: response,
    feedback: [],
    promotedToLongTerm: false,
    weight: Math.max(20, Math.round(event.attentionStrength)),
    tags: event.tags,
    decisionTrace: event.decisionTrace
  };
}

export function promoteEpisode(profile: CreatureProfile, episodeId: string, now = new Date().toISOString()) {
  const episode = profile.episodes.find((item) => item.id === episodeId);
  if (!episode) return undefined;
  if (episode.promotedToLongTerm) {
    return profile.longTermMemories.find((memory) => memory.sourceEpisodeId === episodeId);
  }

  const memory: LongTermMemory = {
    id: makeId("ltm"),
    createdAt: now,
    kind: classifyLongTermKind(episode),
    text: buildLongTermText(episode),
    sourceEpisodeId: episode.id,
    weight: Math.min(100, episode.weight + 18),
    tags: episode.tags.length ? episode.tags : extractTags(episode.inputSummary)
  };
  episode.promotedToLongTerm = true;
  profile.longTermMemories.unshift(memory);
  return memory;
}

export function forgetMemory(profile: CreatureProfile, targetId?: string): boolean {
  if (!targetId) return false;

  const longTermBefore = profile.longTermMemories.length;
  profile.longTermMemories = profile.longTermMemories.filter((memory) => memory.id !== targetId);
  if (profile.longTermMemories.length !== longTermBefore) return true;

  const episode = profile.episodes.find((item) => item.id === targetId);
  if (!episode) return false;
  episode.weight = Math.max(0, episode.weight - 35);
  episode.feedback.push("forget");
  return true;
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
  return "用户主动把这个片段交给我，可能希望我认真理解并判断是否值得记住。";
}

function classifyLongTermKind(episode: EpisodeMemory): LongTermMemory["kind"] {
  const text = `${episode.inputSummary} ${episode.noticed}`;
  if (/隐私|安全|谨慎|删除|忘掉/.test(text)) return "safety_rule";
  if (/我应该|我曾经|小动物|脑功能|注意/.test(text)) return "creature_self_memory";
  if (/提醒|未来|下次|之后/.test(text)) return "future_review";
  if (/喜欢|偏好|更愿意/.test(text)) return "user_preference";
  return "long_theme";
}

function buildLongTermText(episode: EpisodeMemory): string {
  if (episode.noticed.length > 8) return episode.noticed;
  return `我和用户经历过这件事：${episode.inputSummary}`;
}

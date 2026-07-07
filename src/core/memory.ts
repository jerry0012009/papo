import { makeId } from "./ids";
import { extractTags, keywordOverlap, summarizeText } from "./text";
import type { AttentionEvent, CreatureProfile, EpisodeMemory, LongTermMemory, MemoryCandidate } from "./types";

export function findRelatedMemories(profile: CreatureProfile, tags: string[], limit = 3): LongTermMemory[] {
  return [...profile.longTermMemories]
    .filter((memory) => memory.weight > 0 && !isQuietingSelfMemory(memory))
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

function isQuietingSelfMemory(memory: LongTermMemory) {
  return memory.kind === "creature_self_memory" && memory.tags.some((tag) => tag === "更安静" || tag === "更小心边界");
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
      ? "这件事已经多次回到我这里，我想把它抱成一个长期主题。"
      : "我刚才确实认真停了一下，先把这段留成可以被你确认的小记忆。",
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
  if (/说句话|说话|回复|回答|你在吗|你好|hello|汪|打招呼|听见|听到|回应|叫你/i.test(text)) {
    return "你像是在确认我有没有听见，所以我应该先回应你。";
  }
  if (/提醒|待办|deadline|todo/i.test(text)) return "这件事之后可能还会回来，你可能希望我到时候接得上。";
  if (/复盘|总结|review|why/i.test(text)) return "你像是在整理一次经历，希望我陪你看清楚。";
  if (/不像工具|活物|小脑袋|companion|生命/.test(text)) return "你在校准我应该怎么陪你，而不是只完成任务。";
  return "你在分享一件刚发生或刚想起的事，我先回应当下。";
}

function classifyLongTermKind(episode: EpisodeMemory): LongTermMemory["kind"] {
  const text = `${episode.inputSummary} ${episode.noticed}`;
  if (/隐私|安全|谨慎|删除|忘掉/.test(text)) return "safety_rule";
  if (/我应该|我曾经|小动物|脑功能|活物|不像工具|被你养成|你教我/.test(text)) return "creature_self_memory";
  if (/提醒|未来|下次|之后/.test(text)) return "future_review";
  if (/问题|不确定|继续想/.test(text)) return "open_question";
  if (/习惯|经常|总是/.test(text)) return "habit";
  if (/关系|陪伴|靠近/.test(text)) return "relationship";
  if (/喜欢|偏好|更愿意/.test(text)) return "user_preference";
  return "long_theme";
}

function buildLongTermText(episode: EpisodeMemory): string {
  const scene = sharedMomentText(episode);
  const moment = episodeMomentText(episode);
  const response = sharedResponseText(episode.creatureResponse, scene);
  const parts = [scene, moment, response ? `当时我回应你：${response}` : ""].filter(Boolean);
  return normalizeSharedMemoryText(parts.join(" "));
}

function sharedMomentText(episode: EpisodeMemory) {
  const input = stripSourceMetadata(episode.inputSummary);
  if (input.length > 0) return `你当时告诉我：${input}`;
  const noticed = stripSourceMetadata(episode.noticed);
  return noticed.length > 8 ? `我当时听见这件事：${noticed}` : "我和你一起经历过这件事";
}

function episodeMomentText(episode: EpisodeMemory) {
  const parts: string[] = [];
  if (episode.sourceObservedAt) {
    parts.push(`那一小段的时间是 ${memoryMomentTime(episode.sourceObservedAt)}`);
  }
  if (episode.sourceLocation?.label) {
    parts.push(`地点是${episode.sourceLocation.label}`);
  }
  if (!parts.length) return "";
  return `我也记住它发生时的线索：${parts.join("，")}。`;
}

function memoryMomentTime(value: string) {
  return value.replace("T", " ").replace(/\.\d{3}Z$/, " UTC").replace(/Z$/, " UTC");
}

export function normalizeSharedMemoryText(text: string) {
  return text
    .trim()
    .replace(/^我先试着理解[：:]\s*/, "")
    .replace(/我注意到这个片段可能是你想让我认真理解的当前事件[：:]\s*/g, "你刚告诉我的这件事：")
    .replace(/这个片段可能是你想让我认真理解的当前事件[：:]\s*/g, "你刚告诉我的这件事：")
    .replace(/我还没有强烈联想到旧记忆，所以先把它作为新的情景片段/g, "我还没把它和旧事连起来，会先当作这一次的小经历")
    .replace(/这段需要用户确认，尤其是隐私、情绪或保存意图还不够明确/g, "这段我会先放轻一点，等你告诉我能不能留下")
    .replace(/这段需要你确认，尤其是隐私、情绪或保存意图还不够明确/g, "这段我会先放轻一点，等你告诉我能不能留下")
    .replace(/我和用户/g, "我和你")
    .replace(/用户主动/g, "你主动")
    .replace(/用户确认/g, "你确认")
    .replace(/用户反馈/g, "你后来教我")
    .replace(/用户/g, "你")
    .replace(/Papo/g, "我")
    .replace(/小动物/g, "我")
    .replace(/这条\s*episode/gi, "这件事")
    .replace(/episode/gi, "这件事")
    .replace(/memory candidate/gi, "还没完全记稳的想法")
    .replace(/candidate/gi, "还没完全记稳的想法")
    .replace(/当前工作区/g, "现在这一刻")
    .replace(/旧记忆/g, "旧小事")
    .replace(/情景片段/g, "小经历")
    .replace(/保存意图/g, "要不要留下")
    .replace(/需要你确认/g, "我会先等你点头")
    .replace(/长期保存/g, "一直记着")
    .replace(/长期记忆/g, "一直记着的事")
    .replace(/短期记忆/g, "刚刚记下的事")
    .replace(/隐私风险/g, "需要先小心的边界")
    .replace(/隐私、情绪或要不要留下还不够明确/g, "隐私、情绪或要不要留下还需要你点头")
    .replace(/我\s+(说|回应|听|记|想|叫)/g, "我$1")
    .replace(/(\p{Script=Han})\s+(\p{Script=Han})/gu, "$1$2")
    .replace(/[。！？.!?]+$/, "");
}

export function toCreatureMemoryVoice(text: string) {
  return normalizeSharedMemoryText(text)
    .replace(/^(你刚递给我的这件小事|你刚告诉我的这件事|我刚才注意到|我注意到|你曾经对我说)[：:]\s*/g, "")
    .replace(/^我把这条记忆改准了[：:]\s*/g, "")
    .replace(/^你希望我/g, "你那时希望我")
    .replace(/^你想让我/g, "你那时想让我")
    .replace(/^你让我/g, "你那时让我")
    .replace(/我还没把它和旧事连起来，会先当作这一次的小经历/g, "我当时还没和旧事连起来，就先把它当成这一次的小经历")
    .replace(/这段我会先放轻一点，等你告诉我能不能留下/g, "我当时决定先放轻一点，等你告诉我能不能留下")
    .replace(/这条小片段有未来价值/g, "它以后可能还会回来找你")
    .replace(/小片段/g, "这件事")
    .replace(/有未来价值/g, "以后可能还会回来找你")
    .replace(/(\p{Script=Han})\s+(\p{Script=Han})/gu, "$1$2")
    .replace(/[。！？.!?]+$/, "");
}

export function memoryKeepReasonToCreatureVoice(reason: string) {
  return toCreatureMemoryVoice(reason)
    .replace(/^这一小段以后可能还会回来找你$/, "它以后可能还会回来找你")
    .replace(/^这件事已经多次回到我这里，我想把它抱成一个长期主题$/, "它已经几次回到我耳边，我想把它记稳一点")
    .replace(/^我刚才确实认真停了一下，先把这段留成可以被你确认的小记忆$/, "我当时认真听了，等你教我能不能记稳")
    .replace(/^这段值得成为我们之间更稳定的一直记着的事$/, "你教我这段值得在我们之间记稳")
    .replace(/[。！？.!?]+$/, "");
}

function sharedResponseText(response: string, scene: string) {
  const text = normalizeSharedMemoryText(stripSourceMetadata(response));
  if (text.length < 6) return "";
  if (scene.includes(text) || text.includes(scene)) return "";
  return summarizeText(text, 120);
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

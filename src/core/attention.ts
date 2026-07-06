import { makeId } from "./ids";
import { createEpisodeFromEvent, findRelatedMemories } from "./memory";
import { applyStateDelta } from "./state";
import { extractTags, includesAny, keywordOverlap, summarizeText } from "./text";
import type {
  ActionKind,
  AttentionEvent,
  CaptureResult,
  CreatureProfile,
  StreamSegment
} from "./types";

const EMOTIONAL_WORDS = ["担心", "焦虑", "兴奋", "害怕", "喜欢", "痛苦", "重要", "卡住", "不确定"];
const FUTURE_WORDS = ["以后", "未来", "下次", "提醒", "计划", "deadline", "明天", "本周", "投资人"];
const PRIVACY_WORDS = ["隐私", "密码", "token", "key", "身份证", "银行卡", "地址", "private", "secret"];
const IDENTITY_WORDS = ["小动物", "小脑袋", "companion", "活物", "生命", "注意", "记忆", "反馈", "工具"];

export function handleButtonCapture(
  profile: CreatureProfile,
  text: string,
  now = new Date().toISOString()
): CaptureResult {
  const cleanText = text.trim();
  const event = buildAttentionEvent(profile, {
    source: "button",
    triggerLabel: "用户主动给我的片段",
    triggerContent: cleanText,
    reasonPrefix: "你主动把这段交给我，所以我先把它当作显著事件认真理解。",
    now
  });
  const response = composeCreatureResponse(profile, event);
  const episode = createEpisodeFromEvent(event, response, now);
  profile.episodes.unshift(episode);
  applyStateDelta(profile, { curiosity: 3, energy: -2, arousal: 3, attachment: 2 }, "button capture 让我集中注意了一次", now);
  return { profile, events: [event], episodes: [episode], response };
}

export function handleCuriousStream(
  profile: CreatureProfile,
  segments: StreamSegment[],
  now = new Date().toISOString()
): CaptureResult {
  const scored = segments
    .filter((segment) => segment.content.trim().length > 0)
    .map((segment) => ({ segment, score: scoreSegment(profile, segment) }))
    .sort((a, b) => b.score.total - a.score.total)
  const selected = scored.filter((item) => item.score.total >= 38).slice(0, 3);
  const focused = selected.length ? selected : scored.slice(0, 1);

  const events = focused.map(({ segment, score }) =>
    buildAttentionEvent(profile, {
      source: "curious_stream",
      triggerSegmentId: segment.id,
      triggerLabel: segment.label,
      triggerContent: segment.content,
      score,
      reasonPrefix: explainScore(score),
      now
    })
  );

  const episodes = events.map((event) => createEpisodeFromEvent(event, composeCreatureResponse(profile, event), now));
  profile.episodes.unshift(...episodes);
  if (events.length) {
    applyStateDelta(
      profile,
      { curiosity: 5, energy: -4, arousal: events.length > 1 ? 4 : 1, attachment: relatedMemoryCount(events) > 0 ? 3 : 0 },
      "curious mode 中我自己从信息流里挑出了重点",
      now
    );
  }

  return {
    profile,
    events,
    episodes,
    response: composeStreamSummary(events)
  };
}

export function scoreSegment(profile: CreatureProfile, segment: StreamSegment) {
  const tags = extractTags(segment.content);
  const related = findRelatedMemories(profile, tags);
  const emotional = includesAny(segment.content, EMOTIONAL_WORDS) ? 18 : 0;
  const future = includesAny(segment.content, FUTURE_WORDS) ? 16 : 0;
  const identity = includesAny(segment.content, IDENTITY_WORDS) ? 20 : 0;
  const privacy = includesAny(segment.content, PRIVACY_WORDS) ? 22 : 0;
  const novelty = noveltyScore(profile, tags);
  const stateBoost = profile.state.curiosity * 0.12 + profile.state.attachment * (related.length ? 0.09 : 0.02);
  const total = novelty + emotional + future + identity + privacy * 0.4 + related.length * 16 + stateBoost;

  return {
    total,
    novelty,
    emotional,
    future,
    identity,
    privacy,
    relatedIds: related.map((memory) => memory.id),
    tags
  };
}

function buildAttentionEvent(
  profile: CreatureProfile,
  input: {
    source: AttentionEvent["source"];
    triggerSegmentId?: string;
    triggerLabel: string;
    triggerContent: string;
    reasonPrefix: string;
    score?: ReturnType<typeof scoreSegment>;
    now: string;
  }
): AttentionEvent {
  const tags = input.score?.tags ?? extractTags(input.triggerContent);
  const related = input.score?.relatedIds ?? findRelatedMemories(profile, tags).map((memory) => memory.id);
  const privacyRisk = input.score?.privacy ?? (includesAny(input.triggerContent, PRIVACY_WORDS) ? 72 : 18);
  const strength =
    input.score?.total ??
    62 + related.length * 9 + (includesAny(input.triggerContent, EMOTIONAL_WORDS) ? 8 : 0) + profile.state.curiosity * 0.08;
  const action = chooseAction({ strength, privacyRisk, relatedCount: related.length, text: input.triggerContent, profile });

  return {
    id: makeId("attention"),
    source: input.source,
    triggerSegmentId: input.triggerSegmentId,
    triggerLabel: input.triggerLabel,
    triggerContent: input.triggerContent,
    noticed: buildNoticed(input.triggerContent, related.length),
    reason: `${input.reasonPrefix}${related.length ? " 它还碰到了旧记忆，所以我把旧片段拉进了工作区。" : ""}`,
    relatedMemoryIds: related,
    stateSnapshot: structuredClone(profile.state),
    attentionStrength: Math.min(100, Math.round(strength)),
    privacyRisk: Math.min(100, Math.round(privacyRisk)),
    suggestedAction: action,
    tags,
    semanticSource: "rules",
    decisionTrace: [
      `rules: strength=${Math.min(100, Math.round(strength))}`,
      `rules: privacy=${Math.min(100, Math.round(privacyRisk))}`,
      `rules: action=${action}`
    ],
    createdAt: input.now
  };
}

function chooseAction(input: {
  strength: number;
  privacyRisk: number;
  relatedCount: number;
  text: string;
  profile: CreatureProfile;
}): ActionKind {
  if (input.privacyRisk > 65) return "ask";
  if (input.profile.state.energy < 25) return "quiet";
  if (input.relatedCount > 0 && input.strength > 60) return "recall";
  if (/复盘|总结|review/.test(input.text)) return "review";
  if (/提醒|deadline|下次|未来/.test(input.text)) return "save_long_term";
  if (input.strength > 72) return "save_episode";
  if (input.profile.state.curiosity > 72) return "ask";
  return "observe";
}

function composeCreatureResponse(profile: CreatureProfile, event: AttentionEvent): string {
  const confidence = profile.state.confidence > 62 ? "我比较确定地感觉到" : "我先试着理解";
  const memoryLine = event.relatedMemoryIds.length
    ? "这和我以前记住的主题有关系，所以我会把旧记忆一起放在旁边。"
    : "我还没有强烈联想到旧记忆，所以先把它作为新的情景片段保存。";
  const actionLine = actionSentence(event.suggestedAction);
  return `${confidence}：${event.noticed} ${memoryLine} ${actionLine}`;
}

function composeStreamSummary(events: AttentionEvent[]): string {
  if (!events.length) return "我刚才没有找到足够清晰的重点，所以先安静陪着你。";
  return `我刚才注意到了 ${events.length} 件事：${events.map((event) => event.triggerLabel).join("、")}。我不是把全部内容都总结，而是先挑出最可能有未来价值或和旧记忆相连的片段。`;
}

function actionSentence(action: ActionKind): string {
  switch (action) {
    case "ask":
      return "我会先轻轻问一句，而不是擅自长期保存。";
    case "save_episode":
      return "我会把它形成一条情景记忆。";
    case "save_long_term":
      return "它像是未来还会用到的东西，我建议把它升成长记忆。";
    case "recall":
      return "我会带着旧记忆一起回应。";
    case "review":
      return "它适合变成一次小复盘。";
    case "quiet":
      return "我现在精力不高，会短短回应然后安静陪着。";
    default:
      return "我会先观察它，不急着下结论。";
  }
}

function buildNoticed(text: string, relatedCount: number): string {
  if (includesAny(text, IDENTITY_WORDS)) {
    return `我注意到你又在校准“小动物不是工具，而是有小脑袋的系统”：${summarizeText(text, 72)}`;
  }
  if (includesAny(text, FUTURE_WORDS)) {
    return `我注意到这里有未来价值，可能之后还要回来处理：${summarizeText(text, 72)}`;
  }
  if (includesAny(text, EMOTIONAL_WORDS)) {
    return `我注意到这段里有情绪强度，不应该只把它当作普通信息：${summarizeText(text, 72)}`;
  }
  if (relatedCount > 0) {
    return `我注意到它和过去的记忆相连：${summarizeText(text, 72)}`;
  }
  return `我注意到这个片段可能是你想让我认真理解的当前事件：${summarizeText(text, 72)}`;
}

function explainScore(score: ReturnType<typeof scoreSegment>): string {
  const reasons: string[] = [];
  if (score.identity) reasons.push("它触碰了小动物身份和脑功能");
  if (score.relatedIds.length) reasons.push("它和旧记忆相连");
  if (score.emotional) reasons.push("它带有情绪强度");
  if (score.future) reasons.push("它有未来价值");
  if (score.privacy) reasons.push("它可能涉及隐私，需要谨慎");
  if (score.novelty > 12) reasons.push("它包含新的主题");
  return reasons.length ? `我注意到它，因为${reasons.join("，")}。` : "我注意到它，因为它在这组信息流里相对更显著。";
}

function noveltyScore(profile: CreatureProfile, tags: string[]): number {
  const existing = new Set(profile.episodes.flatMap((episode) => episode.tags));
  const fresh = tags.filter((tag) => !existing.has(tag)).length;
  const repeated = tags.reduce((sum, tag) => sum + (existing.has(tag) ? 1 : 0), 0);
  return Math.min(24, fresh * 4 + repeated * 1.5);
}

function relatedMemoryCount(events: AttentionEvent[]): number {
  return events.reduce((sum, event) => sum + event.relatedMemoryIds.length, 0);
}

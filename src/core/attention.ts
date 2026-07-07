import { selectAction } from "./action";
import { describeStateInfluence } from "./drive";
import { createAttentionExperience, createCuriousCreatureReport } from "./experience";
import { makeId } from "./ids";
import { createEpisodeFromEvent, createMemoryCandidateFromEpisode, findRelatedMemories } from "./memory";
import { applyStateDelta } from "./state";
import { extractTags, includesAny, keywordOverlap, summarizeText } from "./text";
import type {
  AttentionEvent,
  CaptureResult,
  CreatureProfile,
  CuriousSessionAudit,
  LongTermMemory,
  ScoreContribution,
  SegmentScore,
  StreamSegment
} from "./types";

const EMOTIONAL_WORDS = ["担心", "焦虑", "兴奋", "害怕", "喜欢", "痛苦", "重要", "卡住", "不确定"];
const FUTURE_WORDS = ["以后", "未来", "下次", "提醒", "计划", "deadline", "明天", "本周", "复查", "资料"];
const PRIVACY_WORDS = ["隐私", "密码", "token", "key", "身份证", "银行卡", "地址", "private", "secret"];
const IDENTITY_WORDS = ["小动物", "小脑袋", "companion", "活物", "生命", "注意", "记忆", "反馈", "工具"];
const COMMUNICATION_WORDS = ["说句话", "说话", "回复", "回答", "你在吗", "你好", "hello", "汪", "打招呼", "听见", "听到", "回应", "叫你"];

export function handleButtonCapture(
  profile: CreatureProfile,
  text: string,
  now = new Date().toISOString()
): CaptureResult {
  const cleanText = text.trim();
  const score = scoreSegment(profile, { id: "button", kind: "text", label: "用户主动给我的片段", content: cleanText });
  score.total = Math.max(score.total, 62);
  score.contributions.unshift({
    key: "state_bias",
    label: "button_intent",
    value: 18,
    reason: "这是一段主动输入，会直接进入理解、行动选择和情景记忆流程。"
  });

  const event = buildAttentionEvent(profile, {
    source: "button",
    triggerLabel: "用户主动给我的片段",
    triggerContent: cleanText,
    reasonPrefix: "你主动把这段交给我，所以我先理解你为什么让我看，而不是再判断它值不值得注意。",
    score,
    now
  });
  const response = composeCreatureResponse(profile, event);
  const episode = createEpisodeFromEvent(event, response, now);
  profile.episodes.unshift(episode);
  const candidate = createMemoryCandidateFromEpisode(profile, episode, { now });
  applyStateDelta(profile, { curiosity: 3, energy: -2, arousal: 3, attachment: 2 }, "button capture 让我集中注意了一次", now);
  return { profile, events: [event], episodes: [episode], response, memoryCandidates: [candidate] };
}

export function handleCuriousStream(
  profile: CreatureProfile,
  segments: StreamSegment[],
  now = new Date().toISOString()
): CaptureResult {
  const sessionId = makeId("session");
  const prepared = segments
    .map((segment, index) => ({
      ...segment,
      position: segment.position ?? index + 1,
      observedAt: segment.observedAt ?? now,
      content: contentWithObservationContext({ ...segment, observedAt: segment.observedAt ?? now })
    }))
    .filter((segment) => segment.content.trim().length > 0);

  const attentionBudget = deriveAttentionBudget(profile);
  const initialScores = prepared.map((segment) => ({
    segment,
    score: scoreSegment(profile, segment, { position: segment.position })
  }));

  const selected: Array<{ segment: StreamSegment; score: SegmentScore; whySelected: string }> = [];
  const ignored: Array<{ segment: StreamSegment; score: SegmentScore; whyIgnored: string }> = [];

  for (const item of initialScores.sort((a, b) => b.score.total - a.score.total)) {
    const adjusted = applyRedundancyPenalty(item.score, selected.map((entry) => entry.score.tags));
    if (selected.length < attentionBudget && adjusted.total >= 38) {
      selected.push({ segment: item.segment, score: adjusted, whySelected: explainSelected(adjusted) });
    } else {
      ignored.push({ segment: item.segment, score: adjusted, whyIgnored: explainIgnored(adjusted, selected.length, attentionBudget) });
    }
  }

  const focused = selected.length ? selected : initialScores.slice(0, 1).map((item) => ({
    segment: item.segment,
    score: item.score,
    whySelected: "整组信息都偏弱，我只保留相对最清晰的一段作为轻观察。"
  }));

  const events = focused.map(({ segment, score }) =>
    buildAttentionEvent(profile, {
      source: "curious_stream",
      triggerSegmentId: segment.id,
      triggerBatchId: segment.batchId,
      triggerObservedAt: segment.observedAt,
      triggerLocation: segment.location,
      triggerLabel: segment.label,
      triggerContent: segment.content,
      reasonPrefix: explainScore(score),
      score,
      now
    })
  );

  const episodes = events.map((event) => createEpisodeFromEvent(event, composeCreatureResponse(profile, event), now));
  const memoryCandidates = episodes.map((episode) => createMemoryCandidateFromEpisode(profile, episode, { now }));
  profile.episodes.unshift(...episodes);
  if (events.length) {
    applyStateDelta(
      profile,
      { curiosity: 5, energy: -4 - Math.max(0, events.length - 1), arousal: events.length > 1 ? 4 : 1, attachment: relatedMemoryCount(events) > 0 ? 3 : 0 },
      "curious mode 中我先整体扫描信息流，再挑出少数注意事件",
      now
    );
  }

  const curiousSession: CuriousSessionAudit = {
    id: sessionId,
    createdAt: now,
    totalSegments: prepared.length,
    selected: focused.map((item) => ({
      segmentId: item.segment.id,
      label: item.segment.label,
      score: item.score,
      whySelected: item.whySelected
    })),
    ignored: ignored.map((item) => ({
      segmentId: item.segment.id,
      label: item.segment.label,
      score: item.score,
      whyIgnored: item.whyIgnored
    })),
    stateInfluence: describeStateInfluence(profile),
    attentionBudget,
    creatureReport: ""
  };
  curiousSession.creatureReport = createCuriousCreatureReport(curiousSession);

  return {
    profile,
    events,
    episodes,
    response: composeStreamSummary(events, curiousSession),
    curiousSession,
    attentionCandidates: [
      ...focused.map((item) => ({ segment: item.segment, score: item.score, selectedByRules: true })),
      ...ignored.map((item) => ({ segment: item.segment, score: item.score, selectedByRules: false }))
    ],
    memoryCandidates
  };
}

export function scoreSegment(
  profile: CreatureProfile,
  segment: StreamSegment,
  context: { position?: number } = {}
): SegmentScore {
  const tags = extractTags(segment.content);
  const related = findRelatedMemories(profile, tags);
  const emotional = includesAny(segment.content, EMOTIONAL_WORDS) ? 18 : 0;
  const future = includesAny(segment.content, FUTURE_WORDS) ? 16 : 0;
  const identity = includesAny(segment.content, IDENTITY_WORDS) ? 20 : 0;
  const communication = includesAny(segment.content, COMMUNICATION_WORDS) ? 18 : 0;
  const privacy = includesAny(segment.content, PRIVACY_WORDS) ? 22 + profile.policyProfile.privacySensitivity * 0.18 : 0;
  const novelty = noveltyScore(profile, tags);
  const memoryResonance = related.length * 18;
  const stateBias = profile.state.curiosity * 0.12 + profile.state.attachment * (related.length ? 0.1 : 0.02);
  const fatiguePenalty = Math.max(0, (35 - profile.state.energy) * 0.35);
  const total = novelty + emotional + future + identity + communication + privacy * 0.35 + memoryResonance + stateBias - fatiguePenalty;

  const contributions: ScoreContribution[] = [
    { key: "novelty", label: "novelty", value: round(novelty), reason: novelty > 12 ? "出现较多新主题" : "新主题较少" },
    {
      key: "memory_resonance",
      label: "memory_resonance",
      value: round(memoryResonance),
      reason: related.length ? `关联到长期记忆 ${related.map((memory) => memory.id).join(", ")}` : "没有强旧记忆共振"
    },
    { key: "emotional_charge", label: "emotion", value: emotional, reason: emotional ? "出现担心/不确定等情绪词" : "情绪强度低" },
    { key: "future_value", label: "future_value", value: future, reason: future ? "包含未来/提醒/资料准备等未来价值线索" : "未来价值不明显" },
    { key: "identity_relevance", label: "identity", value: identity, reason: identity ? "触及小动物身份、活物感或脑功能" : "没有直接触及小动物身份" },
    { key: "communication_intent", label: "communication", value: communication, reason: communication ? "用户在直接呼唤我回应，不应该只做后台分析" : "没有直接要求回应" },
    { key: "privacy_risk", label: "privacy", value: round(privacy), reason: privacy ? "包含 key/token/地址等隐私风险词" : "未发现明显隐私风险" },
    { key: "state_bias", label: "state_bias", value: round(stateBias), reason: stateBias > 10 ? "当前状态提高注意倾向" : "状态偏向较弱" },
    { key: "fatigue_penalty", label: "fatigue", value: -round(fatiguePenalty), reason: fatiguePenalty ? "精力偏低，减少注意预算" : "精力足够" }
  ];

  return {
    total: round(total),
    novelty: round(novelty),
    memoryResonance: round(memoryResonance),
    emotionalCharge: emotional,
    futureValue: future,
    identityRelevance: identity,
    privacyRisk: round(privacy),
    stateBias: round(stateBias),
    redundancyPenalty: 0,
    fatiguePenalty: round(fatiguePenalty),
    relatedIds: related.map((memory) => memory.id),
    tags,
    contributions
  };
}

export function buildAttentionEvent(
  profile: CreatureProfile,
  input: {
    source: AttentionEvent["source"];
    triggerSegmentId?: string;
    triggerBatchId?: string;
    triggerObservedAt?: string;
    triggerLocation?: StreamSegment["location"];
    triggerLabel: string;
    triggerContent: string;
    reasonPrefix: string;
    score: SegmentScore;
    now: string;
  }
): AttentionEvent {
  const tags = input.score.tags.length ? input.score.tags : extractTags(input.triggerContent);
  const related = input.score.relatedIds.length ? input.score.relatedIds : findRelatedMemories(profile, tags).map((memory) => memory.id);
  const privacyRisk = includesAny(input.triggerContent, PRIVACY_WORDS) ? Math.max(72, input.score.privacyRisk) : (input.score.privacyRisk || 18);
  const strength = input.source === "button" ? Math.max(62, input.score.total) : input.score.total;
  const actionDecision = selectAction({
    profile,
    source: input.source,
    text: input.triggerContent,
    attentionStrength: strength,
    privacyRisk,
    relatedMemoryIds: related,
    score: input.score
  });
  const relatedMemories = related
    .map((id) => profile.longTermMemories.find((memory) => memory.id === id))
    .filter((memory): memory is LongTermMemory => Boolean(memory));

  return {
    id: makeId("attention"),
    source: input.source,
    triggerSegmentId: input.triggerSegmentId,
    triggerBatchId: input.triggerBatchId,
    triggerObservedAt: input.triggerObservedAt,
    triggerLocation: input.triggerLocation,
    triggerLabel: input.triggerLabel,
    triggerContent: input.triggerContent,
    noticed: buildNoticed(input.triggerContent, related.length),
    reason: `${input.reasonPrefix}${related.length ? " 它还碰到了旧记忆，所以我把旧片段拉进了工作区。" : ""}`,
    relatedMemoryIds: related,
    stateSnapshot: structuredClone(profile.state),
    attentionStrength: Math.min(100, Math.round(strength)),
    privacyRisk: Math.min(100, Math.round(privacyRisk)),
    suggestedAction: actionDecision.action,
    actionDecision,
    scoreBreakdown: input.score,
    creatureExperience: createAttentionExperience({
      profile,
      triggerContent: input.triggerContent,
      relatedMemories,
      score: input.score,
      action: actionDecision.action,
      privacyRisk
    }),
    tags,
    semanticSource: "rules",
    decisionTrace: [
      ...input.score.contributions.map((item) => `${item.label} ${item.value >= 0 ? "+" : ""}${item.value}: ${item.reason}`),
      `final_action: ${actionDecision.action} (${actionDecision.reason})`
    ],
    createdAt: input.now
  };
}

export function composeCreatureResponse(profile: CreatureProfile, event: AttentionEvent): string {
  if (event.actionDecision.action === "respond") {
    const memoryLine = event.relatedMemoryIds.length
      ? "这句话还碰到了我们以前的一点记忆，我会带着那段一起听。"
      : "我会把这次你叫我说话的小片段先记成一段情景记忆。";
    return `我在，听见了。${memoryLine}`;
  }
  const posture = profile.state.confidence > 62 ? "我比较稳地接住了这一小段" : "我先把这一小段轻轻抱住";
  const memoryLine = event.relatedMemoryIds.length
    ? "这一小段碰到我以前抱着的一点记忆，我会把旧片段和现在一起听。"
    : "这像一段新的共同经历，我会先把它放进情景里。";
  return `${posture}：${trimSentence(event.noticed)}。${memoryLine}${actionResponseLine(event.actionDecision.action)}`;
}

function actionResponseLine(action: AttentionEvent["actionDecision"]["action"]): string {
  switch (action) {
    case "ask":
      return "我想轻轻问一句，确认我有没有听对。";
    case "save_episode":
      return "我会先把它写成我们刚一起经历过的一小段。";
    case "save_long_term":
      return "我感觉它可能值得长久留下，但会等你的意思更清楚。";
    case "recall":
      return "我想把旧片段拉近一点，和现在这件事一起看。";
    case "review":
      return "我想陪你把它整理成一小段复盘。";
    case "quiet":
      return "我会先安静一点，只把重点抱住。";
    case "draft_reminder":
      return "我会先把它当成一张以后可能会回来的提醒草稿。";
    case "draft_question_list":
      return "我会先把里面没想完的地方拆成几个小问题。";
    case "observe":
    default:
      return "我先不急着打扰你，只继续看这一小段会不会变重要。";
  }
}

function composeStreamSummary(events: AttentionEvent[], session: CuriousSessionAudit): string {
  if (!events.length) return "我刚才没有找到足够清晰的重点，所以先安静陪着你。";
  const ignoredPrivacy = session.ignored.filter((item) => item.score.privacyRisk > 0).map((item) => item.label);
  const privacyLine = ignoredPrivacy.length ? ` ${ignoredPrivacy.join("、")} 因为隐私风险被压低或需要先问。` : "";
  return `我刚才扫过 ${session.totalSegments} 段，只注意到了 ${events.length} 件事：${events.map((event) => event.triggerLabel).join("、")}。${session.stateInfluence}${privacyLine}`;
}

function buildNoticed(text: string, relatedCount: number): string {
  if (includesAny(text, COMMUNICATION_WORDS)) {
    return `我听到你在叫我回应你：${summarizeText(text, 88)}`;
  }
  if (includesAny(text, IDENTITY_WORDS)) {
    return `我注意到你又在校准“小动物不是工具，而是有小脑袋的系统”：${summarizeText(text, 88)}`;
  }
  if (includesAny(text, FUTURE_WORDS)) {
    return `我注意到这里有未来价值，可能之后还要回来处理：${summarizeText(text, 88)}`;
  }
  if (includesAny(text, EMOTIONAL_WORDS)) {
    return `我注意到这段里有情绪强度，不应该只把它当作普通信息：${summarizeText(text, 88)}`;
  }
  if (relatedCount > 0) {
    return `我注意到这一小段和过去的记忆相连：${summarizeText(text, 88)}`;
  }
  return `我接住你刚递来的这一小段：${summarizeText(text, 88)}`;
}

function trimSentence(text: string) {
  return text.trim().replace(/[。！？.!?]+$/, "");
}

function contentWithObservationContext(segment: StreamSegment) {
  const details: string[] = [];
  if (segment.observedAt) {
    const label = segment.kind === "image_summary" ? "照片时间" : segment.kind === "audio_transcript" ? "音频片段时间" : "观察时间";
    details.push(`${label}：${segment.observedAt}`);
  }
  if (segment.batchId) details.push(`30秒批次：${segment.batchId}`);
  if (segment.location) {
    const accuracy = typeof segment.location.accuracy === "number" ? `，精度约 ${Math.round(segment.location.accuracy)} 米` : "";
    details.push(`观察地点：纬度 ${segment.location.latitude.toFixed(5)}，经度 ${segment.location.longitude.toFixed(5)}${accuracy}`);
  }
  return details.length ? `${segment.content.trim()}\n${details.join("\n")}` : segment.content;
}

function explainScore(score: SegmentScore): string {
  const strong = score.contributions.filter((item) => item.value >= 12 && item.key !== "privacy_risk");
  const reasons = strong.map((item) => item.reason);
  if (score.privacyRisk > 0) reasons.push("它可能涉及隐私，需要谨慎");
  if (score.redundancyPenalty > 0) reasons.push("它和已选片段有重复，所以被压低");
  return reasons.length ? `我注意到它，因为${reasons.join("，")}。` : "我注意到它，因为它在这组信息流里相对更显著。";
}

function explainSelected(score: SegmentScore) {
  const positives = score.contributions.filter((item) => item.value > 0).sort((a, b) => b.value - a.value).slice(0, 3);
  return `选中：${positives.map((item) => `${item.label} ${item.value >= 0 ? "+" : ""}${item.value}`).join("，")}，总分 ${score.total}。`;
}

function explainIgnored(score: SegmentScore, selectedCount: number, budget: number) {
  if (selectedCount >= budget) return `忽略：注意预算已满，当前最多处理 ${budget} 段。`;
  if (score.privacyRisk > 45) return "忽略/压低：隐私风险高，需要先问，不能自动长期保存。";
  if (score.redundancyPenalty > 0) return `忽略：和已注意片段重复，redundancy -${score.redundancyPenalty}。`;
  if (score.total < 38) return `忽略：总分 ${score.total} 未达到主动注意阈值。`;
  return "忽略：相比已选片段，未来价值或记忆共振较弱。";
}

function applyRedundancyPenalty(score: SegmentScore, selectedTags: string[][]): SegmentScore {
  const maxOverlap = Math.max(0, ...selectedTags.map((tags) => keywordOverlap(score.tags, tags)));
  if (!maxOverlap) return score;
  const penalty = Math.min(18, maxOverlap * 6);
  return {
    ...score,
    total: round(score.total - penalty),
    redundancyPenalty: penalty,
    contributions: [
      ...score.contributions,
      { key: "redundancy_penalty", label: "redundancy", value: -penalty, reason: "和已选 attention event 的主题重复" }
    ]
  };
}

function deriveAttentionBudget(profile: CreatureProfile) {
  if (profile.state.energy < 28 || profile.policyProfile.quietTendency > 70) return 1;
  if (profile.state.energy < 45) return 2;
  return 3;
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

function round(value: number): number {
  return Math.round(value);
}

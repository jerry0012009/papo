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
  const score = scoreSegment(profile, { id: "button", kind: "text", label: "你给我的话", content: cleanText });
  score.total = Math.max(score.total, 62);
  score.contributions.unshift({
    key: "state_bias",
    label: "button_intent",
    value: 18,
    reason: "你主动告诉我这件事，我会直接理解并回应。"
  });

  const event = buildAttentionEvent(profile, {
    source: "button",
    triggerLabel: "你给我的话",
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
    { key: "communication_intent", label: "communication", value: communication, reason: communication ? "你在直接叫我回应，我应该先回你" : "没有直接要求回应" },
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
    reason: `${input.reasonPrefix}${related.length ? " 这件事关联到以前的记忆，所以会一起考虑。" : ""}`,
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
    return event.relatedMemoryIds.length ? "我在，听见了。刚才这句话让我想起以前你说过的事。" : "我在，听见了。";
  }
  const line = outwardReactionLine(event.triggerContent, event.actionDecision.action, event.relatedMemoryIds.length > 0);
  const raised = raisedExternalLine(profile, event.actionDecision.action);
  const energy = profile.state.energy < 32 && event.actionDecision.action !== "ask" ? "我会少说一点，但我在听。" : "";
  return [line, raised, energy].filter(Boolean).join("");
}

function outwardReactionLine(text: string, action: AttentionEvent["actionDecision"]["action"], remembered: boolean): string {
  const rememberedLine = remembered ? "这也让我想起之前相关的事。" : "";
  if (hasMixedPreference(text)) return `我听见了。${rememberedLine}这里有你喜欢的部分，也有让你不舒服的部分。`;
  if (includesAny(text, EMOTIONAL_WORDS)) return `我听见了。${rememberedLine}听起来这件事让你有点在意。`;
  if (action === "quiet" || action === "observe") return `我听见了。${rememberedLine || "我先陪你听着。"}`;
  if (action === "review") return `我听见了。${rememberedLine}我们可以慢慢把这件事理清楚。`;
  if (action === "recall") return `我听见了。${rememberedLine}`;
  if (action === "draft_reminder") return `我听见了。${rememberedLine}这件事之后可能还要再看。`;
  if (action === "draft_question_list") return `我听见了。${rememberedLine}里面没想清的地方，我们可以一件件说。`;
  if (action === "save_long_term" || action === "save_episode") return `我听见了。${rememberedLine || "这件事我会放在心上。"}`;
  return rememberedLine ? `我听见了。${rememberedLine}` : "我听见了。你可以接着说。";
}

function raisedExternalLine(profile: CreatureProfile, action: AttentionEvent["actionDecision"]["action"]) {
  const policy = profile.policyProfile;
  if (policy.quietTendency >= 58 && ["ask", "quiet", "observe", "draft_reminder", "draft_question_list"].includes(action)) {
    return "我先不急着打扰你。";
  }
  if ((policy.preferDepth >= 65 || policy.recallTendency >= 65) && ["ask", "recall", "review", "save_episode", "observe", "draft_reminder", "draft_question_list"].includes(action)) {
    return "我会陪你继续多想一会儿。";
  }
  return "";
}

function hasMixedPreference(text: string) {
  return /喜欢/.test(text) && /不喜欢|讨厌|烦|太多|难受/.test(text);
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
    return `我听见你在校准我不该只是工具，而要会注意、记住和被你养成：${summarizeText(text, 88)}`;
  }
  if (includesAny(text, FUTURE_WORDS)) {
    return `我听见这件事之后可能还会回来：${summarizeText(text, 88)}`;
  }
  if (includesAny(text, EMOTIONAL_WORDS)) {
    return `我听见这里有一点情绪，不该把它当成背景声：${summarizeText(text, 88)}`;
  }
  if (relatedCount > 0) {
    return `我听见这件事和以前记住的内容连上了：${summarizeText(text, 88)}`;
  }
  return `我接住你刚告诉我的事：${summarizeText(text, 88)}`;
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
  const reasons = strong.map(creatureReasonForContribution);
  if (score.privacyRisk > 0) reasons.push("这里有一点隐私味道，我需要放轻");
  if (score.redundancyPenalty > 0) reasons.push("它和我刚盯住的小事太像了");
  return reasons.length ? `需要回应，因为${reasons.join("，")}。` : "需要回应，因为它比周围背景更像正在发生的事。";
}

function explainSelected(score: SegmentScore) {
  const positives = score.contributions.filter((item) => item.value > 0).sort((a, b) => b.value - a.value).slice(0, 3);
  const reasons = positives.map(creatureReasonForContribution);
  return reasons.length ? `需要回应，因为${reasons.join("，")}。` : "这段更像正在发生的事，需要先回应。";
}

function explainIgnored(score: SegmentScore, selectedCount: number, budget: number) {
  if (selectedCount >= budget) return `我先放过它，因为这一轮我只能认真盯住 ${budget} 段，不能假装全都记住。`;
  if (score.privacyRisk > 45) return "我先放轻它，因为这里有隐私味道，不能自己偷偷长期留下。";
  if (score.redundancyPenalty > 0) return "暂时略过，因为它和刚才已经回应过的内容太像了。";
  if (score.total < 38) return "暂时略过，因为它更像路过的背景声。";
  return "暂时略过，因为相比刚才回应过的内容，它还没有那么重要。";
}

function creatureReasonForContribution(item: ScoreContribution) {
  switch (item.key) {
    case "communication_intent":
      return "你像是在叫我回应你";
    case "memory_resonance":
      return "它关联到以前记住的事";
    case "emotional_charge":
      return "里面有担心、重要感或没放下的情绪";
    case "future_value":
      return "它以后可能还会回来找你";
    case "identity_relevance":
      return "它在影响我应该怎么长大";
    case "novelty":
      return "它比周围背景更新一点";
    case "state_bias":
      return "你主动告诉了我这件事";
    case "redundancy_penalty":
      return "它和刚才的小事有点重复";
    case "fatigue_penalty":
      return "我现在没有力气盯住太多东西";
    case "privacy_risk":
      return "这里有一点需要保护的边界";
    default:
      return item.reason;
  }
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

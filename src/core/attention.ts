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
    const memoryLine = event.relatedMemoryIds.length
      ? "这句话让我想起以前你说过的事，我会一起考虑。"
      : "你刚才是在叫我说话，我会先回应你。";
    return `我在，听见了。${memoryLine}${raisedResponseLine(profile, event.actionDecision.action)}`;
  }
  const posture = profile.state.confidence > 62 ? "我听见了" : "我先听你说完";
  const memoryLine = event.relatedMemoryIds.length
    ? "这件事让我想起以前相关的内容。"
    : "这件事我会先当作刚发生的对话来回应。";
  return `${posture}：${trimSentence(event.noticed)}。${memoryLine}${actionResponseLine(event.actionDecision.action)}${raisedResponseLine(profile, event.actionDecision.action)}`;
}

function actionResponseLine(action: AttentionEvent["actionDecision"]["action"]): string {
  switch (action) {
    case "ask":
      return "我想轻轻问一句，确认我有没有听对。";
    case "save_episode":
      return "我会记住这次发生了什么，等你之后再纠正我。";
    case "save_long_term":
      return "我感觉它可能值得长久留下，但会等你的意思更清楚。";
    case "recall":
      return "我会把以前相关的事一起考虑。";
    case "review":
      return "我可以陪你把这件事整理清楚。";
    case "quiet":
      return "我会先安静一点，不急着追问。";
    case "draft_reminder":
      return "我会记得这件事之后可能还要再看，但不会替你直接执行。";
    case "draft_question_list":
      return "我会先把里面没想明白的地方轻轻分开，等你要继续时再一起想。";
    case "observe":
    default:
      return "我先不急着打扰你。";
  }
}

function raisedResponseLine(profile: CreatureProfile, action: AttentionEvent["actionDecision"]["action"]) {
  const policy = profile.policyProfile;
  if (policy.quietTendency >= 58 && ["ask", "quiet", "observe", "draft_reminder", "draft_question_list"].includes(action)) {
    return "你这段时间把我教得更安静，所以我先轻轻记下，不急着打扰你。";
  }
  if ((policy.preferDepth >= 65 || policy.recallTendency >= 65) && ["ask", "recall", "review", "save_episode", "observe", "respond", "draft_reminder", "draft_question_list"].includes(action)) {
    return "你这段时间把我教得不要浅浅带过，所以我想继续多想一会儿。";
  }
  return "";
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
    return `我注意到这件事以后可能还会回来找你：${summarizeText(text, 88)}`;
  }
  if (includesAny(text, EMOTIONAL_WORDS)) {
    return `我注意到这段里有一点情绪，不适合被当成路过的背景声：${summarizeText(text, 88)}`;
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

import { selectAction } from "./action";
import { describeStateInfluence } from "./drive";
import { createAttentionExperience } from "./experience";
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
const HIGH_PRIVACY_PATTERN = /token|secret|密码|验证码|身份证|银行卡|api key|apikey|私钥|地址/i;
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
    reason: "manual input enters cognition pipeline"
  });

  const event = buildAttentionEvent(profile, {
    source: "button",
    triggerLabel: "你给我的话",
    triggerContent: cleanText,
    reasonPrefix: "manual_input_candidate",
    score,
    now
  });
  const response = "";
  const episode = createEpisodeFromEvent(event, response, now);
  profile.episodes.unshift(episode);
  const candidate = createMemoryCandidateFromEpisode(profile, episode, { now });
  applyStateDelta(profile, { curiosity: 3, energy: -2, arousal: 3, attachment: 2 }, "manual input processed as attention candidate", now);
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
    if (isHighPrivacySegmentContent(item.segment.content)) {
      ignored.push({ segment: item.segment, score: adjusted, whyIgnored: "privacy guardrail blocked automatic attention" });
    } else if (selected.length < attentionBudget && adjusted.total >= 38) {
      selected.push({ segment: item.segment, score: adjusted, whySelected: explainSelected(adjusted) });
    } else {
      ignored.push({ segment: item.segment, score: adjusted, whyIgnored: explainIgnored(adjusted, selected.length, attentionBudget) });
    }
  }

  const focused = selected.length
    ? selected
    : initialScores
        .filter((item) => !isHighPrivacySegmentContent(item.segment.content))
        .slice(0, 1)
        .map((item) => ({
          segment: item.segment,
          score: item.score,
          whySelected: "candidate retained for model review because no stronger non-private segment was available"
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

  const episodes = events.map((event) => createEpisodeFromEvent(event, "", now));
  const memoryCandidates = episodes.map((episode) => createMemoryCandidateFromEpisode(profile, episode, { now }));
  profile.episodes.unshift(...episodes);
  if (events.length) {
    applyStateDelta(
      profile,
      { curiosity: 5, energy: -4 - Math.max(0, events.length - 1), arousal: events.length > 1 ? 4 : 1, attachment: relatedMemoryCount(events) > 0 ? 3 : 0 },
      "curious stream processed as attention candidates",
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

  return {
    profile,
    events,
    episodes,
    response: "",
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
    { key: "novelty", label: "novelty", value: round(novelty), reason: novelty > 12 ? "rule feature: more unseen tags" : "rule feature: fewer unseen tags" },
    {
      key: "memory_resonance",
      label: "memory_resonance",
      value: round(memoryResonance),
      reason: related.length ? `rule feature: related memory ids ${related.map((memory) => memory.id).join(", ")}` : "rule feature: no related memory ids"
    },
    { key: "emotional_charge", label: "emotion", value: emotional, reason: emotional ? "rule feature: emotion keyword present" : "rule feature: emotion keyword absent" },
    { key: "future_value", label: "future_value", value: future, reason: future ? "rule feature: future keyword present" : "rule feature: future keyword absent" },
    { key: "identity_relevance", label: "identity", value: identity, reason: identity ? "rule feature: identity keyword present" : "rule feature: identity keyword absent" },
    { key: "communication_intent", label: "communication", value: communication, reason: communication ? "rule feature: communication keyword present" : "rule feature: communication keyword absent" },
    { key: "privacy_risk", label: "privacy", value: round(privacy), reason: privacy ? "rule feature: privacy keyword present" : "rule feature: privacy keyword absent" },
    { key: "state_bias", label: "state_bias", value: round(stateBias), reason: stateBias > 10 ? "rule feature: state bias raised score" : "rule feature: state bias low" },
    { key: "fatigue_penalty", label: "fatigue", value: -round(fatiguePenalty), reason: fatiguePenalty ? "rule feature: energy lowered attention budget" : "rule feature: energy did not lower score" }
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
    noticed: buildNoticed(input.triggerContent),
    reason: `${input.reasonPrefix}${related.length ? "; related_memory_candidate=true" : ""}`,
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
  void profile;
  void event;
  return "";
}

export function composeStreamSummary(events: AttentionEvent[], session: CuriousSessionAudit): string {
  void events;
  void session;
  return "";
}

function buildNoticed(text: string): string {
  return `candidate_input: ${summarizeText(text, 88)}`;
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

export function isHighPrivacySegmentContent(text: string) {
  return HIGH_PRIVACY_PATTERN.test(text);
}

function explainScore(score: SegmentScore): string {
  return `rule_candidate_score=${score.total}`;
}

function explainSelected(score: SegmentScore) {
  return `rule_candidate_selected score=${score.total}`;
}

function explainIgnored(score: SegmentScore, selectedCount: number, budget: number) {
  if (selectedCount >= budget) return "attention_budget_reached";
  if (score.privacyRisk > 45) return "privacy_guardrail";
  if (score.redundancyPenalty > 0) return "redundancy_penalty";
  if (score.total < 38) return "below_rule_candidate_threshold";
  return "lower_priority_candidate";
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
      { key: "redundancy_penalty", label: "redundancy", value: -penalty, reason: "rule feature: overlaps selected candidate tags" }
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

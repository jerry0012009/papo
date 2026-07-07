import { selectAction } from "./action";
import { describeStateInfluence } from "./drive";
import { makeId } from "./ids";
import { createEpisodeFromEvent, createMemoryCandidateFromEpisode } from "./memory";
import { hasHighPrivacyText } from "./privacy";
import { applyStateDelta } from "./state";
import { summarizeText } from "./text";
import type {
  AttentionEvent,
  CaptureResult,
  CreatureProfile,
  CuriousSessionAudit,
  ScoreContribution,
  SegmentScore,
  StreamSegment
} from "./types";

export function handleButtonCapture(
  profile: CreatureProfile,
  text: string,
  now = new Date().toISOString()
): CaptureResult {
  const cleanText = text.trim();
  const score = scoreSegment(profile, { id: "button", kind: "text", label: "你给我的话", content: cleanText });
  score.total = 72;
  score.contributions.unshift({
    key: "state_bias",
    label: "button_intent",
    value: 18,
    reason: "manual input enters model cognition pipeline"
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
  const intervalSegments = mergeSegmentsByInterval(prepared, now);
  const candidates = intervalSegments.map((segment) => ({
    segment,
    score: scoreSegment(profile, segment, { position: segment.position })
  }));

  const curiousSession: CuriousSessionAudit = {
    id: sessionId,
    createdAt: now,
    totalSegments: prepared.length,
    selected: [],
    ignored: candidates.map((item) => ({
      segmentId: item.segment.id,
      label: item.segment.label,
      score: item.score,
      whyIgnored: ""
    })),
    stateInfluence: describeStateInfluence(profile),
    attentionBudget,
    creatureReport: ""
  };

  return {
    profile,
    events: [],
    episodes: [],
    response: "",
    curiousSession,
    attentionCandidates: candidates.map((item) => ({ segment: item.segment, score: item.score, selectedByModel: false })),
    memoryCandidates: []
  };
}

export function scoreSegment(
  profile: CreatureProfile,
  segment: StreamSegment,
  context: { position?: number } = {}
): SegmentScore {
  void context;
  const tags: string[] = [];
  const related: string[] = [];
  const privacy = hasHighPrivacyText(segment.content) ? 92 : 0;
  const stateBias = profile.state.curiosity * 0.08 + profile.state.attachment * 0.02;
  const fatiguePenalty = Math.max(0, (35 - profile.state.energy) * 0.35);
  const total = Math.max(1, 40 + stateBias - fatiguePenalty);

  const contributions: ScoreContribution[] = [
    { key: "state_bias", label: "state_bias", value: round(stateBias), reason: "state contributes only to pacing, not semantic meaning" },
    { key: "fatigue_penalty", label: "fatigue", value: -round(fatiguePenalty), reason: fatiguePenalty ? "energy guardrail lowers pacing" : "energy guardrail unchanged" }
  ];

  return {
    total: round(total),
    novelty: 0,
    memoryResonance: 0,
    emotionalCharge: 0,
    futureValue: 0,
    identityRelevance: 0,
    privacyRisk: round(privacy),
    stateBias: round(stateBias),
    redundancyPenalty: 0,
    fatiguePenalty: round(fatiguePenalty),
    relatedIds: related,
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
  const tags = input.score.tags;
  const related = input.score.relatedIds;
  const privacyRisk = hasHighPrivacyText(input.triggerContent) ? 92 : 0;
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
    reason: input.reasonPrefix,
    relatedMemoryIds: related,
    stateSnapshot: structuredClone(profile.state),
    attentionStrength: Math.min(100, Math.round(strength)),
    privacyRisk: Math.min(100, Math.round(privacyRisk)),
    suggestedAction: actionDecision.action,
    actionDecision,
    scoreBreakdown: input.score,
    creatureExperience: {
      earReason: "",
      actionFeeling: "",
      saveFeeling: ""
    },
    tags,
    semanticSource: "rules",
    decisionTrace: [
      ...input.score.contributions.map((item) => `${item.label} ${item.value >= 0 ? "+" : ""}${item.value}: ${item.reason}`),
      `final_action: ${actionDecision.action} (${actionDecision.reason})`
    ],
    createdAt: input.now
  };
}

function buildNoticed(text: string): string {
  return `candidate_input: ${summarizeText(text, 88)}`;
}

function mergeSegmentsByInterval(segments: StreamSegment[], now: string): StreamSegment[] {
  const groups = new Map<string, StreamSegment[]>();
  for (const segment of segments) {
    const key = segment.batchId ?? segment.id;
    groups.set(key, [...(groups.get(key) ?? []), segment]);
  }

  return [...groups.entries()].map(([batchId, items], index) => {
    if (items.length === 1) return items[0];
    const first = items[0];
    return {
      id: `interval-${batchId}`,
      kind: "text",
      label: "这 30 秒",
      content: items.map((item) => `${item.label}：${item.content.trim()}`).join("\n"),
      position: index + 1,
      observedAt: first.observedAt ?? now,
      batchId,
      location: items.find((item) => item.location)?.location
    };
  });
}

function contentWithObservationContext(segment: StreamSegment) {
  const details: string[] = [];
  if (segment.observedAt) {
    const label = segment.kind === "image_summary" ? "照片时间" : segment.kind === "audio_observation" ? "音频片段时间" : "观察时间";
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
  return hasHighPrivacyText(text);
}

function deriveAttentionBudget(profile: CreatureProfile) {
  if (profile.state.energy < 28 || profile.policyProfile.quietTendency > 70) return 1;
  if (profile.state.energy < 45) return 2;
  return 3;
}

function round(value: number): number {
  return Math.round(value);
}

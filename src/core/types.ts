export type AttentionSource = "button" | "curious_stream";
export type ActionKind =
  | "observe"
  | "ask"
  | "save_episode"
  | "save_long_term"
  | "recall"
  | "review"
  | "quiet"
  | "draft_reminder"
  | "draft_question_list";

export type FeedbackKind = "understood" | "continue" | "not_now" | "remember" | "forget";
export type SegmentKind = "text" | "image_summary" | "audio_transcript";
export type ProviderKind = "mimo" | "openrouter" | "generic" | "fallback";
export type ConversationChannel = "wake" | "button" | "curious" | "feedback" | "emergence";

export interface CreatureState {
  curiosity: number;
  attachment: number;
  energy: number;
  arousal: number;
  safety: number;
  confidence: number;
  mood: "curious" | "calm" | "attached" | "careful" | "tired" | "bright";
}

export interface FeedbackPolicyProfile {
  preferDepth: number;
  preferProactivity: number;
  privacySensitivity: number;
  saveThreshold: number;
  askThreshold: number;
  recallTendency: number;
  quietTendency: number;
}

export interface StateChange {
  at: string;
  reason: string;
  before: CreatureState;
  after: CreatureState;
}

export interface StreamSegment {
  id: string;
  kind: SegmentKind;
  label: string;
  content: string;
  position?: number;
  observedAt?: string;
}

export interface ScoreContribution {
  key:
    | "novelty"
    | "memory_resonance"
    | "emotional_charge"
    | "future_value"
    | "identity_relevance"
    | "privacy_risk"
    | "state_bias"
    | "redundancy_penalty"
    | "fatigue_penalty";
  label: string;
  value: number;
  reason: string;
}

export interface SegmentScore {
  total: number;
  novelty: number;
  memoryResonance: number;
  emotionalCharge: number;
  futureValue: number;
  identityRelevance: number;
  privacyRisk: number;
  stateBias: number;
  redundancyPenalty: number;
  fatiguePenalty: number;
  relatedIds: string[];
  tags: string[];
  contributions: ScoreContribution[];
}

export interface ActionDecision {
  action: ActionKind;
  confidence: number;
  reason: string;
  blockedActions: Array<{ action: ActionKind; reason: string }>;
  safetyNotes: string[];
  llmSuggestedAction?: ActionKind;
  ruleTrace: string[];
}

export interface CreatureExperience {
  earReason: string;
  rememberedScene?: string;
  actionFeeling: string;
  saveFeeling: string;
  learnedHint?: string;
}

export interface CuriousSessionAudit {
  id: string;
  createdAt: string;
  totalSegments: number;
  selected: Array<{
    segmentId: string;
    label: string;
    score: SegmentScore;
    whySelected: string;
  }>;
  ignored: Array<{
    segmentId: string;
    label: string;
    score: SegmentScore;
    whyIgnored: string;
  }>;
  stateInfluence: string;
  attentionBudget: number;
  creatureReport: string;
}

export interface AttentionEvent {
  id: string;
  source: AttentionSource;
  triggerSegmentId?: string;
  triggerLabel: string;
  triggerContent: string;
  noticed: string;
  reason: string;
  relatedMemoryIds: string[];
  stateSnapshot: CreatureState;
  attentionStrength: number;
  privacyRisk: number;
  suggestedAction: ActionKind;
  actionDecision: ActionDecision;
  scoreBreakdown?: SegmentScore;
  creatureExperience: CreatureExperience;
  tags: string[];
  semanticSource: "rules" | "llm" | "fallback";
  decisionTrace?: string[];
  createdAt: string;
}

export interface EpisodeMemory {
  id: string;
  createdAt: string;
  source: AttentionSource;
  inputSummary: string;
  noticed: string;
  possibleIntent: string;
  importanceReason: string;
  relatedMemoryIds: string[];
  stateSnapshot: CreatureState;
  creatureResponse: string;
  feedback: FeedbackKind[];
  promotedToLongTerm: boolean;
  memoryCandidateIds: string[];
  actionDecision?: ActionDecision;
  creatureExperience?: CreatureExperience;
  weight: number;
  tags: string[];
  decisionTrace?: string[];
}

export interface LongTermMemory {
  id: string;
  createdAt: string;
  kind:
    | "user_preference"
    | "long_theme"
    | "creature_self_memory"
    | "safety_rule"
    | "future_review"
    | "relationship"
    | "habit"
    | "open_question";
  text: string;
  sourceEpisodeId?: string;
  consolidatedBecause?: string;
  weight: number;
  tags: string[];
  lastReferencedAt?: string;
}

export interface MemoryCandidate {
  id: string;
  createdAt: string;
  candidateText: string;
  memoryKind: LongTermMemory["kind"];
  confidence: number;
  sourceEpisodeId: string;
  whyConsolidate: string;
  writePolicy: "auto" | "ask_user" | "wait_feedback" | "do_not_save";
  privacyReason?: string;
  decayPolicy: "stable" | "decay_without_feedback" | "forget_if_dismissed";
  status: "candidate" | "promoted" | "dismissed";
  tags: string[];
}

export interface FeedbackRecord {
  id: string;
  at: string;
  kind: FeedbackKind;
  targetId?: string;
  effect: string;
  learningNote: string;
}

export interface WakeEvent {
  id: string;
  at: string;
  elapsedMinutes: number;
  message: string;
  innerThought?: string;
  relatedMemoryIds: string[];
  emergenceId?: string;
  stateChangeReason: string;
  stateDelta: Partial<Record<keyof Omit<CreatureState, "mood">, number>>;
  ruleTrace: string[];
}

export interface SemanticBrainRecord {
  id: string;
  at: string;
  source: AttentionSource;
  providerKind: ProviderKind;
  providerName: string;
  status: "skipped" | "applied" | "empty" | "invalid" | "failed";
  message: string;
  ruleTrace: string[];
}

export interface CreatureMessage {
  id: string;
  at: string;
  role: "papo";
  channel: ConversationChannel;
  text: string;
  sourceId?: string;
  relatedMemoryIds: string[];
}

export interface CreatureProfile {
  userId: string;
  creatureName: string;
  createdAt: string;
  lastSeenAt: string;
  state: CreatureState;
  episodes: EpisodeMemory[];
  longTermMemories: LongTermMemory[];
  feedbackHistory: FeedbackRecord[];
  stateChanges: StateChange[];
  policyProfile: FeedbackPolicyProfile;
  memoryCandidates: MemoryCandidate[];
  emergenceHistory: EmergenceRecord[];
  wakeHistory: WakeEvent[];
  semanticBrainHistory: SemanticBrainRecord[];
  conversation: CreatureMessage[];
}

export interface EmergenceRecord {
  id: string;
  at: string;
  kind: "memory_resonance" | "drive_based" | "rhythm";
  whyNow: string;
  relatedMemoryIds: string[];
  driveSource: string;
  message: string;
  ruleTrace: string[];
}

export interface CaptureResult {
  profile: CreatureProfile;
  events: AttentionEvent[];
  episodes: EpisodeMemory[];
  response: string;
  harnessTrace?: string[];
  curiousSession?: CuriousSessionAudit;
  memoryCandidates?: MemoryCandidate[];
}

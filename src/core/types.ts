export type AttentionSource = "button" | "curious_stream";
export type ActionKind =
  | "observe"
  | "respond"
  | "ask"
  | "save_episode"
  | "save_long_term"
  | "recall"
  | "review"
  | "quiet"
  | "draft_reminder"
  | "draft_question_list";

export interface ActionResult {
  kind: "none" | "visible_reply" | "memory_intent" | "reminder_draft" | "question_list_draft";
  title?: string;
  text?: string;
  dueText?: string;
  items?: string[];
}

export type FeedbackKind = "understood" | "continue" | "not_now" | "remember" | "important" | "remind" | "correct" | "forget";
export type FeedbackResponseAction = "acknowledge" | "ask_follow_up" | "quiet" | "note_memory";
export type SegmentKind = "text" | "image_summary" | "audio_observation";
export type ProviderKind = "mimo" | "openrouter" | "generic";
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
  batchId?: string;
  location?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
    label?: string;
  };
}

export interface SegmentScore {
  total: number;
  privacyRisk: number;
  stateBias: number;
  fatiguePenalty: number;
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
  triggerBatchId?: string;
  triggerObservedAt?: string;
  triggerLocation?: StreamSegment["location"];
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
  actionResult?: ActionResult;
  scoreBreakdown?: SegmentScore;
  creatureExperience: CreatureExperience;
  tags: string[];
  semanticSource: "rules" | "llm";
  decisionTrace?: string[];
  createdAt: string;
}

export interface EpisodeMemory {
  id: string;
  createdAt: string;
  source: AttentionSource;
  sourceSegmentId?: string;
  sourceBatchId?: string;
  sourceObservedAt?: string;
  sourceLocation?: StreamSegment["location"];
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
  actionResult?: ActionResult;
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
  inputText?: string;
  inputModality?: SegmentKind | "button";
  effect: string;
  learningNote: string;
  responseAction?: FeedbackResponseAction;
  followUpText?: string;
  replyText?: string;
  memoryCandidateIds?: string[];
  stateDeltas?: Array<{
    key: keyof Omit<CreatureState, "mood">;
    before: number;
    after: number;
    delta: number;
  }>;
  policyDeltas?: Array<{
    key: keyof FeedbackPolicyProfile;
    before: number;
    after: number;
    delta: number;
  }>;
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
  source: AttentionSource | "memory" | "feedback" | "emergence";
  stage?: "attention" | "action" | "memory" | "feedback" | "emergence" | "harness";
  providerKind: ProviderKind;
  providerName: string;
  model?: string;
  status: "skipped" | "applied" | "empty" | "invalid" | "failed";
  message: string;
  ruleTrace: string[];
}

export interface MessageCognitionTrace {
  at: string;
  source: SemanticBrainRecord["source"];
  providerKind: ProviderKind;
  providerName: string;
  model?: string;
  modelRuns: SemanticBrainRecord[];
  harnessTrace?: string[];
  eventDecisions?: Array<{
    eventId: string;
    sourceLabel: string;
    sourceText: string;
    action: ActionKind;
    semanticSource: "rules" | "llm";
    noticed: string;
    reason: string;
    visibleReply?: string;
    actionResult?: ActionResult;
    episodeKept: boolean;
    memoryCandidateKept: boolean;
    relatedMemoryIds: string[];
    decisionTrace: string[];
  }>;
  episodeDecisions?: Array<{
    episodeId: string;
    action?: ActionKind;
    kept: boolean;
    memoryCandidateIds: string[];
    decisionTrace: string[];
  }>;
  memoryDecisions?: Array<{
    candidateId: string;
    sourceEpisodeId: string;
    status: MemoryCandidate["status"];
    writePolicy: MemoryCandidate["writePolicy"];
    memoryKind: LongTermMemory["kind"];
    text: string;
    why: string;
  }>;
  feedbackDecision?: {
    feedbackId: string;
    kind: FeedbackKind;
    targetId?: string;
    inputText?: string;
    effect: string;
    learningNote: string;
    responseAction?: FeedbackResponseAction;
    replyText?: string;
    memoryCandidateIds: string[];
    memoryChanges: Array<{
      targetId: string;
      targetType: "memory" | "episode";
      operation: "updated" | "purged" | "unchanged";
      beforeText?: string;
      afterText?: string;
      beforeKind?: LongTermMemory["kind"];
      afterKind?: LongTermMemory["kind"];
      beforeWeight?: number;
      afterWeight?: number;
    }>;
    stateDeltas: NonNullable<FeedbackRecord["stateDeltas"]>;
    policyDeltas: NonNullable<FeedbackRecord["policyDeltas"]>;
  };
  emergenceDecision?: {
    emergenceId: string;
    kind: EmergenceRecord["kind"];
    shouldEmerge: boolean;
    driveSource: string;
    whyNow: string;
    message: string;
    memoryId?: string;
    proactiveLevel?: string;
    relatedMemoryIds: string[];
    ruleTrace: string[];
  };
}

export interface CreatureMessage {
  id: string;
  at: string;
  role: "user" | "world" | "papo";
  channel: ConversationChannel;
  text: string;
  sourceId?: string;
  relatedMemoryIds: string[];
  modality?: SegmentKind | "button";
  batchId?: string;
  observedAt?: string;
  location?: StreamSegment["location"];
  cognitionTrace?: MessageCognitionTrace;
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
  proactiveLevel?: "quiet" | "gentle" | "active";
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
  attentionCandidates?: Array<{
    segment: StreamSegment;
    score: SegmentScore;
    selectedByModel: boolean;
  }>;
  memoryCandidates?: MemoryCandidate[];
}

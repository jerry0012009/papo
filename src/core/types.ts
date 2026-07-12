export type AttentionSource = "button" | "curious_stream";
export type CognitionInputSource = "direct" | "ambient" | "task_result";
export interface CognitionContext {
  inputSource: CognitionInputSource;
  taskId?: string;
  sourceEventId?: string;
  sourceEpisodeId?: string;
  companion?: {
    sessionId: string;
    currentEventId?: string;
    currentContext: string;
    recentUserNotes: string[];
    recentObservationSummaries: string[];
  };
}
export type ActionKind =
  | "observe"
  | "respond"
  | "acknowledge"
  | "listen_silently"
  | "continue_own_activity"
  | "defer"
  | "ask"
  | "save_episode"
  | "save_long_term"
  | "recall"
  | "review"
  | "quiet"
  | "draft_reminder"
  | "draft_question_list"
  | "use_hermes"
  | "generate_illustration"
  | "generate_action_card"
  | "update_pet_profile";

export interface ActionResult {
  kind: "none" | "visible_reply" | "memory_intent" | "reminder_draft" | "question_list_draft" | "hermes_task" | "illustration_draft" | "illustration" | "action_card_draft" | "action_card" | "pet_profile_update";
  title?: string;
  text?: string;
  dueText?: string;
  items?: string[];
  hermesTaskId?: string;
  prompt?: string;
  caption?: string;
  style?: string;
  sourceIds?: string[];
  plan?: IllustrationPlan;
  attachment?: MediaAttachment;
  videoAttachment?: MediaAttachment;
  durationSeconds?: number;
  petProfile?: Partial<PetIdentityProfile>;
}

export interface PlannedAction {
  action: ActionKind;
  actionResult: ActionResult;
  reason?: string;
}

export interface IllustrationPlan {
  summary: string;
  elements: string[];
  panels: Array<{
    title: string;
    scene: string;
    sourceIds?: string[];
  }>;
  realityMix: string;
  finalPrompt: string;
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

export interface DogInteractionState {
  id: string;
  selectedAt: string;
  label: string;
  actionText: string;
  visualPrompt: string;
  animation: "idle" | "wag" | "bounce" | "sniff" | "nap" | "stretch" | "play" | "listen" | "peek" | "sun";
  reason: string;
  nextCheckAt: string;
  selectedBy: "seed" | "llm" | "touch";
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

export interface DreamRecord {
  id: string;
  at: string;
  summary: string;
  operations: Array<{
    type: "update_memory" | "merge_memories" | "dismiss_candidate" | "promote_candidate" | "adjust_state";
    targetId?: string;
    sourceIds?: string[];
    text?: string;
    reason: string;
  }>;
  stateDeltas?: CreatureStateDeltaRecord[];
  ruleTrace: string[];
}

export interface StreamSegment {
  id: string;
  kind: SegmentKind;
  label: string;
  content: string;
  auditOnly?: boolean;
  position?: number;
  observedAt?: string;
  batchId?: string;
  companionSessionId?: string;
  location?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
    label?: string;
  };
  attachments?: MediaAttachment[];
  sensingTrace?: SensingTrace;
}

export interface MediaAttachment {
  id: string;
  kind: "image" | "video" | "audio";
  label: string;
  mime: "image/png" | "image/jpeg" | "image/webp" | "video/mp4" | "audio/webm" | "audio/wav" | "audio/mpeg" | "audio/mp4" | "audio/ogg" | "audio/aac";
  url: string;
  createdAt: string;
  observedAt?: string;
  location?: StreamSegment["location"];
  sizeBytes?: number;
  generatedBy?: "user_upload" | "papo_illustration" | "papo_action_card" | "papo_profile" | "papo_memory";
  prompt?: string;
  sourceIds?: string[];
  turnId?: string;
  jobId?: string;
}

export interface PetIdentityProfile {
  updatedAt: string;
  source: "registration" | "profile_editor" | "conversation";
  displaySpecies: string;
  appearance: string;
  personality: string;
  habits: string;
  visualStyle: string;
  imagePrompt: string;
  motionStyle: string;
  userGuidance?: string;
  referenceImage?: MediaAttachment;
  avatarImage?: MediaAttachment;
  initialMotion?: {
    status: "idle" | "pending" | "ready" | "failed";
    requestedAt?: string;
    completedAt?: string;
    pendingCount?: number;
    error?: string;
  };
  model?: string;
}

export interface SensingTrace {
  at: string;
  modality: "audio" | "image";
  label: string;
  provider: string;
  model?: string;
  route?: string;
  semanticSource: "llm";
  status: "content" | "empty" | "unreadable";
  decision: string;
  observation?: string;
  audioContent?: AudioSensingContent;
  attempts?: number;
  errorKind?: "unreadable" | "empty" | "provider_error" | "decode_error";
  retainedAudio?: {
    id: string;
    mime: string;
    sizeBytes: number;
    retainedUntil: string;
  };
  ruleTrace: string[];
}

export type AudioSceneType = "environment" | "conversation" | "lecture" | "meeting" | "interview" | "unknown";
export type SpeakerNameSource = "unknown" | "user_statement" | "self_introduction" | "reliable_context";

export interface SpeakerIdentityEvidence {
  speakerId: `speaker_${number}`;
  displayName?: string;
  nameSource: SpeakerNameSource;
  confidence: number;
  evidence?: string;
  sourceSegmentIds: string[];
}

export interface AudioSensingContent {
  sceneType: AudioSceneType;
  transcript: string;
  environmentObservation?: string;
  speakers: SpeakerIdentityEvidence[];
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

export type CreatureStateDeltaRecord = {
  key: keyof Omit<CreatureState, "mood">;
  before: number;
  after: number;
  delta: number;
};

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
  cognitionSource?: CognitionInputSource;
  addressedToPapo?: boolean;
  expectsResponse?: boolean;
  sourceTaskId?: string;
  sourceEventId?: string;
  sourceEpisodeId?: string;
  triggerSegmentId?: string;
  triggerBatchId?: string;
  triggerObservedAt?: string;
  triggerLocation?: StreamSegment["location"];
  attachments?: MediaAttachment[];
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
  backgroundActions?: PlannedAction[];
  actionStateDeltas?: CreatureStateDeltaRecord[];
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
  cognitionSource?: CognitionInputSource;
  sourceTaskId?: string;
  parentEventId?: string;
  parentEpisodeId?: string;
  sourceSegmentId?: string;
  sourceBatchId?: string;
  sourceObservedAt?: string;
  sourceLocation?: StreamSegment["location"];
  attachments?: MediaAttachment[];
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
  shortTitle?: string;
  narrative?: string;
  visual?: MediaAttachment;
  visualPrompt?: string;
  visualUpdatedAt?: string;
  visualStatus?: "pending" | "ready" | "failed" | "not_needed";
  visualError?: string;
  visualMode?: "grounded_scene" | "imaginative_illustration" | "symbolic_cover" | "no_visual";
  papoPresence?: "required" | "optional" | "absent";
  visualPlanReason?: string;
  visualPolicyVersion?: number;
  sourceEpisodeId?: string;
  consolidatedBecause?: string;
  weight: number;
  tags: string[];
  attachments?: MediaAttachment[];
  lastReferencedAt?: string;
  contentRevision?: number;
  contentFingerprint?: string;
  enrichedRevision?: number;
  enrichmentStatus?: "pending" | "completed" | "failed";
  enrichmentError?: string;
}

export interface MemoryCandidate {
  id: string;
  createdAt: string;
  candidateText: string;
  shortTitle?: string;
  memoryKind: LongTermMemory["kind"];
  confidence: number;
  sourceEpisodeId: string;
  whyConsolidate: string;
  writePolicy: "auto" | "ask_user" | "wait_feedback" | "do_not_save";
  privacyReason?: string;
  decayPolicy: "stable" | "decay_without_feedback" | "forget_if_dismissed";
  status: "candidate" | "promoted" | "dismissed";
  tags: string[];
  attachments?: MediaAttachment[];
}

export interface FeedbackTargetSnapshot {
  id: string;
  type: "memory" | "episode" | "candidate";
  text?: string;
  kind?: LongTermMemory["kind"];
  weight?: number;
  status?: MemoryCandidate["status"];
  sourceEpisodeId?: string;
  tags?: string[];
  attachments?: MediaAttachment[];
}

export interface ReadState {
  lastReadPapoMessageId?: string;
  lastReadAt?: string;
}

export interface HermesTaskRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: "pending" | "sent" | "completed" | "timeout" | "failed";
  task: string;
  title?: string;
  channelId?: string;
  channelName?: string;
  sessionId?: string;
  sessionName?: string;
  sentMessageId?: string;
  sourceEventId?: string;
  sourceEpisodeId?: string;
  sourceMessageId?: string;
  resultMessageId?: string;
  resultEpisodeId?: string;
  resultText?: string;
  error?: string;
}

export interface HermesProfileState {
  channelId?: string;
  channelName?: string;
  sessionId?: string;
  sessionName?: string;
  tasks: HermesTaskRecord[];
}

export interface IllustrationRecord {
  id: string;
  createdAt: string;
  kind: "action" | "evening_diary";
  title: string;
  caption?: string;
  prompt: string;
  style?: string;
  plan?: IllustrationPlan;
  attachment: MediaAttachment;
  sourceIds: string[];
  messageId?: string;
  emergenceId?: string;
  actionEventId?: string;
  turnId?: string;
  jobId?: string;
  providerKind: ProviderKind;
  providerName: string;
  model?: string;
}

export interface ActionCardRecord {
  id: string;
  createdAt: string;
  title: string;
  caption?: string;
  prompt: string;
  style?: string;
  durationSeconds: number;
  cover?: MediaAttachment;
  video: MediaAttachment;
  sourceIds: string[];
  messageId?: string;
  emergenceId?: string;
  actionEventId?: string;
  turnId?: string;
  jobId?: string;
  providerKind: ProviderKind;
  providerName: string;
  model?: string;
  disabled?: boolean;
  deleted?: boolean;
}

export type ClientDimension =
  | "identity"
  | "personality"
  | "family"
  | "growth"
  | "leisure"
  | "values"
  | "health"
  | "work"
  | "environment"
  | "community"
  | "family_relationships"
  | "intimate_relationships"
  | "social_relationships";

export interface ClientFact {
  id: string;
  dimension: ClientDimension;
  text: string;
  confidence: number;
  sourceIds: string[];
  updatedAt: string;
}

export interface ClientDocument {
  preferredName?: string;
  preferredNameSourceIds?: string[];
  facts: ClientFact[];
  markdown: string;
  updatedAt: string;
  revision: number;
}

export interface FeedbackRecord {
  id: string;
  at: string;
  kind: FeedbackKind;
  targetId?: string;
  targetSnapshot?: FeedbackTargetSnapshot;
  inputText?: string;
  inputModality?: SegmentKind | "button";
  effect: string;
  learningNote: string;
  responseAction?: FeedbackResponseAction;
  followUpText?: string;
  replyText?: string;
  memoryCandidateIds?: string[];
  stateDeltas?: CreatureStateDeltaRecord[];
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
  source: AttentionSource | "memory" | "feedback" | "emergence" | "dreaming" | "dog_state" | "companion_session";
  stage?: "attention" | "action" | "memory" | "feedback" | "emergence" | "dreaming" | "harness" | "dog_state";
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
  sensingTraces?: SensingTrace[];
  modelRuns: SemanticBrainRecord[];
  harnessTrace?: string[];
  attentionDecision?: {
    attentionBudget: number;
    selected: CuriousSessionAudit["selected"];
    ignored: CuriousSessionAudit["ignored"];
    creatureReport: string;
  };
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
    backgroundActions?: PlannedAction[];
    stateDeltas?: CreatureStateDeltaRecord[];
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
      targetType: "memory" | "episode" | "candidate";
      operation: "created" | "updated" | "purged" | "unchanged";
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
    actionResult?: ActionResult;
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
  displayText?: string;
  auditOnly?: boolean;
  sourceId?: string;
  turnId?: string;
  jobId?: string;
  requestId?: string;
  relatedMemoryIds: string[];
  modality?: SegmentKind | "button";
  batchId?: string;
  observedAt?: string;
  location?: StreamSegment["location"];
  attachments?: MediaAttachment[];
  sensingTrace?: SensingTrace;
  cognitionTrace?: MessageCognitionTrace;
}

export type ConversationJobStatus = "queued" | "running" | "completed" | "failed";
export type ConversationJobType = "image_understanding" | "audio_understanding" | "cognition" | "memory_enrichment" | "illustration" | "action_card" | "hermes";

export interface ConversationJobRecord {
  id: string;
  turnId: string;
  requestId: string;
  type: ConversationJobType;
  stage: "sensing" | "cognition" | "action";
  status: ConversationJobStatus;
  attempt: number;
  maxAttempts: number;
  retryable: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  dependsOn?: string[];
  sourceIds: string[];
  segmentId?: string;
  eventId?: string;
  event?: AttentionEvent;
  episodeId?: string;
  memoryId?: string;
  memoryRevision?: number;
  action?: PlannedAction;
  error?: string;
  attemptHistory?: Array<{
    attempt: number;
    startedAt: string;
    completedAt?: string;
    error?: string;
  }>;
  result?: {
    messageId?: string;
    attachmentIds?: string[];
    episodeIds?: string[];
    memoryIds?: string[];
    memorySourceIds?: string[];
    memoryDecision?: "created" | "skipped_no_new_fact" | "skipped_duplicate";
    memoryReason?: string;
    cognition?: {
      inputSource: CognitionInputSource;
      attention: "selected" | "ignored";
      actions: ActionKind[];
      visibleReply: boolean;
      episodeIds: string[];
    };
  };
}

export interface ConversationTurnRecord {
  id: string;
  requestId: string;
  channel: "button" | "curious";
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  inputMessageIds: string[];
  jobIds: string[];
  segments: StreamSegment[];
  error?: string;
}

export interface CompanionSessionRecord {
  id: string;
  startedAt: string;
  endedAt?: string;
  lastObservedAt: string;
  updatedAt: string;
  status: "active" | "consolidating" | "completed" | "failed";
  sourceTurnIds: string[];
  sourceSegmentIds: string[];
  currentEventId?: string;
  currentContext?: {
    activity?: string;
    rollingSummary: string;
    importantContent: string[];
    recentUserNotes: string[];
    updatedAt: string;
  };
  observations: Array<{
    segmentId: string;
    observedAt: string;
    modality: SegmentKind;
    status: SensingTrace["status"];
    content: string;
    transcript?: string;
    segmentSummary?: string;
    audioSceneType?: AudioSceneType;
    speakers?: SpeakerIdentityEvidence[];
    sourceTurnId?: string;
    role?: "scene_evidence" | "context_setting" | "context_note" | "noise";
    assignmentStatus?: "pending" | "processing" | "assigned" | "ignored" | "failed";
    transition?: "continue" | "start" | "switch" | "pause" | "resume" | "end" | "unrelated";
    eventId?: string;
    /** @deprecated Read segmentSummary for normalized profiles. */
    summary?: string;
    assignmentReason?: string;
    processedAt?: string;
  }>;
  events?: CompanionEventRecord[];
  episodeId?: string;
  memoryId?: string;
  messageId?: string;
  summary?: string;
  title?: string;
  kind?: "lecture" | "meeting" | "conversation" | "ambient";
  consolidatedAt?: string;
  error?: string;
}

export interface CompanionEventRecord {
  id: string;
  sessionId: string;
  status: "active" | "paused" | "consolidating" | "completed";
  kind: "lecture" | "meeting" | "conversation" | "meal" | "travel" | "activity" | "ambient" | "other";
  title: string;
  startedAt: string;
  lastObservedAt: string;
  endedAt?: string;
  updatedAt: string;
  summary: string;
  eventSummary: string;
  transcript: Array<{
    segmentId: string;
    observedAt: string;
    text: string;
    sceneType: AudioSceneType;
    speakers: SpeakerIdentityEvidence[];
  }>;
  speakers: SpeakerIdentityEvidence[];
  importantContent: string[];
  sourceTurnIds: string[];
  sourceSegmentIds: string[];
  revision: number;
  consolidatedRevision?: number;
  consolidatedAt?: string;
  episodeId?: string;
  memoryId?: string;
  messageId?: string;
  error?: string;
}

export interface CreatureProfile {
  userId: string;
  creatureName: string;
  petKind: string;
  password?: string;
  hasPassword?: boolean;
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
  dreamHistory: DreamRecord[];
  semanticBrainHistory: SemanticBrainRecord[];
  conversation: CreatureMessage[];
  turns?: ConversationTurnRecord[];
  jobs?: ConversationJobRecord[];
  companionSessions?: CompanionSessionRecord[];
  proactive: ProactiveEmergenceState;
  readState: ReadState;
  hermes: HermesProfileState;
  illustrations?: IllustrationRecord[];
  actionCards?: ActionCardRecord[];
  clientDocument?: ClientDocument;
  petProfile: PetIdentityProfile;
  dogState: DogInteractionState;
  dogStateHistory: DogInteractionState[];
}

export interface ProactiveEmergenceState {
  pendingCount: number;
  paused: boolean;
  nextCheckAt?: string;
  lastCheckedAt?: string;
  lastActiveAt?: string;
  lastUserResponseAt?: string;
  lastQuietAt?: string;
  pauseReason?: string;
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
  actionResult?: ActionResult;
  delivery?: "manual" | "proactive";
  pendingIndex?: number;
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

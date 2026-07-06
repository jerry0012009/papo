export type AttentionSource = "button" | "curious_stream";
export type ActionKind =
  | "observe"
  | "ask"
  | "save_episode"
  | "save_long_term"
  | "recall"
  | "review"
  | "quiet";

export type FeedbackKind = "understood" | "continue" | "not_now" | "remember" | "forget";
export type SegmentKind = "text" | "image_summary" | "audio_transcript";
export type ProviderKind = "mimo" | "openrouter" | "generic" | "fallback";

export interface CreatureState {
  curiosity: number;
  attachment: number;
  energy: number;
  arousal: number;
  safety: number;
  confidence: number;
  mood: "curious" | "calm" | "attached" | "careful" | "tired" | "bright";
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
  weight: number;
  tags: string[];
  decisionTrace?: string[];
}

export interface LongTermMemory {
  id: string;
  createdAt: string;
  kind: "user_preference" | "long_theme" | "creature_self_memory" | "safety_rule" | "future_review";
  text: string;
  sourceEpisodeId?: string;
  weight: number;
  tags: string[];
  lastReferencedAt?: string;
}

export interface FeedbackRecord {
  id: string;
  at: string;
  kind: FeedbackKind;
  targetId?: string;
  effect: string;
}

export interface CreatureProfile {
  userId: string;
  creatureName: string;
  createdAt: string;
  state: CreatureState;
  episodes: EpisodeMemory[];
  longTermMemories: LongTermMemory[];
  feedbackHistory: FeedbackRecord[];
  stateChanges: StateChange[];
}

export interface CaptureResult {
  profile: CreatureProfile;
  events: AttentionEvent[];
  episodes: EpisodeMemory[];
  response: string;
  harnessTrace?: string[];
}

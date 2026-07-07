import { makeId } from "./ids";
import { initialState } from "./state";
import type { CreatureProfile, FeedbackPolicyProfile } from "./types";

export function createCreatureProfile(input: {
  userId?: string;
  creatureName?: string;
  now?: string;
} = {}): CreatureProfile {
  const now = input.now ?? new Date().toISOString();
  const userId = input.userId ?? makeId("user");
  const profile: CreatureProfile = {
    userId,
    creatureName: input.creatureName?.trim() || "Papo",
    createdAt: now,
    lastSeenAt: now,
    state: initialState(userId),
    episodes: [],
    longTermMemories: [],
    feedbackHistory: [],
    stateChanges: [],
    policyProfile: initialPolicyProfile(),
    memoryCandidates: [],
    emergenceHistory: [],
    wakeHistory: [],
    dreamHistory: [],
    semanticBrainHistory: [],
    conversation: [],
    proactive: initialProactiveState(now)
  };
  return profile;
}

export function initialPolicyProfile(): FeedbackPolicyProfile {
  return {
    preferDepth: 45,
    preferProactivity: 45,
    privacySensitivity: 55,
    saveThreshold: 70,
    askThreshold: 58,
    recallTendency: 50,
    quietTendency: 35
  };
}

export function normalizeCreatureProfile(profile: CreatureProfile): CreatureProfile {
  profile.lastSeenAt ??= profile.createdAt;
  profile.policyProfile ??= initialPolicyProfile();
  profile.memoryCandidates ??= [];
  profile.emergenceHistory ??= [];
  profile.wakeHistory ??= [];
  profile.dreamHistory ??= [];
  profile.semanticBrainHistory ??= [];
  profile.conversation ??= [];
  profile.proactive ??= initialProactiveState(new Date().toISOString());
  profile.proactive.pendingCount = Math.max(0, Math.min(3, Math.round(profile.proactive.pendingCount ?? 0)));
  profile.proactive.paused = Boolean(profile.proactive.paused);
  profile.episodes ??= [];
  profile.longTermMemories ??= [];
  profile.feedbackHistory ??= [];
  profile.stateChanges ??= [];

  for (const episode of profile.episodes) {
    episode.memoryCandidateIds ??= [];
    episode.attachments ??= [];
  }
  for (const memory of profile.longTermMemories) {
    memory.attachments ??= [];
  }
  for (const candidate of profile.memoryCandidates) {
    candidate.attachments ??= [];
  }
  for (const message of profile.conversation) {
    message.attachments ??= [];
  }
  for (const feedback of profile.feedbackHistory) {
    feedback.learningNote ??= feedback.effect;
  }

  return profile;
}

function initialProactiveState(now: string) {
  return {
    pendingCount: 0,
    paused: false,
    nextCheckAt: addMinutes(now, 30)
  };
}

function addMinutes(iso: string, minutes: number) {
  const base = Date.parse(iso);
  const at = Number.isFinite(base) ? base : Date.now();
  return new Date(at + minutes * 60_000).toISOString();
}

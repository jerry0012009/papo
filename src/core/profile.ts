import { makeId } from "./ids";
import { initialState } from "./state";
import type { CreatureProfile, FeedbackPolicyProfile, LongTermMemory } from "./types";

export function createCreatureProfile(input: {
  userId?: string;
  creatureName?: string;
  now?: string;
} = {}): CreatureProfile {
  const now = input.now ?? new Date().toISOString();
  const profile: CreatureProfile = {
    userId: input.userId ?? makeId("user"),
    creatureName: input.creatureName?.trim() || "Papo",
    createdAt: now,
    lastSeenAt: now,
    state: initialState(),
    episodes: [],
    longTermMemories: seedMemories(now),
    feedbackHistory: [],
    stateChanges: [],
    policyProfile: initialPolicyProfile(),
    memoryCandidates: [],
    emergenceHistory: [],
    wakeHistory: [],
    semanticBrainHistory: []
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
  profile.semanticBrainHistory ??= [];
  profile.episodes ??= [];
  profile.longTermMemories ??= [];
  profile.feedbackHistory ??= [];
  profile.stateChanges ??= [];

  for (const episode of profile.episodes) {
    episode.memoryCandidateIds ??= [];
  }
  for (const feedback of profile.feedbackHistory) {
    feedback.learningNote ??= feedback.effect;
  }

  return profile;
}

function seedMemories(now: string): LongTermMemory[] {
  return [
    {
      id: makeId("ltm"),
      createdAt: now,
      kind: "creature_self_memory",
      text: "我正在学习先注意、再记住、再根据反馈改变自己，而不是只做一个聊天框。",
      weight: 62,
      tags: ["注意", "记忆", "反馈", "小脑袋"]
    }
  ];
}

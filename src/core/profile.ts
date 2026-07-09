import { makeId } from "./ids";
import { normalizeDogState, seedDogState } from "./dog-states";
import { normalizePetKind, petKindMeta } from "./pet-kinds";
import { initialState } from "./state";
import type { CreatureProfile, FeedbackPolicyProfile, PetIdentityProfile } from "./types";

export function createCreatureProfile(input: {
  userId?: string;
  creatureName?: string;
  petKind?: string;
  now?: string;
} = {}): CreatureProfile {
  const now = input.now ?? new Date().toISOString();
  const userId = input.userId ?? makeId("user");
  const profile: CreatureProfile = {
    userId,
    creatureName: input.creatureName?.trim() || "Papo",
    petKind: normalizePetKind(input.petKind),
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
    proactive: initialProactiveState(now),
    readState: {},
    hermes: { sessionName: hermesSessionName(userId), tasks: [] },
    illustrations: [],
    actionCards: [],
    petProfile: initialPetProfile(normalizePetKind(input.petKind), now),
    dogState: seedDogState(now),
    dogStateHistory: []
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
  profile.petKind = normalizePetKind(profile.petKind);
  profile.policyProfile ??= initialPolicyProfile();
  profile.memoryCandidates ??= [];
  profile.emergenceHistory ??= [];
  profile.wakeHistory ??= [];
  profile.dreamHistory ??= [];
  profile.semanticBrainHistory ??= [];
  profile.conversation ??= [];
  profile.proactive ??= initialProactiveState(new Date().toISOString());
  profile.readState ??= {};
  profile.hermes ??= { tasks: [] };
  profile.hermes.sessionName ??= hermesSessionName(profile.userId);
  profile.hermes.tasks ??= [];
  profile.hermes.tasks = profile.hermes.tasks.slice(0, 30);
  profile.illustrations ??= [];
  profile.illustrations = profile.illustrations.slice(0, 30);
  profile.actionCards ??= [];
  profile.actionCards = profile.actionCards.slice(0, 30);
  profile.petProfile = normalizePetProfile(profile.petProfile, profile.petKind);
  profile.dogState = normalizeDogState(profile.dogState, new Date().toISOString());
  profile.dogStateHistory ??= [];
  profile.dogStateHistory = profile.dogStateHistory.map((state) => normalizeDogState(state, state.selectedAt)).slice(0, 40);
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

export function initialPetProfile(petKind: string, now = new Date().toISOString()): PetIdentityProfile {
  const meta = petKindMeta(normalizePetKind(petKind));
  return {
    updatedAt: now,
    source: "registration",
    displaySpecies: meta.label,
    appearance: meta.appearance,
    personality: "亲近、好奇、会安静陪着用户，也会在合适的时候轻轻回应。",
    habits: "喜欢在用户身边待着，听见重要的小事会靠近一点。",
    visualStyle: "商业化移动应用里的温暖可爱小动物形象，干净、柔软、有宠物感；画风接近高质感 3D app mascot，不是玩具或摆件。",
    imagePrompt: meta.imagePrompt,
    motionStyle: "短循环动作，镜头稳定，全身居中，温暖米白背景，动作简单可爱，结尾回到接近起始姿势。",
    initialMotion: { status: "idle" }
  };
}

export function normalizePetProfile(input: PetIdentityProfile | undefined, petKind: string): PetIdentityProfile {
  const fallback = initialPetProfile(petKind);
  if (!input) return fallback;
  const normalized: PetIdentityProfile = {
    ...fallback,
    ...input,
    updatedAt: input.updatedAt || fallback.updatedAt,
    source: input.source ?? fallback.source,
    displaySpecies: input.displaySpecies?.trim() || fallback.displaySpecies,
    appearance: input.appearance?.trim() || fallback.appearance,
    personality: input.personality?.trim() || fallback.personality,
    habits: input.habits?.trim() || fallback.habits,
    visualStyle: input.visualStyle?.trim() || fallback.visualStyle,
    imagePrompt: input.imagePrompt?.trim() || fallback.imagePrompt,
    motionStyle: input.motionStyle?.trim() || fallback.motionStyle,
    initialMotion: {
      status: input.initialMotion?.status ?? "idle",
      requestedAt: input.initialMotion?.requestedAt,
      completedAt: input.initialMotion?.completedAt,
      pendingCount: input.initialMotion?.pendingCount,
      error: input.initialMotion?.error
    }
  };
  return normalized;
}

function hermesSessionName(userId: string) {
  const suffix = userId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return `papo-${suffix || "user"}`;
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

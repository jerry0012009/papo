import { makeId } from "./ids";
import { memoryShortTitle } from "./memory";
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
    turns: [],
    jobs: [],
    companionSessions: [],
    proactive: initialProactiveState(now),
    readState: {},
    hermes: { sessionName: hermesSessionName(userId), tasks: [] },
    illustrations: [],
    actionCards: [],
    clientDocument: emptyClientDocument(now),
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
  profile.turns ??= [];
  profile.jobs ??= [];
  profile.companionSessions ??= [];
  profile.companionSessions = profile.companionSessions.map((session) => {
    const updatedAt = session.updatedAt ?? session.lastObservedAt ?? session.startedAt;
    const legacyEventId = `${session.id}:legacy-event`;
    const hasLegacyResult = Boolean(session.episodeId || session.memoryId || session.messageId);
    const events = (session.events?.length ? session.events : hasLegacyResult ? [{
      id: legacyEventId,
      sessionId: session.id,
      status: "completed" as const,
      kind: session.kind ?? "other" as const,
      title: session.title ?? "连续陪伴事件",
      startedAt: session.startedAt,
      lastObservedAt: session.lastObservedAt,
      endedAt: session.lastObservedAt,
      updatedAt,
      summary: session.summary ?? "已从旧版陪伴会话迁移。",
      eventSummary: session.summary ?? "已从旧版陪伴会话迁移。",
      transcript: [],
      speakers: [],
      importantContent: [],
      sourceTurnIds: session.sourceTurnIds ?? [],
      sourceSegmentIds: session.sourceSegmentIds ?? [],
      revision: 1,
      consolidatedRevision: 1,
      consolidatedAt: session.consolidatedAt ?? updatedAt,
      episodeId: session.episodeId,
      memoryId: session.memoryId,
      messageId: session.messageId
    }] : []).map((event) => ({
      ...event,
      status: event.status === "consolidating" && Date.now() - Date.parse(event.updatedAt) > 10 * 60_000 ? "completed" as const : event.status,
      importantContent: event.importantContent ?? [],
      eventSummary: event.eventSummary ?? event.summary ?? "",
      transcript: event.transcript ?? [],
      speakers: event.speakers ?? [],
      sourceTurnIds: event.sourceTurnIds ?? [],
      sourceSegmentIds: event.sourceSegmentIds ?? [],
      revision: Math.max(1, event.revision ?? 1)
    }));
    return {
      ...session,
      status: session.status ?? "active",
      updatedAt,
      sourceTurnIds: session.sourceTurnIds ?? [],
      sourceSegmentIds: session.sourceSegmentIds ?? [],
      currentContext: session.currentContext ?? {
        rollingSummary: session.summary ?? "",
        importantContent: [],
        recentUserNotes: [],
        updatedAt
      },
      observations: (session.observations ?? []).map((observation) => ({
        ...observation,
        transcript: observation.transcript ?? (observation.modality === "audio_observation" ? observation.content : undefined),
        segmentSummary: observation.segmentSummary ?? observation.summary,
        assignmentStatus: observation.assignmentStatus === "processing" && Date.now() - Date.parse(observation.processedAt ?? updatedAt) > 10 * 60_000
          ? "pending" as const
          : observation.assignmentStatus ?? (hasLegacyResult ? "assigned" as const : "pending" as const),
        eventId: observation.eventId ?? (hasLegacyResult ? legacyEventId : undefined)
      })),
      events
    };
  }).slice(0, 40);
  profile.turns = profile.turns.map((turn) => ({
    ...turn,
    status: turn.status ?? "queued",
    inputMessageIds: turn.inputMessageIds ?? [],
    jobIds: turn.jobIds ?? [],
    segments: turn.segments ?? [],
    updatedAt: turn.updatedAt ?? turn.createdAt
  })).slice(0, 80);
  profile.jobs = profile.jobs.map((job) => ({
    ...job,
    status: job.status ?? "queued",
    stage: job.stage ?? "cognition",
    attempt: Math.max(0, job.attempt ?? 0),
    maxAttempts: Math.max(1, job.maxAttempts ?? 3),
    retryable: job.retryable ?? true,
    sourceIds: job.sourceIds ?? [],
    dependsOn: job.dependsOn ?? [],
    updatedAt: job.updatedAt ?? job.createdAt
  })).slice(0, 240);
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
  profile.clientDocument = normalizeClientDocument(profile.clientDocument, profile.createdAt);
  for (const card of profile.actionCards) card.cover ??= profile.petProfile.avatarImage;
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
    memory.shortTitle = memoryShortTitle(memory.narrative ?? memory.text, memory.shortTitle);
  }
  for (const candidate of profile.memoryCandidates) {
    candidate.attachments ??= [];
    candidate.shortTitle = memoryShortTitle(candidate.candidateText, candidate.shortTitle);
  }
  for (const message of profile.conversation) {
    message.attachments ??= [];
  }
  for (const feedback of profile.feedbackHistory) {
    feedback.learningNote ??= feedback.effect;
  }

  return profile;
}

function emptyClientDocument(now: string) {
  return { facts: [], markdown: "# Client\n\n还在慢慢认识你。", updatedAt: now, revision: 0 };
}

function normalizeClientDocument(document: CreatureProfile["clientDocument"], fallbackAt: string) {
  if (!document) return emptyClientDocument(fallbackAt);
  document.preferredNameSourceIds ??= [];
  document.preferredNameSourceIds = [...new Set(document.preferredNameSourceIds)].slice(0, 8);
  document.facts ??= [];
  document.facts = document.facts.filter((fact) => fact.text?.trim() && fact.sourceIds?.length).slice(0, 80);
  document.markdown ||= "# Client\n\n还在慢慢认识你。";
  document.updatedAt ||= fallbackAt;
  document.revision = Math.max(0, Math.round(document.revision ?? 0));
  return document;
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

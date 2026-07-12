import { createHash } from "node:crypto";
import { z } from "zod";
import type { ModelProvider } from "../core/provider";
import type {
  CognitionContext,
  CompanionEventRecord,
  CompanionSessionRecord,
  CreatureMessage,
  CreatureProfile,
  EpisodeMemory,
  LongTermMemory,
  SemanticBrainRecord,
  SpeakerIdentityEvidence,
  StreamSegment
} from "../core/types";
import type { ProfileStore } from "./store";

const INACTIVITY_MS = 4 * 60_000;
const GUARANTEED_LONG_FORM_MS = 10 * 60_000;
const MAX_PENDING_PER_PASS = 8;
const MAX_ASSIGNMENT_TRANSCRIPT_CHARS = 40_000;
const eventKindSchema = z.enum(["lecture", "meeting", "conversation", "meal", "lunch", "dining", "travel", "activity", "ambient", "other"])
  .transform((value) => value === "lunch" || value === "dining" ? "meal" as const : value);
const optionalEventKindSchema = z.preprocess((value) => value === null ? undefined : value, eventKindSchema.optional());
const optionalString = (max: number) => z.preprocess((value) => value === null || value === "" ? undefined : value, z.string().trim().min(1).max(max).optional());
const speakerUpdateSchema = z.object({
  speakerId: z.string().regex(/^speaker_[1-9]\d*$/),
  displayName: optionalString(120),
  nameSource: z.enum(["unknown", "user_statement", "self_introduction", "reliable_context"]),
  confidence: z.number().min(0).max(1),
  evidence: optionalString(500),
  sourceSegmentIds: z.array(z.string().min(1).max(120)).max(20)
});

const assignmentSchema = z.object({
  assignments: z.array(z.object({
    segmentId: z.string().min(1),
    role: z.enum(["scene_evidence", "context_setting", "context_note", "noise", "unrelated"]).transform((value) => value === "unrelated" ? "noise" as const : value),
    transition: z.enum(["continue", "start", "switch", "pause", "resume", "end", "unrelated"]),
    targetEventId: optionalString(120),
    switchDisposition: z.preprocess((value) => value === null ? undefined : value, z.enum(["pause", "complete"]).optional()),
    eventKind: optionalEventKindSchema,
    eventTitle: optionalString(48),
    segmentSummary: z.string().trim().max(1200),
    updatedEventSummary: optionalString(1400),
    importantFacts: z.array(z.string().trim().min(1).max(260)).max(10).default([]),
    speakerUpdates: z.array(speakerUpdateSchema).max(12).default([]),
    reason: z.string().trim().min(1).max(360)
  })).min(1).max(MAX_PENDING_PER_PASS),
  currentContext: z.object({
    activity: optionalString(120),
    rollingSummary: z.string().trim().max(1000),
    importantContent: z.array(z.string().trim().min(1).max(260)).max(12),
    recentUserNotes: z.array(z.string().trim().min(1).max(260)).max(8)
  })
});

const consolidationSchema = z.object({
  kind: eventKindSchema,
  title: z.string().trim().min(2).max(48),
  summary: z.string().trim().min(1).max(1800),
  shouldRemember: z.boolean(),
  memoryText: z.string().trim().max(1100).optional(),
  importanceReason: z.string().trim().min(1).max(360),
  tags: z.array(z.string().trim().min(1).max(40)).max(12)
});

export function collectCompanionTurn(profile: CreatureProfile, turnId: string, segments: StreamSegment[]) {
  for (const segment of segments) {
    const sessionId = segment.companionSessionId ?? companionSessionId(segment.batchId);
    if (!sessionId) continue;
    const observedAt = segment.observedAt ?? new Date().toISOString();
    let session = profile.companionSessions?.find((item) => item.id === sessionId);
    if (!session) {
      session = {
        id: sessionId,
        startedAt: observedAt,
        lastObservedAt: observedAt,
        updatedAt: observedAt,
        status: "active",
        sourceTurnIds: [],
        sourceSegmentIds: [],
        currentContext: { rollingSummary: "", importantContent: [], recentUserNotes: [], updatedAt: observedAt },
        observations: [],
        events: []
      };
      profile.companionSessions = [session, ...(profile.companionSessions ?? [])].slice(0, 40);
    }
    const previous = session.observations.find((item) => item.segmentId === segment.id);
    const status = segment.sensingTrace?.status ?? (segment.kind === "text" && segment.content.trim() ? "content" : segment.auditOnly ? "empty" : segment.content.trim() ? "content" : "empty");
    const content = status === "content" ? segment.content.trim().slice(0, 24_000) : "";
    const audioContent = segment.sensingTrace?.audioContent;
    const transcript = audioContent?.transcript.trim() || (segment.kind === "audio_observation" && status === "content" ? content : undefined);
    const speakers = audioContent?.speakers.map((speaker) => ({
      ...speaker,
      sourceSegmentIds: unique([...speaker.sourceSegmentIds, segment.id])
    }));
    const changed = !previous
      || previous.status !== status
      || previous.content !== content
      || previous.transcript !== transcript
      || previous.audioSceneType !== audioContent?.sceneType;
    session.startedAt = minIso(session.startedAt, observedAt);
    session.lastObservedAt = maxIso(session.lastObservedAt, observedAt);
    session.updatedAt = maxIso(session.updatedAt, observedAt);
    if (changed) {
      session.status = "active";
      session.error = undefined;
    }
    session.sourceTurnIds = unique([...session.sourceTurnIds, turnId]);
    session.sourceSegmentIds = unique([...session.sourceSegmentIds, segment.id]);
    const observation: CompanionSessionRecord["observations"][number] = {
      ...previous,
      segmentId: segment.id,
      sourceTurnId: turnId,
      observedAt,
      modality: segment.kind,
      status,
      content,
      transcript,
      audioSceneType: audioContent?.sceneType,
      speakers,
      segmentSummary: changed ? undefined : previous?.segmentSummary,
      summary: changed ? undefined : previous?.summary,
      assignmentStatus: changed ? "pending" : previous?.assignmentStatus ?? "pending",
      processedAt: changed ? undefined : previous?.processedAt,
      assignmentReason: changed ? undefined : previous?.assignmentReason
    };
    session.observations = [observation, ...session.observations.filter((item) => item.segmentId !== segment.id)]
      .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
      .slice(-160);
  }
}

export function companionCognitionContext(profile: CreatureProfile, turnId: string): CognitionContext["companion"] | undefined {
  const session = (profile.companionSessions ?? []).find((item) => item.observations.some((observation) => observation.sourceTurnId === turnId));
  if (!session) return undefined;
  const recent = session.observations.filter((item) => item.assignmentStatus === "assigned" && item.segmentSummary).slice(-5);
  return {
    sessionId: session.id,
    currentEventId: session.currentEventId,
    currentContext: session.currentContext?.rollingSummary ?? "",
    recentUserNotes: session.currentContext?.recentUserNotes ?? [],
    recentObservationSummaries: recent.map((item) => item.segmentSummary!).filter(Boolean)
  };
}

export async function processCompanionTurnContext(store: ProfileStore, provider: ModelProvider, userId: string, turnId: string) {
  const profile = await store.getProfile(userId);
  const session = profile?.companionSessions?.find((item) => item.observations.some((observation) => observation.sourceTurnId === turnId && observation.assignmentStatus === "pending"));
  if (!session) return { processed: 0 };
  return processPendingObservations(store, provider, userId, session.id, turnId);
}

export async function runCompanionSessionSweep(store: ProfileStore, provider: ModelProvider, now = new Date().toISOString()) {
  let checked = 0;
  let completed = 0;
  let failed = 0;
  for (const summary of await store.listProfiles()) {
    let profile = await store.getProfile(summary.userId);
    if (!profile) continue;
    const backfilled = backfillCompanionSessions(profile);
    if (backfilled) await store.saveProfile(profile);

    for (const session of profile.companionSessions ?? []) {
      if (session.observations.some((item) => item.assignmentStatus === "pending")) {
        try {
          let processed = 0;
          for (let pass = 0; pass < 4; pass += 1) {
            const result = await processPendingObservations(store, provider, profile.userId, session.id);
            processed += result.processed;
            if (result.processed < MAX_PENDING_PER_PASS) break;
          }
          checked += processed ? 1 : 0;
        } catch {
          failed += 1;
        }
      }
    }

    profile = await store.getProfile(summary.userId);
    if (!profile) continue;
    for (const session of profile.companionSessions ?? []) {
      if (isSessionDue(session, now)) await closeInactiveSessionEvents(store, profile.userId, session.id, now);
    }

    profile = await store.getProfile(summary.userId);
    if (!profile) continue;
    for (const session of profile.companionSessions ?? []) {
      for (const event of session.events ?? []) {
        if (!eventNeedsConsolidation(event)) continue;
        checked += 1;
        try {
          const applied = await consolidateEvent(store, provider, profile.userId, session.id, event.id, now);
          if (applied) completed += 1;
        } catch (error) {
          failed += 1;
          await store.updateProfile(profile.userId, (latest) => {
            const target = findEvent(latest, session.id, event.id);
            if (!target) return;
            target.status = "completed";
            target.updatedAt = now;
            target.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
          });
        }
      }
      await settleSession(store, profile.userId, session.id, now);
    }
  }
  return { checked, completed, failed };
}

async function processPendingObservations(store: ProfileStore, provider: ModelProvider, userId: string, sessionId: string, turnId?: string) {
  const claimedIds: string[] = [];
  const claimAt = new Date().toISOString();
  const claimed = await store.updateProfile(userId, (profile) => {
    const session = profile.companionSessions?.find((item) => item.id === sessionId);
    if (!session) return;
    const candidates = session.observations
      .filter((item) => item.assignmentStatus === "pending" && (!turnId || item.sourceTurnId === turnId))
      .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
      .slice(0, MAX_PENDING_PER_PASS);
    const pending: typeof candidates = [];
    let transcriptChars = 0;
    for (const observation of candidates) {
      const size = observation.transcript?.length ?? observation.content.length;
      if (pending.length && transcriptChars + size > MAX_ASSIGNMENT_TRANSCRIPT_CHARS) break;
      pending.push(observation);
      transcriptChars += size;
    }
    for (const observation of pending) {
      observation.assignmentStatus = "processing";
      observation.processedAt = claimAt;
      claimedIds.push(observation.segmentId);
    }
    if (pending.length) {
      session.status = "active";
      session.updatedAt = claimAt;
    }
  });
  const session = claimed?.companionSessions?.find((item) => item.id === sessionId);
  const observations = session?.observations.filter((item) => claimedIds.includes(item.segmentId)) ?? [];
  if (!claimed || !session || !observations.length) return { processed: 0 };

  try {
    const raw = await provider.generateJson<unknown>(buildAssignmentPrompt(claimed, session, observations));
    const parsed = assignmentSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`invalid companion event assignment (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 300)})`);
    const decisions = new Map(parsed.data.assignments.map((item) => [item.segmentId, item]));
    if (observations.some((item) => !decisions.has(item.segmentId))) throw new Error("companion event assignment omitted a claimed observation");
    await store.updateProfile(userId, (latest) => {
      const target = latest.companionSessions?.find((item) => item.id === sessionId);
      if (!target) return;
      for (const observation of observations.sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))) {
        const stored = target.observations.find((item) => item.segmentId === observation.segmentId);
        const decision = decisions.get(observation.segmentId);
        if (!stored || stored.assignmentStatus !== "processing" || !decision) continue;
        applyAssignment(target, stored, decision, claimAt);
      }
      const meaningful = parsed.data.assignments.some((item) => item.transition !== "unrelated" && item.role !== "noise");
      if (meaningful) {
        target.currentContext = {
          activity: parsed.data.currentContext.activity,
          rollingSummary: parsed.data.currentContext.rollingSummary,
          importantContent: unique(parsed.data.currentContext.importantContent).slice(-12),
          recentUserNotes: unique(parsed.data.currentContext.recentUserNotes).slice(-8),
          updatedAt: claimAt
        };
      }
      target.updatedAt = claimAt;
      target.error = undefined;
    });
    return { processed: observations.length };
  } catch (error) {
    await store.updateProfile(userId, (latest) => {
      const target = latest.companionSessions?.find((item) => item.id === sessionId);
      if (!target) return;
      for (const observation of target.observations.filter((item) => claimedIds.includes(item.segmentId) && item.assignmentStatus === "processing")) {
        observation.assignmentStatus = "pending";
        observation.assignmentReason = error instanceof Error ? error.message.slice(0, 360) : String(error).slice(0, 360);
      }
      target.error = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      target.updatedAt = claimAt;
    });
    throw error;
  }
}

function applyAssignment(
  session: CompanionSessionRecord,
  observation: CompanionSessionRecord["observations"][number],
  decision: z.infer<typeof assignmentSchema>["assignments"][number],
  now: string
) {
  observation.role = decision.role;
  observation.transition = decision.transition;
  observation.segmentSummary = decision.segmentSummary;
  observation.summary = decision.segmentSummary;
  observation.assignmentReason = decision.reason;
  observation.processedAt = now;
  if (decision.transition === "unrelated" || decision.role === "noise") {
    observation.assignmentStatus = "ignored";
    observation.eventId = undefined;
    return;
  }

  session.events ??= [];
  let current = session.events.find((item) => item.id === session.currentEventId);
  let event = decision.targetEventId ? session.events.find((item) => item.id === decision.targetEventId) : undefined;
  if (decision.targetEventId && !event) throw new Error(`companion assignment referenced unknown event ${decision.targetEventId}`);
  if (event && decision.transition !== "resume" && event.id !== current?.id) {
    throw new Error("only resume may target a non-current companion event");
  }
  if (decision.transition === "start" || decision.transition === "switch" || (!current && decision.transition === "continue")) {
    if (current?.status === "active") closeOrPause(current, decision.switchDisposition ?? "complete", observation.observedAt, now);
    event = createEvent(session, observation, decision, now);
  } else if (decision.transition === "resume") {
    const resumable = session.events
      .filter((item) => item.status === "paused" || item.status === "completed")
      .sort((left, right) => Date.parse(right.lastObservedAt) - Date.parse(left.lastObservedAt));
    if (!event && resumable.length > 1 && Date.parse(resumable[0].lastObservedAt) === Date.parse(resumable[1].lastObservedAt)) {
      throw new Error("resume must provide targetEventId when prior events are equally recent");
    }
    event ??= resumable[0];
    if (!event) event = createEvent(session, observation, decision, now);
    if (current && current.id !== event.id && current.status === "active") closeOrPause(current, decision.switchDisposition ?? "pause", observation.observedAt, now);
    event.status = "active";
    event.endedAt = undefined;
  } else {
    event ??= current;
    if (!event) event = createEvent(session, observation, decision, now);
  }

  event.status = event.status === "consolidating" ? "active" : event.status;
  event.lastObservedAt = maxIso(event.lastObservedAt, observation.observedAt);
  event.updatedAt = now;
  event.title = decision.eventTitle ?? event.title;
  event.kind = decision.eventKind ?? event.kind;
  event.eventSummary = decision.updatedEventSummary?.trim() || appendSummary(event.eventSummary, decision.segmentSummary);
  event.summary = event.eventSummary;
  event.importantContent = unique([...event.importantContent, ...decision.importantFacts]).slice(-24);
  if (observation.transcript?.trim()) {
    event.transcript = [
      ...event.transcript.filter((item) => item.segmentId !== observation.segmentId),
      {
        segmentId: observation.segmentId,
        observedAt: observation.observedAt,
        text: observation.transcript.trim(),
        sceneType: observation.audioSceneType ?? "unknown",
        speakers: observation.speakers ?? []
      }
    ].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  }
  event.speakers = mergeEventSpeakers(
    event.speakers,
    [...(observation.speakers ?? []), ...decision.speakerUpdates],
    observation.segmentId,
    new Set([...event.sourceSegmentIds, observation.segmentId])
  );
  event.sourceTurnIds = unique([...event.sourceTurnIds, observation.sourceTurnId ?? ""]);
  event.sourceSegmentIds = unique([...event.sourceSegmentIds, observation.segmentId]);
  event.revision += 1;
  event.error = undefined;
  observation.assignmentStatus = "assigned";
  observation.eventId = event.id;

  if (decision.transition === "pause") {
    event.status = "paused";
    event.endedAt = observation.observedAt;
    session.currentEventId = undefined;
  } else if (decision.transition === "end") {
    event.status = "completed";
    event.endedAt = observation.observedAt;
    session.currentEventId = undefined;
  } else {
    event.status = "active";
    event.endedAt = undefined;
    session.currentEventId = event.id;
  }
}

function createEvent(
  session: CompanionSessionRecord,
  observation: CompanionSessionRecord["observations"][number],
  decision: z.infer<typeof assignmentSchema>["assignments"][number],
  now: string
): CompanionEventRecord {
  const suffix = createHash("sha256").update(`${session.id}\u0000${observation.segmentId}`).digest("hex").slice(0, 16);
  const event: CompanionEventRecord = {
    id: `companion_event_${suffix}`,
    sessionId: session.id,
    status: "active",
    kind: decision.eventKind ?? "other",
    title: decision.eventTitle ?? "持续生活片段",
    startedAt: observation.observedAt,
    lastObservedAt: observation.observedAt,
    updatedAt: now,
    summary: "",
    eventSummary: "",
    transcript: [],
    speakers: [],
    importantContent: [],
    sourceTurnIds: [],
    sourceSegmentIds: [],
    revision: 0
  };
  session.events = [...(session.events ?? []), event];
  return event;
}

function closeOrPause(event: CompanionEventRecord, disposition: "pause" | "complete", at: string, now: string) {
  event.status = disposition === "pause" ? "paused" : "completed";
  event.endedAt = at;
  event.updatedAt = now;
}

async function closeInactiveSessionEvents(store: ProfileStore, userId: string, sessionId: string, now: string) {
  await store.updateProfile(userId, (profile) => {
    const session = profile.companionSessions?.find((item) => item.id === sessionId);
    if (!session || !isSessionDue(session, now)) return;
    if (session.observations.some((item) => item.assignmentStatus === "pending" || item.assignmentStatus === "processing")) return;
    for (const event of session.events ?? []) {
      if (event.status !== "active" && event.status !== "paused") continue;
      event.status = "completed";
      event.endedAt = event.lastObservedAt;
      event.updatedAt = now;
    }
    session.currentEventId = undefined;
    session.updatedAt = now;
  });
}

async function consolidateEvent(store: ProfileStore, provider: ModelProvider, userId: string, sessionId: string, eventId: string, now: string) {
  let claimedRevision: number | undefined;
  const claimed = await store.updateProfile(userId, (profile) => {
    const event = findEvent(profile, sessionId, eventId);
    if (!event || !eventNeedsConsolidation(event)) return;
    claimedRevision = event.revision;
    event.status = "consolidating";
    event.updatedAt = now;
    event.error = undefined;
  });
  const session = claimed?.companionSessions?.find((item) => item.id === sessionId);
  const event = session?.events?.find((item) => item.id === eventId);
  if (!claimed || !session || !event || claimedRevision === undefined) return false;
  const observations = session.observations.filter((item) => item.eventId === event.id && item.assignmentStatus === "assigned" && item.status === "content");
  if (!observations.length) {
    await store.updateProfile(userId, (latest) => {
      const target = findEvent(latest, sessionId, eventId);
      if (!target || target.revision !== claimedRevision) return;
      target.status = "completed";
      target.consolidatedRevision = target.revision;
      target.consolidatedAt = now;
      target.updatedAt = now;
    });
    return true;
  }
  const raw = await provider.generateJson<unknown>(buildConsolidationPrompt(claimed, session, event, observations));
  const parsed = consolidationSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid companion event consolidation (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 300)})`);
  const durationMs = Math.max(0, Date.parse(event.lastObservedAt) - Date.parse(event.startedAt));
  const longForm = durationMs >= GUARANTEED_LONG_FORM_MS && observations.length >= 3 && (parsed.data.kind === "lecture" || parsed.data.kind === "meeting");
  if ((longForm || event.memoryId) && (!parsed.data.shouldRemember || !parsed.data.memoryText?.trim())) {
    throw new Error("a long-form or previously remembered companion event must retain one integrated memory");
  }
  const records = eventRecords(claimed, session, event, parsed.data, provider, now);
  const saved = await store.updateProfile(userId, (latest) => {
    const targetSession = latest.companionSessions?.find((item) => item.id === sessionId);
    const target = targetSession?.events?.find((item) => item.id === eventId);
    if (!target) return;
    if (target.revision !== claimedRevision || target.status !== "consolidating") {
      if (target.status === "consolidating") target.status = "active";
      return;
    }
    latest.episodes = mergeById(latest.episodes, [records.episode]).slice(0, 80);
    if (records.memory) latest.longTermMemories = mergeById(latest.longTermMemories, [records.memory]).slice(0, 80);
    if (records.message) latest.conversation = mergeById(latest.conversation, [records.message]).slice(0, 80);
    latest.semanticBrainHistory = mergeById(latest.semanticBrainHistory, [records.semanticRun]).slice(0, 30);
    target.status = "completed";
    target.updatedAt = now;
    target.consolidatedAt = now;
    target.consolidatedRevision = target.revision;
    target.episodeId = records.episode.id;
    target.memoryId = records.memory?.id ?? target.memoryId;
    target.messageId = records.message?.id ?? target.messageId;
    target.title = parsed.data.title;
    target.summary = parsed.data.summary;
    target.eventSummary = parsed.data.summary;
    target.kind = parsed.data.kind;
    target.error = undefined;
  });
  return Boolean(saved);
}

function eventRecords(
  profile: CreatureProfile,
  session: CompanionSessionRecord,
  event: CompanionEventRecord,
  decision: z.infer<typeof consolidationSchema>,
  provider: ModelProvider,
  now: string
) {
  const suffix = createHash("sha256").update(`${profile.userId}\u0000${event.id}`).digest("hex").slice(0, 20);
  const episodeId = event.episodeId ?? `episode_companion_event_${suffix}`;
  const memoryId = event.memoryId ?? `ltm_companion_event_${suffix}`;
  const shouldRemember = decision.shouldRemember && Boolean(decision.memoryText?.trim());
  const episode: EpisodeMemory = {
    id: episodeId,
    createdAt: event.startedAt,
    source: "curious_stream",
    cognitionSource: "ambient",
    sourceBatchId: event.id,
    sourceObservedAt: event.lastObservedAt,
    inputSummary: decision.summary,
    noticed: `Papo 连续陪伴并整理了“${decision.title}”这件事。`,
    possibleIntent: "把连续生活中的同一事件整合成完整经历",
    importanceReason: decision.importanceReason,
    relatedMemoryIds: shouldRemember ? [memoryId] : [],
    stateSnapshot: structuredClone(profile.state),
    creatureResponse: "",
    feedback: [],
    promotedToLongTerm: shouldRemember,
    memoryCandidateIds: [],
    actionDecision: {
      action: "listen_silently",
      confidence: 100,
      reason: "event-level consolidation preserves continuity without interrupting each observation",
      blockedActions: [],
      safetyNotes: [],
      llmSuggestedAction: "listen_silently",
      ruleTrace: ["source=companion_event", "reply=quiet", `memory=${shouldRemember}`]
    },
    actionResult: { kind: "memory_intent", title: decision.title, text: decision.importanceReason, sourceIds: event.sourceSegmentIds },
    creatureExperience: { earReason: "我把属于同一件事的声音、画面和说明接起来理解。", actionFeeling: "持续陪伴后整理", saveFeeling: shouldRemember ? "把完整事件收成一条记忆" : "只留下完整经历" },
    weight: shouldRemember ? 82 : 55,
    tags: unique(["陪伴事件", decision.kind, ...decision.tags]),
    decisionTrace: [
      `session=${session.id}`,
      `event=${event.id}`,
      `event_revision=${event.revision}`,
      `segments=${event.sourceSegmentIds.length}`,
      "attention-independent continuous scene tracking"
    ]
  };
  const memory: LongTermMemory | undefined = shouldRemember ? {
    id: memoryId,
    createdAt: event.consolidatedAt ?? now,
    kind: "long_theme",
    text: decision.memoryText!.trim(),
    shortTitle: [...decision.title.replace(/\s+/g, "")].slice(0, 8).join(""),
    sourceEpisodeId: episodeId,
    consolidatedBecause: decision.importanceReason,
    weight: 88,
    tags: unique(["陪伴事件", decision.kind, ...decision.tags]),
    lastReferencedAt: now
  } : undefined;
  const message: CreatureMessage | undefined = memory ? {
    id: event.messageId ?? `msg_companion_event_${suffix}`,
    at: now,
    role: "papo",
    channel: "curious",
    text: `我把“${decision.title}”这件事整理好了。${decision.summary}`,
    sourceId: event.id,
    relatedMemoryIds: [memory.id],
    attachments: []
  } : undefined;
  const semanticRun: SemanticBrainRecord = {
    id: `semantic_companion_event_${suffix}_r${event.revision}`,
    at: now,
    source: "companion_session",
    stage: "memory",
    providerKind: provider.kind,
    providerName: provider.name,
    model: provider.diagnostics?.textModel,
    status: "applied",
    message: `consolidated companion event revision ${event.revision} into one episode${memory ? " and one memory" : ""}`,
    ruleTrace: [`session=${session.id}`, `event=${event.id}`, `revision=${event.revision}`, `memory=${Boolean(memory)}`]
  };
  return { episode, memory, message, semanticRun };
}

function buildAssignmentPrompt(profile: CreatureProfile, session: CompanionSessionRecord, observations: CompanionSessionRecord["observations"]) {
  return `请作为 Papo 的连续生活事件归属脑。一个 companion session 是连续生活容器，里面可以有多个连续、交替、暂停后恢复的事件；不要把整场 session 强行视作一件事，也不要把每个录音切片各自视作一件事。

按时间顺序判断每条新 observation：continue 延续当前事件；start 在没有当前事件时开始；switch 切换到新事件并用 switchDisposition 决定旧事件暂停或完成；pause 暂停当前事件；resume 恢复一个 paused event；end 结束当前事件；unrelated 表示无关噪音或无法归属，不得污染事件摘要。eventKind 只能使用 lecture、meeting、conversation、meal、travel、activity、ambient、other。
role 只能使用 scene_evidence、context_setting、context_note、noise。用户文字可能是 scene_evidence、context_setting 或 context_note。像“接下来我要听讲座”“这是第二位发言人”这样的说明必须更新上下文并影响后续观察，不能因 Attention 静默而丢失。照片、声音和同期文字应在语义与时间一致时归入同一事件。
只根据证据判断，不要编造。segmentSummary 必须严格基于该 observation 的 transcript 生成，压缩单片主旨但保留关键数字、专有名词、论点与结论；不得把 segmentSummary 当 transcript。updatedEventSummary 要跨片段整合事件至今内容，不逐片罗列；importantFacts 只保留核心事实。若一批中先开始事件、后续 assignment 可用 continue 引用本批刚建立的当前事件。targetEventId 只能引用 existingEvents 中的事件，主要用于 resume；新事件 ID 由系统生成。
speakerUpdates 用于把片段 speaker 标签维护到事件中。只有用户明确说明、说话者明确自我介绍，或 existingEvents/currentContext 提供可靠对应关系时才可填写 displayName；必须同时给出 nameSource、evidence、confidence 和 sourceSegmentIds。否则只保留 speaker_1、speaker_2 标签，nameSource=unknown，绝不能猜姓名。
只返回 JSON：
{"assignments":[{"segmentId":"...","role":"context_setting","transition":"start","eventKind":"lecture","eventTitle":"...","segmentSummary":"...","updatedEventSummary":"...","importantFacts":["..."],"speakerUpdates":[{"speakerId":"speaker_1","displayName":"...","nameSource":"self_introduction","confidence":0.95,"evidence":"...","sourceSegmentIds":["..."]}],"reason":"..."}],"currentContext":{"activity":"...","rollingSummary":"...","importantContent":["..."],"recentUserNotes":["..."]}}

session:
${JSON.stringify({ id: session.id, startedAt: session.startedAt, lastObservedAt: session.lastObservedAt })}

currentContext:
${JSON.stringify(session.currentContext ?? {})}

existingEvents:
${JSON.stringify((session.events ?? []).map((event) => ({ id: event.id, status: event.status, kind: event.kind, title: event.title, startedAt: event.startedAt, lastObservedAt: event.lastObservedAt, eventSummary: event.eventSummary, importantContent: event.importantContent, speakers: event.speakers })))}

recentAssignedObservations:
${JSON.stringify(session.observations.filter((item) => item.assignmentStatus === "assigned").slice(-6).map((item) => ({ observedAt: item.observedAt, role: item.role, eventId: item.eventId, segmentSummary: item.segmentSummary })))}

newObservations:
${JSON.stringify(observations.map((item) => ({ segmentId: item.segmentId, sourceTurnId: item.sourceTurnId, observedAt: item.observedAt, modality: item.modality, status: item.status, transcript: item.transcript, audioSceneType: item.audioSceneType, speakers: item.speakers, content: item.modality === "audio_observation" ? undefined : item.content })))}

recentDirectConversation:
${JSON.stringify(profile.conversation.filter((message) => message.role === "user").slice(0, 6).map((message) => ({ at: message.at, text: message.text, batchId: message.batchId })))}
`;
}

function buildConsolidationPrompt(
  profile: CreatureProfile,
  session: CompanionSessionRecord,
  event: CompanionEventRecord,
  observations: CompanionSessionRecord["observations"]
) {
  return `请作为 Papo 的事件级经历整理与记忆决策脑。只整理给定 event，不要把同一 companion session 中其他事件混进来。

所有归入该 event 的成功观察都应参与总结，即使某片没有触发 Attention 或 Papo 当时保持安静。eventSummary 必须以 eventTranscript 为第一事实源，并用 segmentSummaries 辅助定位，整合主题、关键事实、论点、论据、转折、结论和待办；不能从片段摘要反推或编造 transcript 中不存在的事实。
transcript 是事件资料，不等于长期记忆。不要仅因 transcript 很长就 shouldRemember=true；长期记忆仍只保存对 Papo 与用户有持续价值的整合内容。
只有稳定偏好、重要经历、持续情绪、长期计划，或完整且有回顾价值的讲座/会议才写长期记忆。持续 10 分钟以上且至少 3 个有效片段的 lecture/meeting 必须 shouldRemember=true，形成一条自足的整合记忆。
如果 event 已有 memoryId，说明这是后续补充或恢复：必须更新原记忆，不能另建重复记忆。
只返回 JSON：
{"kind":"lecture","title":"...","summary":"...","shouldRemember":true,"memoryText":"...","importanceReason":"...","tags":["..."]}

sessionContext:
${JSON.stringify({ id: session.id, currentContext: session.currentContext })}

event:
${JSON.stringify({ ...event, transcript: undefined })}

eventTranscript:
${JSON.stringify(event.transcript)}

segmentSummaries:
${JSON.stringify(observations.map((item) => ({ segmentId: item.segmentId, observedAt: item.observedAt, modality: item.modality, role: item.role, segmentSummary: item.segmentSummary })))}

recentDirectContext:
${JSON.stringify(profile.conversation.filter((message) => message.role === "user").slice(0, 8).map((message) => ({ at: message.at, text: message.text })))}
`;
}

function backfillCompanionSessions(profile: CreatureProfile) {
  const before = JSON.stringify((profile.companionSessions ?? []).map((session) => [session.id, session.sourceSegmentIds.length, session.lastObservedAt]));
  for (const turn of profile.turns ?? []) collectCompanionTurn(profile, turn.id, turn.segments ?? []);
  const after = JSON.stringify((profile.companionSessions ?? []).map((session) => [session.id, session.sourceSegmentIds.length, session.lastObservedAt]));
  return before !== after;
}

function companionSessionId(batchId?: string) {
  if (!batchId) return undefined;
  const native = batchId.match(/^(native-\d+)(?:-camera)?-\d{1,4}$/);
  if (native) return native[1];
  const live = batchId.match(/^(live-.+)-\d{1,4}$/);
  return live?.[1];
}

function isSessionDue(session: CompanionSessionRecord, now: string) {
  if (session.status === "consolidating") return false;
  if (session.endedAt && Date.parse(session.endedAt) <= Date.parse(now)) return true;
  return Date.parse(now) - Date.parse(session.lastObservedAt) >= INACTIVITY_MS;
}

function eventNeedsConsolidation(event: CompanionEventRecord) {
  return event.status === "completed" && event.consolidatedRevision !== event.revision;
}

async function settleSession(store: ProfileStore, userId: string, sessionId: string, now: string) {
  await store.updateProfile(userId, (profile) => {
    const session = profile.companionSessions?.find((item) => item.id === sessionId);
    if (!session || !isSessionDue(session, now)) return;
    const pending = session.observations.some((item) => item.assignmentStatus === "pending" || item.assignmentStatus === "processing");
    const active = (session.events ?? []).some((event) => event.status === "active" || event.status === "paused" || event.status === "consolidating" || eventNeedsConsolidation(event));
    if (pending || active) return;
    session.status = "completed";
    session.updatedAt = now;
    session.consolidatedAt = now;
    const titles = (session.events ?? []).map((event) => event.title).filter(Boolean);
    session.summary = titles.length ? `这次陪伴包含 ${titles.map((title) => `“${title}”`).join("、")} 等事件。` : "这次陪伴没有形成可用的连续事件。";
    session.error = undefined;
  });
}

function findEvent(profile: CreatureProfile, sessionId: string, eventId: string) {
  return profile.companionSessions?.find((item) => item.id === sessionId)?.events?.find((item) => item.id === eventId);
}

function mergeById<T extends { id: string }>(current: T[], owned: T[]) {
  const ids = new Set(owned.map((item) => item.id));
  return [...owned, ...current.filter((item) => !ids.has(item.id))];
}

function appendSummary(current: string, addition: string) {
  const clean = addition.trim();
  if (!clean || current.includes(clean)) return current;
  return [current.trim(), clean].filter(Boolean).join("；").slice(-1400);
}

function mergeEventSpeakers(
  current: SpeakerIdentityEvidence[],
  incoming: Array<Omit<SpeakerIdentityEvidence, "speakerId"> & { speakerId: string }>,
  sourceSegmentId: string,
  allowedSourceIds: Set<string>
) {
  const byId = new Map(current.map((speaker) => [speaker.speakerId, speaker]));
  for (const raw of incoming) {
    const nameAllowed = raw.nameSource !== "unknown" && raw.confidence >= 0.7 && Boolean(raw.displayName?.trim()) && Boolean(raw.evidence?.trim());
    const speaker: SpeakerIdentityEvidence = {
      speakerId: raw.speakerId as `speaker_${number}`,
      displayName: nameAllowed ? raw.displayName?.trim() : undefined,
      nameSource: nameAllowed ? raw.nameSource : "unknown",
      confidence: nameAllowed ? raw.confidence : Math.min(raw.confidence, 0.69),
      evidence: nameAllowed ? raw.evidence?.trim() : undefined,
      sourceSegmentIds: unique([...raw.sourceSegmentIds, sourceSegmentId]).filter((id) => allowedSourceIds.has(id))
    };
    const existing = byId.get(speaker.speakerId);
    const chosen = !existing || speaker.confidence >= existing.confidence ? speaker : existing;
    byId.set(speaker.speakerId, {
      ...existing,
      ...chosen,
      sourceSegmentIds: unique([...(existing?.sourceSegmentIds ?? []), ...speaker.sourceSegmentIds])
    });
  }
  return [...byId.values()].sort((left, right) => left.speakerId.localeCompare(right.speakerId));
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function minIso(left: string, right: string) {
  return Date.parse(right) < Date.parse(left) ? right : left;
}

function maxIso(left: string, right: string) {
  return Date.parse(right) > Date.parse(left) ? right : left;
}

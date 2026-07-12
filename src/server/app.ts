import cors from "cors";
import express from "express";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { appendInputMessage, appendPapoMessage } from "../core/conversation";
import { updateClientDocument } from "../core/client-document";
import { audioObservationPreview, imageSummaryPreview } from "../core/display-text";
import { applyPetTouchState, isDogStateCheckDue, refreshDogStateIfDue } from "../core/dog-states";
import { isDreamingDue, recordDreamingFailure, semanticDreamMemories } from "../core/dreaming";
import { semanticDecideEmergence } from "../core/emergence";
import { applyFeedback, semanticReflectFeedback } from "../core/feedback";
import { runButtonHarness, runCuriousHarness } from "../core/harness";
import { enqueueMemoryEnrichmentJob, MEMORY_VISUAL_POLICY_VERSION, upsertLongTermMemory } from "../core/memory";
import { createModelProvider, type ImageReference, type ModelProvider } from "../core/provider";
import { explicitUserAge } from "../core/model-safety";
import { deferProactiveEmergence, isProactiveEmergenceDue, markProactiveUserResponse, settleProactiveEmergence } from "../core/proactive";
import { wakeCreature } from "../core/rhythm";
import { clampState, deriveMood } from "../core/state";
import type { ActionCardRecord, ActionResult, CaptureResult, ConversationJobRecord, ConversationTurnRecord, CreatureProfile, EmergenceRecord, FeedbackRecord, IllustrationPlan, IllustrationRecord, LongTermMemory, MediaAttachment, MessageCognitionTrace, PetIdentityProfile, PlannedAction, SemanticBrainRecord, SensingTrace, StreamSegment } from "../core/types";
import { createHermesBridge, type HermesBridge } from "./hermes";
import { JsonDeviceAuthService, type DeviceAuthService } from "./device-auth";
import { NativeIngestQueue, type NativeIngestPayload } from "./native-ingest-queue";
import { createCandidateVisualPreview, enrichMemoryExperience, MemoryEnrichmentFailure } from "./memory-enrichment";
import { createWebPushService, PushNotifyingProfileStore, type WebPushService } from "./push";
import { JsonProfileStore, type ProfileStore } from "./store";
import { PersistentTurnWorker } from "./turn-worker";
import { TransientAudioStore, type RetainedAudioAsset } from "./transient-audio";
import { collectCompanionTurn, companionCognitionContext, processCompanionTurnContext, runCompanionSessionSweep } from "./companion-session";
import { buildAudioSensingPrompt, normalizeAudioSensingResult } from "./audio-sensing";

const createProfileSchema = z.object({
  userId: z.string().min(3).max(40).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  creatureName: z.string().min(1).max(40).optional(),
  petKind: z.string().min(1).max(40).optional()
});

const loginProfileSchema = z.object({
  password: z.string().max(120).optional()
});

const passwordSchema = z.object({
  currentPassword: z.string().max(120).optional(),
  newPassword: z.string().max(120).optional()
});

const updateProfileSchema = z.object({
  creatureName: z.string().trim().min(1).max(40).optional()
}).refine((body) => body.creatureName !== undefined, { message: "No profile fields to update" });

const updateActionCardSchema = z.object({
  disabled: z.boolean().optional(),
  deleted: z.boolean().optional()
});

const buttonSchema = z.object({
  text: z.string().min(1).max(4000)
});

const turnIdSchema = z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const asyncTurnSchema = z.object({
  turnId: turnIdSchema,
  requestId: turnIdSchema,
  channel: z.enum(["button", "curious"]),
  segments: z.array(z.object({
    id: turnIdSchema,
    kind: z.enum(["text", "image_summary", "audio_observation"]),
    label: z.string().min(1).max(80),
    content: z.string().max(24_000).optional(),
    dataUrl: z.string().max(24_000_000).optional(),
    auditOnly: z.boolean().optional(),
    observedAt: z.string().datetime().optional(),
    batchId: z.string().min(1).max(100).optional(),
    companionSessionId: z.string().min(1).max(100).optional(),
    location: z.lazy(() => locationSchema).optional(),
    sensingTrace: z.lazy(() => sensingTraceSchema).optional()
  }).superRefine((segment, context) => {
    if (segment.kind === "text" && !segment.content?.trim()) context.addIssue({ code: "custom", message: "Text is empty" });
    if (segment.kind === "text" && (segment.content?.length ?? 0) > 4_000) context.addIssue({ code: "custom", message: "Text is too long" });
    if (segment.kind !== "text" && !segment.dataUrl && !(segment.content?.trim() && segment.sensingTrace)) context.addIssue({ code: "custom", message: "Media data or sensing result is missing" });
  })).min(1).max(12)
});

const petTouchSchema = z.object({
  action: z.enum(["idle", "poke-wave", "play-ball", "nap"])
});

const speakerEvidenceSchema = z.object({
  speakerId: z.string().regex(/^speaker_[1-9]\d*$/).transform((value) => value as `speaker_${number}`),
  displayName: z.string().max(120).optional(),
  nameSource: z.enum(["unknown", "user_statement", "self_introduction", "reliable_context"]),
  confidence: z.number().min(0).max(1),
  evidence: z.string().max(500).optional(),
  sourceSegmentIds: z.array(z.string().max(120)).max(40)
});

const audioContentSchema = z.object({
  sceneType: z.enum(["environment", "conversation", "lecture", "meeting", "interview", "unknown"]),
  transcript: z.string().max(20_000),
  environmentObservation: z.string().max(800).optional(),
  speakers: z.array(speakerEvidenceSchema).max(12)
});

const sensingTraceSchema = z.object({
  at: z.string().datetime(),
  modality: z.enum(["audio", "image"]),
  label: z.string().min(1).max(120),
  provider: z.string().min(1).max(120),
  model: z.string().max(160).optional(),
  route: z.string().max(80).optional(),
  semanticSource: z.literal("llm"),
  status: z.enum(["content", "empty", "unreadable"]),
  decision: z.string().min(1).max(600),
  observation: z.string().max(24_000).optional(),
  audioContent: audioContentSchema.optional(),
  ruleTrace: z.array(z.string().max(240)).max(12)
});

const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().optional(),
  label: z.string().min(1).max(120).optional()
});

const mediaAttachmentSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.literal("image"),
  label: z.string().min(1).max(120),
  mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
  url: z.string().min(1).max(300),
  createdAt: z.string().datetime(),
  observedAt: z.string().datetime().optional(),
  location: locationSchema.optional(),
  sizeBytes: z.number().int().nonnegative().optional()
});

const petProfileRequestSchema = z.object({
  guidance: z.string().trim().max(1200).optional(),
  referenceSummary: z.string().trim().max(1200).optional(),
  referenceAttachment: mediaAttachmentSchema.optional()
}).refine((body) => Boolean(body.guidance || body.referenceSummary || body.referenceAttachment), { message: "No pet profile material" });

const initialActionCardSchema = z.object({
  guidance: z.string().trim().max(800).optional()
});

const curiousSchema = z.object({
  segments: z
    .array(
      z.object({
        id: z.string().min(1),
        kind: z.enum(["text", "image_summary", "audio_observation"]),
        label: z.string().min(1).max(80),
        content: z.string().max(24_000),
        auditOnly: z.boolean().optional(),
        observedAt: z.string().datetime().optional(),
        batchId: z.string().min(1).max(80).optional(),
        companionSessionId: z.string().min(1).max(100).optional(),
        location: locationSchema.optional(),
        attachments: z.array(mediaAttachmentSchema).max(6).optional(),
        sensingTrace: sensingTraceSchema.optional()
      })
    )
    .min(1)
    .max(12)
});

const imageSummarySchema = z.object({
  dataUrl: imageDataUrlSchema(),
  label: z.string().min(1).max(80).optional()
});

const audioObservationSchema = z.object({
  dataUrl: audioDataUrlSchema(),
  label: z.string().min(1).max(80).optional()
});

const nativeListeningBatchSchema = z.object({
  batchId: z.string().min(1).max(80),
  companionSessionId: z.string().min(1).max(100).optional(),
  observedAt: z.string().datetime(),
  audioDataUrl: audioDataUrlSchema().optional(),
  imageDataUrl: imageDataUrlSchema().optional(),
  cameraFacing: z.enum(["front", "back"]).optional()
}).refine((body) => Boolean(body.audioDataUrl || body.imageDataUrl), { message: "Native listening batch is empty" });

const companionSessionSchema = z.object({
  id: z.string().min(8).max(100).regex(/^[a-zA-Z0-9:._-]+$/),
  startedAt: z.string().datetime()
});

const endCompanionSessionSchema = z.object({
  endedAt: z.string().datetime()
});

const feedbackSchema = z.object({
  kind: z.enum(["understood", "continue", "not_now", "remember", "important", "remind", "correct", "forget"]),
  targetId: z.string().optional(),
  content: z.string().max(1200).optional(),
  modality: z.enum(["text", "audio_observation", "button"]).optional()
});

const updateMemorySchema = z.object({
  text: z.string().min(1).max(1000)
});

const readStateSchema = z.object({
  lastReadPapoMessageId: z.string().min(1).optional()
});

const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048).refine(isTrustedPushEndpoint, "Unsupported Web Push endpoint"),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512)
  }),
  appUrl: z.string().url().max(2048)
});

const removePushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048)
});

export function createApp(input: {
  store?: ProfileStore;
  provider?: ModelProvider;
  push?: WebPushService;
  deviceAuth?: DeviceAuthService;
  nativeIngest?: { directory?: string; intervalMs?: number; autoStart?: boolean; audioDirectory?: string; audioRetentionMs?: number; audioCleanupIntervalMs?: number };
  proactive?: { enabled?: boolean; intervalMs?: number };
  hermes?: { enabled?: boolean; bridge?: HermesBridge };
  turns?: { autoStart?: boolean; concurrency?: number; intervalMs?: number };
} = {}) {
  const push = input.push ?? createWebPushService();
  const deviceAuth = input.deviceAuth ?? new JsonDeviceAuthService();
  const baseStore = input.store ?? new JsonProfileStore();
  const store = push.enabled ? new PushNotifyingProfileStore(baseStore, push) : baseStore;
  const provider = input.provider ?? createModelProvider();
  const hermesBridge = input.hermes?.bridge ?? (input.hermes?.enabled ? createHermesBridge({ store, provider }) : undefined);
  const app = express();
  const nativeBatchLocks = new Map<string, Promise<void>>();
  const transientAudioStore = new TransientAudioStore(
    input.nativeIngest?.audioDirectory,
    input.nativeIngest?.audioRetentionMs,
    input.nativeIngest?.audioCleanupIntervalMs
  );
  transientAudioStore.start();
  app.locals.transientAudioStore = transientAudioStore;

  const turnWorker = new PersistentTurnWorker({
    store,
    concurrency: input.turns?.concurrency ?? 3,
    intervalMs: input.turns?.intervalMs ?? 250,
    handle: processConversationJob
  });
  app.locals.turnWorker = turnWorker;
  if (input.turns?.autoStart !== false) void turnWorker.start();

  async function persistCuriousCapture(profile: CreatureProfile, segments: StreamSegment[]) {
    markProactiveUserResponse(profile);
    const beforeSemanticIds = semanticRecordIds(profile);
    const result = await runCuriousHarness(profile, segments, provider, new Date().toISOString(), { inputSource: "ambient" });
    await hermesBridge?.enqueueTasks(profile, result);
    applyPetProfileActionResults(profile, result);
    const illustrationAttachments = await executeIllustrationActions(profile, result, provider, "action");
    const modelRuns = newSemanticRuns(profile, beforeSemanticIds);
    const sensingTraces = segments.flatMap((segment) => segment.sensingTrace ? [segment.sensingTrace] : []);
    const cognitionTrace = captureCognitionTrace(result, provider, "curious_stream", modelRuns, sensingTraces);
    for (const segment of segments) {
      const text = `${segment.label}：${segment.content}`;
      appendInputMessage(profile, {
        channel: "curious",
        role: segment.kind === "text" ? "user" : "world",
        text,
        displayText: segmentDisplayText(segment.kind, text),
        auditOnly: segment.auditOnly,
        sourceId: segment.id,
        modality: segment.kind,
        batchId: segment.batchId,
        observedAt: segment.observedAt,
        location: segment.location,
        attachments: segment.attachments,
        sensingTrace: segment.sensingTrace,
        cognitionTrace
      });
    }
    appendPapoMessage(profile, {
      channel: "curious",
      text: result.response,
      sourceId: result.episodes[0]?.id ?? result.curiousSession?.id ?? result.events[0]?.id,
      relatedMemoryIds: result.events.flatMap((event) => event.relatedMemoryIds),
      attachments: illustrationAttachments,
      cognitionTrace
    });
    await store.saveProfile(profile);
    queueActionCardGeneration({ store, userId: profile.userId, result, provider });
    turnWorker.wake();
    return result;
  }

  async function processConversationJob(userId: string, job: ConversationJobRecord) {
    if (job.type === "image_understanding" || job.type === "audio_understanding") {
      const current = await store.getProfile(userId);
      const segment = current?.turns?.find((turn) => turn.id === job.turnId)?.segments.find((item) => item.id === job.segmentId);
      const attachment = segment?.attachments?.[0];
      if (!current || !segment || !attachment) throw new Error("Turn media source is missing");
      const dataUrl = await mediaAttachmentDataUrl(attachment);
      if (!dataUrl) throw new Error("Turn media asset is unreadable");
      let content = "";
      let trace: SensingTrace;
      if (job.type === "image_understanding") {
        const prompt = `请用中文把这张图片压缩成一段 80 字以内的生活场景摘要，给 Curious Mode 当 image_summary。标签：${segment.label}`;
        content = (await provider.summarizeImage(dataUrl, prompt)).slice(0, 600).trim();
        trace = imageSensingTrace(provider, segment.label, content);
      } else {
        const prompt = buildAudioSensingPrompt(segment.label, companionAudioSensingContext(current, segment.companionSessionId) ?? companionCognitionContext(current, job.turnId)?.currentContext);
        const observation = normalizeAudioObservation(await observeAudioForSensing(provider, dataUrl, prompt));
        content = observation.text;
        trace = audioSensingTrace(provider, segment.label, observation, { sourceSegmentId: segment.id });
      }
      await store.updateProfile(userId, (profile) => {
        const stored = profile.turns?.find((turn) => turn.id === job.turnId)?.segments.find((item) => item.id === job.segmentId);
        if (!stored) return;
        stored.content = content;
        stored.sensingTrace = trace;
        const turn = profile.turns?.find((item) => item.id === job.turnId);
        if (turn) collectCompanionTurn(profile, turn.id, [stored]);
        const message = profile.conversation.find((item) => item.turnId === job.turnId && item.sourceId === job.segmentId);
        if (message) {
          message.text = `${stored.label}：${content || (trace.status === "unreadable" ? "音频无法读取" : "没有识别到可用内容")}`;
          message.displayText = stored.kind === "image_summary" ? "一张照片" : "一段录音";
          message.sensingTrace = trace;
        }
      });
      return { attachmentIds: [attachment.id] };
    }

    if (job.type === "cognition") return processCognitionJob(userId, job);
    if (job.type === "memory_enrichment") return processTurnMemoryEnrichment(userId, job);
    if (job.type === "candidate_visual") return processCandidateVisual(userId, job);
    return processActionJob(userId, job);
  }

  async function processCognitionJob(userId: string, job: ConversationJobRecord) {
    await processCompanionTurnContext(store, provider, userId, job.turnId).catch((error) => {
      console.warn("Companion context update deferred to background sweep", { userId, turnId: job.turnId, error: error instanceof Error ? error.message : String(error) });
    });
    const profile = await store.getProfile(userId);
    const turn = profile?.turns?.find((item) => item.id === job.turnId);
    if (!profile || !turn) throw new Error("Conversation turn is missing");
    const existing = profile.conversation.find((message) => message.jobId === job.id && message.role === "papo");
    if (existing) return { messageId: existing.id };
    const baseProfile = structuredClone(profile);
    markProactiveUserResponse(profile);
    const beforeSemanticIds = semanticRecordIds(profile);
    const cognitionContext = {
      inputSource: isAmbientTurn(turn) ? "ambient" as const : "direct" as const,
      companion: companionCognitionContext(profile, turn.id)
    };
    const result = turn.channel === "button" && turn.segments.length === 1 && turn.segments[0].kind === "text"
      ? await runButtonHarness(profile, turn.segments[0].content, provider, new Date().toISOString(), cognitionContext)
      : await runCuriousHarness(profile, turn.segments, provider, new Date().toISOString(), cognitionContext);
    applyPetProfileActionResults(profile, result);
    const modelRuns = newSemanticRuns(profile, beforeSemanticIds);
    const sensingTraces = turn.segments.flatMap((segment) => segment.sensingTrace ? [segment.sensingTrace] : []);
    const cognitionTrace = captureCognitionTrace(result, provider, turn.channel === "button" ? "button" : "curious_stream", modelRuns, sensingTraces);
    const inputMessages = profile.conversation.filter((message) => turn.inputMessageIds.includes(message.id));
    for (const message of inputMessages) message.cognitionTrace = cognitionTrace;
    const reply = appendPapoMessage(profile, {
      channel: turn.channel,
      text: result.response,
      sourceId: `${turn.id}:reply`,
      turnId: turn.id,
      jobId: job.id,
      requestId: turn.requestId,
      relatedMemoryIds: result.events.flatMap((event) => event.relatedMemoryIds),
      cognitionTrace
    });
    const baseJobIds = new Set((baseProfile.jobs ?? []).map((item) => item.id));
    const lifecycleJobs = (profile.jobs ?? []).filter((item) => !baseJobIds.has(item.id) && (item.type === "memory_enrichment" || item.type === "candidate_visual"));
    const childJobs = [...plannedConversationJobs(turn, job, result), ...lifecycleJobs];
    profile.jobs = [...childJobs, ...(profile.jobs ?? [])].filter((item, index, list) => list.findIndex((other) => other.id === item.id) === index).slice(0, 240);
    turn.jobIds = [...new Set([...turn.jobIds, ...childJobs.map((item) => item.id)])];
    const saved = await store.updateProfile(userId, (latest) => {
      commitCognitionOwnedRecords(latest, baseProfile, profile, result, inputMessages, reply, childJobs, job);
    });
    if (!saved) throw new Error("Profile disappeared before cognition commit");
    result.profile = saved;
    turnWorker.wake();
    return {
      messageId: reply?.id,
      episodeIds: result.episodes.map((episode) => episode.id),
      memoryIds: lifecycleJobs.flatMap((item) => item.type === "memory_enrichment" && item.memoryId ? [item.memoryId] : []),
      memorySourceIds: [turn.id, job.id],
      cognition: {
        inputSource: cognitionContext.inputSource,
        attention: result.events.length ? "selected" as const : "ignored" as const,
        actions: result.events.map((event) => event.actionDecision.action),
        visibleReply: Boolean(reply),
        episodeIds: result.episodes.map((episode) => episode.id)
      }
    };
  }

  async function processTurnMemoryEnrichment(userId: string, job: ConversationJobRecord) {
    const memoryId = job.memoryId ?? job.sourceIds.find((id) => id.startsWith("ltm_"));
    const snapshot = await store.getProfile(userId);
    const memory = snapshot?.longTermMemories.find((item) => item.id === memoryId && item.weight > 0);
    if (!snapshot || !memory) return { memoryDecision: "skipped_duplicate" as const, memoryReason: "Memory no longer exists", memorySourceIds: job.sourceIds };
    const revision = job.memoryRevision ?? memory.contentRevision ?? 1;
    if ((memory.contentRevision ?? 1) !== revision) {
      return { memoryIds: [memory.id], memorySourceIds: job.sourceIds, memoryDecision: "skipped_duplicate" as const, memoryReason: `Stale enrichment revision ${revision}; current revision is ${memory.contentRevision ?? 1}` };
    }
    try {
      await enrichMemoryExperience(snapshot, memory, provider, { throwOnVisualError: true });
      await updateClientDocument(snapshot, provider, [memory.id]);
      memory.enrichedRevision = revision;
      memory.enrichmentStatus = "completed";
      memory.enrichmentError = undefined;
      const saved = await store.updateProfile(userId, (latest) => {
        const target = latest.longTermMemories.find((item) => item.id === memory.id && item.weight > 0);
        if (!target || (target.contentRevision ?? 1) !== revision) return;
        applyMemoryEnrichmentResult(target, memory, job, true);
        if ((snapshot.clientDocument?.revision ?? 0) > (latest.clientDocument?.revision ?? 0)) latest.clientDocument = snapshot.clientDocument;
      });
      if (!saved) throw new Error("Profile disappeared before memory enrichment commit");
    } catch (error) {
      const computed = error instanceof MemoryEnrichmentFailure ? error.memory : memory;
      await store.updateProfile(userId, (latest) => {
        const target = latest.longTermMemories.find((item) => item.id === memory.id && item.weight > 0);
        if (!target || (target.contentRevision ?? 1) !== revision) return;
        applyMemoryEnrichmentResult(target, computed, job, false);
        target.enrichmentStatus = "failed";
        target.enrichmentError = error instanceof Error ? error.message.slice(0, 300) : "Unknown memory enrichment error";
        target.visualError ??= target.enrichmentError;
      });
      throw error;
    }
    return { memoryIds: [memory.id], memorySourceIds: [...new Set([job.turnId, job.id, memory.id])], memoryDecision: "created" as const, memoryReason: "Primary cognition approved this long-term memory; presentation was enriched idempotently" };
  }

  async function processCandidateVisual(userId: string, job: ConversationJobRecord) {
    const candidateId = job.candidateId ?? job.sourceIds.find((id) => id.startsWith("candidate_"));
    const snapshot = await store.getProfile(userId);
    const candidate = snapshot?.memoryCandidates.find((item) => item.id === candidateId);
    if (!snapshot || !candidate) return { memoryDecision: "skipped_duplicate" as const, memoryReason: "Candidate no longer exists", memorySourceIds: job.sourceIds };
    const promotedMemory = candidate.status === "promoted" ? snapshot.longTermMemories.find((memory) => memory.sourceEpisodeId === candidate.sourceEpisodeId) : undefined;
    if (candidate.status !== "candidate" && !promotedMemory) return { memoryDecision: "skipped_duplicate" as const, memoryReason: "Candidate was dismissed", memorySourceIds: job.sourceIds };
    if (candidate.previewVisual || candidate.previewStatus === "not_needed") {
      return { attachmentIds: candidate.previewVisual ? [candidate.previewVisual.id] : [], memoryDecision: "skipped_duplicate" as const, memoryReason: "Candidate preview already exists", memorySourceIds: job.sourceIds };
    }
    try {
      const preview = await createCandidateVisualPreview(snapshot, candidate, provider);
      await store.updateProfile(userId, (latest) => {
        const target = latest.memoryCandidates.find((item) => item.id === candidate.id);
        if (!target) return;
        if (!target.previewVisual && target.previewStatus !== "not_needed") Object.assign(target, preview, { previewError: undefined });
        if (target.status !== "promoted") return;
        const memory = latest.longTermMemories.find((item) => item.sourceEpisodeId === target.sourceEpisodeId);
        if (!memory || memory.visual) return;
        memory.visual = preview.previewVisual;
        memory.visualPrompt = preview.previewPrompt;
        memory.visualMode = preview.previewMode;
        memory.papoPresence = preview.previewPapoPresence;
        memory.visualPlanReason = preview.previewPlanReason;
        memory.narrative = preview.previewNarrative ?? memory.narrative;
        memory.visualPolicyVersion = MEMORY_VISUAL_POLICY_VERSION;
        memory.visualStatus = preview.previewVisual ? "ready" : preview.previewStatus === "not_needed" ? "not_needed" : "failed";
        memory.visualUpdatedAt = preview.previewUpdatedAt;
        memory.enrichedRevision = memory.contentRevision;
        memory.enrichmentStatus = "completed";
      });
      const committed = await store.getProfile(userId);
      const committedMemory = committed?.longTermMemories.find((item) => item.sourceEpisodeId === candidate.sourceEpisodeId && item.weight > 0);
      if (committed && committedMemory) {
        await updateClientDocument(committed, provider, [committedMemory.id]);
        await store.updateProfile(userId, (latest) => {
          if ((committed.clientDocument?.revision ?? 0) > (latest.clientDocument?.revision ?? 0)) latest.clientDocument = committed.clientDocument;
        });
      }
      return { attachmentIds: preview.previewVisual ? [preview.previewVisual.id] : [], memorySourceIds: [job.id, candidate.id] };
    } catch (error) {
      await store.updateProfile(userId, (latest) => {
        const target = latest.memoryCandidates.find((item) => item.id === candidate.id);
        if (!target) return;
        const terminal = job.attempt >= job.maxAttempts;
        target.previewStatus = terminal ? "not_needed" : "failed";
        target.previewError = terminal ? undefined : error instanceof Error ? error.message.slice(0, 300) : "Unknown candidate preview error";
        if (terminal) {
          target.previewMode = "no_visual";
          target.previewPapoPresence = "absent";
          target.previewPlanReason = "可选预览暂不可用，继续使用文字候选";
        }
        target.previewUpdatedAt = new Date().toISOString();
        if (target.status !== "promoted" || !terminal) return;
        const memory = latest.longTermMemories.find((item) => item.sourceEpisodeId === target.sourceEpisodeId && item.weight > 0);
        if (!memory) return;
        memory.enrichmentStatus = "pending";
        memory.visualStatus = memory.visual ? "ready" : "pending";
        memory.enrichmentError = undefined;
        enqueueMemoryEnrichmentJob(latest, memory, { sourceIds: [job.id, target.id] });
      });
      throw error;
    }
  }

  async function processActionJob(userId: string, job: ConversationJobRecord) {
    const profile = await store.getProfile(userId);
    if (!profile || !job.event || !job.action) throw new Error("Background action source is missing");
    const existing = profile.conversation.find((message) => message.jobId === job.id && message.role === "papo");
    if (existing) return {
      messageId: existing.id,
      attachmentIds: existing.attachments?.map((item) => item.id),
      memoryDecision: "skipped_duplicate" as const,
      memoryReason: "This job output was already committed"
    };
    const baseIllustrationIds = new Set((profile.illustrations ?? []).map((item) => item.id));
    const baseActionCardIds = new Set((profile.actionCards ?? []).map((item) => item.id));
    const baseHermesTaskIds = new Set((profile.hermes.tasks ?? []).map((item) => item.id));
    const event = structuredClone(job.event);
    event.actionDecision = { ...event.actionDecision, action: job.action.action };
    event.suggestedAction = job.action.action;
    event.actionResult = structuredClone(job.action.actionResult);
    const episode = job.episodeId ? profile.episodes.find((item) => item.id === job.episodeId) : undefined;
    const result: CaptureResult = { profile, events: [event], episodes: episode ? [structuredClone(episode)] : [], response: "" };
    let attachments: MediaAttachment[] = [];
    if (job.type === "illustration") attachments = await executeIllustrationActions(profile, result, provider, "action");
    if (job.type === "action_card") {
      attachments = await executeActionCardActions(profile, result, provider, "action");
      applyActionCardCompletion(profile, result, attachments);
    }
    if (job.type === "hermes") {
      if (!hermesBridge) throw new Error("Hermes is not configured");
      await hermesBridge.enqueueTasks(profile, result);
    }
    const text = job.type === "illustration"
      ? job.action.actionResult.caption ?? job.action.actionResult.title ?? "画好啦，给你看。"
      : job.type === "action_card"
        ? job.action.actionResult.caption ?? job.action.actionResult.title ?? "动作做好啦。"
        : "已经把这件事交给虾虾继续处理。";
    const message = attachments.length ? appendPapoMessage(profile, {
      channel: profile.turns?.find((turn) => turn.id === job.turnId)?.channel ?? "curious",
      text,
      sourceId: job.id,
      turnId: job.turnId,
      jobId: job.id,
      requestId: job.requestId,
      attachments
    }) : undefined;
    for (const illustration of profile.illustrations ?? []) if (attachments.some((item) => item.id === illustration.attachment.id)) {
      illustration.messageId = message?.id;
      illustration.turnId = job.turnId;
      illustration.jobId = job.id;
    }
    for (const card of profile.actionCards ?? []) if (attachments.some((item) => item.id === card.video.id)) {
      card.messageId = message?.id;
      card.turnId = job.turnId;
      card.jobId = job.id;
    }
    const ownedIllustrations = (profile.illustrations ?? []).filter((item) => !baseIllustrationIds.has(item.id));
    const ownedActionCards = (profile.actionCards ?? []).filter((item) =>
      !baseActionCardIds.has(item.id)
      || (item.replacedByActionCardId && attachments.some((attachment) => attachment.id === item.replacedByActionCardId))
    );
    const ownedHermesTasks = (profile.hermes.tasks ?? []).filter((item) => !baseHermesTaskIds.has(item.id));
    const saved = await store.updateProfile(userId, (latest) => {
      if (message) latest.conversation = mergeOwnedById(latest.conversation, [message]).slice(0, 80);
      latest.illustrations = mergeOwnedById(latest.illustrations ?? [], ownedIllustrations).slice(0, 30);
      latest.actionCards = mergeOwnedById(latest.actionCards ?? [], ownedActionCards).slice(0, 30);
      latest.hermes.tasks = mergeOwnedById(latest.hermes.tasks ?? [], ownedHermesTasks).slice(0, 30);
      if (attachments.length && job.episodeId) linkActionAttachmentsToMemorySources(latest, job, attachments);
    });
    if (!saved) throw new Error("Profile disappeared before action commit");
    return {
      messageId: message?.id,
      attachmentIds: attachments.map((item) => item.id),
      memorySourceIds: attachments.length ? [...new Set([job.turnId, job.id, ...attachments.map((item) => item.id)])] : undefined,
      memoryDecision: "skipped_no_new_fact" as const,
      memoryReason: job.type === "illustration" || job.type === "action_card"
        ? "Generated media presents facts already evaluated during primary cognition"
        : "Hermes handoff has no external result to evaluate yet"
    };
  }

  async function processNativeBatch(userId: string, body: NativeIngestPayload) {
    const lockKey = `${userId}\u0000${body.batchId}`;
    const previous = nativeBatchLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    nativeBatchLocks.set(lockKey, tail);
    await previous;
    try {
      const profile = await requireExistingProfile(store, userId);
      const sourceIds = [`${body.batchId}:audio`, `${body.batchId}:image`];
      if (profile.conversation.some((message) => message.sourceId && sourceIds.includes(message.sourceId))) return;

      const segments: StreamSegment[] = [];
      if (body.audioDataUrl) {
        const retainedAudio = await transientAudioStore.save(userId, body.batchId, body.audioDataUrl, new Date());
        const sessionContext = companionAudioSensingContext(profile, body.companionSessionId);
        const prompt = buildAudioSensingPrompt("Android 后台倾听", sessionContext);
        const sensed = await observeAudioWithUnreadableRetry(provider, body.audioDataUrl, prompt);
        const observation = sensed.observation;
        const sensingTrace = audioSensingTrace(provider, "Android 后台倾听", observation, { attempts: sensed.attempts, retainedAudio, sourceSegmentId: `${body.batchId}:audio` });
        segments.push({
          id: `${body.batchId}:audio`,
          kind: "audio_observation",
          label: "后台听到的声音",
          content: observation.text || nativeAudioAuditSummary(sensingTrace.status),
          auditOnly: sensingTrace.status !== "content",
          observedAt: body.observedAt,
          batchId: body.batchId,
          companionSessionId: body.companionSessionId,
          sensingTrace
        });
      }
      if (body.imageDataUrl) {
        const facing = body.cameraFacing === "back" ? "后置" : "前置";
        const prompt = `请用中文把这张 ${facing}摄像头定时取帧压缩成一段 100 字以内的生活场景观察，给 Papo 后续注意机制使用。只描述画面直接可见的事实，不推断身份、关系、情绪、隐私或画面外事件；看不清就返回空文本。`;
        const summary = (await provider.summarizeImage(body.imageDataUrl, prompt)).slice(0, 600).trim();
        const sensingTrace = imageSensingTrace(provider, `Android ${facing}摄像头`, summary);
        segments.push({
          id: `${body.batchId}:image`,
          kind: "image_summary",
          label: `${facing}摄像头看到的画面`,
          content: summary || "这次定时画面没有看清。",
          auditOnly: !summary,
          observedAt: body.observedAt,
          batchId: body.batchId,
          companionSessionId: body.companionSessionId,
          sensingTrace
        });
      }
      await persistSensedCompanionTurn(userId, body.batchId, segments);
    } finally {
      release();
      if (nativeBatchLocks.get(lockKey) === tail) nativeBatchLocks.delete(lockKey);
    }
  }

  async function persistSensedCompanionTurn(userId: string, batchId: string, segments: StreamSegment[]) {
    const turnId = `turn_native_${batchId.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 100);
    const now = new Date().toISOString();
    const cognitionJob: ConversationJobRecord = {
      id: `${turnId}-cognition`, turnId, requestId: turnId, type: "cognition", stage: "cognition", status: "queued",
      attempt: 0, maxAttempts: 3, retryable: true, createdAt: now, updatedAt: now,
      sourceIds: [turnId, ...segments.map((segment) => segment.id)]
    };
    const saved = await store.updateProfile(userId, (profile) => {
      if (profile.turns?.some((turn) => turn.id === turnId || turn.requestId === turnId)) return;
      const inputMessageIds: string[] = [];
      markProactiveUserResponse(profile, now);
      for (const segment of segments) {
        const text = `${segment.label}：${segment.content}`;
        const message = appendInputMessage(profile, {
          channel: "curious", role: "world", text, displayText: segmentDisplayText(segment.kind, text), auditOnly: segment.auditOnly,
          sourceId: segment.id, turnId, requestId: turnId, modality: segment.kind, batchId: segment.batchId,
          observedAt: segment.observedAt, location: segment.location, attachments: segment.attachments, sensingTrace: segment.sensingTrace
        });
        if (message) inputMessageIds.push(message.id);
      }
      const turn: ConversationTurnRecord = { id: turnId, requestId: turnId, channel: "curious", status: "queued", createdAt: now, updatedAt: now, inputMessageIds, jobIds: [cognitionJob.id], segments };
      profile.turns = [turn, ...(profile.turns ?? [])].slice(0, 80);
      profile.jobs = [cognitionJob, ...(profile.jobs ?? [])].slice(0, 240);
      collectCompanionTurn(profile, turnId, segments);
    });
    if (!saved) throw new Error("Profile disappeared before companion turn commit");
    turnWorker.wake();
  }

  const nativeIngestQueue = new NativeIngestQueue(
    processNativeBatch,
    input.nativeIngest?.directory,
    input.nativeIngest?.intervalMs,
    input.nativeIngest?.audioRetentionMs
  );
  if (input.nativeIngest?.autoStart !== false) nativeIngestQueue.start();

  app.use(cors());
  app.use(express.json({ limit: "28mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, provider: provider.kind });
  });

  app.get("/api/provider", (_req, res) => {
    res.json({
      kind: provider.kind,
      name: provider.name,
      available: provider.available,
      usesRealModel: provider.usesRealModel,
      diagnostics: provider.diagnostics
    });
  });

  app.get("/api/push/config", (_req, res) => {
    res.json({ enabled: push.enabled, publicKey: push.publicKey });
  });

  app.post("/api/profiles/:userId/device-sessions", async (req, res, next) => {
    try {
      await requireProfile(store, req.params.userId, req);
      res.status(201).json(await deviceAuth.create(req.params.userId));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/profiles/:userId/device-sessions", async (req, res, next) => {
    try {
      await requireProfile(store, req.params.userId, req);
      await deviceAuth.revokeAll(req.params.userId);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/push-subscriptions", async (req, res, next) => {
    try {
      await requireProfile(store, req.params.userId, req);
      const subscription = pushSubscriptionSchema.parse(req.body);
      if (!push.enabled) throw new HttpError(503, "Web Push is not configured");
      await push.subscribe(req.params.userId, subscription);
      res.status(201).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/profiles/:userId/push-subscriptions", async (req, res, next) => {
    try {
      await requireProfile(store, req.params.userId, req);
      const body = removePushSubscriptionSchema.parse(req.body);
      await push.unsubscribe(req.params.userId, body.endpoint);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/assets/:filename", async (req, res, next) => {
    try {
      const filename = req.params.filename;
      if (!/^(img|vid|aud)_[a-f0-9]{24}\.(png|jpg|webp|mp4|webm|wav|mp3|m4a|ogg|aac)$/.test(filename)) throw new HttpError(404, "Asset not found");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.sendFile(path.join(imageAssetDir(), filename));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/image-summary", async (req, res, next) => {
    try {
      const body = imageSummarySchema.parse(req.body);
      const asset = await saveImageAsset(body.dataUrl, body.label ?? "照片");
      const prompt = `请用中文把这张图片压缩成一段 80 字以内的生活场景摘要，给 Curious Mode 当 image_summary。标签：${body.label ?? "截图"}`;
      const summary = (await provider.summarizeImage(body.dataUrl, prompt)).slice(0, 600);
      const trace = imageSensingTrace(provider, body.label ?? "截图", summary);
      res.json({
        summary,
        asset,
        provider: sensingProvider(provider, "vision"),
        model: provider.diagnostics?.visionModel,
        route: "chat_completions",
        semanticSource: "llm",
        sensingTrace: trace
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/camera-observation", async (req, res, next) => {
    try {
      const body = imageSummarySchema.parse(req.body);
      const prompt = `请用中文把这张定时摄像头画面压缩成一段 100 字以内的生活场景观察，给 Papo 后续注意机制使用。只描述画面直接可见的事实，不推断身份、关系、情绪、隐私或画面外事件；看不清就返回空文本。标签：${body.label ?? "陪伴画面"}`;
      const summary = (await provider.summarizeImage(body.dataUrl, prompt)).slice(0, 600).trim();
      const trace = imageSensingTrace(provider, body.label ?? "陪伴画面", summary);
      res.json({
        summary,
        provider: sensingProvider(provider, "vision"),
        model: provider.diagnostics?.visionModel,
        route: "chat_completions",
        semanticSource: "llm",
        sensingTrace: trace
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/audio-observation", async (req, res, next) => {
    try {
      const body = audioObservationSchema.parse(req.body);
      const prompt = buildAudioSensingPrompt(body.label ?? "录音");
      const audioObservation = normalizeAudioObservation(await observeAudioForSensing(provider, body.dataUrl, prompt));
      const trace = audioSensingTrace(provider, body.label ?? "录音", audioObservation);
      res.json({
        observation: audioObservation.text,
        noSpeech: !audioObservation.text,
        unreadable: audioObservation.unreadable,
        provider: sensingProvider(provider, "audio"),
        model: provider.diagnostics?.audioModel,
        route: provider.diagnostics?.audioRoute,
        semanticSource: "llm",
        sensingTrace: trace
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/profiles", async (_req, res, next) => {
    try {
      res.json({ profiles: await store.listProfiles() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles", async (req, res, next) => {
    try {
      const body = createProfileSchema.parse(req.body);
      if (body.userId && await store.getProfile(body.userId)) {
        throw new HttpError(409, "User ID already exists");
      }
      const profile = await store.createProfile(body);
      res.status(201).json({ profile: publicProfile(profile) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/login", async (req, res, next) => {
    try {
      const profile = await requireExistingProfile(store, req.params.userId);
      const body = loginProfileSchema.parse(req.body);
      assertProfilePassword(profile, body.password);
      res.json({ profile: publicProfile(profile) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/profiles/:userId", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId, req);
      res.json({ profile: publicProfile(profile) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/profiles/:userId", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId, req);
      const body = updateProfileSchema.parse(req.body);
      if (body.creatureName !== undefined) profile.creatureName = body.creatureName;
      await store.saveProfile(profile);
      res.json({ profile: publicProfile(profile) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/pet-profile", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId, req);
      const body = petProfileRequestSchema.parse(req.body);
      const designed = await designPetProfile(profile, body, provider);
      profile.petProfile = designed;
      await store.saveProfile(profile);
      res.json({ profile: publicProfile(profile), petProfile: profile.petProfile });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/pet-profile/initial-action-cards", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId, req);
      const body = initialActionCardSchema.parse(req.body ?? {});
      const existingCount = initialMotionActionCards(profile).length;
      if (existingCount >= 4) {
        profile.petProfile.initialMotion = { status: "ready", completedAt: profile.petProfile.initialMotion?.completedAt, pendingCount: 0 };
        await store.saveProfile(profile);
        res.json({ profile: publicProfile(profile), status: profile.petProfile.initialMotion });
        return;
      }
      const now = new Date().toISOString();
      profile.petProfile.initialMotion = { status: "pending", requestedAt: now, pendingCount: 1 };
      await store.saveProfile(profile);
      queueInitialPetMotionGeneration({ store, userId: profile.userId, provider, guidance: body.guidance });
      res.json({ profile: publicProfile(profile), status: profile.petProfile.initialMotion });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/wake", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId, req);
      const wake = wakeCreature(profile);
      await refreshDogStateIfDue(profile, provider).catch((error) => {
        console.error(`Dog state check failed for ${profile.userId}`, error);
      });
      await store.saveProfile(profile);
      res.json({ profile: publicProfile(profile), wake });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/pet-touch", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId, req);
      const body = petTouchSchema.parse(req.body);
      const dogState = applyPetTouchState(profile, body.action);
      await store.saveProfile(profile);
      res.json({ profile: publicProfile(profile), dogState, applied: Boolean(dogState) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/turns", async (req, res, next) => {
    try {
      await requireProfile(store, req.params.userId, req);
      const body = asyncTurnSchema.parse(req.body);
      const existing = (await store.getProfile(req.params.userId))?.turns?.find((turn) => turn.id === body.turnId || turn.requestId === body.requestId);
      if (existing) {
        const profile = await requireExistingProfile(store, req.params.userId);
        res.json({ profile: publicProfile(profile), turn: existing, jobs: (profile.jobs ?? []).filter((job) => job.turnId === existing.id), duplicate: true });
        return;
      }
      const segments: StreamSegment[] = [];
      for (const inputSegment of body.segments) {
        let attachments: MediaAttachment[] = [];
        if (inputSegment.kind === "image_summary" && inputSegment.dataUrl) {
          attachments = [{ ...(await saveImageAsset(inputSegment.dataUrl, inputSegment.label)), generatedBy: "user_upload", observedAt: inputSegment.observedAt, location: inputSegment.location, turnId: body.turnId }];
        }
        if (inputSegment.kind === "audio_observation" && inputSegment.dataUrl) {
          attachments = [{ ...(await saveAudioAsset(inputSegment.dataUrl, inputSegment.label)), generatedBy: "user_upload", observedAt: inputSegment.observedAt, location: inputSegment.location, turnId: body.turnId }];
        }
        segments.push({
          id: inputSegment.id,
          kind: inputSegment.kind,
          label: inputSegment.label,
          content: inputSegment.content?.trim() ?? "",
          auditOnly: inputSegment.auditOnly,
          observedAt: inputSegment.observedAt,
          batchId: inputSegment.batchId,
          companionSessionId: inputSegment.companionSessionId,
          location: inputSegment.location,
          attachments,
          sensingTrace: inputSegment.sensingTrace
        });
      }
      const now = new Date().toISOString();
      const sensingJobs = segments.filter((segment) => segment.kind !== "text" && !segment.sensingTrace).map((segment): ConversationJobRecord => ({
        id: `${body.turnId}-${segment.kind === "image_summary" ? "vision" : "audio"}-${segment.id}`,
        turnId: body.turnId,
        requestId: body.requestId,
        type: segment.kind === "image_summary" ? "image_understanding" : "audio_understanding",
        stage: "sensing",
        status: "queued",
        attempt: 0,
        maxAttempts: 3,
        retryable: true,
        createdAt: now,
        updatedAt: now,
        sourceIds: [body.turnId, segment.id, ...(segment.attachments ?? []).map((item) => item.id)],
        segmentId: segment.id
      }));
      const cognitionJob: ConversationJobRecord = {
        id: `${body.turnId}-cognition`,
        turnId: body.turnId,
        requestId: body.requestId,
        type: "cognition",
        stage: "cognition",
        status: "queued",
        attempt: 0,
        maxAttempts: 3,
        retryable: true,
        createdAt: now,
        updatedAt: now,
        dependsOn: sensingJobs.map((job) => job.id),
        sourceIds: [body.turnId, ...segments.map((segment) => segment.id)]
      };
      const inputMessageIds: string[] = [];
      const saved = await store.updateProfile(req.params.userId, (profile) => {
        const duplicate = profile.turns?.find((turn) => turn.id === body.turnId || turn.requestId === body.requestId);
        if (duplicate) return;
        markProactiveUserResponse(profile, now);
        for (const segment of segments) {
          const placeholder = segment.kind === "text" ? segment.content : segment.kind === "image_summary" ? "照片已收到，正在理解" : "录音已收到，正在转写";
          const message = appendInputMessage(profile, {
            channel: body.channel,
            role: "user",
            text: segment.kind === "text" ? segment.content : `${segment.label}：${placeholder}`,
            displayText: segment.kind === "text" ? undefined : placeholder,
            sourceId: segment.id,
            turnId: body.turnId,
            requestId: body.requestId,
            modality: segment.kind,
            batchId: segment.batchId,
            observedAt: segment.observedAt,
            location: segment.location,
            attachments: segment.attachments,
            sensingTrace: segment.sensingTrace
          });
          if (message) inputMessageIds.push(message.id);
        }
        const turn: ConversationTurnRecord = {
          id: body.turnId,
          requestId: body.requestId,
          channel: body.channel,
          status: "queued",
          createdAt: now,
          updatedAt: now,
          inputMessageIds,
          jobIds: [...sensingJobs.map((job) => job.id), cognitionJob.id],
          segments
        };
        profile.turns = [turn, ...(profile.turns ?? [])].slice(0, 80);
        profile.jobs = [...sensingJobs, cognitionJob, ...(profile.jobs ?? [])].slice(0, 240);
        collectCompanionTurn(profile, turn.id, segments);
      });
      if (!saved) throw new HttpError(404, "Profile not found");
      const turn = saved.turns?.find((item) => item.id === body.turnId || item.requestId === body.requestId);
      turnWorker.wake();
      res.status(202).json({ profile: publicProfile(saved), turn, jobs: (saved.jobs ?? []).filter((job) => job.turnId === turn?.id), duplicate: turn?.id !== body.turnId });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/button", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId, req);
      const body = buttonSchema.parse(req.body);
      const inputSourceId = `button-${Date.now()}`;
      markProactiveUserResponse(profile);
      const beforeSemanticIds = semanticRecordIds(profile);
      const result = await runButtonHarness(profile, body.text, provider);
      await hermesBridge?.enqueueTasks(profile, result);
      applyPetProfileActionResults(profile, result);
      const illustrationAttachments = await executeIllustrationActions(profile, result, provider, "action");
      const modelRuns = newSemanticRuns(profile, beforeSemanticIds);
      const cognitionTrace = captureCognitionTrace(result, provider, "button", modelRuns);
      appendInputMessage(profile, {
        channel: "button",
        role: "user",
        text: body.text,
        sourceId: inputSourceId,
        modality: "button",
        cognitionTrace
      });
      appendPapoMessage(profile, {
        channel: "button",
        text: result.response,
        sourceId: result.episodes[0]?.id ?? result.events[0]?.id,
        relatedMemoryIds: result.events.flatMap((event) => event.relatedMemoryIds),
        attachments: illustrationAttachments,
        cognitionTrace
      });
      await store.saveProfile(profile);
      queueActionCardGeneration({ store, userId: profile.userId, result, provider });
      turnWorker.wake();
      res.json(publicCaptureResult(result, provider.kind));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/curious", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId, req);
      const body = curiousSchema.parse(req.body);
      const result = await persistCuriousCapture(profile, body.segments as StreamSegment[]);
      res.json(publicCaptureResult(result, provider.kind));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/listening/native-batch", async (req, res, next) => {
    try {
      await requireNativeProfile(store, deviceAuth, req.params.userId, req);
      const body = nativeListeningBatchSchema.parse(req.body);
      const profile = await requireExistingProfile(store, req.params.userId);
      const sourceIds = [`${body.batchId}:audio`, `${body.batchId}:image`];
      if (profile.conversation.some((message) => message.sourceId && sourceIds.includes(message.sourceId))) {
        res.json({ profile: publicProfile(profile), batchId: body.batchId, duplicate: true });
        return;
      }
      const queued = await nativeIngestQueue.enqueue(req.params.userId, body);
      res.status(202).json({ ...queued, batchId: body.batchId });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/companion-sessions", async (req, res, next) => {
    try {
      await requireProfile(store, req.params.userId, req);
      const body = companionSessionSchema.parse(req.body);
      const saved = await store.updateProfile(req.params.userId, (profile) => {
        if (profile.companionSessions?.some((session) => session.id === body.id)) return;
        profile.companionSessions = [{
          id: body.id,
          startedAt: body.startedAt,
          lastObservedAt: body.startedAt,
          updatedAt: body.startedAt,
          status: "active" as const,
          sourceTurnIds: [],
          sourceSegmentIds: [],
          currentContext: { rollingSummary: "", importantContent: [], recentUserNotes: [], updatedAt: body.startedAt },
          observations: [],
          events: []
        }, ...(profile.companionSessions ?? [])].slice(0, 40);
      });
      if (!saved) throw new HttpError(404, "Profile not found");
      res.status(201).json({ profile: publicProfile(saved), session: saved.companionSessions?.find((item) => item.id === body.id) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/profiles/:userId/companion-sessions/:sessionId/end", async (req, res, next) => {
    try {
      await requireProfile(store, req.params.userId, req);
      const body = endCompanionSessionSchema.parse(req.body);
      const saved = await store.updateProfile(req.params.userId, (profile) => {
        const session = profile.companionSessions?.find((item) => item.id === req.params.sessionId);
        if (!session) return;
        session.endedAt = session.endedAt && Date.parse(session.endedAt) <= Date.parse(body.endedAt) ? session.endedAt : body.endedAt;
        session.updatedAt = body.endedAt;
      });
      if (!saved) throw new HttpError(404, "Profile not found");
      res.json({ profile: publicProfile(saved), session: saved.companionSessions?.find((item) => item.id === req.params.sessionId) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/feedback", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId, req);
      const body = feedbackSchema.parse(req.body);
      markProactiveUserResponse(profile, new Date().toISOString());
      const targetBefore = feedbackTargetSnapshot(profile, body.targetId);
      const feedback = applyFeedback(profile, body);
      const beforeSemanticIds = semanticRecordIds(profile);
      await semanticReflectFeedback(profile, feedback, provider);
      const modelRuns = newSemanticRuns(profile, beforeSemanticIds);
      const relatedMemoryIds = feedbackRelatedMemoryIds(profile, body.targetId, targetBefore?.type === "memory" ? targetBefore.id : undefined);
      const cognitionTrace = feedbackCognitionTrace(feedback, provider, modelRuns, profile, targetBefore);
      appendInputMessage(profile, {
        channel: "feedback",
        role: "user",
        text: feedbackInputText(feedback.kind, body.content),
        sourceId: `${feedback.id}:input`,
        modality: body.modality ?? (body.content?.trim() ? "text" : "button"),
        observedAt: feedback.at,
        at: feedback.at,
        relatedMemoryIds,
        cognitionTrace
      });
      appendPapoMessage(profile, {
        channel: "feedback",
        text: feedback.replyText,
        sourceId: feedback.id,
        relatedMemoryIds,
        cognitionTrace
      });
      await store.saveProfile(profile);
      turnWorker.wake();
      res.json({ profile: publicProfile(profile), feedback });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/profiles/:userId/read-state", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId, req);
      const body = readStateSchema.parse(req.body);
      const latestReadable = profile.conversation.find((message) => message.role === "papo" && message.channel !== "wake");
      const requested = body.lastReadPapoMessageId;
      if (requested && !profile.conversation.some((message) => message.id === requested && message.role === "papo" && message.channel !== "wake")) {
        throw new HttpError(400, "Read message not found");
      }
      profile.readState = {
        lastReadPapoMessageId: requested ?? latestReadable?.id,
        lastReadAt: new Date().toISOString()
      };
      await store.saveProfile(profile);
      res.json({ profile: publicProfile(profile) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/profiles/:userId/memories/:memoryId", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId, req);
      const body = updateMemorySchema.parse(req.body);
      const previousMemory = profile.longTermMemories.find((item) => item.id === req.params.memoryId);
      if (!previousMemory) throw new HttpError(404, "Memory not found");
      markProactiveUserResponse(profile, new Date().toISOString());
      const targetBefore = feedbackTargetSnapshot(profile, req.params.memoryId);
      const at = new Date().toISOString();
      const feedback = applyFeedback(profile, {
        kind: "correct",
        targetId: req.params.memoryId,
        content: body.text,
        modality: "text",
        now: at
      });
      const beforeSemanticIds = semanticRecordIds(profile);
      await semanticReflectFeedback(profile, feedback, provider);
      const modelRuns = newSemanticRuns(profile, beforeSemanticIds);
      const memory = profile.longTermMemories.find((item) => item.id === req.params.memoryId);
      if (!memory) throw new HttpError(404, "Memory not found after feedback reflection");
      const cognitionTrace = feedbackCognitionTrace(feedback, provider, modelRuns, profile, targetBefore);
      appendInputMessage(profile, {
        channel: "feedback",
        role: "user",
        text: feedback.inputText ?? body.text,
        sourceId: `${memory.id}:edit:input`,
        modality: "text",
        observedAt: at,
        at,
        relatedMemoryIds: [memory.id],
        cognitionTrace
      });
      appendPapoMessage(profile, {
        channel: "feedback",
        text: feedback.replyText,
        sourceId: `${memory.id}:edit`,
        relatedMemoryIds: [memory.id],
        cognitionTrace,
        at
      });
      await store.saveProfile(profile);
      turnWorker.wake();
      res.json({ profile: publicProfile(profile), memory });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/dreaming", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId, req);
      markProactiveUserResponse(profile, new Date().toISOString());
      const dream = await semanticDreamMemories(profile, provider, { force: true });
      await store.saveProfile(profile);
      res.json({ profile: publicProfile(profile), dream });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/emergence", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId, req);
      const beforeSemanticIds = semanticRecordIds(profile);
      const emergence = await semanticDecideEmergence(profile, provider, new Date().toISOString(), { delivery: "manual" });
      const modelRuns = newSemanticRuns(profile, beforeSemanticIds);
      const cognitionTrace = emergenceCognitionTrace(emergence, provider, modelRuns);
      appendPapoMessage(profile, {
        channel: "emergence",
        text: emergence.text,
        sourceId: emergence.id,
        relatedMemoryIds: emergence.relatedMemoryIds,
        attachments: [],
        cognitionTrace
      });
      await store.saveProfile(profile);
      void queueEmergenceIllustrationGeneration({ store, userId: profile.userId, emergence, provider });
      void queueEmergenceActionCardGeneration({ store, userId: profile.userId, emergence, provider });
      res.json({ profile: publicProfile(profile), emergence: { ...emergence, cognitionTrace } });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/profiles/:userId/action-cards/:cardId", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId, req);
      const body = updateActionCardSchema.parse(req.body);
      const card = profile.actionCards?.find((item) => item.id === req.params.cardId);
      if (!card) throw new HttpError(404, "Action card not found");
      if (body.disabled !== undefined) card.disabled = body.disabled;
      if (body.deleted !== undefined) card.deleted = body.deleted;
      await store.saveProfile(profile);
      res.json({ profile: publicProfile(profile), actionCard: card });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/profiles/:userId/password", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId, req);
      const body = passwordSchema.parse(req.body);
      const currentPassword = profilePassword(profile);
      if (currentPassword && body.currentPassword && body.currentPassword !== currentPassword) {
        throw new HttpError(401, "Password is incorrect");
      }
      const nextPassword = body.newPassword?.trim();
      const saved = await store.updateProfile(profile.userId, (current) => {
        if (nextPassword) current.password = nextPassword;
        else delete current.password;
      });
      if (!saved) throw new HttpError(404, "Profile not found");
      await deviceAuth.revokeAll(profile.userId);
      res.json({ profile: publicProfile(saved) });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: zodErrorMessage(error), details: error.flatten() });
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error(error);
    res.status(500).json({ error: sensingError(error) });
  });

  if (input.proactive?.enabled) {
    startProactiveEmergenceLoop(store, provider, input.proactive.intervalMs, hermesBridge);
  }
  if (input.hermes?.enabled) {
    hermesBridge?.start();
  }

  return app;
}

function applyMemoryEnrichmentResult(target: LongTermMemory, generated: LongTermMemory, job: ConversationJobRecord, replaceVisual: boolean) {
  target.shortTitle = generated.shortTitle;
  target.narrative = generated.narrative;
  target.visualPrompt = generated.visualPrompt;
  target.visualMode = generated.visualMode;
  target.papoPresence = generated.papoPresence;
  target.visualPlanReason = generated.visualPlanReason;
  target.visualStatus = generated.visualStatus;
  target.visualError = generated.visualError;
  target.visualUpdatedAt = generated.visualUpdatedAt;
  target.enrichedRevision = generated.enrichedRevision;
  target.enrichmentStatus = generated.enrichmentStatus;
  target.enrichmentError = generated.enrichmentError;
  if (replaceVisual) {
    target.visual = generated.visual ? {
      ...generated.visual,
      turnId: job.turnId,
      jobId: job.id,
      sourceIds: [...new Set([...(generated.visual.sourceIds ?? []), ...job.sourceIds, job.turnId, job.id, target.id])]
    } : undefined;
  }
}

function linkActionAttachmentsToMemorySources(profile: CreatureProfile, job: ConversationJobRecord, attachments: MediaAttachment[]) {
  const sourceIds = [...new Set([job.turnId, job.id, ...job.sourceIds, ...attachments.map((item) => item.id)])];
  const linked = attachments.map((attachment) => ({
    ...attachment,
    turnId: job.turnId,
    jobId: job.id,
    sourceIds: [...new Set([...(attachment.sourceIds ?? []), ...sourceIds])]
  }));
  const episode = profile.episodes.find((item) => item.id === job.episodeId);
  if (episode) episode.attachments = mergeOwnedById(episode.attachments ?? [], linked);
  for (const candidate of profile.memoryCandidates.filter((item) => item.sourceEpisodeId === job.episodeId)) {
    candidate.attachments = mergeOwnedById(candidate.attachments ?? [], linked);
  }
  for (const memory of profile.longTermMemories.filter((item) => item.sourceEpisodeId === job.episodeId)) {
    upsertLongTermMemory(profile, {
      ...memory,
      attachments: mergeOwnedById(memory.attachments ?? [], linked)
    }, { sourceIds: [job.id, job.turnId, ...linked.map((item) => item.id)] });
  }
}

async function observeAudioForSensing(provider: ModelProvider, dataUrl: string, prompt: string) {
  try {
    return await provider.observeAudio(dataUrl, prompt);
  } catch (error) {
    if (isUnreadableAudioInputError(error)) return "ERROR_AUDIO_UNREADABLE";
    throw error;
  }
}

function isUnreadableAudioInputError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Audio input conversion failed|invalid_request_audio|Failed to load audio file|Invalid data found when processing input|EBML header parsing failed|operation was aborted|AbortError|aborted/i.test(message);
}

export function startProactiveEmergenceLoop(store: ProfileStore, provider: ModelProvider, intervalMs = 60_000, hermesBridge?: HermesBridge) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runAutomaticDreamingSweep(store, provider);
      await runDogStateSweep(store, provider);
      await hermesBridge?.checkTimeouts();
      await runCompanionSessionSweep(store, provider);
      await runProactiveEmergenceSweep(store, provider);
    } catch (error) {
      console.error("Background cognition sweep failed", error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}

export async function runAutomaticDreamingSweep(store: ProfileStore, provider: ModelProvider, now = new Date().toISOString()) {
  const summaries = await store.listProfiles();
  let checked = 0;
  let applied = 0;
  let quiet = 0;
  let deferred = 0;
  for (const summary of summaries) {
    const profile = await store.getProfile(summary.userId);
    if (!profile) continue;
    const due = isDreamingDue(profile, now);
    if (!due.due) continue;
    checked += 1;
    try {
      const dream = await semanticDreamMemories(profile, provider, { now, recordQuiet: true });
      if (dream?.operations.length) applied += 1;
      else quiet += 1;
      await store.saveProfile(profile);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Automatic dreaming failed for ${summary.userId}`, error);
      recordDreamingFailure(profile, provider, now, message);
      await store.saveProfile(profile);
      deferred += 1;
    }
  }
  return { checked, applied, quiet, deferred };
}

export async function runDogStateSweep(store: ProfileStore, provider: ModelProvider, now = new Date().toISOString()) {
  const summaries = await store.listProfiles();
  let checked = 0;
  let applied = 0;
  let deferred = 0;
  for (const summary of summaries) {
    const profile = await store.getProfile(summary.userId);
    if (!profile || !isDogStateCheckDue(profile, now)) continue;
    checked += 1;
    try {
      const state = await refreshDogStateIfDue(profile, provider, { now });
      if (state) applied += 1;
      await store.saveProfile(profile);
    } catch (error) {
      console.error(`Dog state sweep failed for ${summary.userId}`, error);
      deferred += 1;
    }
  }
  return { checked, applied, deferred };
}

export async function runProactiveEmergenceSweep(store: ProfileStore, provider: ModelProvider, now = new Date().toISOString()) {
  const summaries = await store.listProfiles();
  let checked = 0;
  let active = 0;
  let quiet = 0;
  let deferred = 0;
  for (const summary of summaries) {
    const profile = await store.getProfile(summary.userId);
    if (!profile) continue;
    const due = isProactiveEmergenceDue(profile, now);
    if (!due.due) {
      if (!profile.proactive.lastCheckedAt) {
        profile.proactive.lastCheckedAt = now;
        await store.saveProfile(profile);
      }
      continue;
    }
    checked += 1;
    const beforeSemanticIds = semanticRecordIds(profile);
    try {
      const emergence = await semanticDecideEmergence(profile, provider, now, { delivery: "proactive" });
      const modelRuns = newSemanticRuns(profile, beforeSemanticIds);
      const cognitionTrace = emergenceCognitionTrace(emergence, provider, modelRuns);
      settleProactiveEmergence(profile, emergence, now);
      if (emergence.text.trim()) {
        appendPapoMessage(profile, {
          channel: "emergence",
          text: emergence.text,
          sourceId: emergence.id,
          relatedMemoryIds: emergence.relatedMemoryIds,
          attachments: [],
          cognitionTrace,
          at: now
        });
        active += 1;
      } else {
        quiet += 1;
      }
      await store.saveProfile(profile);
      await Promise.all([
        queueEmergenceIllustrationGeneration({ store, userId: profile.userId, emergence, provider }),
        queueEmergenceActionCardGeneration({ store, userId: profile.userId, emergence, provider })
      ]);
    } catch (error) {
      console.error(`Proactive emergence failed for ${summary.userId}`, error);
      deferProactiveEmergence(profile, now, 30);
      await store.saveProfile(profile);
      deferred += 1;
    }
  }
  return { checked, active, quiet, deferred };
}

function imageAssetDir() {
  return path.join(process.cwd(), "data", "assets", "images");
}

async function saveImageAsset(dataUrl: string, label: string): Promise<MediaAttachment> {
  const parsed = parseImageDataUrl(dataUrl);
  const hash = createHash("sha256").update(parsed.buffer).digest("hex");
  const id = `img_${hash.slice(0, 24)}`;
  const filename = `${id}.${parsed.extension}`;
  const dir = imageAssetDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), parsed.buffer);
  const now = new Date().toISOString();
  return {
    id,
    kind: "image",
    label: label.trim() || "照片",
    mime: parsed.mime,
    url: `/api/assets/${filename}`,
    createdAt: now,
    sizeBytes: parsed.buffer.byteLength
  };
}

async function saveAudioAsset(dataUrl: string, label: string): Promise<MediaAttachment> {
  const parsed = parseAudioDataUrl(dataUrl);
  const hash = createHash("sha256").update(parsed.buffer).digest("hex");
  const id = `aud_${hash.slice(0, 24)}`;
  const filename = `${id}.${parsed.extension}`;
  const dir = imageAssetDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), parsed.buffer);
  return {
    id,
    kind: "audio",
    label: label.trim() || "录音",
    mime: parsed.mime,
    url: `/api/assets/${filename}`,
    createdAt: new Date().toISOString(),
    sizeBytes: parsed.buffer.byteLength
  };
}

async function saveGeneratedIllustration(input: {
  dataUrl: string;
  label: string;
  prompt: string;
  sourceIds: string[];
}): Promise<MediaAttachment> {
  const asset = await saveImageAsset(input.dataUrl, input.label);
  return {
    ...asset,
    generatedBy: "papo_illustration",
    prompt: input.prompt,
    sourceIds: input.sourceIds
  };
}

async function saveGeneratedActionVideo(input: {
  dataUrl: string;
  label: string;
  prompt: string;
  sourceIds: string[];
}): Promise<MediaAttachment> {
  const parsed = parseVideoDataUrl(input.dataUrl);
  const hash = createHash("sha256").update(parsed.buffer).digest("hex");
  const id = `vid_${hash.slice(0, 24)}`;
  const filename = `${id}.mp4`;
  const dir = imageAssetDir();
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), parsed.buffer);
  return {
    id,
    kind: "video",
    label: input.label.trim() || "动作卡",
    mime: "video/mp4",
    url: `/api/assets/${filename}`,
    createdAt: new Date().toISOString(),
    sizeBytes: parsed.buffer.byteLength,
    generatedBy: "papo_action_card",
    prompt: input.prompt,
    sourceIds: input.sourceIds
  };
}

async function saveGeneratedActionKeyframe(input: {
  dataUrl: string;
  label: string;
  prompt: string;
  sourceIds: string[];
}): Promise<MediaAttachment> {
  const asset = await saveImageAsset(input.dataUrl, input.label);
  return {
    ...asset,
    generatedBy: "papo_action_card",
    prompt: input.prompt,
    sourceIds: input.sourceIds
  };
}

async function createActionCardCover(input: {
  profile: CreatureProfile;
  provider: ModelProvider;
  prompt: string;
  references: ImageReference[];
  label: string;
  sourceIds: string[];
}) {
  try {
    const generated = await input.provider.generateImage(input.prompt, {
      style: input.profile.petProfile.visualStyle,
      references: input.references
    });
    const cover = await saveGeneratedActionKeyframe({
      dataUrl: generated.dataUrl,
      label: input.label,
      prompt: input.prompt,
      sourceIds: input.sourceIds
    });
    return { cover, referenceImage: { dataUrl: generated.dataUrl, label: cover.label } satisfies ImageReference };
  } catch (error) {
    const referenceImage = input.references[0];
    if (!referenceImage) throw error;
    console.warn(`Action cover generation failed; using current profile image for ${input.profile.userId}`, error);
    return {
      cover: input.profile.petProfile.avatarImage ?? input.profile.petProfile.referenceImage,
      referenceImage
    };
  }
}

async function saveGeneratedProfileImage(input: {
  dataUrl: string;
  label: string;
  prompt: string;
  sourceIds: string[];
}): Promise<MediaAttachment> {
  const asset = await saveImageAsset(input.dataUrl, input.label);
  return {
    ...asset,
    generatedBy: "papo_profile",
    prompt: input.prompt,
    sourceIds: input.sourceIds
  };
}

async function designPetProfile(
  profile: CreatureProfile,
  input: { guidance?: string; referenceSummary?: string; referenceAttachment?: MediaAttachment },
  provider: ModelProvider
): Promise<PetIdentityProfile> {
  const raw = await provider.generateJson<unknown>(buildPetProfileDesignPrompt(profile, input));
  const patch = normalizePetProfileDesign(raw);
  const references = await petProfileReferences(input.referenceAttachment);
  const sourceIds = [input.referenceAttachment?.id, `pet-profile:${Date.now()}`].filter(Boolean) as string[];
  const imagePrompt = buildProfileImagePrompt(profile, patch, Boolean(references[0]));
  const generated = await provider.generateImage(imagePrompt, { style: patch.visualStyle, references });
  const avatarImage = await saveGeneratedProfileImage({
    dataUrl: generated.dataUrl,
    label: `${profile.creatureName} 的形象`,
    prompt: imagePrompt,
    sourceIds
  });
  return {
    ...profile.petProfile,
    ...patch,
    updatedAt: new Date().toISOString(),
    source: "profile_editor",
    userGuidance: input.guidance?.trim() || patch.userGuidance,
    referenceImage: input.referenceAttachment ?? profile.petProfile.referenceImage,
    avatarImage,
    initialMotion: { status: "idle" },
    model: generated.model ?? provider.diagnostics?.imageModel ?? provider.diagnostics?.textModel
  };
}

function applyPetProfileActionResults(profile: CreatureProfile, result: CaptureResult) {
  for (const event of result.events) {
    const actionResult = event.actionResult;
    if (event.actionDecision.action !== "update_pet_profile" || actionResult?.kind !== "pet_profile_update" || !actionResult.petProfile) continue;
    profile.petProfile = {
      ...profile.petProfile,
      ...actionResult.petProfile,
      updatedAt: event.createdAt,
      source: "conversation",
      userGuidance: actionResult.text ?? actionResult.petProfile.userGuidance ?? profile.petProfile.userGuidance
    };
    event.decisionTrace = [...(event.decisionTrace ?? []), "pet_profile: llm patch applied"];
  }
}

function queueInitialPetMotionGeneration(input: {
  store: ProfileStore;
  userId: string;
  provider: ModelProvider;
  guidance?: string;
}) {
  void (async () => {
    try {
      const profile = await input.store.getProfile(input.userId);
      if (!profile) return;
      if (!input.provider.generateVideo) throw new Error("Video generation provider is not configured");
      const card = await planInitialPetMotionCard(profile, input.provider, input.guidance);
      const references = await petProfileVisualReferences(profile);
      const sourceIds = [`pet-profile:${profile.petProfile.updatedAt}`, `initial-motion:${card.key}`];
      const keyframePrompt = buildInitialMotionKeyframePrompt(profile, card, Boolean(references[0]));
      const coverResult = await createActionCardCover({
        profile,
        provider: input.provider,
        prompt: keyframePrompt,
        references,
        label: `${card.title} 首帧`,
        sourceIds
      });
      const videoPrompt = buildInitialMotionVideoPrompt(profile, card, true);
      const generated = await input.provider.generateVideo(videoPrompt, {
        durationSeconds: card.durationSeconds,
        style: card.style,
        referenceImage: coverResult.referenceImage
      });
      const video = await saveGeneratedActionVideo({
        dataUrl: generated.dataUrl,
        label: card.title,
        prompt: videoPrompt,
        sourceIds
      });
      const created: ActionCardRecord = {
        id: video.id,
        createdAt: new Date().toISOString(),
        title: card.title,
        caption: card.caption,
        prompt: videoPrompt,
        style: card.style,
        durationSeconds: card.durationSeconds,
        cover: coverResult.cover,
        video,
        sourceIds,
        providerKind: input.provider.diagnostics?.videoProvider ?? input.provider.kind,
        providerName: input.provider.diagnostics?.videoProvider ? `${input.provider.diagnostics.videoProvider} video` : input.provider.name,
        model: generated.model ?? input.provider.diagnostics?.videoModel
      };
      profile.actionCards = [created, ...(profile.actionCards ?? [])].slice(0, 30);
      profile.petProfile.initialMotion = {
        status: "ready",
        requestedAt: profile.petProfile.initialMotion?.requestedAt,
        completedAt: new Date().toISOString(),
        pendingCount: 0
      };
      await input.store.saveProfile(profile);
    } catch (error) {
      console.error(`Initial pet motion generation failed for ${input.userId}`, error);
      const profile = await input.store.getProfile(input.userId);
      if (!profile) return;
      profile.petProfile.initialMotion = {
        status: "failed",
        requestedAt: profile.petProfile.initialMotion?.requestedAt,
        error: error instanceof Error ? error.message.slice(0, 300) : "Unknown video generation error"
      };
      await input.store.saveProfile(profile);
    }
  })();
}

function hasActionCardDraft(result: CaptureResult) {
  return result.events.some((event) => event.actionDecision.action === "generate_action_card" && event.actionResult?.kind === "action_card_draft" && event.actionResult.prompt?.trim());
}

function queueActionCardGeneration(input: {
  store: ProfileStore;
  userId: string;
  result: CaptureResult;
  provider: ModelProvider;
}) {
  if (!hasActionCardDraft(input.result)) return;
  void (async () => {
    try {
      const profile = await input.store.getProfile(input.userId);
      if (!profile) return;
      const attachments = await executeActionCardActions(profile, input.result, input.provider, "action", new Date().toISOString());
      if (!attachments.length) return;
      applyActionCardCompletion(profile, input.result, attachments);
      await input.store.saveProfile(profile);
    } catch (error) {
      console.error(`Action card generation failed for ${input.userId}`, error);
    }
  })();
}

function queueEmergenceActionCardGeneration(input: {
  store: ProfileStore;
  userId: string;
  emergence: EmergenceRecord & { text: string; memoryId?: string };
  provider: ModelProvider;
}) {
  if (input.emergence.actionResult?.kind !== "action_card_draft" || !input.emergence.actionResult.prompt?.trim()) return Promise.resolve();
  return (async () => {
    try {
      const profile = await input.store.getProfile(input.userId);
      if (!profile) return;
      const storedEmergence = profile.emergenceHistory.find((item) => item.id === input.emergence.id);
      if (!storedEmergence || storedEmergence.actionResult?.kind !== "action_card_draft") return;
      const attachments = await executeEmergenceActionCard(profile, storedEmergence as EmergenceRecord & { text: string }, input.provider, new Date().toISOString());
      if (!attachments.length) return;
      applyEmergenceActionCardCompletion(profile, storedEmergence, attachments);
      const created = (profile.actionCards ?? []).find((card) => attachments.some((attachment) => attachment.id === card.video.id));
      await input.store.updateProfile(input.userId, (latest) => {
        if (created) latest.actionCards = mergeOwnedById(latest.actionCards ?? [], [created]).slice(0, 30);
        patchEmergenceMedia(latest, storedEmergence, attachments);
      });
    } catch (error) {
      console.error(`Emergence action card generation failed for ${input.userId}`, error);
    }
  })();
}

function queueEmergenceIllustrationGeneration(input: {
  store: ProfileStore;
  userId: string;
  emergence: EmergenceRecord & { text: string; memoryId?: string };
  provider: ModelProvider;
}) {
  if (input.emergence.actionResult?.kind !== "illustration_draft" || !input.emergence.actionResult.prompt?.trim()) return Promise.resolve();
  return (async () => {
    try {
      const profile = await input.store.getProfile(input.userId);
      const storedEmergence = profile?.emergenceHistory.find((item) => item.id === input.emergence.id);
      if (!profile || !storedEmergence || storedEmergence.actionResult?.kind !== "illustration_draft") return;
      const attachments = await executeEmergenceIllustration(profile, storedEmergence as EmergenceRecord & { text: string }, input.provider, new Date().toISOString());
      if (!attachments.length) return;
      const created = (profile.illustrations ?? []).find((illustration) => attachments.some((attachment) => attachment.id === illustration.attachment.id));
      await input.store.updateProfile(input.userId, (latest) => {
        if (created) latest.illustrations = mergeOwnedById(latest.illustrations ?? [], [created]).slice(0, 30);
        patchEmergenceMedia(latest, storedEmergence, attachments);
      });
    } catch (error) {
      console.error(`Emergence illustration generation failed for ${input.userId}`, error);
    }
  })();
}

function patchEmergenceMedia(profile: CreatureProfile, computed: EmergenceRecord, attachments: MediaAttachment[]) {
  const emergence = profile.emergenceHistory.find((item) => item.id === computed.id);
  if (emergence) emergence.actionResult = computed.actionResult;
  const message = profile.conversation.find((item) => item.sourceId === computed.id && item.role === "papo");
  if (message) {
    message.attachments = mergeAttachmentsById(message.attachments ?? [], attachments);
    if (message.cognitionTrace?.emergenceDecision) message.cognitionTrace.emergenceDecision.actionResult = computed.actionResult;
  }
}

function mergeAttachmentsById(current: MediaAttachment[], incoming: MediaAttachment[]) {
  return [...incoming, ...current].filter((item, index, list) => list.findIndex((other) => other.id === item.id) === index);
}

function applyActionCardCompletion(profile: CreatureProfile, result: CaptureResult, attachments: MediaAttachment[]) {
  const actionResultsByEvent = new Map<string, ActionResult>();
  for (const event of result.events) {
    if (event.actionResult?.kind === "action_card") actionResultsByEvent.set(event.id, event.actionResult);
  }
  if (!actionResultsByEvent.size) return;
  for (const episode of result.episodes) {
    if (episode.actionResult?.kind !== "action_card") continue;
    const stored = profile.episodes.find((item) => item.id === episode.id);
    if (stored) stored.actionResult = episode.actionResult;
  }
  for (const message of profile.conversation ?? []) {
    const decisions = message.cognitionTrace?.eventDecisions;
    if (!decisions?.length) continue;
    let touched = false;
    for (const decision of decisions) {
      const finalResult = actionResultsByEvent.get(decision.eventId);
      if (!finalResult) continue;
      decision.actionResult = finalResult;
      touched = true;
    }
    if (touched && message.role === "papo") {
      message.attachments = mergeMediaAttachments(message.attachments, attachments);
    }
  }
}

function applyEmergenceActionCardCompletion(profile: CreatureProfile, emergence: EmergenceRecord, attachments: MediaAttachment[]) {
  const finalResult = emergence.actionResult;
  if (finalResult?.kind !== "action_card") return;
  const storedEmergence = profile.emergenceHistory.find((item) => item.id === emergence.id);
  if (storedEmergence) storedEmergence.actionResult = finalResult;
  for (const message of profile.conversation ?? []) {
    if (message.sourceId !== emergence.id && message.cognitionTrace?.emergenceDecision?.emergenceId !== emergence.id) continue;
    if (message.cognitionTrace?.emergenceDecision) message.cognitionTrace.emergenceDecision.actionResult = finalResult;
    if (message.role === "papo") message.attachments = mergeMediaAttachments(message.attachments, attachments);
  }
}

function mergeMediaAttachments(current: MediaAttachment[] | undefined, incoming: MediaAttachment[]) {
  const byId = new Map<string, MediaAttachment>();
  for (const attachment of [...(current ?? []), ...incoming]) byId.set(attachment.id, attachment);
  return [...byId.values()];
}

async function executeActionCardActions(
  profile: CreatureProfile,
  result: CaptureResult,
  provider: ModelProvider,
  kind: "action",
  now = new Date().toISOString()
) {
  void kind;
  const attachments: MediaAttachment[] = [];
  for (const event of result.events) {
    const actionResult = event.actionResult;
    if (event.actionDecision.action !== "generate_action_card" || actionResult?.kind !== "action_card_draft" || !actionResult.prompt?.trim()) continue;
    const references = await actionCardReferences(profile, event.attachments, actionResult.replacesActionCardId);
    const referenceImage = references[0];
    if (!provider.generateVideo) throw new Error("Video generation provider is not configured");
    const sourceIds = [...new Set([event.id, event.triggerSegmentId, event.triggerBatchId, ...(event.relatedMemoryIds ?? []), ...(event.attachments ?? []).map((item) => item.id), ...(actionResult.sourceIds ?? [])].filter(Boolean) as string[])];
    const keyframePrompt = actionCardKeyframePrompt(profile, actionResult, event, Boolean(referenceImage));
    const coverResult = await createActionCardCover({
      profile,
      provider,
      prompt: keyframePrompt,
      references,
      label: `${actionResult.title ?? profile.creatureName} 封面`,
      sourceIds
    });
    const videoPrompt = actionCardVideoPrompt(profile, actionResult, event, true);
    const generated = await provider.generateVideo(videoPrompt, {
      durationSeconds: actionResult.durationSeconds ?? 8,
      style: profile.petProfile.visualStyle,
      referenceImage: coverResult.referenceImage
    });
    const video = await saveGeneratedActionVideo({
      dataUrl: generated.dataUrl,
      label: actionResult.title ?? `${profile.creatureName} 的动作卡`,
      prompt: videoPrompt,
      sourceIds
    });
    const finalResult: ActionResult = {
      ...actionResult,
      kind: "action_card",
      videoAttachment: video,
      attachment: video,
      durationSeconds: actionResult.durationSeconds ?? 8
    };
    event.actionResult = finalResult;
    const episode = result.episodes.find((item) => item.actionDecision?.reason === event.actionDecision.reason || item.sourceSegmentId === event.triggerSegmentId || item.sourceBatchId === event.triggerBatchId);
    if (episode?.actionResult?.kind === "action_card_draft") episode.actionResult = finalResult;
    profile.actionCards ??= [];
    profile.actionCards.unshift({
      id: video.id,
      createdAt: now,
      title: actionResult.title ?? `${profile.creatureName} 的动作卡`,
      caption: actionResult.caption ?? actionResult.text,
      prompt: videoPrompt,
      style: actionResult.style,
      durationSeconds: actionResult.durationSeconds ?? 8,
      cover: coverResult.cover,
      video,
      sourceIds,
      actionEventId: event.id,
      replacementForActionCardId: actionResult.replacesActionCardId,
      providerKind: provider.diagnostics?.videoProvider ?? provider.kind,
      providerName: provider.diagnostics?.videoProvider ? `${provider.diagnostics.videoProvider} video` : provider.name,
      model: generated.model ?? provider.diagnostics?.videoModel
    });
    if (actionResult.replacesActionCardId) {
      const replaced = profile.actionCards.find((card) => card.id === actionResult.replacesActionCardId);
      if (replaced) {
        replaced.disabled = true;
        replaced.replacedByActionCardId = video.id;
      }
    }
    profile.actionCards = profile.actionCards.slice(0, 30);
    attachments.push(video);
  }
  return attachments;
}

async function executeEmergenceActionCard(
  profile: CreatureProfile,
  emergence: EmergenceRecord & { text: string; memoryId?: string },
  provider: ModelProvider,
  now: string
) {
  const actionResult = emergence.actionResult;
  if (actionResult?.kind !== "action_card_draft" || !actionResult.prompt?.trim()) return [];
  if (!provider.generateVideo) throw new Error("Video generation provider is not configured");
  const references = await actionCardReferences(
    profile,
    profile.episodes
      .filter((episode) => actionResult.sourceIds?.includes(episode.id) || emergence.relatedMemoryIds.includes(episode.id))
      .flatMap((episode) => episode.attachments ?? [])
  );
  const sourceIds = [...new Set([emergence.id, emergence.memoryId, ...(emergence.relatedMemoryIds ?? []), ...(actionResult.sourceIds ?? [])].filter(Boolean) as string[])];
  const keyframePrompt = actionCardKeyframePromptForEmergence(profile, actionResult, emergence, Boolean(references[0]));
  const coverResult = await createActionCardCover({
    profile,
    provider,
    prompt: keyframePrompt,
    references,
    label: `${actionResult.title ?? profile.creatureName} 封面`,
    sourceIds
  });
  const videoPrompt = actionCardVideoPromptForEmergence(profile, actionResult, emergence, true);
  const generated = await provider.generateVideo(videoPrompt, {
    durationSeconds: actionResult.durationSeconds ?? 8,
    style: profile.petProfile.visualStyle,
    referenceImage: coverResult.referenceImage
  });
  const video = await saveGeneratedActionVideo({
    dataUrl: generated.dataUrl,
    label: actionResult.title ?? `${profile.creatureName} 的动作卡`,
    prompt: videoPrompt,
    sourceIds
  });
  emergence.actionResult = {
    ...actionResult,
    kind: "action_card",
    videoAttachment: video,
    attachment: video,
    durationSeconds: actionResult.durationSeconds ?? 8,
    sourceIds
  };
  profile.actionCards ??= [];
  profile.actionCards.unshift({
    id: video.id,
    createdAt: now,
    title: actionResult.title ?? `${profile.creatureName} 的动作卡`,
    caption: actionResult.caption ?? actionResult.text ?? emergence.text,
    prompt: videoPrompt,
    style: actionResult.style,
    durationSeconds: actionResult.durationSeconds ?? 8,
    cover: coverResult.cover,
    video,
    sourceIds,
    emergenceId: emergence.id,
    providerKind: provider.diagnostics?.videoProvider ?? provider.kind,
    providerName: provider.diagnostics?.videoProvider ? `${provider.diagnostics.videoProvider} video` : provider.name,
    model: generated.model ?? provider.diagnostics?.videoModel
  });
  profile.actionCards = profile.actionCards.slice(0, 30);
  return [video];
}

async function executeIllustrationActions(
  profile: CreatureProfile,
  result: CaptureResult,
  provider: ModelProvider,
  kind: IllustrationRecord["kind"],
  now = new Date().toISOString()
) {
  const attachments: MediaAttachment[] = [];
  for (const event of result.events) {
    const actionResult = event.actionResult;
    if (event.actionDecision.action !== "generate_illustration" || actionResult?.kind !== "illustration_draft" || !actionResult.prompt?.trim()) continue;
    const references = await illustrationReferences(event.attachments);
    const generated = await provider.generateImage(illustrationPrompt(actionResult, event, references), { style: actionResult.style, references });
    const sourceIds = [...new Set([event.id, event.triggerSegmentId, event.triggerBatchId, ...(event.relatedMemoryIds ?? []), ...(event.attachments ?? []).map((item) => item.id), ...(actionResult.sourceIds ?? [])].filter(Boolean) as string[])];
    const attachment = await saveGeneratedIllustration({
      dataUrl: generated.dataUrl,
      label: actionResult.title ?? "Papo 画的小画",
      prompt: actionResult.prompt,
      sourceIds
    });
    const finalResult: ActionResult = {
      ...actionResult,
      kind: "illustration",
      attachment
    };
    event.actionResult = finalResult;
    const episode = result.episodes.find((item) => item.actionDecision?.reason === event.actionDecision.reason || item.sourceSegmentId === event.triggerSegmentId || item.sourceBatchId === event.triggerBatchId);
    if (episode?.actionResult?.kind === "illustration_draft") episode.actionResult = finalResult;
    profile.illustrations ??= [];
    profile.illustrations.unshift({
      id: attachment.id,
      createdAt: now,
      kind,
      title: actionResult.title ?? "Papo 画的小画",
      caption: actionResult.caption ?? actionResult.text,
      prompt: actionResult.prompt,
      style: actionResult.style,
      attachment,
      sourceIds,
      actionEventId: event.id,
      providerKind: provider.diagnostics?.imageProvider ?? provider.kind,
      providerName: provider.diagnostics?.imageProvider ? `${provider.diagnostics.imageProvider} image` : provider.name,
      model: generated.model ?? provider.diagnostics?.imageModel
    });
    profile.illustrations = profile.illustrations.slice(0, 30);
    attachments.push(attachment);
  }
  return attachments;
}

async function executeEmergenceIllustration(
  profile: CreatureProfile,
  emergence: EmergenceRecord & { text: string; memoryId?: string },
  provider: ModelProvider,
  now: string
) {
  const actionResult = emergence.actionResult;
  if (actionResult?.kind !== "illustration_draft" || !actionResult.prompt?.trim()) return [];
  const references = await illustrationReferences(
    profile.episodes
      .filter((episode) => actionResult.sourceIds?.includes(episode.id) || emergence.relatedMemoryIds.includes(episode.id))
      .flatMap((episode) => episode.attachments ?? [])
  );
  const plan = await planEveningDiaryIllustration(profile, emergence, actionResult, references, provider, now);
  const generated = await provider.generateImage(illustrationPromptForEmergence(actionResult, emergence, profile, references, plan), { style: actionResult.style, references });
  const sourceIds = [...new Set([emergence.id, emergence.memoryId, ...(emergence.relatedMemoryIds ?? []), ...(actionResult.sourceIds ?? [])].filter(Boolean) as string[])];
  const attachment = await saveGeneratedIllustration({
    dataUrl: generated.dataUrl,
    label: actionResult.title ?? "Papo 的观察日记",
    prompt: plan.finalPrompt,
    sourceIds
  });
  emergence.actionResult = {
    ...actionResult,
    kind: "illustration",
    attachment,
    plan,
    sourceIds
  };
  profile.illustrations ??= [];
  profile.illustrations.unshift({
    id: attachment.id,
    createdAt: now,
    kind: "evening_diary",
    title: actionResult.title ?? "Papo 的观察日记",
    caption: actionResult.caption ?? actionResult.text ?? emergence.text,
    prompt: plan.finalPrompt,
    style: actionResult.style,
    plan,
    attachment,
    sourceIds,
    emergenceId: emergence.id,
    providerKind: provider.diagnostics?.imageProvider ?? provider.kind,
    providerName: provider.diagnostics?.imageProvider ? `${provider.diagnostics.imageProvider} image` : provider.name,
    model: generated.model ?? provider.diagnostics?.imageModel
  });
  profile.illustrations = profile.illustrations.slice(0, 30);
  return [attachment];
}

function illustrationPrompt(actionResult: ActionResult, event: CaptureResult["events"][number], references: ImageReference[] = []) {
  const sourceImages = (event.attachments ?? []).map((item) => `${item.label} ${item.url}`).join("\n");
  return [
    "Create one warm hand-drawn comic / postcard style illustration for Papo, a cute companion pet.",
    "No UI, no text labels, no screenshots, no photorealistic rendering.",
    "Style: soft hand-drawn lines, cozy colors, gentle manga/comic feeling.",
    actionResult.style ? `Requested style: ${actionResult.style}` : "",
    "Ground the image in the real moment below. Do not invent unrelated events.",
    `Moment: ${event.noticed || event.triggerContent}`,
    sourceImages ? `Available source image assets:\n${sourceImages}` : "",
    references.length ? `${references.length} original uploaded image reference(s) are attached to the image generation request. Use them as visual grounding.` : "",
    `Image prompt from action model:\n${actionResult.prompt}`
  ].filter(Boolean).join("\n\n");
}

function actionCardVideoPrompt(profile: CreatureProfile, actionResult: ActionResult, event: CaptureResult["events"][number], hasReferenceImage: boolean) {
  const identity = petVisualIdentity(profile);
  const userDepiction = actionCardUserDepiction(event);
  const sourceImages = (event.attachments ?? []).map((item) => `${item.label} ${item.url}`).join("\n");
  return [
    `Create a short looping animated video action card for ${profile.creatureName}, a ${identity.species}.`,
    "Visual goal: a living digital pet based on the current profile image/photo, lightly stylized for a polished companion app. It must look like the same animal/creature from the profile, not a plush toy or figurine.",
    "Scene and camera: warm clean app background, soft natural light, full body centered, locked camera, stable scale, no cuts, no zoom unless extremely subtle.",
    `The character must stay consistent with this companion profile: ${identity.appearance}`,
    `Personality and habits to express through motion: ${identity.personality} ${identity.habits}`,
    `Visual style: ${identity.visualStyle}`,
    `Motion style: ${identity.motionStyle}`,
    userDepiction,
    hasReferenceImage ? "The attached image is the approved action-card cover and exact first frame. Animate this image; do not redesign, reinterpret, restyle, or replace the character, background, palette, proportions, or rendering technique." : "Keep the character design consistent with the pet kind and current profile.",
    "Action priority: preserve the action, object, mood, and scene requested by the action model and user moment. Do not replace a specific requested action with a generic idle, wave, ball, or nap action.",
    "Loop requirement: first frame and final frame should match as closely as possible in pose, position, camera framing, and background. The motion should return to the starting pose for a seamless loop.",
    "Forbidden look: stuffed animal, plush toy, fabric doll, vinyl toy, figurine, statue, clay model, product mockup, visible seams, toy joints, plastic shine, stitched fabric.",
    userDepiction
      ? "No UI, text labels, subtitles, or watermark. Include only the people and animals required by the action-model prompt."
      : "No UI, no text labels, no subtitles, no watermark, no extra animals, no human, no props that hide the body. Keep the action readable and cute, with simple loopable motion.",
    `Current visible state: ${profile.dogState?.label ?? "陪着用户"} / ${namedCreatureText(profile.dogState?.actionText, profile.creatureName)}`,
    `Moment: ${event.noticed || event.triggerContent}`,
    sourceImages ? `Source image assets:\n${sourceImages}` : "",
    `Action model prompt:\n${actionResult.prompt}`
  ].filter(Boolean).join("\n\n");
}

function actionCardKeyframePrompt(profile: CreatureProfile, actionResult: ActionResult, event: CaptureResult["events"][number], hasReferenceImage: boolean) {
  const identity = petVisualIdentity(profile);
  const userDepiction = actionCardUserDepiction(event);
  return [
    `Create one square approved cover and exact first frame for ${profile.creatureName}'s action card.`,
    `Character: ${identity.species}. Identity: ${identity.appearance}.`,
    `Authoritative visual style: ${identity.visualStyle}. Match the current profile/avatar image's exact rendering medium, palette, linework or 3D treatment, lighting, facial design, body proportions, and background language. Do not introduce a different art style.`,
    hasReferenceImage ? "The attached current profile/avatar image is the single authoritative character reference. Preserve its identity exactly; change only pose and action setup." : "Use the written profile as the authoritative identity.",
    actionResult.replacesActionCardId ? "A previous card may also be attached as historical continuity for its activity and relationship. Re-author the user from the confirmed current facts below." : "",
    userDepiction,
    `Action setup: ${actionResult.prompt}. Moment: ${event.noticed || event.triggerContent}.`,
    "Full body readable, centered, stable scale, clean simple background consistent with the avatar, suitable as both the first and final loop frame.",
    userDepiction
      ? "Keep the pet identity stable and include only the people and animals required by the action-model prompt. No text, UI, or watermark."
      : "Forbidden: character redesign, style transfer, different species, changed coat colors or markings, plush toy, figurine, text, UI, watermark, extra animals or humans."
  ].filter(Boolean).join("\n\n");
}

function actionCardUserDepiction(event: CaptureResult["events"][number]) {
  const age = explicitUserAge(event.triggerContent);
  if (!age || age < 18) return "";
  return `Confirmed user identity: the depicted user is ${age} years old and an adult. Render age-accurate adult facial features, body proportions, and visual styling. The action model remains responsible for the scene, composition, clothing, and art direction.`;
}

function namedCreatureText(text: string | undefined, creatureName: string) {
  return (text ?? "").replace(/\bPapo\b/g, creatureName);
}

function actionCardVideoPromptForEmergence(profile: CreatureProfile, actionResult: ActionResult, emergence: EmergenceRecord, hasReferenceImage: boolean) {
  const identity = petVisualIdentity(profile);
  return [
    `Create a short looping animated video action card for ${profile.creatureName}, a ${identity.species}.`,
    "Visual goal: a living digital pet based on the current profile image/photo, lightly stylized for a polished companion app. It must look like the same animal/creature from the profile, not a plush toy or figurine.",
    "Scene and camera: warm clean app background, soft natural light, full body centered, locked camera, stable scale, no cuts, no zoom unless extremely subtle.",
    `Keep the pet identity consistent: ${identity.appearance}`,
    `Personality and habits to express through motion: ${identity.personality} ${identity.habits}`,
    `Visual and motion style: ${identity.visualStyle} ${identity.motionStyle}`,
    hasReferenceImage ? "The attached image is the approved action-card cover and exact first frame. Animate it without redesigning or restyling the character or scene." : "",
    "Action priority: preserve the action, object, mood, and scene requested by the emergence/action model. Do not replace a specific requested action with a generic idle, wave, ball, or nap action.",
    "Loop requirement: first frame and final frame should match as closely as possible in pose, position, camera framing, and background. The motion should return to the starting pose for a seamless loop.",
    "Forbidden look: stuffed animal, plush toy, fabric doll, vinyl toy, figurine, statue, clay model, product mockup, visible seams, toy joints, plastic shine, stitched fabric.",
    "No UI, no text labels, no subtitles, no watermark, no extra animals, no human, no props that hide the body.",
    `Why now: ${emergence.whyNow}`,
    `Visible message: ${emergence.message}`,
    `Action model prompt:\n${actionResult.prompt}`
  ].filter(Boolean).join("\n\n");
}

function actionCardKeyframePromptForEmergence(profile: CreatureProfile, actionResult: ActionResult, emergence: EmergenceRecord, hasReferenceImage: boolean) {
  const identity = petVisualIdentity(profile);
  return [
    `Create one square approved cover and exact first frame for ${profile.creatureName}'s action card.`,
    `Character identity: ${identity.species}; ${identity.appearance}.`,
    `Authoritative visual style: ${identity.visualStyle}. Match the current profile/avatar image exactly in rendering medium, palette, facial design, body proportions, lighting and background language.`,
    hasReferenceImage ? "The attached profile/avatar image is authoritative. Preserve the same character exactly; change only pose and action setup." : "Use the written profile as authoritative identity.",
    `Action setup: ${actionResult.prompt}. Why now: ${emergence.whyNow}.`,
    "Full body centered, stable scale, clean background, loop-compatible starting pose.",
    "No redesign, no different art style, no plush or figurine, no text, UI, watermark, extra animals or humans."
  ].join("\n\n");
}

function petVisualIdentity(profile: CreatureProfile) {
  const fallbackSpecies = profile.petKind === "british-shorthair" ? "round-faced gray and white British Shorthair kitten" : profile.petKind === "shiba" ? "cute cartoon Shiba Inu dog" : "cute small AI companion pet";
  const species = profile.petProfile?.displaySpecies || fallbackSpecies;
  return {
    species: profile.petKind === "british-shorthair" && !/British Shorthair/i.test(species) ? `${species} (British Shorthair)` : species,
    appearance: profile.petProfile?.appearance || fallbackSpecies,
    personality: profile.petProfile?.personality || "curious, warm, companionable",
    habits: profile.petProfile?.habits || "stays near the user and reacts gently",
    visualStyle: profile.petProfile?.visualStyle || "premium cute mobile companion mascot",
    motionStyle: profile.petProfile?.motionStyle || "short loopable motion, stable camera, full-body centered"
  };
}

function buildPetProfileDesignPrompt(
  profile: CreatureProfile,
  input: { guidance?: string; referenceSummary?: string; referenceAttachment?: MediaAttachment }
) {
  return `你是 Papo 的小动物形象设计脑。你不和用户聊天，只把用户给的照片/描述整理成一个稳定的小动物 profile，并写给图像模型的头像提示词。

要求：
- 设计必须服务于一个移动端 AI 小动物商业 demo：可爱、清晰、可持续生成动作视频。
- 如果用户给了照片摘要，要把照片里的关键形象作为参考，但可以转译成统一的 app mascot 风格。
- 如果用户文字和照片冲突，优先保留用户明确文字要求，并在 appearance 中自然融合照片特征。
- 不要编造无关背景故事，不要写用户隐私。
- imagePrompt 要能直接交给图像生成模型，生成一张干净的正方形角色参考图。
- motionStyle 要能约束后续动作视频，让动作卡和首页视频风格一致。

当前小动物：
${JSON.stringify({
  creatureName: profile.creatureName,
  petKind: profile.petKind,
  currentProfile: profile.petProfile
})}

用户要求：
${input.guidance || "未提供文字要求"}

照片摘要：
${input.referenceSummary || "未提供照片"}

返回严格 JSON：
{
  "displaySpecies": "例如 圆脸灰白英短小猫",
  "appearance": "稳定外观描述，含颜色、体型、脸、眼睛、标志性特征",
  "personality": "性格和陪伴气质",
  "habits": "它常见的小动作/习惯",
  "visualStyle": "视觉风格约束",
  "imagePrompt": "英文或中文均可，但要足够具体，可直接给图像模型生成角色参考图",
  "motionStyle": "后续动作视频的镜头、光线、循环和动作风格",
  "userGuidance": "用户这次要求的简短归纳"
}`;
}

function normalizePetProfileDesign(raw: unknown): Partial<PetIdentityProfile> {
  const schema = z.object({
    displaySpecies: z.string().min(1).max(120),
    appearance: z.string().min(1).max(800),
    personality: z.string().min(1).max(600),
    habits: z.string().min(1).max(600),
    visualStyle: z.string().min(1).max(600),
    imagePrompt: z.string().min(1).max(1600),
    motionStyle: z.string().min(1).max(800),
    userGuidance: z.string().max(800).optional()
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid pet profile design JSON (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  return parsed.data;
}

function buildProfileImagePrompt(profile: CreatureProfile, patch: Partial<PetIdentityProfile>, hasReferenceImage: boolean) {
  return [
    `Create a square character reference image for ${profile.creatureName}, a ${patch.displaySpecies ?? profile.petProfile.displaySpecies}.`,
    "Create a living digital pet character for a polished AI companion app. It should feel like the user's real animal or chosen creature has become a clean animated app character, not a toy.",
    "Warm off-white studio background, soft natural lighting, full body centered, clean silhouette, expressive natural eyes, natural fur or skin texture, commercial app quality.",
    hasReferenceImage ? "Use the attached user photo as the primary identity source. Preserve the animal's real species, coat colors, markings, face shape, body proportions, and recognizable expression while lightly stylizing it for an app." : "Use the written profile as the identity source.",
    `Appearance: ${patch.appearance ?? profile.petProfile.appearance}`,
    `Personality: ${patch.personality ?? profile.petProfile.personality}`,
    `Visual style: ${patch.visualStyle ?? profile.petProfile.visualStyle}`,
    `Model prompt from design brain: ${patch.imagePrompt ?? profile.petProfile.imagePrompt}`,
    "Do not make it a stuffed animal, plush toy, figurine, vinyl toy, statue, doll, or product mockup. No visible seams, fabric nap, plastic surface, joints, toy stitching, text, UI, watermark, extra animals, human, or props that hide the body."
  ].filter(Boolean).join("\n\n");
}

async function planInitialPetMotionCard(profile: CreatureProfile, provider: ModelProvider, guidance?: string) {
  const raw = await provider.generateJson<unknown>(buildInitialPetMotionPlanPrompt(profile, guidance));
  const schema = z.object({
    card: z.object({
      key: z.string().min(1).max(40),
      title: z.string().min(1).max(120),
      caption: z.string().min(1).max(220).optional(),
      prompt: z.string().min(1).max(1200),
      style: z.string().min(1).max(240).optional(),
      durationSeconds: z.number().min(4).max(20).optional()
    })
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid initial motion plan JSON (${parsed.error.issues.map((issue) => issue.message).join("; ").slice(0, 180)})`);
  const card = parsed.data.card;
  return { ...card, durationSeconds: Math.max(4, Math.min(20, Math.round(card.durationSeconds ?? 8))) };
}

function buildInitialPetMotionPlanPrompt(profile: CreatureProfile, guidance?: string) {
  const existing = initialMotionActionCards(profile).map((card) => ({
    title: card.title,
    sourceIds: card.sourceIds
  }));
  const userMotionGuidance = guidance?.trim() || "";
  return `你是 Papo 的动作卡导演。请基于当前小动物 profile，为首页准备 1 张初始动作视频卡。

目标：
- 这次只规划一张动作卡，不要一次返回多张。用户可以重复点击，最多补到 4 张初始动作。
- 动作应该像首页状态视频一样自然，可循环，可被用户点击切换。
- 如果 userMotionGuidance 有内容，它就是这次动作卡的主目标。必须优先保留用户指定的动作、物体、情绪和场景，不要把它改写成默认按钮动作。
- 默认动作库只在用户没有提供明确动作时使用，用于补齐陪伴产品最常用的状态：待着、回应用户、玩耍/好奇、休息；不要重复已有动作。
- prompt 只描述画面和动作，不写内部流程。
- LLM 的职责是整合：把当前 profile 的外观/画风/镜头/循环约束，与用户提示里的动作内容合成一个可生成的视频提示词。动作内容优先来自用户，画风和身份优先来自 profile/reference image。
- 必须保持同一个角色外观，不要创造新角色。
- 必须明确这是“真实动物/当前数字形象的动作视频”，不是玩具、毛绒公仔、摆件或产品模型。
- 要求动作用固定镜头、全身可见、首尾姿态尽量一致，适合无缝循环。

pet_profile:
${JSON.stringify({
  creatureName: profile.creatureName,
  petKind: profile.petKind,
  petProfile: profile.petProfile,
  dogState: profile.dogState,
  existingInitialMotions: existing,
  userMotionGuidance: userMotionGuidance || "未提供"
})}

返回严格 JSON：
{
  "card": {
    "key":"简短动作键名。如果用户给了动作，key 应贴近用户动作",
    "title":"面向用户的动作卡标题",
    "caption":"这张动作卡发生了什么，一句话",
    "prompt":"视频画面提示词。必须先写用户指定动作；再写同一只小动物的 profile 外观和画风；最后写镜头、循环、禁止玩具感等约束",
    "style":"视觉风格。优先对齐 petProfile.visualStyle 和 reference/avatar photo，不要另起风格",
    "durationSeconds":8
  }
}`;
}

function buildInitialMotionVideoPrompt(profile: CreatureProfile, card: { title: string; prompt: string; style?: string }, hasReferenceImage: boolean) {
  const identity = petVisualIdentity(profile);
  return [
    `Create a short looping animated video action card for ${profile.creatureName}, a ${identity.species}.`,
    "Visual goal: a living digital pet based on the current profile image/photo, lightly stylized for a polished companion app. It must look like the same animal/creature from the profile, not a plush toy or figurine.",
    "Scene and camera: warm clean app background, soft natural light, full body centered, locked camera, stable scale, no cuts, no zoom unless extremely subtle.",
    `Character identity: ${identity.appearance}`,
    `Personality/habits: ${identity.personality} ${identity.habits}`,
    `Motion style: ${identity.motionStyle}`,
    hasReferenceImage ? "The attached image is the approved cover and exact first frame for this action. Animate it directly. Do not redesign, reinterpret or restyle the character, background, palette, proportions, lighting, or rendering technique." : "Use the written profile as strict grounding for character identity.",
    "Action priority: preserve the action, object, mood, and scene requested in the action direction. Do not replace a user-requested action with a generic idle, wave, ball, or nap action.",
    "Loop requirement: first frame and final frame should match as closely as possible in pose, position, camera framing, and background. The motion should return to the starting pose for a seamless loop.",
    "Forbidden look: stuffed animal, plush toy, fabric doll, vinyl toy, figurine, statue, clay model, product mockup, visible seams, toy joints, plastic shine, stitched fabric.",
    "No UI, no text, no watermark, no human, no extra animals, no props that hide the body.",
    `Action card title: ${card.title}`,
    `Action direction: ${card.prompt}`,
    card.style ? `Extra style: ${card.style}` : ""
  ].filter(Boolean).join("\n\n");
}

function buildInitialMotionKeyframePrompt(profile: CreatureProfile, card: { title: string; prompt: string; style?: string }, hasReferenceImage: boolean) {
  const identity = petVisualIdentity(profile);
  return [
    `Create one square first-frame key image for a looping action video of ${profile.creatureName}, a ${identity.species}.`,
    "This is not the final video. It is the still keyframe that the video model will animate from.",
    "Visual goal: a living digital pet based on the current profile image/photo, lightly stylized for a polished companion app. It must look like the same animal/creature from the profile, not a plush toy or figurine.",
    hasReferenceImage ? "The first attached current profile/avatar image is the authoritative identity and art-style source. Match its exact rendering medium, palette, linework or 3D treatment, lighting, facial design, body proportions and background language. Change only pose/action setup." : "Use the written profile as the identity source.",
    "Composition: warm clean app background, soft natural light, full body centered, stable scale, clear silhouette. The pose should be the starting pose and also suitable as the ending pose for a loop.",
    "Action priority: the still keyframe must visibly set up the user's requested action. Do not fall back to a generic default pose if the action direction names a specific action.",
    `Character identity: ${identity.appearance}`,
    `Authoritative visual style: ${identity.visualStyle}`,
    `Personality/habits: ${identity.personality} ${identity.habits}`,
    `Action title: ${card.title}`,
    `Action keyframe direction: ${card.prompt}`,
    card.style ? `Extra style: ${card.style}` : "",
    "Forbidden look: stuffed animal, plush toy, fabric doll, vinyl toy, figurine, statue, clay model, product mockup, visible seams, toy joints, plastic shine, stitched fabric.",
    "No UI, no text, no watermark, no human, no extra animals, no props that hide the body."
  ].filter(Boolean).join("\n\n");
}

function initialMotionActionCards(profile: CreatureProfile) {
  return (profile.actionCards ?? []).filter((card) => !card.deleted && card.sourceIds.some((id) => id.startsWith("initial-motion:")));
}

async function planEveningDiaryIllustration(
  profile: CreatureProfile,
  emergence: EmergenceRecord,
  actionResult: ActionResult,
  references: ImageReference[],
  provider: ModelProvider,
  now: string
): Promise<IllustrationPlan> {
  const raw = await provider.generateJson<unknown>(buildEveningDiaryIllustrationPlanPrompt(profile, emergence, actionResult, references, now));
  return normalizeIllustrationPlan(raw);
}

function buildEveningDiaryIllustrationPlanPrompt(
  profile: CreatureProfile,
  emergence: EmergenceRecord & { memoryId?: string },
  actionResult: ActionResult,
  references: ImageReference[],
  now: string
) {
  const sourceEpisodes = profile.episodes
    .filter((episode) => actionResult.sourceIds?.includes(episode.id) || emergence.relatedMemoryIds.includes(episode.id))
    .slice(0, 8)
    .map((episode) => ({
      id: episode.id,
      createdAt: episode.createdAt,
      inputSummary: episode.inputSummary,
      noticed: episode.noticed,
      response: episode.creatureResponse,
      tags: episode.tags,
      attachmentIds: (episode.attachments ?? []).map((attachment) => attachment.id)
    }));
  const sourceMemories = profile.longTermMemories
    .filter((memory) => actionResult.sourceIds?.includes(memory.id) || emergence.relatedMemoryIds.includes(memory.id) || memory.id === emergence.memoryId)
    .slice(0, 8)
    .map((memory) => ({
      id: memory.id,
      kind: memory.kind,
      text: memory.text,
      tags: memory.tags,
      sourceEpisodeId: memory.sourceEpisodeId
    }));
  return `你是 Papo 的观察日记漫画规划脑。你不生成图片，只规划一张晚间观察日记漫画，然后给图片模型写最终提示词。

目标：
- 先理解当天真实素材，再决定这张漫画包含哪些元素、几个分镜、现实与想象如何有机组合。
- 优先画成 3-6 格手绘多格漫画，像“Papo 今天看到的用户的一天”。
- 可以有温柔的想象世界和 Papo 视角，但必须锚定真实 episode、记忆、照片或音频观察；不要编造当天没有发生的核心事件。
- 如果有原始图片引用，它们已经会作为 image references 交给图片模型；你的 finalPrompt 要提醒图片模型使用这些引用作为视觉依据。
- 不要写 UI、文字标签、气泡文字、截图、真实照片风格。

当前时间：${now}
Papo 主动消息：${emergence.message}
初始图像草稿：
${JSON.stringify({
  title: actionResult.title,
  caption: actionResult.caption,
  prompt: actionResult.prompt,
  style: actionResult.style,
  sourceIds: actionResult.sourceIds
})}
source_episodes:
${JSON.stringify(sourceEpisodes)}
source_memories:
${JSON.stringify(sourceMemories)}
reference_images:
${JSON.stringify(references.map((reference, index) => ({ index: index + 1, label: reference.label })))}

返回严格 JSON object：
{
  "summary": "这张漫画整体想表达什么",
  "elements": ["画面必须包含的元素1", "元素2"],
  "panels": [
    {"title":"第1格主题","scene":"第1格画面描述","sourceIds":["episode_xxx","img_xxx"]}
  ],
  "realityMix": "哪些来自现实素材，哪些是 Papo 视角的温柔想象",
  "finalPrompt": "给图片生成模型的完整英文或中英混合提示词，必须明确 3-6 panel hand-drawn comic diary, from Papo's point of view, no text labels, grounded in sources"
}`;
}

function normalizeIllustrationPlan(raw: unknown): IllustrationPlan {
  if (!raw || typeof raw !== "object") throw new Error("illustration planner returned empty result");
  const value = raw as Partial<IllustrationPlan>;
  const summary = cleanPlanText(value.summary, "illustration planner requires summary");
  const elements = cleanPlanList(value.elements, "illustration planner requires elements").slice(0, 12);
  const panels = Array.isArray(value.panels)
    ? value.panels
        .map((panel) => normalizeIllustrationPanel(panel))
        .filter((panel): panel is IllustrationPlan["panels"][number] => Boolean(panel))
        .slice(0, 6)
    : [];
  if (!panels.length) throw new Error("illustration planner requires at least one panel");
  const realityMix = cleanPlanText(value.realityMix, "illustration planner requires realityMix");
  const finalPrompt = cleanPlanText(value.finalPrompt, "illustration planner requires finalPrompt");
  return { summary, elements, panels, realityMix, finalPrompt };
}

function normalizeIllustrationPanel(panel: unknown): IllustrationPlan["panels"][number] | undefined {
  if (!panel || typeof panel !== "object") return undefined;
  const value = panel as { title?: unknown; scene?: unknown; sourceIds?: unknown };
  const title = typeof value.title === "string" ? value.title.trim().slice(0, 120) : "";
  const scene = typeof value.scene === "string" ? value.scene.trim().slice(0, 600) : "";
  if (!title || !scene) return undefined;
  const sourceIds = Array.isArray(value.sourceIds) ? value.sourceIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).slice(0, 8) : undefined;
  return { title, scene, sourceIds };
}

function cleanPlanText(value: unknown, error: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(error);
  return value.trim().slice(0, 4000);
}

function cleanPlanList(value: unknown, error: string) {
  if (!Array.isArray(value)) throw new Error(error);
  const items = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim().slice(0, 240));
  if (!items.length) throw new Error(error);
  return items;
}

function illustrationPromptForEmergence(actionResult: ActionResult, emergence: EmergenceRecord, profile: CreatureProfile, references: ImageReference[] = [], plan?: IllustrationPlan) {
  const sourceEpisodes = profile.episodes
    .filter((episode) => actionResult.sourceIds?.includes(episode.id) || emergence.relatedMemoryIds.includes(episode.id))
    .slice(0, 5)
    .map((episode) => `${episode.id}: ${episode.inputSummary} ${episode.noticed}`)
    .join("\n");
  return [
    "Create one warm hand-drawn multi-panel comic observation diary from Papo's point of view.",
    "No UI, no text labels, no screenshots, no photorealistic rendering.",
    "Preferred composition: 3-6 comic panels that gently depict the user's day as Papo saw it, with small visual continuity across panels.",
    "Use a single postcard-like scene only if the source material clearly contains just one simple moment.",
    "Style: soft hand-drawn lines, cozy colors, gentle manga/comic feeling, diary-like pacing.",
    actionResult.style ? `Requested style: ${actionResult.style}` : "",
    "Ground the image in real memories and episodes. Do not invent unrelated events.",
    `Papo message: ${emergence.message}`,
    sourceEpisodes ? `Source episodes:\n${sourceEpisodes}` : "",
    references.length ? `${references.length} original uploaded image reference(s) are attached to the image generation request. Use them as visual grounding.` : "",
    plan ? `LLM comic plan:\n${JSON.stringify(plan)}` : "",
    plan?.finalPrompt ? `Final image prompt from comic planner:\n${plan.finalPrompt}` : "",
    `Image prompt from emergence model:\n${actionResult.prompt}`
  ].filter(Boolean).join("\n\n");
}

async function illustrationReferences(attachments?: MediaAttachment[]): Promise<ImageReference[]> {
  const images = (attachments ?? []).filter((attachment) => attachment.kind === "image" && attachment.generatedBy !== "papo_illustration").slice(0, 4);
  const references: ImageReference[] = [];
  for (const image of images) {
    const dataUrl = await imageAttachmentDataUrl(image);
    if (dataUrl) references.push({ dataUrl, label: image.label });
  }
  return references;
}

async function actionCardReferences(profile: CreatureProfile, attachments?: MediaAttachment[], replacementCardId?: string): Promise<ImageReference[]> {
  const profileReferences = await petProfileVisualReferences(profile);
  const uploaded = await illustrationReferences(attachments);
  const previousCard = replacementCardId ? profile.actionCards?.find((card) => card.id === replacementCardId) : undefined;
  const previousCover = previousCard?.cover ? await imageAttachmentDataUrl(previousCard.cover) : undefined;
  const historical = previousCover ? [{ dataUrl: previousCover, label: `Historical card activity reference: ${previousCard?.title ?? replacementCardId}` }] : [];
  if (profileReferences.length) return [...profileReferences, ...uploaded, ...historical].slice(0, 4);
  const character = await generatedPetReference(profile);
  return [...(character ? [character] : []), ...uploaded, ...historical].slice(0, 4);
}

async function petProfileReferences(referenceAttachment?: MediaAttachment): Promise<ImageReference[]> {
  if (!referenceAttachment) return [];
  const dataUrl = await imageAttachmentDataUrl(referenceAttachment);
  return dataUrl ? [{ dataUrl, label: referenceAttachment.label }] : [];
}

async function petProfileVisualReferences(profile: CreatureProfile): Promise<ImageReference[]> {
  const references: ImageReference[] = [];
  for (const image of [profile.petProfile?.avatarImage, profile.petProfile?.referenceImage]) {
    if (!image) continue;
    const dataUrl = await imageAttachmentDataUrl(image);
    if (dataUrl) references.push({ dataUrl, label: image.label });
  }
  return references;
}

async function generatedPetReference(profile: CreatureProfile): Promise<ImageReference | undefined> {
  if (profile.petKind !== "british-shorthair") return undefined;
  const assetPath = path.join(process.cwd(), "public", "pets", "generated", "british-shorthair-v1", "poke-wave.webp");
  try {
    const buffer = await readFile(assetPath);
    return {
      dataUrl: `data:image/webp;base64,${buffer.toString("base64")}`,
      label: `${profile.creatureName} character reference card`
    };
  } catch {
    return undefined;
  }
}

async function imageAttachmentDataUrl(image: MediaAttachment) {
  const match = image.url.match(/^\/api\/assets\/(img_[a-f0-9]{24}\.(?:png|jpg|webp))$/);
  if (!match) return undefined;
  try {
    const buffer = await readFile(path.join(imageAssetDir(), match[1]));
    return `data:${image.mime};base64,${buffer.toString("base64")}`;
  } catch {
    return undefined;
  }
}

async function mediaAttachmentDataUrl(attachment: MediaAttachment) {
  if (attachment.kind === "image") return imageAttachmentDataUrl(attachment);
  if (attachment.kind !== "audio") return undefined;
  const match = attachment.url.match(/^\/api\/assets\/(aud_[a-f0-9]{24}\.(?:webm|wav|mp3|m4a|ogg|aac))$/);
  if (!match) return undefined;
  try {
    const buffer = await readFile(path.join(imageAssetDir(), match[1]));
    return `data:${attachment.mime};base64,${buffer.toString("base64")}`;
  } catch {
    return undefined;
  }
}

function parseImageDataUrl(dataUrl: string): { mime: "image/png" | "image/jpeg" | "image/webp"; extension: "png" | "jpg" | "webp"; buffer: Buffer } {
  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/);
  if (!match) throw new HttpError(400, "Invalid image data URL");
  const rawMime = match[1] === "image/jpg" ? "image/jpeg" : match[1];
  const mime = rawMime as "image/png" | "image/jpeg" | "image/webp";
  const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.byteLength) throw new HttpError(400, "Empty image asset");
  return { mime, extension, buffer };
}

function parseAudioDataUrl(dataUrl: string): { mime: "audio/webm" | "audio/wav" | "audio/mpeg" | "audio/mp4" | "audio/ogg" | "audio/aac"; extension: "webm" | "wav" | "mp3" | "m4a" | "ogg" | "aac"; buffer: Buffer } {
  const match = dataUrl.match(/^data:(audio\/(?:webm|wav|mpeg|mp4|ogg|aac))(?:;[^,]+)?;base64,(.+)$/);
  if (!match) throw new HttpError(400, "Invalid audio data");
  const mime = match[1] as "audio/webm" | "audio/wav" | "audio/mpeg" | "audio/mp4" | "audio/ogg" | "audio/aac";
  const extension = ({ "audio/webm": "webm", "audio/wav": "wav", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/aac": "aac" } as const)[mime];
  return { mime, extension, buffer: Buffer.from(match[2], "base64") };
}

function parseVideoDataUrl(dataUrl: string): { buffer: Buffer } {
  const match = dataUrl.match(/^data:video\/(?:mp4|quicktime|mpeg);base64,(.+)$/);
  if (!match) throw new HttpError(400, "Invalid video data URL");
  const buffer = Buffer.from(match[1], "base64");
  if (!buffer.byteLength) throw new HttpError(400, "Empty video asset");
  return { buffer };
}

async function requireExistingProfile(store: ProfileStore, userId: string) {
  const profile = await store.getProfile(userId);
  if (!profile) throw new HttpError(404, "Profile not found");
  return profile;
}

async function requireProfile(store: ProfileStore, userId: string, req?: express.Request) {
  const profile = await requireExistingProfile(store, userId);
  if (req) assertProfilePassword(profile, authPasswordFromRequest(req));
  return profile;
}

async function requireNativeProfile(store: ProfileStore, deviceAuth: DeviceAuthService, userId: string, req: express.Request) {
  const authorization = req.header("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  if (match && await deviceAuth.verify(userId, match[1])) return requireExistingProfile(store, userId);
  throw new HttpError(401, "Valid device session required");
}

function assertProfilePassword(profile: CreatureProfile, inputPassword?: string) {
  const password = profilePassword(profile);
  if (!password) return;
  if (!inputPassword) throw new HttpError(401, "Password required");
  if (inputPassword !== password) throw new HttpError(401, "Password is incorrect");
}

function profilePassword(profile: CreatureProfile) {
  return typeof profile.password === "string" && profile.password.trim() ? profile.password : undefined;
}

function authPasswordFromRequest(req: express.Request) {
  const value = req.header("x-papo-password");
  return typeof value === "string" ? value : undefined;
}

function publicProfile(profile: CreatureProfile): CreatureProfile {
  const { password: _password, ...rest } = profile;
  return { ...rest, hasPassword: Boolean(profilePassword(profile)) };
}

function publicCaptureResult(result: CaptureResult, providerKind: string) {
  return { ...result, profile: publicProfile(result.profile), provider: providerKind };
}

function plannedConversationJobs(turn: ConversationTurnRecord, parent: ConversationJobRecord, result: CaptureResult): ConversationJobRecord[] {
  const now = new Date().toISOString();
  const jobs: ConversationJobRecord[] = [];
  for (const event of result.events) {
    const actions: PlannedAction[] = [
      ...(event.backgroundActions ?? []),
      ...(["generate_illustration", "generate_action_card", "use_hermes"].includes(event.actionDecision.action) && event.actionResult
        ? [{ action: event.actionDecision.action, actionResult: event.actionResult } as PlannedAction]
        : [])
    ];
    for (const [index, action] of actions.entries()) {
      const type = action.action === "generate_illustration" ? "illustration" : action.action === "generate_action_card" ? "action_card" : action.action === "use_hermes" ? "hermes" : undefined;
      if (!type) continue;
      const id = `${turn.id}-${type}-${event.id}-${index}`;
      jobs.push({
        id,
        turnId: turn.id,
        requestId: turn.requestId,
        type,
        stage: "action",
        status: "queued",
        attempt: 0,
        maxAttempts: 3,
        retryable: true,
        createdAt: now,
        updatedAt: now,
        dependsOn: [parent.id],
        sourceIds: [...new Set([turn.id, parent.id, event.id, event.triggerSegmentId, ...(action.actionResult.sourceIds ?? [])].filter(Boolean) as string[])],
        eventId: event.id,
        event: structuredClone(event),
        episodeId: result.episodes.find((episode) => episode.sourceSegmentId === event.triggerSegmentId || episode.sourceBatchId === event.triggerBatchId)?.id,
        action: structuredClone(action)
      });
    }
  }
  return jobs;
}

function isAmbientTurn(turn: ConversationTurnRecord) {
  return turn.id.startsWith("turn_live_") || turn.id.startsWith("turn_native_");
}

function commitCognitionOwnedRecords(
  latest: CreatureProfile,
  base: CreatureProfile,
  computed: CreatureProfile,
  result: CaptureResult,
  inputMessages: CreatureProfile["conversation"],
  reply: CreatureProfile["conversation"][number] | undefined,
  childJobs: ConversationJobRecord[],
  parentJob: ConversationJobRecord
) {
  const ownedEpisodeIds = new Set(result.episodes.map((item) => item.id));
  const ownedCandidateIds = new Set((result.memoryCandidates ?? []).map((item) => item.id));
  const baseMemoryIds = new Set(base.longTermMemories.map((item) => item.id));
  const ownedMemories = computed.longTermMemories.filter((item) => !baseMemoryIds.has(item.id) || ownedEpisodeIds.has(item.sourceEpisodeId ?? ""));
  const baseStateChangeKeys = new Set(base.stateChanges.map((item) => `${item.at}\u0000${item.reason}`));
  const ownedStateChanges = computed.stateChanges.filter((item) => !baseStateChangeKeys.has(`${item.at}\u0000${item.reason}`));
  const stateDelta = stateDeltaBetween(base.state, computed.state);
  latest.state = applyOwnedStateDelta(latest.state, stateDelta);
  latest.stateChanges = mergeOwnedByKey(latest.stateChanges, ownedStateChanges, (item) => `${item.at}\u0000${item.reason}`).slice(0, 80);
  latest.episodes = mergeOwnedById(latest.episodes, computed.episodes.filter((item) => ownedEpisodeIds.has(item.id))).slice(0, 80);
  latest.memoryCandidates = mergeOwnedById(latest.memoryCandidates, computed.memoryCandidates.filter((item) => ownedCandidateIds.has(item.id))).slice(0, 80);
  latest.longTermMemories = mergeOwnedById(latest.longTermMemories, ownedMemories).slice(0, 80);
  const baseSemanticIds = new Set(base.semanticBrainHistory.map((item) => item.id));
  latest.semanticBrainHistory = mergeOwnedById(latest.semanticBrainHistory, computed.semanticBrainHistory.filter((item) => !baseSemanticIds.has(item.id))).slice(0, 30);
  latest.conversation = mergeOwnedById(latest.conversation, inputMessages).slice(0, 80);
  if (reply) latest.conversation = mergeOwnedById(latest.conversation, [reply]).slice(0, 80);
  latest.jobs = mergeOwnedById(latest.jobs ?? [], childJobs).slice(0, 240);
  const turn = latest.turns?.find((item) => item.id === parentJob.turnId);
  if (turn) turn.jobIds = [...new Set([...turn.jobIds, ...childJobs.map((item) => item.id)])];
  if (computed.petProfile.updatedAt !== base.petProfile.updatedAt) latest.petProfile = computed.petProfile;
  latest.lastSeenAt = maxIso(latest.lastSeenAt, computed.lastSeenAt);
}

function mergeOwnedById<T extends { id: string }>(current: T[], owned: T[]) {
  const ownedIds = new Set(owned.map((item) => item.id));
  return [...owned, ...current.filter((item) => !ownedIds.has(item.id))];
}

function mergeOwnedByKey<T>(current: T[], owned: T[], keyOf: (item: T) => string) {
  const ownedIds = new Set(owned.map(keyOf));
  return [...owned, ...current.filter((item) => !ownedIds.has(keyOf(item)))];
}

function stateDeltaBetween(before: CreatureProfile["state"], after: CreatureProfile["state"]) {
  const keys = ["curiosity", "attachment", "energy", "arousal", "safety", "confidence"] as const;
  return Object.fromEntries(keys.map((key) => [key, after[key] - before[key]])) as Record<typeof keys[number], number>;
}

function applyOwnedStateDelta(current: CreatureProfile["state"], delta: ReturnType<typeof stateDeltaBetween>) {
  const next = clampState({ ...current });
  for (const key of Object.keys(delta) as Array<keyof typeof delta>) next[key] = Math.max(0, Math.min(100, Math.round(next[key] + delta[key])));
  next.mood = deriveMood(next);
  return next;
}

function maxIso(left: string, right: string) {
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function feedbackInputText(kind: string, content?: string) {
  const label = {
    understood: "懂了",
    continue: "再想想",
    not_now: "轻一点",
    remember: "记住",
    important: "重要",
    remind: "提醒",
    correct: "改准",
    forget: "放下"
  }[kind] ?? kind;
  const note = content?.trim();
  return note ? `${label}：${note}` : label;
}

function semanticRecordIds(profile: CreatureProfile) {
  return new Set((profile.semanticBrainHistory ?? []).map((record) => record.id));
}

function segmentDisplayText(kind: StreamSegment["kind"], text: string) {
  if (kind === "audio_observation") return audioObservationPreview(text);
  if (kind === "image_summary") return imageSummaryPreview(text);
  return undefined;
}

function newSemanticRuns(profile: CreatureProfile, beforeIds: Set<string>) {
  return (profile.semanticBrainHistory ?? []).filter((record) => !beforeIds.has(record.id)).reverse();
}

function captureCognitionTrace(
  result: CaptureResult,
  provider: ModelProvider,
  source: "button" | "curious_stream",
  modelRuns: SemanticBrainRecord[],
  sensingTraces: SensingTrace[] = []
): MessageCognitionTrace {
  return {
    at: new Date().toISOString(),
    source,
    providerKind: provider.kind,
    providerName: provider.name,
    model: provider.diagnostics?.textModel,
    sensingTraces,
    modelRuns,
    harnessTrace: result.harnessTrace ?? [],
    attentionDecision: result.curiousSession ? {
      attentionBudget: result.curiousSession.attentionBudget,
      selected: result.curiousSession.selected,
      ignored: result.curiousSession.ignored,
      creatureReport: result.curiousSession.creatureReport
    } : undefined,
    eventDecisions: result.events.map((event) => {
      const episode = result.episodes.find((item) => item.sourceSegmentId === event.triggerSegmentId || item.id === event.triggerSegmentId);
      const memoryCandidateKept = Boolean(episode && (result.memoryCandidates ?? []).some((candidate) => candidate.sourceEpisodeId === episode.id));
      return {
        eventId: event.id,
        sourceLabel: event.triggerLabel,
        sourceText: event.triggerContent,
        action: event.actionDecision.action,
        semanticSource: event.semanticSource,
        noticed: event.noticed,
        reason: event.reason,
        visibleReply: event.id === result.events[0]?.id ? result.response : undefined,
        actionResult: event.actionResult,
        backgroundActions: event.backgroundActions,
        stateDeltas: event.actionStateDeltas,
        episodeKept: Boolean(episode),
        memoryCandidateKept,
        relatedMemoryIds: event.relatedMemoryIds,
        decisionTrace: event.decisionTrace ?? event.actionDecision.ruleTrace ?? []
      };
    }),
    episodeDecisions: result.episodes.map((episode) => ({
      episodeId: episode.id,
      action: episode.actionDecision?.action,
      kept: true,
      memoryCandidateIds: episode.memoryCandidateIds,
      decisionTrace: episode.decisionTrace ?? episode.actionDecision?.ruleTrace ?? []
    })),
    memoryDecisions: (result.memoryCandidates ?? []).map((candidate) => ({
      candidateId: candidate.id,
      sourceEpisodeId: candidate.sourceEpisodeId,
      status: candidate.status,
      writePolicy: candidate.writePolicy,
      memoryKind: candidate.memoryKind,
      text: candidate.candidateText,
      why: candidate.whyConsolidate
    }))
  };
}

function feedbackCognitionTrace(
  feedback: FeedbackRecord,
  provider: ModelProvider,
  modelRuns: SemanticBrainRecord[],
  profile: CreatureProfile,
  targetBefore?: FeedbackTargetSnapshot
): MessageCognitionTrace {
  return {
    at: new Date().toISOString(),
    source: "feedback",
    providerKind: provider.kind,
    providerName: provider.name,
    model: provider.diagnostics?.textModel,
    modelRuns,
    feedbackDecision: {
      feedbackId: feedback.id,
      kind: feedback.kind,
      targetId: feedback.targetId,
      inputText: feedback.inputText,
      effect: feedback.effect,
      learningNote: feedback.learningNote,
      responseAction: feedback.responseAction,
      replyText: feedback.replyText,
      memoryCandidateIds: feedback.memoryCandidateIds ?? [],
      memoryChanges: feedbackMemoryChanges(profile, targetBefore),
      stateDeltas: feedback.stateDeltas ?? [],
      policyDeltas: feedback.policyDeltas ?? []
    }
  };
}

interface FeedbackTargetSnapshot {
  id: string;
  type: "memory" | "episode" | "candidate";
  text?: string;
  kind?: CreatureProfile["longTermMemories"][number]["kind"];
  weight?: number;
  status?: CreatureProfile["memoryCandidates"][number]["status"];
  relatedMemories: FeedbackMemorySnapshot[];
}

interface FeedbackMemorySnapshot {
  id: string;
  text: string;
  kind: CreatureProfile["longTermMemories"][number]["kind"];
  weight: number;
}

function feedbackTargetSnapshot(profile: CreatureProfile, targetId?: string): FeedbackTargetSnapshot | undefined {
  if (!targetId) return undefined;
  const memory = profile.longTermMemories.find((item) => item.id === targetId);
  if (memory) {
    return { id: memory.id, type: "memory", text: memory.text, kind: memory.kind, weight: memory.weight, relatedMemories: [snapshotMemory(memory)] };
  }
  const episode = profile.episodes.find((item) => item.id === targetId);
  if (episode) {
    return {
      id: episode.id,
      type: "episode",
      text: episode.inputSummary,
      weight: episode.weight,
      relatedMemories: profile.longTermMemories.filter((item) => item.sourceEpisodeId === episode.id).map(snapshotMemory)
    };
  }
  const candidate = profile.memoryCandidates.find((item) => item.id === targetId);
  if (candidate) {
    return {
      id: candidate.id,
      type: "candidate",
      text: candidate.candidateText,
      kind: candidate.memoryKind,
      weight: candidate.confidence,
      status: candidate.status,
      relatedMemories: profile.longTermMemories.filter((item) => item.sourceEpisodeId === candidate.sourceEpisodeId).map(snapshotMemory)
    };
  }
  return undefined;
}

function feedbackMemoryChanges(profile: CreatureProfile, before?: FeedbackTargetSnapshot): NonNullable<MessageCognitionTrace["feedbackDecision"]>["memoryChanges"] {
  if (!before) return [];
  const changes: NonNullable<MessageCognitionTrace["feedbackDecision"]>["memoryChanges"] = [];
  const afterMemory = before.type === "memory" ? profile.longTermMemories.find((item) => item.id === before.id) : undefined;
  const afterEpisode = before.type === "episode" ? profile.episodes.find((item) => item.id === before.id) : undefined;
  const afterCandidate = before.type === "candidate" ? profile.memoryCandidates.find((item) => item.id === before.id) : undefined;
  const after = afterMemory
    ? { id: afterMemory.id, type: "memory" as const, text: afterMemory.text, kind: afterMemory.kind, weight: afterMemory.weight }
    : afterEpisode
      ? { id: afterEpisode.id, type: "episode" as const, text: afterEpisode.inputSummary, weight: afterEpisode.weight }
      : afterCandidate
        ? { id: afterCandidate.id, type: "candidate" as const, text: afterCandidate.candidateText, kind: afterCandidate.memoryKind, weight: afterCandidate.confidence, status: afterCandidate.status }
        : undefined;

  if (!after) {
    changes.push({
      targetId: before.id,
      targetType: before.type,
      operation: "purged",
      beforeText: before.text,
      beforeKind: before.kind,
      beforeWeight: before.weight
    });
  } else {
    const changed = before.text !== after.text || before.kind !== after.kind || before.weight !== after.weight || before.status !== after.status;
    changes.push({
      targetId: before.id,
      targetType: before.type,
      operation: changed ? "updated" : "unchanged",
      beforeText: before.text,
      afterText: after.text,
      beforeKind: before.kind,
      afterKind: after.kind,
      beforeWeight: before.weight,
      afterWeight: after.weight
    });
  }

  const relatedBefore = new Map(before.relatedMemories.map((item) => [item.id, item]));
  const relatedAfter = relatedFeedbackMemories(profile, before);
  for (const memory of relatedAfter) {
    const old = relatedBefore.get(memory.id);
    if (!old) {
      changes.push({
        targetId: memory.id,
        targetType: "memory",
        operation: "created",
        afterText: memory.text,
        afterKind: memory.kind,
        afterWeight: memory.weight
      });
      continue;
    }
    const changed = old.text !== memory.text || old.kind !== memory.kind || old.weight !== memory.weight;
    changes.push({
      targetId: memory.id,
      targetType: "memory",
      operation: changed ? "updated" : "unchanged",
      beforeText: old.text,
      afterText: memory.text,
      beforeKind: old.kind,
      afterKind: memory.kind,
      beforeWeight: old.weight,
      afterWeight: memory.weight
    });
    relatedBefore.delete(memory.id);
  }
  for (const old of relatedBefore.values()) {
    changes.push({
      targetId: old.id,
      targetType: "memory",
      operation: "purged",
      beforeText: old.text,
      beforeKind: old.kind,
      beforeWeight: old.weight
    });
  }
  return changes;
}

function relatedFeedbackMemories(profile: CreatureProfile, before: FeedbackTargetSnapshot) {
  if (before.type === "memory") {
    return profile.longTermMemories.filter((item) => item.id === before.id).map(snapshotMemory);
  }
  if (before.type === "candidate") {
    const candidate = profile.memoryCandidates.find((item) => item.id === before.id);
    return profile.longTermMemories.filter((item) => item.sourceEpisodeId === candidate?.sourceEpisodeId).map(snapshotMemory);
  }
  return profile.longTermMemories.filter((item) => item.sourceEpisodeId === before.id).map(snapshotMemory);
}

function snapshotMemory(memory: CreatureProfile["longTermMemories"][number]): FeedbackMemorySnapshot {
  return { id: memory.id, text: memory.text, kind: memory.kind, weight: memory.weight };
}

function emergenceCognitionTrace(
  emergence: EmergenceRecord & { text: string; memoryId?: string },
  provider: ModelProvider,
  modelRuns: SemanticBrainRecord[]
): MessageCognitionTrace {
  return {
    at: new Date().toISOString(),
    source: "emergence",
    providerKind: provider.kind,
    providerName: provider.name,
    model: provider.diagnostics?.textModel,
    modelRuns,
    emergenceDecision: {
      emergenceId: emergence.id,
      kind: emergence.kind,
      shouldEmerge: Boolean(emergence.text?.trim()),
      driveSource: emergence.driveSource,
      whyNow: emergence.whyNow,
      message: emergence.text,
      actionResult: emergence.actionResult,
      memoryId: emergence.memoryId,
      proactiveLevel: emergence.proactiveLevel,
      relatedMemoryIds: emergence.relatedMemoryIds,
      ruleTrace: emergence.ruleTrace
    }
  };
}

function feedbackRelatedMemoryIds(profile: CreatureProfile, targetId?: string, targetMemoryIdBefore?: string) {
  const ids = new Set<string>();
  if (targetMemoryIdBefore && profile.longTermMemories.some((memory) => memory.id === targetMemoryIdBefore)) {
    ids.add(targetMemoryIdBefore);
  }
  if (targetId) {
    const candidate = profile.memoryCandidates.find((item) => item.id === targetId);
    for (const memory of profile.longTermMemories) {
      if (memory.sourceEpisodeId === targetId) ids.add(memory.id);
      if (candidate && memory.sourceEpisodeId === candidate.sourceEpisodeId) ids.add(memory.id);
    }
  }
  return [...ids];
}

function normalizeAudioObservation(text: string) {
  return normalizeAudioSensingResult(text);
}

function companionAudioSensingContext(profile: CreatureProfile, sessionId?: string) {
  if (!sessionId) return undefined;
  const session = profile.companionSessions?.find((item) => item.id === sessionId);
  if (!session) return undefined;
  const event = session.events?.find((item) => item.id === session.currentEventId);
  return JSON.stringify({
    currentContext: session.currentContext,
    currentEvent: event ? { id: event.id, title: event.title, kind: event.kind, speakers: event.speakers } : undefined
  });
}

function nativeAudioAuditSummary(status: SensingTrace["status"]) {
  if (status === "unreadable") return "这段后台录音没有整理出可用内容。";
  if (status === "empty") return "这段后台录音里没有听到需要继续处理的内容。";
  return "这段后台录音里没有形成需要继续处理的声音线索。";
}

function audioSensingTrace(
  provider: ModelProvider,
  label: string,
  observation: ReturnType<typeof normalizeAudioObservation>,
  options: { attempts?: number; retainedAudio?: RetainedAudioAsset; sourceSegmentId?: string } = {}
): SensingTrace {
  const status: SensingTrace["status"] = observation.text ? "content" : observation.unreadable ? "unreadable" : "empty";
  const decision = observation.text
    ? "音频模型读到了可用的生活信息；规则把它作为 audio_observation 放入当前录音切片，交给注意 LLM 决定是否继续处理。"
    : observation.unreadable
      ? "音频模型没有读出可用生活信息或认为音频不可读；规则只结算这段音频，不把它伪造成对话事件。"
      : "音频模型判断这段没有可用生活信息；规则只结算这段音频，不进入注意、行动或记忆流程。";
  return {
    at: new Date().toISOString(),
    modality: "audio",
    label,
    provider: sensingProvider(provider, "audio"),
    model: provider.diagnostics?.audioModel,
    route: provider.diagnostics?.audioRoute,
    semanticSource: "llm",
    status,
    decision,
    observation: observation.text || undefined,
    audioContent: observation.audioContent ? {
      ...observation.audioContent,
      speakers: observation.audioContent.speakers.map((speaker) => ({
        ...speaker,
        sourceSegmentIds: [...new Set([...speaker.sourceSegmentIds, ...(options.sourceSegmentId ? [options.sourceSegmentId] : [])])]
      }))
    } : undefined,
    attempts: options.attempts ?? 1,
    errorKind: status === "unreadable" ? "unreadable" : status === "empty" ? "empty" : undefined,
    retainedAudio: options.retainedAudio,
    ruleTrace: [
      "sensing: call audio-capable model",
      `status=${status}`,
      `attempts=${options.attempts ?? 1}`,
      observation.audioContent ? `audio_scene=${observation.audioContent.sceneType}` : "audio_scene=legacy_plain_text",
      observation.audioContent?.transcript ? `transcript_chars=${observation.audioContent.transcript.length}` : "transcript_chars=0",
      options.retainedAudio ? `retained_audio=${options.retainedAudio.id}` : "retained_audio=none",
      observation.text ? "route=curious_candidate" : "route=settle_audio_batch_only"
    ]
  };
}

async function observeAudioWithUnreadableRetry(provider: ModelProvider, dataUrl: string, prompt: string) {
  let observation = { text: "", unreadable: true };
  for (let attempts = 1; attempts <= 2; attempts += 1) {
    observation = normalizeAudioObservation(await observeAudioForSensing(provider, dataUrl, prompt));
    if (!observation.unreadable || attempts === 2) return { observation, attempts };
  }
  return { observation, attempts: 2 };
}

function imageSensingTrace(provider: ModelProvider, label: string, summary: string): SensingTrace {
  const observation = summary.trim();
  const status: SensingTrace["status"] = observation ? "content" : "empty";
  return {
    at: new Date().toISOString(),
    modality: "image",
    label,
    provider: sensingProvider(provider, "vision"),
    model: provider.diagnostics?.visionModel,
    route: "chat_completions",
    semanticSource: "llm",
    status,
    decision: observation
      ? "视觉模型读到了可用的图片信息；规则把它作为 image_summary 放入当前事件或陪伴批次，交给注意 LLM 决定是否继续处理。"
      : "视觉模型没有读到可用图片信息；规则不把它伪造成对话事件，也不进入注意、行动或记忆流程。",
    observation: observation || undefined,
    ruleTrace: [
      "sensing: call vision-capable model",
      `status=${status}`,
      observation ? "route=curious_candidate" : "route=settle_image_only"
    ]
  };
}

function sensingProvider(provider: ModelProvider, modality: "vision" | "audio") {
  return modality === "vision"
    ? provider.diagnostics?.visionProvider ?? provider.kind
    : provider.diagnostics?.audioProvider ?? provider.kind;
}

function sensingError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function zodErrorMessage(error: z.ZodError) {
  const flat = error.flatten();
  const dataUrlErrors = flat.fieldErrors.dataUrl ?? [];
  if (dataUrlErrors.some((message) => /too big|at most|String must contain at most|maximum/i.test(message))) {
    return "Image is too large";
  }
  if (dataUrlErrors.length) return "Invalid image data";
  return "Invalid request";
}

function imageDataUrlSchema() {
  return z.string().min(64).max(18_000_000).regex(/^data:image\/(png|jpe?g|webp);base64,/);
}

function audioDataUrlSchema() {
  return z
    .string()
    .min(64)
    .max(24_000_000)
    .regex(/^data:audio\/(webm|wav|wave|x-wav|mpeg|mp3|mp4|m4a|x-m4a|ogg|aac)(?:;[^,]+)?;base64,/);
}

function isTrustedPushEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && [
      "fcm.googleapis.com",
      "updates.push.services.mozilla.com",
      "web.push.apple.com"
    ].includes(url.hostname);
  } catch {
    return false;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

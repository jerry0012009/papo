import cors from "cors";
import express from "express";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { appendInputMessage, appendPapoMessage } from "../core/conversation";
import { audioObservationPreview, imageSummaryPreview } from "../core/display-text";
import { applyPetTouchState, isDogStateCheckDue, refreshDogStateIfDue } from "../core/dog-states";
import { isDreamingDue, recordDreamingFailure, semanticDreamMemories } from "../core/dreaming";
import { semanticDecideEmergence } from "../core/emergence";
import { applyFeedback, semanticReflectFeedback } from "../core/feedback";
import { runButtonHarness, runCuriousHarness } from "../core/harness";
import { createModelProvider, type ImageReference, type ModelProvider } from "../core/provider";
import { deferProactiveEmergence, isProactiveEmergenceDue, markProactiveUserResponse, settleProactiveEmergence } from "../core/proactive";
import { wakeCreature } from "../core/rhythm";
import type { ActionCardRecord, ActionResult, CaptureResult, CreatureProfile, EmergenceRecord, FeedbackRecord, IllustrationPlan, IllustrationRecord, MediaAttachment, MessageCognitionTrace, PetIdentityProfile, SemanticBrainRecord, SensingTrace, StreamSegment } from "../core/types";
import { createHermesBridge, type HermesBridge } from "./hermes";
import { JsonProfileStore, type ProfileStore } from "./store";

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

const petTouchSchema = z.object({
  action: z.enum(["idle", "poke-wave", "play-ball", "nap"])
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
  observation: z.string().max(1200).optional(),
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
        content: z.string().max(4000),
        auditOnly: z.boolean().optional(),
        observedAt: z.string().datetime().optional(),
        batchId: z.string().min(1).max(80).optional(),
        location: locationSchema.optional(),
        attachments: z.array(mediaAttachmentSchema).max(6).optional(),
        sensingTrace: sensingTraceSchema.optional()
      })
    )
    .min(1)
    .max(12)
});

const imageSummarySchema = z.object({
  dataUrl: z.string().min(64).max(18_000_000).regex(/^data:image\/(png|jpe?g|webp);base64,/),
  label: z.string().min(1).max(80).optional()
});

const audioObservationSchema = z.object({
  dataUrl: z
    .string()
    .min(64)
    .max(24_000_000)
    .regex(/^data:audio\/(webm|wav|wave|x-wav|mpeg|mp3|mp4|m4a|x-m4a|ogg|aac)(?:;[^,]+)?;base64,/),
  label: z.string().min(1).max(80).optional()
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

export function createApp(input: {
  store?: ProfileStore;
  provider?: ModelProvider;
  proactive?: { enabled?: boolean; intervalMs?: number };
  hermes?: { enabled?: boolean; bridge?: HermesBridge };
} = {}) {
  const store = input.store ?? new JsonProfileStore();
  const provider = input.provider ?? createModelProvider();
  const hermesBridge = input.hermes?.bridge ?? (input.hermes?.enabled ? createHermesBridge({ store, provider }) : undefined);
  const app = express();

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

  app.get("/api/assets/:filename", async (req, res, next) => {
    try {
      const filename = req.params.filename;
      if (!/^(img|vid)_[a-f0-9]{24}\.(png|jpg|webp|mp4)$/.test(filename)) throw new HttpError(404, "Asset not found");
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

  app.post("/api/audio-observation", async (req, res, next) => {
    try {
      const body = audioObservationSchema.parse(req.body);
      const prompt = `请直接理解这段音频，写成一段给 Papo 后续注意机制使用的中文生活观察。只描述能直接听见的事实、明确听清的说话内容、环境声类型或正在发生的事；不能猜测人声、文字、看不见的物体、身份或原因，不能把非语音声音当成说话；不确定就写“不确定的声音”。最多 400 字；如果没有可用生活信息，返回空文本。如果你无法读取或处理这段音频，只返回 ERROR_AUDIO_UNREADABLE。标签：${body.label ?? "录音"}`;
      const audioObservation = normalizeAudioObservation((await observeAudioForSensing(provider, body.dataUrl, prompt)).slice(0, 1200));
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
      res.json(publicCaptureResult(result, provider.kind));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/curious", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId, req);
      const body = curiousSchema.parse(req.body);
      markProactiveUserResponse(profile);
      const beforeSemanticIds = semanticRecordIds(profile);
      const result = await runCuriousHarness(profile, body.segments as StreamSegment[], provider);
      await hermesBridge?.enqueueTasks(profile, result);
      applyPetProfileActionResults(profile, result);
      const illustrationAttachments = await executeIllustrationActions(profile, result, provider, "action");
      const modelRuns = newSemanticRuns(profile, beforeSemanticIds);
      const sensingTraces = body.segments.flatMap((segment) => segment.sensingTrace ? [segment.sensingTrace as SensingTrace] : []);
      const cognitionTrace = captureCognitionTrace(result, provider, "curious_stream", modelRuns, sensingTraces);
      for (const segment of body.segments) {
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
          sensingTrace: segment.sensingTrace as SensingTrace | undefined,
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
      res.json(publicCaptureResult(result, provider.kind));
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
      queueEmergenceActionCardGeneration({ store, userId: profile.userId, emergence, provider });
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
      if (nextPassword) {
        profile.password = nextPassword;
      } else {
        delete profile.password;
      }
      await store.saveProfile(profile);
      res.json({ profile: publicProfile(profile) });
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
      const emergenceAttachments = await executeEmergenceIllustration(profile, emergence, provider, now);
      const modelRuns = newSemanticRuns(profile, beforeSemanticIds);
      const cognitionTrace = emergenceCognitionTrace(emergence, provider, modelRuns);
      settleProactiveEmergence(profile, emergence, now);
      if (emergence.text.trim()) {
        appendPapoMessage(profile, {
          channel: "emergence",
          text: emergence.text,
          sourceId: emergence.id,
          relatedMemoryIds: emergence.relatedMemoryIds,
          attachments: emergenceAttachments,
          cognitionTrace,
          at: now
        });
        queueEmergenceActionCardGeneration({ store, userId: profile.userId, emergence, provider });
        active += 1;
      } else {
        quiet += 1;
      }
      await store.saveProfile(profile);
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
      const keyframeGenerated = await input.provider.generateImage(keyframePrompt, {
        style: card.style,
        references
      });
      const cover = await saveGeneratedActionKeyframe({
        dataUrl: keyframeGenerated.dataUrl,
        label: `${card.title} 首帧`,
        prompt: keyframePrompt,
        sourceIds
      });
      const videoPrompt = buildInitialMotionVideoPrompt(profile, card, true);
      const generated = await input.provider.generateVideo(videoPrompt, {
        durationSeconds: card.durationSeconds,
        style: card.style,
        referenceImage: { dataUrl: keyframeGenerated.dataUrl, label: cover.label }
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
        cover,
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
  if (input.emergence.actionResult?.kind !== "action_card_draft" || !input.emergence.actionResult.prompt?.trim()) return;
  void (async () => {
    try {
      const profile = await input.store.getProfile(input.userId);
      if (!profile) return;
      const attachments = await executeEmergenceActionCard(profile, input.emergence, input.provider, new Date().toISOString());
      if (!attachments.length) return;
      applyEmergenceActionCardCompletion(profile, input.emergence, attachments);
      await input.store.saveProfile(profile);
    } catch (error) {
      console.error(`Emergence action card generation failed for ${input.userId}`, error);
    }
  })();
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
    const references = await actionCardReferences(profile, event.attachments);
    const referenceImage = references[0];
    if (!provider.generateVideo) throw new Error("Video generation provider is not configured");
    const sourceIds = [...new Set([event.id, event.triggerSegmentId, event.triggerBatchId, ...(event.relatedMemoryIds ?? []), ...(event.attachments ?? []).map((item) => item.id), ...(actionResult.sourceIds ?? [])].filter(Boolean) as string[])];
    const videoPrompt = actionCardVideoPrompt(profile, actionResult, event, Boolean(referenceImage));
    const generated = await provider.generateVideo(videoPrompt, {
      durationSeconds: actionResult.durationSeconds ?? 8,
      style: actionResult.style,
      referenceImage
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
      video,
      sourceIds,
      actionEventId: event.id,
      providerKind: provider.diagnostics?.videoProvider ?? provider.kind,
      providerName: provider.diagnostics?.videoProvider ? `${provider.diagnostics.videoProvider} video` : provider.name,
      model: generated.model ?? provider.diagnostics?.videoModel
    });
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
  const videoPrompt = actionCardVideoPromptForEmergence(profile, actionResult, emergence, Boolean(references[0]));
  const generated = await provider.generateVideo(videoPrompt, {
    durationSeconds: actionResult.durationSeconds ?? 8,
    style: actionResult.style,
    referenceImage: references[0]
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
  const sourceImages = (event.attachments ?? []).map((item) => `${item.label} ${item.url}`).join("\n");
  return [
    `Create a short looping animated video action card for ${profile.creatureName}, a ${identity.species}.`,
    "Visual goal: a living digital pet based on the current profile image/photo, lightly stylized for a polished companion app. It must look like the same animal/creature from the profile, not a plush toy or figurine.",
    "Scene and camera: warm clean app background, soft natural light, full body centered, locked camera, stable scale, no cuts, no zoom unless extremely subtle.",
    `The character must stay consistent with this companion profile: ${identity.appearance}`,
    `Personality and habits to express through motion: ${identity.personality} ${identity.habits}`,
    `Visual style: ${identity.visualStyle}`,
    `Motion style: ${identity.motionStyle}`,
    hasReferenceImage ? "Use the attached profile/reference image as strict visual grounding. Preserve coat colors, markings, face shape, body proportions, expression, and overall identity from the image." : "Keep the character design consistent with the pet kind and current profile.",
    "Action priority: preserve the action, object, mood, and scene requested by the action model and user moment. Do not replace a specific requested action with a generic idle, wave, ball, or nap action.",
    "Loop requirement: first frame and final frame should match as closely as possible in pose, position, camera framing, and background. The motion should return to the starting pose for a seamless loop.",
    "Forbidden look: stuffed animal, plush toy, fabric doll, vinyl toy, figurine, statue, clay model, product mockup, visible seams, toy joints, plastic shine, stitched fabric.",
    "No UI, no text labels, no subtitles, no watermark, no extra animals, no human, no props that hide the body. Keep the action readable and cute, with simple loopable motion.",
    `Current visible state: ${profile.dogState?.label ?? "陪着用户"} / ${namedCreatureText(profile.dogState?.actionText, profile.creatureName)}`,
    `Moment: ${event.noticed || event.triggerContent}`,
    sourceImages ? `Source image assets:\n${sourceImages}` : "",
    `Action model prompt:\n${actionResult.prompt}`
  ].filter(Boolean).join("\n\n");
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
    hasReferenceImage ? "Use the attached profile/reference image as strict visual grounding. Preserve coat colors, markings, face shape, body proportions, expression, and overall identity from the image." : "",
    "Action priority: preserve the action, object, mood, and scene requested by the emergence/action model. Do not replace a specific requested action with a generic idle, wave, ball, or nap action.",
    "Loop requirement: first frame and final frame should match as closely as possible in pose, position, camera framing, and background. The motion should return to the starting pose for a seamless loop.",
    "Forbidden look: stuffed animal, plush toy, fabric doll, vinyl toy, figurine, statue, clay model, product mockup, visible seams, toy joints, plastic shine, stitched fabric.",
    "No UI, no text labels, no subtitles, no watermark, no extra animals, no human, no props that hide the body.",
    `Why now: ${emergence.whyNow}`,
    `Visible message: ${emergence.message}`,
    `Action model prompt:\n${actionResult.prompt}`
  ].filter(Boolean).join("\n\n");
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
    hasReferenceImage ? "The attached image is the generated first-frame/keyframe for this exact action. Animate from it while preserving the same identity, pose family, coat colors, markings, face shape, body proportions, expression, and background." : "Use the written profile as strict grounding for character identity.",
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
    hasReferenceImage ? "Use the attached user/profile reference image as the primary identity source. Preserve coat colors, markings, face shape, body proportions, recognizable expression, and species." : "Use the written profile as the identity source.",
    "Composition: warm clean app background, soft natural light, full body centered, stable scale, clear silhouette. The pose should be the starting pose and also suitable as the ending pose for a loop.",
    "Action priority: the still keyframe must visibly set up the user's requested action. Do not fall back to a generic default pose if the action direction names a specific action.",
    `Character identity: ${identity.appearance}`,
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

async function actionCardReferences(profile: CreatureProfile, attachments?: MediaAttachment[]): Promise<ImageReference[]> {
  const uploaded = await illustrationReferences(attachments);
  if (uploaded.length) return uploaded;
  const profileReferences = await petProfileVisualReferences(profile);
  if (profileReferences.length) return profileReferences;
  const character = await generatedPetReference(profile);
  return character ? [character] : [];
}

async function petProfileReferences(referenceAttachment?: MediaAttachment): Promise<ImageReference[]> {
  if (!referenceAttachment) return [];
  const dataUrl = await imageAttachmentDataUrl(referenceAttachment);
  return dataUrl ? [{ dataUrl, label: referenceAttachment.label }] : [];
}

async function petProfileVisualReferences(profile: CreatureProfile): Promise<ImageReference[]> {
  const references: ImageReference[] = [];
  for (const image of [profile.petProfile?.referenceImage, profile.petProfile?.avatarImage]) {
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
  const trimmed = text.trim();
  if (!trimmed || /^["'“”‘’\s]+$/.test(trimmed)) return { text: "", unreadable: false };
  const quoted = trimmed.match(/^["“](.*)["”]$/s) ?? trimmed.match(/^['‘](.*)['’]$/s);
  const normalized = (quoted ? quoted[1] : trimmed).trim();
  if (normalized === "ERROR_AUDIO_UNREADABLE" || /无法(获取|读取|处理|访问).{0,12}音频/.test(normalized)) {
    return { text: "", unreadable: true };
  }
  if (isEmptyAudioObservation(normalized)) {
    return { text: "", unreadable: false };
  }
  return { text: normalized, unreadable: false };
}

function isEmptyAudioObservation(text: string) {
  const normalized = text.replace(/\s+/g, "");
  return [
    /没有可用生活信息/,
    /没有可识别的说话内容/,
    /没有可识别.*生活事件/,
    /无可用生活信息/,
    /无声音内容/,
    /只有持续的噪音/,
    /只有噪音/,
    /没有明显.*内容/,
    /未听到.*内容/,
    /听不清.*内容/
  ].some((pattern) => pattern.test(normalized));
}

function audioSensingTrace(
  provider: ModelProvider,
  label: string,
  observation: ReturnType<typeof normalizeAudioObservation>
): SensingTrace {
  const status: SensingTrace["status"] = observation.text ? "content" : observation.unreadable ? "unreadable" : "empty";
  const decision = observation.text
    ? "音频模型读到了可用的生活信息；规则把它作为 audio_observation 放入当前 30 秒批次，交给注意 LLM 决定是否继续处理。"
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
    ruleTrace: [
      "sensing: call audio-capable model",
      `status=${status}`,
      observation.text ? "route=curious_candidate" : "route=settle_audio_batch_only"
    ]
  };
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
      ? "视觉模型读到了可用的图片信息；规则把它作为 image_summary 放入当前事件或 30 秒批次，交给注意 LLM 决定是否继续处理。"
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

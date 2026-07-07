import cors from "cors";
import express from "express";
import { z } from "zod";
import { appendInputMessage, appendPapoMessage } from "../core/conversation";
import { semanticDecideEmergence } from "../core/emergence";
import { applyFeedback, semanticReflectFeedback } from "../core/feedback";
import { runButtonHarness, runCuriousHarness } from "../core/harness";
import { createModelProvider, type ModelProvider } from "../core/provider";
import { wakeCreature } from "../core/rhythm";
import type { CaptureResult, CreatureProfile, EmergenceRecord, FeedbackRecord, MessageCognitionTrace, SemanticBrainRecord, StreamSegment } from "../core/types";
import { JsonProfileStore, type ProfileStore } from "./store";

const createProfileSchema = z.object({
  userId: z.string().min(1).optional(),
  creatureName: z.string().min(1).max(40).optional()
});

const buttonSchema = z.object({
  text: z.string().min(1).max(4000)
});

const curiousSchema = z.object({
  segments: z
    .array(
      z.object({
        id: z.string().min(1),
        kind: z.enum(["text", "image_summary", "audio_observation"]),
        label: z.string().min(1).max(80),
        content: z.string().max(4000),
        observedAt: z.string().datetime().optional(),
        batchId: z.string().min(1).max(80).optional(),
        location: z
          .object({
            latitude: z.number().min(-90).max(90),
            longitude: z.number().min(-180).max(180),
            accuracy: z.number().nonnegative().optional(),
            label: z.string().min(1).max(120).optional()
          })
          .optional()
      })
    )
    .min(1)
    .max(12)
});

const imageSummarySchema = z.object({
  dataUrl: z.string().min(64).max(6_000_000).regex(/^data:image\/(png|jpe?g|webp);base64,/),
  label: z.string().min(1).max(80).optional()
});

const audioObservationSchema = z.object({
  dataUrl: z
    .string()
    .min(64)
    .max(10_000_000)
    .regex(/^data:audio\/(webm|wav|mpeg|mp3|mp4|m4a|x-m4a|ogg)(?:;[^,]+)?;base64,/),
  label: z.string().min(1).max(80).optional()
});

const feedbackSchema = z.object({
  kind: z.enum(["understood", "continue", "not_now", "remember", "forget"]),
  targetId: z.string().optional(),
  content: z.string().max(1200).optional(),
  modality: z.enum(["text", "audio_observation", "button"]).optional()
});

const updateMemorySchema = z.object({
  text: z.string().min(1).max(1000)
});

export function createApp(input: { store?: ProfileStore; provider?: ModelProvider } = {}) {
  const store = input.store ?? new JsonProfileStore();
  const provider = input.provider ?? createModelProvider();
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "12mb" }));

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

  app.post("/api/image-summary", async (req, res, next) => {
    try {
      const body = imageSummarySchema.parse(req.body);
      const prompt = `请用中文把这张图片压缩成一段 80 字以内的生活场景摘要，给 Curious Mode 当 image_summary。标签：${body.label ?? "截图"}`;
      const summary = (await provider.summarizeImage(body.dataUrl, prompt)).slice(0, 600);
      res.json({
        summary,
        provider: sensingProvider(provider, "vision"),
        model: provider.diagnostics?.visionModel,
        route: "chat_completions",
        semanticSource: "llm"
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/audio-observation", async (req, res, next) => {
    try {
      const body = audioObservationSchema.parse(req.body);
      const prompt = `请直接理解这段音频，写成一段给 Papo 后续注意机制使用的中文生活观察。只描述能直接听见的事实、明确听清的说话内容、环境声类型或正在发生的事；不能猜测人声、文字、看不见的物体、身份或原因，不能把非语音声音当成说话；不确定就写“不确定的声音”。最多 400 字；如果没有可用生活信息，返回空文本。如果你无法读取或处理这段音频，只返回 ERROR_AUDIO_UNREADABLE。标签：${body.label ?? "录音"}`;
      const observation = normalizeAudioObservation((await provider.observeAudio(body.dataUrl, prompt)).slice(0, 1200));
      res.json({
        observation,
        noSpeech: !observation,
        provider: sensingProvider(provider, "audio"),
        model: provider.diagnostics?.audioModel,
        route: provider.diagnostics?.audioRoute,
        semanticSource: "llm"
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
      const profile = await store.createProfile(body);
      res.status(201).json({ profile });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/profiles/:userId", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId);
      res.json({ profile });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/wake", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId);
      const wake = wakeCreature(profile);
      await store.saveProfile(profile);
      res.json({ profile, wake });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/button", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId);
      const body = buttonSchema.parse(req.body);
      appendInputMessage(profile, { channel: "button", role: "user", text: body.text, sourceId: `button-${Date.now()}`, modality: "button" });
      const beforeSemanticIds = semanticRecordIds(profile);
      const result = await runButtonHarness(profile, body.text, provider);
      const modelRuns = newSemanticRuns(profile, beforeSemanticIds);
      appendPapoMessage(profile, {
        channel: "button",
        text: result.response,
        sourceId: result.episodes[0]?.id ?? result.events[0]?.id,
        relatedMemoryIds: result.events.flatMap((event) => event.relatedMemoryIds),
        cognitionTrace: captureCognitionTrace(result, provider, "button", modelRuns)
      });
      await store.saveProfile(profile);
      res.json({ ...result, provider: provider.kind });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/curious", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId);
      const body = curiousSchema.parse(req.body);
      for (const segment of body.segments) {
        appendInputMessage(profile, {
          channel: "curious",
          role: segment.kind === "text" ? "user" : "world",
          text: `${segment.label}：${segment.content}`,
          sourceId: segment.id,
          modality: segment.kind,
          batchId: segment.batchId,
          observedAt: segment.observedAt,
          location: segment.location
        });
      }
      const beforeSemanticIds = semanticRecordIds(profile);
      const result = await runCuriousHarness(profile, body.segments as StreamSegment[], provider);
      const modelRuns = newSemanticRuns(profile, beforeSemanticIds);
      appendPapoMessage(profile, {
        channel: "curious",
        text: result.response,
        sourceId: result.episodes[0]?.id ?? result.curiousSession?.id ?? result.events[0]?.id,
        relatedMemoryIds: result.events.flatMap((event) => event.relatedMemoryIds),
        cognitionTrace: captureCognitionTrace(result, provider, "curious_stream", modelRuns)
      });
      await store.saveProfile(profile);
      res.json({ ...result, provider: provider.kind });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/feedback", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId);
      const body = feedbackSchema.parse(req.body);
      const targetBefore = feedbackTargetSnapshot(profile, body.targetId);
      const feedback = applyFeedback(profile, body);
      const beforeSemanticIds = semanticRecordIds(profile);
      await semanticReflectFeedback(profile, feedback, provider);
      const modelRuns = newSemanticRuns(profile, beforeSemanticIds);
      const relatedMemoryIds = feedbackRelatedMemoryIds(profile, body.targetId, targetBefore?.type === "memory" ? targetBefore.id : undefined);
      appendInputMessage(profile, {
        channel: "feedback",
        role: "user",
        text: feedbackInputText(feedback.kind, body.content),
        sourceId: `${feedback.id}:input`,
        modality: body.modality ?? (body.content?.trim() ? "text" : "button"),
        observedAt: feedback.at,
        at: feedback.at,
        relatedMemoryIds
      });
      appendPapoMessage(profile, {
        channel: "feedback",
        text: feedback.replyText,
        sourceId: feedback.id,
        relatedMemoryIds,
        cognitionTrace: feedbackCognitionTrace(feedback, provider, modelRuns, profile, targetBefore)
      });
      await store.saveProfile(profile);
      res.json({ profile, feedback });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/profiles/:userId/memories/:memoryId", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId);
      const body = updateMemorySchema.parse(req.body);
      const previousMemory = profile.longTermMemories.find((item) => item.id === req.params.memoryId);
      if (!previousMemory) throw new HttpError(404, "Memory not found");
      const targetBefore = feedbackTargetSnapshot(profile, req.params.memoryId);
      const at = new Date().toISOString();
      const feedback = applyFeedback(profile, {
        kind: "continue",
        targetId: req.params.memoryId,
        content: `帮我记准：${body.text}`,
        modality: "text",
        now: at
      });
      const beforeSemanticIds = semanticRecordIds(profile);
      await semanticReflectFeedback(profile, feedback, provider);
      const modelRuns = newSemanticRuns(profile, beforeSemanticIds);
      const memory = profile.longTermMemories.find((item) => item.id === req.params.memoryId);
      if (!memory) throw new HttpError(404, "Memory not found after feedback reflection");
      appendInputMessage(profile, {
        channel: "feedback",
        role: "user",
        text: feedback.inputText ?? `帮我记准：${body.text}`,
        sourceId: `${memory.id}:edit:input`,
        modality: "text",
        observedAt: at,
        at,
        relatedMemoryIds: [memory.id]
      });
      appendPapoMessage(profile, {
        channel: "feedback",
        text: feedback.replyText,
        sourceId: `${memory.id}:edit`,
        relatedMemoryIds: [memory.id],
        cognitionTrace: feedbackCognitionTrace(feedback, provider, modelRuns, profile, targetBefore),
        at
      });
      await store.saveProfile(profile);
      res.json({ profile, memory });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/emergence", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId);
      const beforeSemanticIds = semanticRecordIds(profile);
      const emergence = await semanticDecideEmergence(profile, provider);
      const modelRuns = newSemanticRuns(profile, beforeSemanticIds);
      appendPapoMessage(profile, {
        channel: "emergence",
        text: emergence.text,
        sourceId: emergence.id,
        relatedMemoryIds: emergence.relatedMemoryIds,
        cognitionTrace: emergenceCognitionTrace(emergence, provider, modelRuns)
      });
      await store.saveProfile(profile);
      res.json({ profile, emergence });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request", details: error.flatten() });
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error(error);
    res.status(500).json({ error: sensingError(error) });
  });

  return app;
}

async function requireProfile(store: ProfileStore, userId: string) {
  const profile = await store.getProfile(userId);
  if (!profile) throw new HttpError(404, "Profile not found");
  return profile;
}

function feedbackInputText(kind: string, content?: string) {
  const label = {
    understood: "这次懂了",
    continue: "再想一会儿",
    not_now: "先安静点",
    remember: "帮我记住",
    forget: "帮我放下"
  }[kind] ?? kind;
  const note = content?.trim();
  return note ? `${label}：${note}` : label;
}

function semanticRecordIds(profile: CreatureProfile) {
  return new Set((profile.semanticBrainHistory ?? []).map((record) => record.id));
}

function newSemanticRuns(profile: CreatureProfile, beforeIds: Set<string>) {
  return (profile.semanticBrainHistory ?? []).filter((record) => !beforeIds.has(record.id)).reverse();
}

function captureCognitionTrace(
  result: CaptureResult,
  provider: ModelProvider,
  source: "button" | "curious_stream",
  modelRuns: SemanticBrainRecord[]
): MessageCognitionTrace {
  return {
    at: new Date().toISOString(),
    source,
    providerKind: provider.kind,
    providerName: provider.name,
    model: provider.diagnostics?.textModel,
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
  type: "memory" | "episode";
  text?: string;
  kind?: CreatureProfile["longTermMemories"][number]["kind"];
  weight?: number;
}

function feedbackTargetSnapshot(profile: CreatureProfile, targetId?: string): FeedbackTargetSnapshot | undefined {
  if (!targetId) return undefined;
  const memory = profile.longTermMemories.find((item) => item.id === targetId);
  if (memory) {
    return { id: memory.id, type: "memory", text: memory.text, kind: memory.kind, weight: memory.weight };
  }
  const episode = profile.episodes.find((item) => item.id === targetId);
  if (episode) {
    return { id: episode.id, type: "episode", text: episode.inputSummary, weight: episode.weight };
  }
  return undefined;
}

function feedbackMemoryChanges(profile: CreatureProfile, before?: FeedbackTargetSnapshot): NonNullable<MessageCognitionTrace["feedbackDecision"]>["memoryChanges"] {
  if (!before) return [];
  const afterMemory = before.type === "memory" ? profile.longTermMemories.find((item) => item.id === before.id) : undefined;
  const afterEpisode = before.type === "episode" ? profile.episodes.find((item) => item.id === before.id) : undefined;
  const after = afterMemory
    ? { id: afterMemory.id, type: "memory" as const, text: afterMemory.text, kind: afterMemory.kind, weight: afterMemory.weight }
    : afterEpisode
      ? { id: afterEpisode.id, type: "episode" as const, text: afterEpisode.inputSummary, weight: afterEpisode.weight }
      : undefined;

  if (!after) {
    return [{
      targetId: before.id,
      targetType: before.type,
      operation: "purged",
      beforeText: before.text,
      beforeKind: before.kind,
      beforeWeight: before.weight
    }];
  }

  const changed = before.text !== after.text || before.kind !== after.kind || before.weight !== after.weight;
  return [{
    targetId: before.id,
    targetType: before.type,
    operation: changed ? "updated" : "unchanged",
    beforeText: before.text,
    afterText: after.text,
    beforeKind: before.kind,
    afterKind: after.kind,
    beforeWeight: before.weight,
    afterWeight: after.weight
  }];
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
    for (const memory of profile.longTermMemories) {
      if (memory.sourceEpisodeId === targetId) ids.add(memory.id);
    }
  }
  return [...ids];
}

function normalizeAudioObservation(text: string) {
  const trimmed = text.trim();
  if (!trimmed || /^["'“”‘’\s]+$/.test(trimmed)) return "";
  const quoted = trimmed.match(/^["“](.*)["”]$/s) ?? trimmed.match(/^['‘](.*)['’]$/s);
  const normalized = (quoted ? quoted[1] : trimmed).trim();
  if (normalized === "ERROR_AUDIO_UNREADABLE" || /无法(获取|读取|处理|访问).{0,12}音频/.test(normalized)) {
    throw new Error("Audio model did not process the audio input.");
  }
  return normalized;
}

function sensingProvider(provider: ModelProvider, modality: "vision" | "audio") {
  return modality === "vision"
    ? provider.diagnostics?.visionProvider ?? provider.kind
    : provider.diagnostics?.audioProvider ?? provider.kind;
}

function sensingError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

import cors from "cors";
import express from "express";
import { z } from "zod";
import { appendInputMessage, appendPapoMessage } from "../core/conversation";
import { createActiveEmergence } from "../core/emergence";
import { applyFeedback } from "../core/feedback";
import { runButtonHarness, runCuriousHarness } from "../core/harness";
import { enrichEmergenceNarration, enrichFeedbackNarration } from "../core/narration";
import { createModelProvider, type ModelProvider } from "../core/provider";
import { promoteEpisode, updateLongTermMemory } from "../core/memory";
import { wakeCreature } from "../core/rhythm";
import { summarizeText } from "../core/text";
import type { CreatureProfile, StreamSegment } from "../core/types";
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
        kind: z.enum(["text", "image_summary", "audio_transcript"]),
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

const audioTranscriptSchema = z.object({
  dataUrl: z
    .string()
    .min(64)
    .max(10_000_000)
    .regex(/^data:audio\/(webm|wav|mpeg|mp3|mp4|m4a|x-m4a|ogg);base64,/),
  label: z.string().min(1).max(80).optional()
});

const feedbackSchema = z.object({
  kind: z.enum(["understood", "continue", "not_now", "remember", "forget"]),
  targetId: z.string().optional(),
  content: z.string().max(1200).optional(),
  modality: z.enum(["text", "audio_transcript", "button"]).optional()
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
      try {
        const summary = (await provider.summarizeImage(body.dataUrl, prompt)).slice(0, 600);
        res.json({ summary, provider: provider.kind, semanticSource: provider.usesRealModel ? "llm" : "fallback" });
      } catch (error) {
        res.json({
          summary: `图片已上传，但视觉模型暂时没有返回摘要。请手动补充这张截图里值得注意的生活信息。${error instanceof Error ? ` (${error.message})` : ""}`,
          provider: provider.kind,
          semanticSource: "fallback"
        });
      }
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/audio-transcript", async (req, res, next) => {
    try {
      const body = audioTranscriptSchema.parse(req.body);
      const prompt = `请把这段音频转写成中文。只保留用户生活片段里值得 Papo 注意的内容，最多 400 字，给 Curious Mode 当 audio_transcript。标签：${body.label ?? "录音"}`;
      try {
        const transcript =
          (await provider.transcribeAudio(body.dataUrl, prompt)).slice(0, 1200).trim() ||
          "这段录音里没有听到清楚的人声。你可以补一句这段声音里发生了什么。";
        res.json({ transcript, provider: provider.kind, semanticSource: provider.usesRealModel ? "llm" : "fallback" });
      } catch (error) {
        res.json({
          transcript: `音频已上传，但音频模型暂时没有返回转写。请手动补充这段录音里值得注意的生活信息。${error instanceof Error ? ` (${error.message})` : ""}`,
          provider: provider.kind,
          semanticSource: "fallback"
        });
      }
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
      const wakeEmergence = wake.emergenceId ? profile.emergenceHistory.find((item) => item.id === wake.emergenceId) : undefined;
      if (wakeEmergence) {
        const enriched = await enrichEmergenceNarration(profile, { ...wakeEmergence, text: wakeEmergence.message }, provider);
        wake.innerThought = enriched.text;
      }
      appendPapoMessage(profile, { channel: "wake", text: wake.message, sourceId: wake.id, relatedMemoryIds: wake.relatedMemoryIds, at: wake.at });
      appendPapoMessage(profile, { channel: "wake", text: wake.innerThought, sourceId: wake.emergenceId, relatedMemoryIds: wake.relatedMemoryIds, at: wake.at });
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
      const result = await runButtonHarness(profile, body.text, provider);
      appendPapoMessage(profile, {
        channel: "button",
        text: result.response,
        sourceId: result.episodes[0]?.id,
        relatedMemoryIds: result.events.flatMap((event) => event.relatedMemoryIds)
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
      const result = await runCuriousHarness(profile, body.segments as StreamSegment[], provider);
      appendPapoMessage(profile, {
        channel: "curious",
        text: result.response,
        sourceId: result.curiousSession?.id ?? result.episodes[0]?.id,
        relatedMemoryIds: result.events.flatMap((event) => event.relatedMemoryIds)
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
      const targetMemoryBefore = body.targetId ? profile.longTermMemories.find((memory) => memory.id === body.targetId) : undefined;
      const feedback = applyFeedback(profile, body);
      await enrichFeedbackNarration(profile, feedback, provider);
      const relatedMemoryIds = feedbackRelatedMemoryIds(profile, body.targetId, targetMemoryBefore?.id);
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
      appendPapoMessage(profile, { channel: "feedback", text: feedback.replyText ?? feedback.learningNote, sourceId: feedback.id, relatedMemoryIds });
      await store.saveProfile(profile);
      res.json({ profile, feedback });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/profiles/:userId/episodes/:episodeId/promote", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId);
      const memory = promoteEpisode(profile, req.params.episodeId);
      await store.saveProfile(profile);
      res.json({ profile, memory });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/profiles/:userId/memories/:memoryId", async (req, res, next) => {
    try {
      const profile = await requireProfile(store, req.params.userId);
      const body = updateMemorySchema.parse(req.body);
      const memory = updateLongTermMemory(profile, req.params.memoryId, body.text);
      if (!memory) throw new HttpError(404, "Memory not found");
      const at = new Date().toISOString();
      appendInputMessage(profile, {
        channel: "feedback",
        role: "user",
        text: `帮我记准：${summarizeText(body.text, 140)}`,
        sourceId: `${memory.id}:edit:input`,
        modality: "text",
        observedAt: at,
        at,
        relatedMemoryIds: [memory.id]
      });
      appendPapoMessage(profile, {
        channel: "feedback",
        text: `我把这条记忆改准了：${summarizeText(memory.text, 120)}。之后它再从我里面回来时，我会按你刚教的版本想起。`,
        sourceId: `${memory.id}:edit`,
        relatedMemoryIds: [memory.id],
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
      const emergence = createActiveEmergence(profile);
      await enrichEmergenceNarration(profile, emergence, provider);
      appendPapoMessage(profile, {
        channel: "emergence",
        text: emergence.text,
        sourceId: emergence.id,
        relatedMemoryIds: emergence.relatedMemoryIds
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
    res.status(500).json({ error: "Internal server error" });
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

import cors from "cors";
import express from "express";
import { z } from "zod";
import { createActiveEmergence } from "../core/emergence";
import { applyFeedback } from "../core/feedback";
import { runButtonHarness, runCuriousHarness } from "../core/harness";
import { createModelProvider, type ModelProvider } from "../core/provider";
import { promoteEpisode, updateLongTermMemory } from "../core/memory";
import { wakeCreature } from "../core/rhythm";
import type { StreamSegment } from "../core/types";
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
        content: z.string().max(4000)
      })
    )
    .min(1)
    .max(12)
});

const feedbackSchema = z.object({
  kind: z.enum(["understood", "continue", "not_now", "remember", "forget"]),
  targetId: z.string().optional()
});

const updateMemorySchema = z.object({
  text: z.string().min(1).max(1000)
});

export function createApp(input: { store?: ProfileStore; provider?: ModelProvider } = {}) {
  const store = input.store ?? new JsonProfileStore();
  const provider = input.provider ?? createModelProvider();
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, provider: provider.kind });
  });

  app.get("/api/provider", (_req, res) => {
    res.json({ kind: provider.kind, name: provider.name, available: provider.available, usesRealModel: provider.usesRealModel });
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
      const result = await runButtonHarness(profile, body.text, provider);
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
      const result = await runCuriousHarness(profile, body.segments as StreamSegment[], provider);
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
      const feedback = applyFeedback(profile, body);
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

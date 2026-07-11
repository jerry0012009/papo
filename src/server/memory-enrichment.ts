import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { updateClientDocument } from "../core/client-document";
import type { ModelProvider } from "../core/provider";
import type { CreatureProfile, LongTermMemory, MediaAttachment } from "../core/types";
import { applyMemoryVisualPlan, memoryVisualReferences, planMemoryVisual } from "./memory-visual";
import type { ProfileStore } from "./store";

export async function enrichMemoryExperience(profile: CreatureProfile, memory: LongTermMemory, provider: ModelProvider) {
  const plan = await planMemoryVisual(profile, memory, provider);
  applyMemoryVisualPlan(memory, plan);
  memory.visualStatus = "pending";
  memory.visualError = undefined;
  try {
    const references = await memoryVisualReferences(profile, memory, plan, imageAttachmentDataUrl);
    const generated = await provider.generateImage(plan.imagePrompt, {
      size: "1024x1024",
      style: profile.petProfile.visualStyle,
      references
    });
    memory.visual = await saveMemoryVisual(generated.dataUrl, memory.shortTitle ?? "共同回忆", plan.imagePrompt, [memory.id, ...plan.relatedMemoryIds]);
    memory.visualStatus = "ready";
    memory.visualUpdatedAt = new Date().toISOString();
  } catch (error) {
    memory.visualStatus = "failed";
    memory.visualError = error instanceof Error ? error.message.slice(0, 300) : "Unknown memory image generation error";
    memory.visualUpdatedAt = new Date().toISOString();
  }
  return memory;
}

export function queueMemoryEnrichment(input: { store: ProfileStore; userId: string; memoryIds: string[]; provider: ModelProvider }) {
  const memoryIds = [...new Set(input.memoryIds)].filter(Boolean);
  if (!memoryIds.length) return;
  void (async () => {
    try {
      for (const id of memoryIds) {
        const snapshot = await input.store.getProfile(input.userId);
        const memory = snapshot?.longTermMemories.find((item) => item.id === id && item.weight > 0);
        if (!snapshot || !memory) continue;
        await enrichMemoryExperience(snapshot, memory, input.provider);
        const latest = await input.store.getProfile(input.userId);
        const target = latest?.longTermMemories.find((item) => item.id === id && item.weight > 0);
        if (!latest || !target) continue;
        applyPresentation(target, memory);
        await input.store.saveProfile(latest);
      }
      const profile = await input.store.getProfile(input.userId);
      if (!profile) return;
      try {
        await updateClientDocument(profile, input.provider, memoryIds);
      } catch (error) {
        console.error(`Client.md update failed for ${input.userId}`, error);
      }
      await input.store.saveProfile(profile);
    } catch (error) {
      console.error(`Memory enrichment failed for ${input.userId}`, error);
    }
  })();
}

function applyPresentation(target: LongTermMemory, generated: LongTermMemory) {
  target.shortTitle = generated.shortTitle;
  target.narrative = generated.narrative;
  target.visual = generated.visual;
  target.visualPrompt = generated.visualPrompt;
  target.visualStatus = generated.visualStatus;
  target.visualError = generated.visualError;
  target.visualUpdatedAt = generated.visualUpdatedAt;
}

export function markMemoriesPending(profile: CreatureProfile, memoryIds: string[]) {
  const ids = new Set(memoryIds);
  for (const memory of profile.longTermMemories) {
    if (!ids.has(memory.id) || memory.weight <= 0) continue;
    memory.visualStatus = "pending";
    memory.visualError = undefined;
  }
}

async function saveMemoryVisual(dataUrl: string, label: string, prompt: string, sourceIds: string[]): Promise<MediaAttachment> {
  const parsed = parseImageDataUrl(dataUrl);
  const hash = createHash("sha256").update(parsed.buffer).digest("hex");
  const id = `img_${hash.slice(0, 24)}`;
  const filename = `${id}.${parsed.extension}`;
  await mkdir(imageAssetDir(), { recursive: true });
  await writeFile(path.join(imageAssetDir(), filename), parsed.buffer);
  return {
    id,
    kind: "image",
    label,
    mime: parsed.mime,
    url: `/api/assets/${filename}`,
    createdAt: new Date().toISOString(),
    sizeBytes: parsed.buffer.byteLength,
    generatedBy: "papo_memory",
    prompt,
    sourceIds
  };
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

function imageAssetDir() {
  return path.join(process.cwd(), "data", "assets", "images");
}

function parseImageDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/);
  if (!match) throw new Error("Invalid generated memory image data URL");
  const mime = (match[1] === "image/jpg" ? "image/jpeg" : match[1]) as "image/png" | "image/jpeg" | "image/webp";
  const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.byteLength) throw new Error("Empty generated memory image");
  return { mime, extension, buffer };
}

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ModelProvider } from "../core/provider";
import type { CreatureProfile, LongTermMemory, MediaAttachment } from "../core/types";
import { applyMemoryVisualPlan, memoryVisualReferences, planMemoryVisual } from "./memory-visual";

export class MemoryEnrichmentFailure extends Error {
  constructor(message: string, readonly memory: LongTermMemory) {
    super(message);
  }
}

export async function enrichMemoryExperience(
  profile: CreatureProfile,
  memory: LongTermMemory,
  provider: ModelProvider,
  options: { throwOnVisualError?: boolean } = {}
) {
  const previousVisual = memory.visual;
  const plan = await planMemoryVisual(profile, memory, provider);
  applyMemoryVisualPlan(memory, plan);
  if (plan.visualMode === "no_visual") {
    memory.visual = undefined;
    memory.visualStatus = "not_needed";
    memory.visualError = undefined;
    memory.visualUpdatedAt = new Date().toISOString();
    return memory;
  }
  memory.visualStatus = "pending";
  memory.visualError = undefined;
  try {
    const imagePrompt = plan.imagePrompt;
    if (!imagePrompt) throw new Error("Memory visual plan omitted imagePrompt");
    const references = await memoryVisualReferences(profile, memory, plan, imageAttachmentDataUrl);
    const generated = await provider.generateImage(imagePrompt, {
      size: "1024x1024",
      style: profile.petProfile.visualStyle,
      references
    });
    memory.visual = await saveMemoryVisual(generated.dataUrl, memory.shortTitle ?? "共同回忆", imagePrompt, [memory.id, ...plan.relatedMemoryIds]);
    memory.visualStatus = "ready";
    memory.visualUpdatedAt = new Date().toISOString();
  } catch (error) {
    memory.visual = previousVisual;
    memory.visualStatus = "failed";
    memory.visualError = error instanceof Error ? error.message.slice(0, 300) : "Unknown memory image generation error";
    memory.visualUpdatedAt = new Date().toISOString();
    if (options.throwOnVisualError) throw new MemoryEnrichmentFailure(memory.visualError, memory);
  }
  return memory;
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

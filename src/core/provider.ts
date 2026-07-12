import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ProviderKind } from "./types";

const execFileAsync = promisify(execFile);

export interface ModelProvider {
  kind: ProviderKind;
  name: string;
  available: boolean;
  usesRealModel: boolean;
  diagnostics?: ProviderDiagnostics;
  generate(prompt: string): Promise<string>;
  generateJson<T>(prompt: string): Promise<T | undefined>;
  generateJsonFallback?<T>(prompt: string): Promise<T | undefined>;
  summarizeImage(dataUrl: string, prompt: string): Promise<string>;
  observeAudio(dataUrl: string, prompt: string): Promise<string>;
  generateImage(prompt: string, input?: { size?: string; style?: string; references?: ImageReference[] }): Promise<{ dataUrl: string; mime: "image/png" | "image/jpeg" | "image/webp"; model?: string }>;
  generateVideo?(prompt: string, input?: { durationSeconds?: number; style?: string; referenceImage?: ImageReference }): Promise<{ dataUrl: string; mime: "video/mp4"; model?: string; remoteUrl?: string }>;
}

export class ModelProviderRefusalError extends Error {
  readonly retryable = false;

  constructor(readonly reason: "safety" | "policy", message = "Model provider declined this request") {
    super(message);
    this.name = "ModelProviderRefusalError";
  }
}

export function isModelProviderRefusal(error: unknown): error is ModelProviderRefusalError {
  return error instanceof ModelProviderRefusalError;
}

export interface ImageReference {
  dataUrl: string;
  label?: string;
}

export interface ProviderDiagnostics {
  textProvider?: ProviderKind;
  textFallbackProvider?: ProviderKind;
  visionProvider?: ProviderKind;
  audioProvider?: ProviderKind;
  textModel?: string;
  textFallbackModel?: string;
  visionModel?: string;
  audioModel?: string;
  imageModel?: string;
  videoModel?: string;
  imageProvider?: ProviderKind;
  videoProvider?: ProviderKind;
  imageRoute?: "openrouter_images" | "images_generations" | "chat_completions";
  videoRoute?: "openrouter_videos" | "dashscope_video_synthesis";
  audioRoute?: "chat_completions" | "audio_transcriptions";
}

export function createModelProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const config = loadLocalProviderConfig(env.PAPO_CONFIG_PATH);
  const dotenv = shouldLoadLocalEnv(env) ? loadLocalProviderEnv(env.PAPO_ENV_PATH) : {};
  const merged = { ...config, ...dotenv, ...env };
  const preferred = merged.PAPO_PROVIDER;

  let primary: ModelProvider | undefined;
  if (preferred === "openrouter" && merged.OPENROUTER_API_KEY) primary = openRouterProvider(merged);
  if (!primary && preferred === "mimo" && (merged.MIMO_ENDPOINT || merged.MIMO_API_KEY)) primary = mimoProvider(merged);
  if (!primary && preferred === "generic" && (merged.OPENAI_API_KEY || merged.GENERIC_MODEL_API_KEY)) primary = genericProvider(merged);

  if (!primary && merged.OPENROUTER_API_KEY) primary = openRouterProvider(merged);
  if (!primary && (merged.MIMO_ENDPOINT || merged.MIMO_API_KEY)) primary = mimoProvider(merged);
  if (!primary && (merged.OPENAI_API_KEY || merged.GENERIC_MODEL_API_KEY)) primary = genericProvider(merged);
  if (!primary) throw new Error("Papo requires a real model provider; configure OpenRouter, Mimo, or a generic OpenAI-compatible provider.");
  const fallback = textFallbackProvider(primary, merged);
  const textProvider = fallback ? {
    ...primary,
    diagnostics: {
      ...primary.diagnostics,
      textFallbackProvider: fallback.kind,
      textFallbackModel: fallback.diagnostics?.textModel
    },
    generateJsonFallback: fallback.generateJson.bind(fallback)
  } : primary;
  return withModalityOverrides(textProvider, merged);
}

function textFallbackProvider(primary: ModelProvider, merged: NodeJS.ProcessEnv) {
  const requested = merged.PAPO_TEXT_FALLBACK_PROVIDER;
  if (requested === "primary" || requested === "none") return undefined;
  if (requested) {
    const fallback = providerForKind(requested, merged);
    return fallback.kind === primary.kind ? undefined : fallback;
  }
  if (primary.kind !== "openrouter" && merged.OPENROUTER_API_KEY) return openRouterProvider(merged);
  if (primary.kind !== "mimo" && (merged.MIMO_ENDPOINT || merged.MIMO_API_KEY)) return mimoProvider(merged);
  if (primary.kind !== "generic" && (merged.OPENAI_API_KEY || merged.GENERIC_MODEL_API_KEY)) return genericProvider(merged);
  return undefined;
}

function openRouterProvider(merged: NodeJS.ProcessEnv): ModelProvider {
  const textModel = merged.OPENROUTER_MODEL ?? "openai/gpt-5.5";
  const visionModel = merged.OPENROUTER_VISION_MODEL ?? "nex-agi/nex-n2-mini";
  const audioModel = merged.OPENROUTER_AUDIO_MODEL ?? "xiaomi/mimo-v2.5";
  const imageModel = merged.OPENROUTER_IMAGE_MODEL ?? "google/gemini-3.1-flash-lite-image";
  const videoModel = merged.OPENROUTER_VIDEO_MODEL ?? "alibaba/happyhorse-1.1";
  const baseUrl = "https://openrouter.ai/api/v1";
  return openAiCompatibleProvider({
    kind: "openrouter",
    name: "OpenRouter",
    endpoint: `${baseUrl}/chat/completions`,
    imageEndpoint: `${baseUrl}/images`,
    videoEndpoint: `${baseUrl}/videos`,
    apiKey: merged.OPENROUTER_API_KEY,
    model: textModel,
    visionModel,
    audioModel,
    imageModel,
    videoModel,
    imageRoute: "openrouter_images",
    videoRoute: "openrouter_videos",
    videoDefaultDurationSeconds: videoDurationFromEnv(merged.PAPO_VIDEO_DEFAULT_SECONDS, 4),
    videoMaxDurationSeconds: videoDurationFromEnv(merged.PAPO_VIDEO_MAX_SECONDS, 5),
    audioRoute: "chat_completions",
    chatTimeoutMs: timeoutFromEnv(merged, "PAPO_MODEL_TIMEOUT_MS", 45_000),
    visionTimeoutMs: timeoutFromEnv(merged, "PAPO_VISION_TIMEOUT_MS", 45_000),
    audioTimeoutMs: timeoutFromEnv(merged, "PAPO_AUDIO_TIMEOUT_MS", 90_000),
    videoTimeoutMs: longTimeoutFromEnv(merged, "PAPO_VIDEO_TIMEOUT_MS", 480_000)
  });
}

function mimoProvider(merged: NodeJS.ProcessEnv): ModelProvider {
  const baseUrl = (merged.MIMO_ENDPOINT ?? "http://localhost:11434/v1/chat/completions").replace(/\/chat\/completions$/, "");
  return openAiCompatibleProvider({
    kind: "mimo",
    name: "Local Mimo",
    endpoint: merged.MIMO_ENDPOINT ?? "http://localhost:11434/v1/chat/completions",
    imageEndpoint: merged.MIMO_IMAGE_ENDPOINT ?? `${baseUrl}/images/generations`,
    videoEndpoint: merged.MIMO_VIDEO_ENDPOINT,
    apiKey: merged.MIMO_API_KEY,
    model: merged.MIMO_MODEL ?? "mimo",
    visionModel: merged.MIMO_VISION_MODEL ?? merged.MIMO_MODEL ?? "mimo",
    audioModel: merged.MIMO_AUDIO_MODEL ?? merged.MIMO_MODEL ?? "mimo",
    imageModel: merged.MIMO_IMAGE_MODEL ?? merged.MIMO_MODEL ?? "mimo",
    videoModel: merged.MIMO_VIDEO_MODEL,
    videoDefaultDurationSeconds: videoDurationFromEnv(merged.PAPO_VIDEO_DEFAULT_SECONDS, 4),
    videoMaxDurationSeconds: videoDurationFromEnv(merged.PAPO_VIDEO_MAX_SECONDS, 5),
    chatTimeoutMs: timeoutFromEnv(merged, "PAPO_MODEL_TIMEOUT_MS", 45_000),
    visionTimeoutMs: timeoutFromEnv(merged, "PAPO_VISION_TIMEOUT_MS", 45_000),
    audioTimeoutMs: timeoutFromEnv(merged, "PAPO_AUDIO_TIMEOUT_MS", 90_000),
    videoTimeoutMs: longTimeoutFromEnv(merged, "PAPO_VIDEO_TIMEOUT_MS", 480_000)
  });
}

function genericProvider(merged: NodeJS.ProcessEnv): ModelProvider {
  const baseUrl = (merged.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const textModel = merged.OPENAI_MODEL ?? merged.GENERIC_MODEL ?? "gpt-5.5";
  const audioModel = genericAudioModel(merged);
  const audioRoute = genericAudioRoute(audioModel);
  const imageModel = merged.OPENAI_IMAGE_MODEL ?? merged.GENERIC_IMAGE_MODEL ?? "gpt-image-1";
  return openAiCompatibleProvider({
    kind: "generic",
    name: "Generic model API",
    endpoint: `${baseUrl}/chat/completions`,
    imageEndpoint: `${baseUrl}/images/generations`,
    videoEndpoint: merged.OPENAI_VIDEO_ENDPOINT ?? merged.GENERIC_VIDEO_ENDPOINT,
    audioEndpoint: audioRoute === "audio_transcriptions" ? `${baseUrl}/audio/transcriptions` : undefined,
    apiKey: merged.OPENAI_API_KEY ?? merged.GENERIC_MODEL_API_KEY,
    model: textModel,
    visionModel: merged.OPENAI_VISION_MODEL ?? textModel,
    audioModel,
    imageModel,
    videoModel: merged.OPENAI_VIDEO_MODEL ?? merged.GENERIC_VIDEO_MODEL,
    videoDefaultDurationSeconds: videoDurationFromEnv(merged.PAPO_VIDEO_DEFAULT_SECONDS, 4),
    videoMaxDurationSeconds: videoDurationFromEnv(merged.PAPO_VIDEO_MAX_SECONDS, 5),
    audioRoute,
    chatTimeoutMs: timeoutFromEnv(merged, "PAPO_MODEL_TIMEOUT_MS", 45_000),
    visionTimeoutMs: timeoutFromEnv(merged, "PAPO_VISION_TIMEOUT_MS", 45_000),
    audioTimeoutMs: timeoutFromEnv(merged, "PAPO_AUDIO_TIMEOUT_MS", 90_000),
    videoTimeoutMs: longTimeoutFromEnv(merged, "PAPO_VIDEO_TIMEOUT_MS", 480_000)
  });
}

function genericAudioModel(merged: NodeJS.ProcessEnv) {
  if (merged.OPENAI_AUDIO_MODEL) return merged.OPENAI_AUDIO_MODEL;
  const explicit = merged.OPENAI_AUDIO_TRANSCRIPTION_MODEL ?? merged.OPENAI_TRANSCRIPTION_MODEL;
  if (explicit) return explicit;
  return "gpt-4o-mini-audio-preview";
}

function genericAudioRoute(model: string): ProviderDiagnostics["audioRoute"] {
  return /(transcribe|whisper)/i.test(model) ? "audio_transcriptions" : "chat_completions";
}

function shouldLoadLocalEnv(env: NodeJS.ProcessEnv) {
  if (env.PAPO_ENV_PATH) return true;
  if (env.NODE_ENV === "test") return false;
  return Object.keys(env).length > 0;
}

function loadLocalProviderConfig(configPath?: string): NodeJS.ProcessEnv {
  const candidates = [
    configPath,
    path.join(process.cwd(), "papo.config.json"),
    path.join(process.cwd(), ".papo", "provider.json")
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, string>;
      return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "string"));
    } catch {
      return {};
    }
  }
  return {};
}

function loadLocalProviderEnv(envPath?: string): NodeJS.ProcessEnv {
  const candidates = [envPath, path.join(process.cwd(), ".env")].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return parseEnvFile(readFileSync(candidate, "utf8"));
    } catch {
      return {};
    }
  }
  return {};
}

function parseEnvFile(content: string): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const raw = trimmed.slice(separator + 1).trim();
    parsed[key] = raw.replace(/^['"]|['"]$/g, "");
  }
  return parsed;
}

function timeoutFromEnv(env: NodeJS.ProcessEnv, key: string, defaultMs: number) {
  const value = Number(env[key]);
  if (!Number.isFinite(value) || value <= 0) return defaultMs;
  return Math.max(5_000, Math.min(120_000, Math.round(value)));
}

function longTimeoutFromEnv(env: NodeJS.ProcessEnv, key: string, defaultMs: number) {
  const value = Number(env[key]);
  if (!Number.isFinite(value) || value <= 0) return defaultMs;
  return Math.max(30_000, Math.min(900_000, Math.round(value)));
}

function videoDurationFromEnv(raw: string | undefined, fallback: number) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(3, Math.min(20, Math.round(value)));
}

function pollIntervalFromEnv(raw: string | undefined, fallback: number) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.min(60_000, Math.round(value)));
}

function openAiCompatibleProvider(input: {
  kind: ProviderKind;
  name: string;
  endpoint: string;
  audioEndpoint?: string;
  imageEndpoint?: string;
  videoEndpoint?: string;
  apiKey?: string;
  model: string;
  visionModel?: string;
  audioModel?: string;
  imageModel?: string;
  videoModel?: string;
  imageRoute?: ProviderDiagnostics["imageRoute"];
  videoRoute?: ProviderDiagnostics["videoRoute"];
  videoDefaultDurationSeconds?: number;
  videoMaxDurationSeconds?: number;
  audioRoute?: ProviderDiagnostics["audioRoute"];
  chatTimeoutMs: number;
  visionTimeoutMs: number;
  audioTimeoutMs: number;
  videoTimeoutMs: number;
}): ModelProvider {
  return {
    kind: input.kind,
    name: input.name,
    available: true,
    usesRealModel: true,
    diagnostics: {
      textProvider: input.kind,
      visionProvider: input.kind,
      audioProvider: input.kind,
      imageProvider: input.kind,
      videoProvider: input.videoEndpoint ? input.kind : undefined,
      textModel: input.model,
      visionModel: input.visionModel ?? input.model,
      audioModel: input.audioModel ?? input.model,
      imageModel: input.imageModel ?? input.model,
      videoModel: input.videoModel,
      imageRoute: input.imageRoute ?? (input.imageEndpoint?.endsWith("/images") ? "openrouter_images" : input.imageEndpoint?.endsWith("/chat/completions") ? "chat_completions" : "images_generations"),
      videoRoute: input.videoRoute,
      audioRoute: input.audioRoute ?? "chat_completions"
    },
    async generate(prompt: string) {
      const payload = await callChatCompletions(input, prompt, false);
      return payload.content;
    },
    async generateJson<T>(prompt: string) {
      const payload = await callChatCompletions(input, prompt, true);
      if (!payload.content.trim()) throw new Error("Model provider returned empty JSON content");
      return parseJson<T>(payload.content);
    },
    async summarizeImage(dataUrl: string, prompt: string) {
      const payload = await callVisionSummary(input, dataUrl, prompt);
      return payload.content;
    },
    async observeAudio(dataUrl: string, prompt: string) {
      const payload =
        input.audioRoute === "audio_transcriptions"
          ? await callAudioTranscriptionEndpoint(input, dataUrl, prompt)
          : await callAudioObservation(input, dataUrl, prompt);
      return payload.content;
    },
    async generateImage(prompt: string, imageInput = {}) {
      return callImageGeneration(input, prompt, imageInput);
    },
    async generateVideo(prompt: string, videoInput = {}) {
      return callVideoGeneration(input, prompt, videoInput);
    }
  };
}

function withModalityOverrides(primary: ModelProvider, merged: NodeJS.ProcessEnv): ModelProvider {
  const vision = visionOverrideProvider(primary, merged);
  const audio = audioOverrideProvider(primary, merged);
  const image = imageOverrideProvider(primary, merged);
  const video = videoOverrideProvider(primary, merged);
  if (!vision && !audio && !image && !video) return primary;
  return {
    ...primary,
    name: [
      primary.name,
      vision ? `${vision.name} vision` : "",
      audio ? `${audio.name} audio` : "",
      image ? `${image.name} image` : "",
      video ? `${video.name} video` : ""
    ].filter(Boolean).join(" + "),
    diagnostics: {
      ...primary.diagnostics,
      ...(image ? {
        imageProvider: image.kind,
        imageModel: image.diagnostics?.imageModel,
        imageRoute: image.diagnostics?.imageRoute
      } : {
        imageProvider: primary.diagnostics?.imageProvider,
        imageModel: primary.diagnostics?.imageModel,
        imageRoute: primary.diagnostics?.imageRoute
      }),
      ...(video ? {
        videoProvider: video.kind,
        videoModel: video.diagnostics?.videoModel,
        videoRoute: video.diagnostics?.videoRoute
      } : {
        videoProvider: primary.diagnostics?.videoProvider,
        videoModel: primary.diagnostics?.videoModel,
        videoRoute: primary.diagnostics?.videoRoute
      }),
      ...(vision ? {
        visionProvider: vision.kind,
        visionModel: vision.diagnostics?.visionModel
      } : {}),
      ...(audio ? {
        audioProvider: audio.kind,
        audioModel: audio.diagnostics?.audioModel,
        audioRoute: audio.diagnostics?.audioRoute
      } : {})
    },
    summarizeImage: vision ? (dataUrl, prompt) => vision.summarizeImage(dataUrl, prompt) : primary.summarizeImage,
    observeAudio: audio ? (dataUrl, prompt) => audio.observeAudio(dataUrl, prompt) : primary.observeAudio,
    generateImage: image ? (prompt, input) => image.generateImage(prompt, input) : primary.generateImage,
    generateVideo: video ? (prompt, input) => video.generateVideo?.(prompt, input) ?? Promise.reject(new Error("Video generation provider is not configured")) : primary.generateVideo
  };
}

function imageOverrideProvider(primary: ModelProvider, merged: NodeJS.ProcessEnv) {
  const requested = merged.PAPO_IMAGE_PROVIDER;
  if (!requested || requested === "primary") return undefined;
  const provider = providerForKind(requested, merged);
  if (provider.kind === primary.kind) return undefined;
  return provider;
}

function videoOverrideProvider(primary: ModelProvider, merged: NodeJS.ProcessEnv) {
  const requested = merged.PAPO_VIDEO_PROVIDER;
  if (requested === "primary") return undefined;
  if (requested === "dashscope") return dashscopeVideoProvider(merged);
  if (requested) {
    const provider = providerForKind(requested, merged);
    if (provider.kind === primary.kind) return undefined;
    return provider;
  }
  if (primary.diagnostics?.videoProvider) return undefined;
  if (merged.DASHSCOPE_API_KEY) return dashscopeVideoProvider(merged);
  if (!merged.OPENROUTER_API_KEY) return undefined;
  return openRouterProvider(merged);
}

function dashscopeVideoProvider(merged: NodeJS.ProcessEnv): ModelProvider {
  const apiKey = merged.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("PAPO video provider requested DashScope without DASHSCOPE_API_KEY.");
  const endpoint = (merged.DASHSCOPE_VIDEO_ENDPOINT ?? "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis").replace(/\/$/, "");
  const model = merged.DASHSCOPE_VIDEO_MODEL ?? "wan2.2-i2v-flash";
  const resolution = merged.DASHSCOPE_VIDEO_RESOLUTION ?? "480P";
  const timeoutMs = longTimeoutFromEnv(merged, "PAPO_VIDEO_TIMEOUT_MS", 480_000);
  const pollIntervalMs = pollIntervalFromEnv(merged.DASHSCOPE_VIDEO_POLL_MS, 5_000);
  const unsupported = async () => { throw new Error("DashScope is configured only for Papo video generation"); };
  return {
    kind: "dashscope",
    name: "Alibaba Cloud Model Studio",
    available: true,
    usesRealModel: true,
    diagnostics: {
      videoProvider: "dashscope",
      videoModel: model,
      videoRoute: "dashscope_video_synthesis"
    },
    generate: unsupported,
    generateJson: unsupported,
    summarizeImage: unsupported,
    observeAudio: unsupported,
    generateImage: unsupported,
    generateVideo: (prompt, input = {}) => callDashscopeVideoGeneration({ endpoint, apiKey, model, resolution, timeoutMs, pollIntervalMs }, prompt, input)
  };
}

async function callDashscopeVideoGeneration(
  config: { endpoint: string; apiKey: string; model: string; resolution: string; timeoutMs: number; pollIntervalMs: number },
  prompt: string,
  input: { durationSeconds?: number; style?: string; referenceImage?: ImageReference }
) {
  if (!input.referenceImage?.dataUrl) throw new Error("DashScope image-to-video requires an approved cover image");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable"
      },
      body: JSON.stringify({
        model: config.model,
        input: {
          prompt: `${prompt}${input.style ? `\n\nStyle: ${input.style}` : ""}`,
          img_url: input.referenceImage.dataUrl
        },
        parameters: {
          resolution: config.resolution,
          prompt_extend: true,
          duration: config.model === "wan2.2-i2v-flash" ? 5 : Math.max(3, Math.min(5, Math.round(input.durationSeconds ?? 4))),
          watermark: false
        }
      })
    });
    if (!response.ok) throw new Error(`DashScope video submission failed: ${response.status} ${await responseErrorSummary(response)}`);
    const created = await response.json() as { output?: { task_id?: string; task_status?: string }; code?: string; message?: string };
    const taskId = created.output?.task_id;
    if (!taskId) throw new Error(`DashScope video submission returned no task id (${created.code ?? "unknown"}: ${created.message ?? "empty response"})`);
    const endpointUrl = new URL(config.endpoint);
    const taskUrl = new URL(`/api/v1/tasks/${encodeURIComponent(taskId)}`, endpointUrl.origin).toString();
    while (true) {
      if (controller.signal.aborted) throw new Error("DashScope video generation timed out");
      await delay(config.pollIntervalMs);
      const statusResponse = await fetch(taskUrl, { signal: controller.signal, headers: { Authorization: `Bearer ${config.apiKey}` } });
      if (!statusResponse.ok) throw new Error(`DashScope video status failed: ${statusResponse.status} ${await responseErrorSummary(statusResponse)}`);
      const status = await statusResponse.json() as { output?: { task_status?: string; video_url?: string; code?: string; message?: string } };
      const state = status.output?.task_status?.toUpperCase();
      if (state === "FAILED" || state === "CANCELED" || state === "UNKNOWN") {
        throw new Error(`DashScope video generation failed: ${status.output?.code ?? state} ${status.output?.message ?? ""}`.trim());
      }
      if (state !== "SUCCEEDED") continue;
      const videoUrl = status.output?.video_url;
      if (!videoUrl) throw new Error("DashScope video generation succeeded without a video URL");
      return videoResultFromRaw(videoUrl, config.model, controller.signal);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function audioOverrideProvider(primary: ModelProvider, merged: NodeJS.ProcessEnv) {
  const requested = merged.PAPO_AUDIO_PROVIDER;
  if (requested === "primary") return undefined;
  if (!requested && primary.kind === "generic") return undefined;
  if (!requested && !(merged.OPENAI_API_KEY || merged.GENERIC_MODEL_API_KEY)) return undefined;
  return requested ? providerForKind(requested, merged) : genericProvider(merged);
}

function visionOverrideProvider(primary: ModelProvider, merged: NodeJS.ProcessEnv) {
  const requested = merged.PAPO_VISION_PROVIDER;
  if (!requested || requested === "primary") return undefined;
  const provider = providerForKind(requested, merged);
  if (provider.kind === primary.kind) return undefined;
  return provider;
}

function providerForKind(kind: string, merged: NodeJS.ProcessEnv) {
  if (kind === "openrouter") {
    if (!merged.OPENROUTER_API_KEY) throw new Error("PAPO modality override requested OpenRouter without OPENROUTER_API_KEY.");
    return openRouterProvider(merged);
  }
  if (kind === "mimo") {
    if (!(merged.MIMO_ENDPOINT || merged.MIMO_API_KEY)) throw new Error("PAPO modality override requested Mimo without MIMO_ENDPOINT or MIMO_API_KEY.");
    return mimoProvider(merged);
  }
  if (kind === "generic") {
    if (!(merged.OPENAI_API_KEY || merged.GENERIC_MODEL_API_KEY)) throw new Error("PAPO modality override requested generic without OPENAI_API_KEY or GENERIC_MODEL_API_KEY.");
    return genericProvider(merged);
  }
  throw new Error(`Unsupported PAPO modality provider override: ${kind}`);
}

async function callChatCompletions(
  input: { endpoint: string; apiKey?: string; model: string; kind: ProviderKind; chatTimeoutMs: number },
  prompt: string,
  json: boolean
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.chatTimeoutMs);
  try {
    const response = await fetch(input.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
        ...(input.kind === "openrouter" ? { "HTTP-Referer": "http://localhost:5173", "X-Title": "Papo" } : {})
      },
      body: JSON.stringify({
        model: input.model,
        temperature: temperatureForModel(input.model, 0.35),
        response_format: json ? { type: "json_object" } : undefined,
        messages: [
          {
            role: "system",
            content:
              "你是一个生命体 agent harness 的语义脑。按用户请求输出内容，并遵守调用方给出的 JSON 结构。"
          },
          { role: "user", content: prompt }
        ]
      })
    });

    if (!response.ok) {
      const summary = await responseErrorSummary(response);
      if (isProviderRefusalText(summary)) throw new ModelProviderRefusalError("safety");
      throw new Error(`Model provider failed: ${response.status} ${summary}`);
    }
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string; refusal?: string } }> };
    const message = data.choices?.[0]?.message;
    if (message?.refusal) throw new ModelProviderRefusalError("policy");
    return { content: message?.content ?? message?.refusal ?? "" };
  } finally {
    clearTimeout(timeout);
  }
}

async function callVisionSummary(
  input: { endpoint: string; apiKey?: string; model: string; visionModel?: string; kind: ProviderKind; visionTimeoutMs: number },
  dataUrl: string,
  prompt: string
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.visionTimeoutMs);
  try {
    const response = await fetch(input.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
        ...(input.kind === "openrouter" ? { "HTTP-Referer": "http://localhost:5173", "X-Title": "Papo" } : {})
      },
      body: JSON.stringify({
        model: input.visionModel ?? input.model,
        temperature: temperatureForModel(input.visionModel ?? input.model, 0.2),
        messages: [
          {
            role: "system",
            content:
              "你是 Papo 的视觉摘要器。只描述图片里和用户生活片段有关的可见事实，不要决定状态、记忆或行动。不要输出开发过程或产品说明。"
          },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl } }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Vision provider failed: ${response.status} ${await responseErrorSummary(response)}`);
    }
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return { content: data.choices?.[0]?.message?.content?.trim() ?? "" };
  } finally {
    clearTimeout(timeout);
  }
}

async function callAudioObservation(
  input: { endpoint: string; apiKey?: string; model: string; audioModel?: string; kind: ProviderKind; audioTimeoutMs: number },
  dataUrl: string,
  prompt: string
) {
  const audio = await audioForChatCompletions(dataUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.audioTimeoutMs);
  try {
    const response = await fetch(input.endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
        ...(input.kind === "openrouter" ? { "HTTP-Referer": "http://localhost:5173", "X-Title": "Papo" } : {})
      },
      body: JSON.stringify({
        model: input.audioModel ?? input.model,
        temperature: temperatureForModel(input.audioModel ?? input.model, 0.1),
        messages: [
          {
            role: "system",
            content:
              "你是 Papo 的声音感知与转写器。严格遵守调用方要求的 JSON 契约。讲座、会议、访谈必须优先忠实保留 transcript 中的数字、专有名词、说话人标签、论点、论据、转折和结论，不能在感知阶段先压缩成摘要；环境声保持简短。只记录可直接听见或由可靠上下文明确支持的内容，不猜身份、姓名、动机或画面外事实。不要决定状态、行动或长期记忆。无法读取时只返回 ERROR_AUDIO_UNREADABLE。"
          },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "input_audio", input_audio: { data: audio.data, format: audio.format } }
            ]
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Audio provider failed: ${response.status} ${await responseErrorSummary(response)}`);
    }
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return { content: data.choices?.[0]?.message?.content?.trim() ?? "" };
  } finally {
    clearTimeout(timeout);
  }
}

async function callAudioTranscriptionEndpoint(
  input: { audioEndpoint?: string; apiKey?: string; audioModel?: string; model: string; audioTimeoutMs: number },
  dataUrl: string,
  prompt: string
) {
  if (!input.audioEndpoint) throw new Error("Audio transcription endpoint is not configured");
  const audio = parseAudioDataUrl(dataUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.audioTimeoutMs);
  const form = new FormData();
  const bytes = Buffer.from(audio.data, "base64");
  const file = new Blob([new Uint8Array(bytes)], { type: audio.mime });
  form.append("model", input.audioModel ?? input.model);
  form.append("file", file, `papo-audio.${audio.format}`);
  form.append("prompt", prompt);
  try {
    const response = await fetch(input.audioEndpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {})
      },
      body: form
    });

    if (!response.ok) {
      throw new Error(`Audio provider failed: ${response.status} ${await responseErrorSummary(response)}`);
    }
    const data = (await response.json()) as { text?: string; choices?: Array<{ message?: { content?: string } }> };
    return { content: (data.text ?? data.choices?.[0]?.message?.content ?? "").trim() };
  } finally {
    clearTimeout(timeout);
  }
}

async function callImageGeneration(
  input: { imageEndpoint?: string; apiKey?: string; model: string; imageModel?: string; kind: ProviderKind; visionTimeoutMs: number; imageRoute?: ProviderDiagnostics["imageRoute"] },
  prompt: string,
  imageInput: { size?: string; style?: string; references?: ImageReference[] }
) {
  if (!input.imageEndpoint) throw new Error("Image generation endpoint is not configured");
  if (/\/chat\/completions$/.test(input.imageEndpoint)) return callChatImageGeneration(input, prompt, imageInput);
  if (input.imageRoute === "openrouter_images" || /\/images$/.test(input.imageEndpoint)) return callOpenRouterImageGeneration(input, prompt, imageInput);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.visionTimeoutMs);
  const model = input.imageModel ?? input.model;
  try {
    const response = await fetch(input.imageEndpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
        ...(input.kind === "openrouter" ? { "HTTP-Referer": "http://localhost:5173", "X-Title": "Papo" } : {})
      },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size: imageInput.size ?? "1024x1024",
        response_format: "b64_json",
        style: imageInput.style
      })
    });

    if (!response.ok) {
      throw new Error(`Image generation provider failed: ${response.status} ${await responseErrorSummary(response)}`);
    }
    const data = (await response.json()) as {
      data?: Array<{ b64_json?: string; url?: string }>;
      images?: Array<{ b64_json?: string; url?: string }>;
    };
    const item = data.data?.[0] ?? data.images?.[0];
    const raw = item?.b64_json ?? item?.url;
    if (!raw) throw new Error("Image generation provider returned no image");
    if (/^data:image\//.test(raw)) return dataUrlImageResult(raw, model);
    if (/^https?:\/\//.test(raw)) {
      const fetched = await fetch(raw, { signal: controller.signal });
      if (!fetched.ok) throw new Error(`Generated image download failed: ${fetched.status}`);
      return downloadedImageResult(fetched, model);
    }
    return { dataUrl: `data:image/png;base64,${raw}`, mime: "image/png" as const, model };
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenRouterImageGeneration(
  input: { imageEndpoint?: string; apiKey?: string; model: string; imageModel?: string; kind: ProviderKind; visionTimeoutMs: number },
  prompt: string,
  imageInput: { size?: string; style?: string; references?: ImageReference[] }
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.visionTimeoutMs);
  const model = input.imageModel ?? input.model;
  try {
    const payload: Record<string, unknown> = {
      model,
      prompt: `${prompt}${imageInput.style ? `\n\nStyle: ${imageInput.style}` : ""}`,
      n: 1
    };
    const size = imageInput.size ?? "1024x1024";
    if (/^\d+x\d+$/i.test(size)) {
      payload.size = size;
    } else {
      payload.resolution = size;
    }
    if (!("size" in payload)) payload.resolution = payload.resolution ?? "1K";
    if (!("aspect_ratio" in payload)) payload.aspect_ratio = "1:1";
    const references = openRouterImageReferences(imageInput.references);
    if (references.length) payload.input_references = references;
    const response = await fetch(input.imageEndpoint!, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
        "HTTP-Referer": "http://localhost:5173",
        "X-Title": "Papo"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Image generation provider failed: ${response.status} ${await responseErrorSummary(response)}`);
    }
    const data = (await response.json()) as {
      data?: Array<{ b64_json?: string; url?: string; media_type?: string }>;
      images?: Array<{ b64_json?: string; url?: string; media_type?: string }>;
    };
    const item = data.data?.[0] ?? data.images?.[0];
    const raw = item?.b64_json ?? item?.url;
    if (!raw) throw new Error("Image generation provider returned no image");
    const mime = rasterMime(item?.media_type);
    if (/^data:image\//.test(raw)) return dataUrlImageResult(raw, model);
    if (/^https?:\/\//.test(raw)) {
      const fetched = await fetch(raw, { signal: controller.signal });
      if (!fetched.ok) throw new Error(`Generated image download failed: ${fetched.status}`);
      return downloadedImageResult(fetched, model);
    }
    return { dataUrl: `data:${mime};base64,${raw}`, mime, model };
  } finally {
    clearTimeout(timeout);
  }
}

async function callChatImageGeneration(
  input: { imageEndpoint?: string; apiKey?: string; model: string; imageModel?: string; kind: ProviderKind; visionTimeoutMs: number },
  prompt: string,
  imageInput: { size?: string; style?: string; references?: ImageReference[] }
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.visionTimeoutMs);
  const model = input.imageModel ?? input.model;
  try {
    const response = await fetch(input.imageEndpoint!, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
        ...(input.kind === "openrouter" ? { "HTTP-Referer": "http://localhost:5173", "X-Title": "Papo" } : {})
      },
      body: JSON.stringify({
        model,
        temperature: temperatureForModel(model, 0.7),
        modalities: ["image", "text"],
        messages: [
          {
            role: "system",
            content:
              "You generate warm hand-drawn comic/postcard style images for a companion app. Return an image, not a textual description."
          },
          {
            role: "user",
            content: `${prompt}\n\nSize: ${imageInput.size ?? "1024x1024"}. ${imageInput.style ? `Style: ${imageInput.style}.` : ""}`
          }
        ]
      })
    });

    if (!response.ok) {
      throw new Error(`Image generation provider failed: ${response.status} ${await responseErrorSummary(response)}`);
    }
    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          images?: Array<{ image_url?: { url?: string }; url?: string; b64_json?: string }>;
          content?: unknown;
        };
      }>;
    };
    const message = data.choices?.[0]?.message;
    const raw = extractGeneratedImage(message);
    if (!raw) throw new Error("Image generation provider returned no image");
    if (/^data:image\//.test(raw)) return dataUrlImageResult(raw, model);
    if (/^https?:\/\//.test(raw)) {
      const fetched = await fetch(raw, { signal: controller.signal });
      if (!fetched.ok) throw new Error(`Generated image download failed: ${fetched.status}`);
      return downloadedImageResult(fetched, model);
    }
    return { dataUrl: `data:image/png;base64,${raw}`, mime: "image/png" as const, model };
  } finally {
    clearTimeout(timeout);
  }
}

function openRouterImageReferences(references?: ImageReference[]) {
  return (references ?? []).slice(0, 4).map((reference) => ({
    type: "image_url",
    image_url: {
      url: reference.dataUrl
    }
  }));
}

function dataUrlImageResult(dataUrl: string, model: string) {
  const match = dataUrl.match(/^data:(image\/[^;]+);base64,/i);
  const mime = rasterMime(match?.[1]);
  return { dataUrl: dataUrl.replace(/^data:image\/jpg;/i, "data:image/jpeg;"), mime, model };
}

async function downloadedImageResult(response: Response, model: string) {
  const mime = rasterMime(response.headers.get("content-type") ?? undefined);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, mime, model };
}

function rasterMime(value?: string): "image/png" | "image/jpeg" | "image/webp" {
  const clean = value?.split(";")[0]?.toLowerCase();
  if (clean === "image/jpeg" || clean === "image/jpg") return "image/jpeg";
  if (clean === "image/webp") return "image/webp";
  if (!clean || clean === "image/png") return "image/png";
  throw new Error(`Image generation provider returned unsupported image type: ${clean}`);
}

function extractGeneratedImage(message: { images?: Array<{ image_url?: { url?: string }; url?: string; b64_json?: string }>; content?: unknown } | undefined): string | undefined {
  const direct = message?.images?.find(Boolean);
  if (direct?.image_url?.url) return direct.image_url.url;
  if (direct?.url) return direct.url;
  if (direct?.b64_json) return direct.b64_json;
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const part of content as Array<Record<string, unknown>>) {
      const imageUrl = part.image_url as { url?: string } | undefined;
      if (imageUrl?.url) return imageUrl.url;
      if (typeof part.url === "string") return part.url;
      if (typeof part.b64_json === "string") return part.b64_json;
    }
  }
  if (typeof content === "string") {
    const dataUrl = content.match(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/)?.[0];
    if (dataUrl) return dataUrl;
  }
  return undefined;
}

async function callVideoGeneration(
  input: { videoEndpoint?: string; apiKey?: string; model: string; videoModel?: string; kind: ProviderKind; videoTimeoutMs: number; videoDefaultDurationSeconds?: number; videoMaxDurationSeconds?: number },
  prompt: string,
  videoInput: { durationSeconds?: number; style?: string; referenceImage?: ImageReference }
) {
  if (!input.videoEndpoint) throw new Error("Video generation endpoint is not configured");
  const model = input.videoModel ?? input.model;
  if (!model) throw new Error("Video generation model is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.videoTimeoutMs);
  try {
    const started = Date.now();
    const capability = await videoModelCapability(input, model, controller.signal);
    const requestedDuration = Math.min(
      videoInput.durationSeconds ?? input.videoDefaultDurationSeconds ?? 4,
      input.videoMaxDurationSeconds ?? 5
    );
    const duration = supportedDuration(capability, requestedDuration);
    const aspectRatio = supportedAspectRatio(capability, "1:1");
    const resolution = supportedResolution(capability, "720p");
    const payload: Record<string, unknown> = {
      model,
      prompt: `${prompt}${videoInput.style ? `\n\nStyle: ${videoInput.style}` : ""}`,
      duration,
      duration_seconds: duration,
      aspect_ratio: aspectRatio,
      resolution,
      response_format: "url"
    };
    if (videoInput.referenceImage?.dataUrl) {
      payload.image_url = videoInput.referenceImage.dataUrl;
      payload.input_image = videoInput.referenceImage.dataUrl;
    }
    const response = await fetch(input.videoEndpoint, {
      method: "POST",
      signal: controller.signal,
      headers: openRouterHeaders(input),
      body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`Video generation provider failed: ${response.status} ${await responseErrorSummary(response)}`);
    const initial = await response.json();
    const direct = extractGeneratedVideo(initial);
    if (direct) return await videoResultFromRaw(direct, model, controller.signal);

    const id = extractJobId(initial);
    if (!id) throw new Error(`Video generation provider returned no video or job id (${jsonDiagnostic(JSON.stringify(initial).slice(0, 1000))})`);
    const pollingUrl = extractPollingUrl(initial);
    while (Date.now() - started < input.videoTimeoutMs) {
      await delay(5_000);
      const status = await fetch(resolveVideoEndpoint(input.videoEndpoint, pollingUrl ?? id), {
        method: "GET",
        signal: controller.signal,
        headers: openRouterHeaders(input)
      });
      if (!status.ok) throw new Error(`Video generation status failed: ${status.status} ${await responseErrorSummary(status)}`);
      const data = await status.json();
      const statusText = String((data as Record<string, unknown>).status ?? (data as Record<string, unknown>).state ?? "").toLowerCase();
      if (/fail|error|cancel/.test(statusText)) throw new Error(`Video generation failed: ${JSON.stringify(data).slice(0, 600)}`);
      const raw = extractGeneratedVideo(data);
      if (raw) return await videoResultFromRaw(raw, model, controller.signal);
      if (/complete|succeed|success|done|finished/.test(statusText)) {
        const content = await fetch(`${input.videoEndpoint.replace(/\/$/, "")}/${encodeURIComponent(id)}/content`, {
          method: "GET",
          signal: controller.signal,
          headers: openRouterHeaders(input)
        });
        if (!content.ok) throw new Error(`Video generation content download failed: ${content.status} ${await responseErrorSummary(content)}`);
        const bytes = Buffer.from(await content.arrayBuffer());
        return { dataUrl: `data:video/mp4;base64,${bytes.toString("base64")}`, mime: "video/mp4" as const, model };
      }
    }
    throw new Error(`Video generation timed out after ${Math.round(input.videoTimeoutMs / 1000)}s`);
  } finally {
    clearTimeout(timeout);
  }
}

async function videoModelCapability(
  input: { videoEndpoint?: string; apiKey?: string; kind: ProviderKind },
  model: string,
  signal: AbortSignal
) {
  if (!input.videoEndpoint || input.kind !== "openrouter") return undefined;
  const response = await fetch(`${input.videoEndpoint.replace(/\/videos$/, "")}/videos/models`, {
    method: "GET",
    signal,
    headers: openRouterHeaders(input)
  });
  if (!response.ok) throw new Error(`Video models lookup failed: ${response.status} ${await responseErrorSummary(response)}`);
  const data = await response.json() as { data?: Array<Record<string, unknown>> };
  return data.data?.find((item) => item.id === model);
}

function supportedDuration(capability: Record<string, unknown> | undefined, desired: number) {
  const durations = Array.isArray(capability?.supported_durations) ? capability.supported_durations.filter((item): item is number => typeof item === "number") : [];
  if (!durations.length) return desired;
  return durations.reduce((best, current) => Math.abs(current - desired) < Math.abs(best - desired) ? current : best, durations[0]);
}

function supportedAspectRatio(capability: Record<string, unknown> | undefined, desired: string) {
  const ratios = Array.isArray(capability?.supported_aspect_ratios) ? capability.supported_aspect_ratios.filter((item): item is string => typeof item === "string") : [];
  if (!ratios.length || ratios.includes(desired)) return desired;
  return ratios.includes("16:9") ? "16:9" : ratios[0];
}

function supportedResolution(capability: Record<string, unknown> | undefined, desired: string) {
  const resolutions = Array.isArray(capability?.supported_resolutions) ? capability.supported_resolutions.filter((item): item is string => typeof item === "string") : [];
  if (!resolutions.length || resolutions.includes(desired)) return desired;
  return resolutions.includes("480p") ? "480p" : resolutions[0];
}

function extractPollingUrl(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.polling_url === "string" ? record.polling_url : undefined;
}

function resolveVideoEndpoint(videoEndpoint: string, idOrPath: string) {
  if (/^https?:\/\//.test(idOrPath)) return idOrPath;
  if (idOrPath.startsWith("/")) {
    const base = new URL(videoEndpoint);
    return `${base.origin}${idOrPath}`;
  }
  return `${videoEndpoint.replace(/\/$/, "")}/${encodeURIComponent(idOrPath)}`;
}

function openRouterHeaders(input: { apiKey?: string; kind: ProviderKind }) {
  return {
    "Content-Type": "application/json",
    ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
    ...(input.kind === "openrouter" ? { "HTTP-Referer": "http://localhost:5173", "X-Title": "Papo" } : {})
  };
}

function extractJobId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["id", "job_id", "task_id", "generation_id"]) {
    if (typeof record[key] === "string" && record[key]) return record[key] as string;
  }
  if (record.data && typeof record.data === "object") return extractJobId(record.data);
  return undefined;
}

function extractGeneratedVideo(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") {
    if (/^data:video\//.test(value) || /^https?:\/\//.test(value) || /^[A-Za-z0-9+/=]{200,}$/.test(value)) return value;
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractGeneratedVideo(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["url", "video_url", "download_url", "mp4", "b64_json", "base64", "data_url"]) {
    const found = extractGeneratedVideo(record[key]);
    if (found) return found;
  }
  for (const key of ["video", "videos", "output", "outputs", "result", "results", "data", "artifacts"]) {
    const found = extractGeneratedVideo(record[key]);
    if (found) return found;
  }
  return undefined;
}

async function videoResultFromRaw(raw: string, model: string, signal: AbortSignal) {
  if (/^data:video\//.test(raw)) {
    const normalized = raw.replace(/^data:video\/quicktime;/i, "data:video/mp4;");
    return { dataUrl: normalized, mime: "video/mp4" as const, model };
  }
  if (/^https?:\/\//.test(raw)) {
    const response = await fetch(raw, { signal });
    if (!response.ok) throw new Error(`Generated video download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { dataUrl: `data:video/mp4;base64,${bytes.toString("base64")}`, mime: "video/mp4" as const, model, remoteUrl: raw };
  }
  return { dataUrl: `data:video/mp4;base64,${raw}`, mime: "video/mp4" as const, model };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseAudioDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(audio\/[^;]+)(?:;[^,]+)?;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("Invalid audio data URL");
  const mime = match[1].toLowerCase();
  const format = audioFormatFromMime(mime);
  return { data: match[2], format, mime };
}

async function audioForChatCompletions(dataUrl: string) {
  const audio = parseAudioDataUrl(dataUrl);
  if (audio.format === "mp3" || audio.format === "wav") return audio;
  return transcodeAudioToWav(audio);
}

async function transcodeAudioToWav(audio: ReturnType<typeof parseAudioDataUrl>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "papo-audio-"));
  const inputPath = path.join(directory, `input.${audio.format}`);
  const outputPath = path.join(directory, "output.wav");
  try {
    await writeFile(inputPath, Buffer.from(audio.data, "base64"));
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      outputPath
    ], { timeout: 20_000 });
    const converted = await readFile(outputPath);
    return {
      data: converted.toString("base64"),
      format: "wav" as const,
      mime: "audio/wav"
    };
  } catch (error) {
    throw new Error(`Audio input conversion failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function audioFormatFromMime(mime: string) {
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("aac")) return "aac";
  if (mime.includes("m4a") || mime.includes("mp4")) return "mp4";
  return "webm";
}

function temperatureForModel(model: string, value: number) {
  return /^openai\/gpt-5|^gpt-5/i.test(model) ? undefined : value;
}

async function responseErrorSummary(response: Response) {
  try {
    const text = await response.text();
    return text.replace(/\s+/g, " ").trim().slice(0, 260);
  } catch {
    return "";
  }
}

function parseJson<T>(text: string): T | undefined {
  if (isProviderRefusalText(text)) throw new ModelProviderRefusalError("safety");
  const candidates = [text.trim(), ...extractJsonBlocks(text), extractFirstJsonObject(text)].filter((item): item is string => Boolean(item?.trim()));
  for (const candidate of candidates) {
    try {
      return parseJsonCandidate<T>(candidate);
    } catch {
      // Try the next exact JSON candidate from the model output.
    }
  }
  throw new Error(`Model provider returned invalid JSON content (${jsonDiagnostic(text)})`);
}

export function isProviderRefusalText(text: string) {
  return /request (?:was |has been )?rejected|considered high risk|safety (?:policy|filters?)|cannot (?:assist|comply)|unable to comply|内容风险|安全策略|请求被拒绝/i.test(text.trim());
}

function parseJsonCandidate<T>(candidate: string): T {
  const parsed = JSON.parse(candidate) as unknown;
  if (typeof parsed === "string") {
    const nested = parsed.trim();
    if (nested.startsWith("{") || nested.startsWith("[")) return JSON.parse(nested) as T;
  }
  return parsed as T;
}

function jsonDiagnostic(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "empty";
  return `length=${text.length}, prefix=${JSON.stringify(compact.slice(0, 120))}`;
}

function extractJsonBlocks(text: string) {
  return [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim());
}

function extractFirstJsonObject(text: string) {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}

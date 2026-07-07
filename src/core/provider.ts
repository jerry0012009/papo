import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ProviderKind } from "./types";

export interface ModelProvider {
  kind: ProviderKind;
  name: string;
  available: boolean;
  usesRealModel: boolean;
  diagnostics?: ProviderDiagnostics;
  generate(prompt: string): Promise<string>;
  generateJson<T>(prompt: string): Promise<T | undefined>;
  summarizeImage(dataUrl: string, prompt: string): Promise<string>;
  observeAudio(dataUrl: string, prompt: string): Promise<string>;
}

export interface ProviderDiagnostics {
  textProvider?: ProviderKind;
  visionProvider?: ProviderKind;
  audioProvider?: ProviderKind;
  textModel?: string;
  visionModel?: string;
  audioModel?: string;
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
  return withModalityOverrides(primary, merged);
}

function openRouterProvider(merged: NodeJS.ProcessEnv): ModelProvider {
  const textModel = merged.OPENROUTER_MODEL ?? "openai/gpt-5.5";
  const visionModel = merged.OPENROUTER_VISION_MODEL ?? "nex-agi/nex-n2-mini";
  const audioModel = merged.OPENROUTER_AUDIO_MODEL ?? "mistralai/voxtral-small-24b-2507";
  return openAiCompatibleProvider({
    kind: "openrouter",
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: merged.OPENROUTER_API_KEY,
    model: textModel,
    visionModel,
    audioModel,
    audioRoute: "chat_completions",
    chatTimeoutMs: timeoutFromEnv(merged, "PAPO_MODEL_TIMEOUT_MS", 45_000),
    visionTimeoutMs: timeoutFromEnv(merged, "PAPO_VISION_TIMEOUT_MS", 45_000),
    audioTimeoutMs: timeoutFromEnv(merged, "PAPO_AUDIO_TIMEOUT_MS", 45_000)
  });
}

function mimoProvider(merged: NodeJS.ProcessEnv): ModelProvider {
  return openAiCompatibleProvider({
    kind: "mimo",
    name: "Local Mimo",
    endpoint: merged.MIMO_ENDPOINT ?? "http://localhost:11434/v1/chat/completions",
    apiKey: merged.MIMO_API_KEY,
    model: merged.MIMO_MODEL ?? "mimo",
    visionModel: merged.MIMO_VISION_MODEL ?? merged.MIMO_MODEL ?? "mimo",
    audioModel: merged.MIMO_AUDIO_MODEL ?? merged.MIMO_MODEL ?? "mimo",
    chatTimeoutMs: timeoutFromEnv(merged, "PAPO_MODEL_TIMEOUT_MS", 45_000),
    visionTimeoutMs: timeoutFromEnv(merged, "PAPO_VISION_TIMEOUT_MS", 45_000),
    audioTimeoutMs: timeoutFromEnv(merged, "PAPO_AUDIO_TIMEOUT_MS", 45_000)
  });
}

function genericProvider(merged: NodeJS.ProcessEnv): ModelProvider {
  const baseUrl = (merged.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const textModel = merged.OPENAI_MODEL ?? merged.GENERIC_MODEL ?? "gpt-5.5";
  const audioModel = genericAudioModel(merged);
  const audioRoute = genericAudioRoute(audioModel);
  return openAiCompatibleProvider({
    kind: "generic",
    name: "Generic model API",
    endpoint: `${baseUrl}/chat/completions`,
    audioEndpoint: audioRoute === "audio_transcriptions" ? `${baseUrl}/audio/transcriptions` : undefined,
    apiKey: merged.OPENAI_API_KEY ?? merged.GENERIC_MODEL_API_KEY,
    model: textModel,
    visionModel: merged.OPENAI_VISION_MODEL ?? textModel,
    audioModel,
    audioRoute,
    chatTimeoutMs: timeoutFromEnv(merged, "PAPO_MODEL_TIMEOUT_MS", 45_000),
    visionTimeoutMs: timeoutFromEnv(merged, "PAPO_VISION_TIMEOUT_MS", 45_000),
    audioTimeoutMs: timeoutFromEnv(merged, "PAPO_AUDIO_TIMEOUT_MS", 45_000)
  });
}

function genericAudioModel(merged: NodeJS.ProcessEnv) {
  if (merged.OPENAI_AUDIO_MODEL) return merged.OPENAI_AUDIO_MODEL;
  const explicit = merged.OPENAI_AUDIO_TRANSCRIPTION_MODEL ?? merged.OPENAI_TRANSCRIPTION_MODEL;
  if (explicit) return explicit;
  return "gpt-4o-mini-transcribe";
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

function openAiCompatibleProvider(input: {
  kind: ProviderKind;
  name: string;
  endpoint: string;
  audioEndpoint?: string;
  apiKey?: string;
  model: string;
  visionModel?: string;
  audioModel?: string;
  audioRoute?: ProviderDiagnostics["audioRoute"];
  chatTimeoutMs: number;
  visionTimeoutMs: number;
  audioTimeoutMs: number;
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
      textModel: input.model,
      visionModel: input.visionModel ?? input.model,
      audioModel: input.audioModel ?? input.model,
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
    }
  };
}

function withModalityOverrides(primary: ModelProvider, merged: NodeJS.ProcessEnv): ModelProvider {
  const vision = visionOverrideProvider(primary, merged);
  const audio = audioOverrideProvider(primary, merged);
  if (!vision && !audio) return primary;
  return {
    ...primary,
    name: [
      primary.name,
      vision ? `${vision.name} vision` : "",
      audio ? `${audio.name} audio` : ""
    ].filter(Boolean).join(" + "),
    diagnostics: {
      ...primary.diagnostics,
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
    observeAudio: audio ? (dataUrl, prompt) => audio.observeAudio(dataUrl, prompt) : primary.observeAudio
  };
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
      throw new Error(`Model provider failed: ${response.status} ${await responseErrorSummary(response)}`);
    }
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return { content: data.choices?.[0]?.message?.content ?? "" };
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
  const audio = parseAudioDataUrl(dataUrl);
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
              "你是 Papo 的声音感知器。直接根据音频写一段中文生活观察，只描述可直接听见的事实、明确听清的说话内容和环境声类型；不能猜测人声、文字、看不见的物体、身份、动机或原因，不能把非语音声音当成说话，不确定就写不确定。不要决定状态、记忆或行动。没有可用生活信息时返回空文本。无法读取或处理音频时只返回 ERROR_AUDIO_UNREADABLE。不要输出开发过程或产品说明。"
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

function parseAudioDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(audio\/[^;]+)(?:;[^,]+)?;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("Invalid audio data URL");
  const mime = match[1].toLowerCase();
  const format = audioFormatFromMime(mime);
  return { data: match[2], format, mime };
}

function audioFormatFromMime(mime: string) {
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("ogg")) return "ogg";
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

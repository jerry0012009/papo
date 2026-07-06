import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ProviderKind } from "./types";

export interface ModelProvider {
  kind: ProviderKind;
  name: string;
  available: boolean;
  usesRealModel: boolean;
  generate(prompt: string): Promise<string>;
  generateJson<T>(prompt: string): Promise<T | undefined>;
  summarizeImage(dataUrl: string, prompt: string): Promise<string>;
  transcribeAudio(dataUrl: string, prompt: string): Promise<string>;
}

export function createModelProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const config = loadLocalProviderConfig(env.PAPO_CONFIG_PATH);
  const dotenv = shouldLoadLocalEnv(env) ? loadLocalProviderEnv(env.PAPO_ENV_PATH) : {};
  const merged = { ...config, ...dotenv, ...env };
  const preferred = merged.PAPO_PROVIDER;

  if (preferred === "openrouter" && merged.OPENROUTER_API_KEY) return openRouterProvider(merged);
  if (preferred === "mimo" && (merged.MIMO_ENDPOINT || merged.MIMO_API_KEY)) return mimoProvider(merged);
  if (preferred === "generic" && (merged.OPENAI_API_KEY || merged.GENERIC_MODEL_API_KEY)) return genericProvider(merged);

  if (merged.OPENROUTER_API_KEY) return openRouterProvider(merged);
  if (merged.MIMO_ENDPOINT || merged.MIMO_API_KEY) return mimoProvider(merged);
  if (merged.OPENAI_API_KEY || merged.GENERIC_MODEL_API_KEY) return genericProvider(merged);
  return staticProvider("fallback", "Fallback demo brain", true);
}

function openRouterProvider(merged: NodeJS.ProcessEnv): ModelProvider {
  return openAiCompatibleProvider({
    kind: "openrouter",
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    apiKey: merged.OPENROUTER_API_KEY,
    model: merged.OPENROUTER_MODEL ?? "openai/gpt-5.5",
    visionModel: merged.OPENROUTER_VISION_MODEL ?? "google/gemini-2.0-flash-001",
    audioModel: merged.OPENROUTER_AUDIO_MODEL ?? merged.OPENROUTER_VISION_MODEL ?? "google/gemini-2.0-flash-001",
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
  return openAiCompatibleProvider({
    kind: "generic",
    name: "Generic model API",
    endpoint: merged.OPENAI_BASE_URL
      ? `${merged.OPENAI_BASE_URL.replace(/\/$/, "")}/chat/completions`
      : "https://api.openai.com/v1/chat/completions",
    apiKey: merged.OPENAI_API_KEY ?? merged.GENERIC_MODEL_API_KEY,
    model: merged.OPENAI_MODEL ?? merged.GENERIC_MODEL ?? "gpt-5.5",
    visionModel: merged.OPENAI_VISION_MODEL ?? merged.OPENAI_MODEL ?? merged.GENERIC_MODEL ?? "gpt-5.5",
    audioModel: merged.OPENAI_AUDIO_MODEL ?? merged.OPENAI_MODEL ?? merged.GENERIC_MODEL ?? "gpt-5.5",
    chatTimeoutMs: timeoutFromEnv(merged, "PAPO_MODEL_TIMEOUT_MS", 45_000),
    visionTimeoutMs: timeoutFromEnv(merged, "PAPO_VISION_TIMEOUT_MS", 45_000),
    audioTimeoutMs: timeoutFromEnv(merged, "PAPO_AUDIO_TIMEOUT_MS", 45_000)
  });
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

function timeoutFromEnv(env: NodeJS.ProcessEnv, key: string, fallback: number) {
  const value = Number(env[key]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(5_000, Math.min(120_000, Math.round(value)));
}

function staticProvider(kind: ProviderKind, name: string, available: boolean): ModelProvider {
  return {
    kind,
    name,
    available,
    usesRealModel: false,
    async generate(prompt: string) {
      const firstLine = prompt.split("\n").find(Boolean) ?? prompt;
      return `fallback:${firstLine.slice(0, 160)}`;
    },
    async generateJson() {
      return undefined;
    },
    async summarizeImage() {
      return "图片已上传，但当前 fallback brain 不能真实看图。请把截图里你希望我注意的地方补成一句摘要。";
    },
    async transcribeAudio() {
      return "音频已上传，但当前 fallback brain 不能真实转写。请把录音里你希望我注意的内容补成一句话。";
    }
  };
}

function openAiCompatibleProvider(input: {
  kind: ProviderKind;
  name: string;
  endpoint: string;
  apiKey?: string;
  model: string;
  visionModel?: string;
  audioModel?: string;
  chatTimeoutMs: number;
  visionTimeoutMs: number;
  audioTimeoutMs: number;
}): ModelProvider {
  return {
    kind: input.kind,
    name: input.name,
    available: true,
    usesRealModel: true,
    async generate(prompt: string) {
      const payload = await callChatCompletions(input, prompt, false);
      return payload.content;
    },
    async generateJson<T>(prompt: string) {
      const payload = await callChatCompletions(input, prompt, true);
      return parseJson<T>(payload.content);
    },
    async summarizeImage(dataUrl: string, prompt: string) {
      const payload = await callVisionSummary(input, dataUrl, prompt);
      return payload.content;
    },
    async transcribeAudio(dataUrl: string, prompt: string) {
      const payload = await callAudioTranscript(input, dataUrl, prompt);
      return payload.content;
    }
  };
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
        ...(input.kind === "openrouter" ? { "HTTP-Referer": "http://localhost:5173", "X-Title": "Papo Demo" } : {})
      },
      body: JSON.stringify({
        model: input.model,
        temperature: temperatureForModel(input.model, 0.35),
        response_format: json ? { type: "json_object" } : undefined,
        messages: [
          {
            role: "system",
            content:
              "你是一个生命体 agent harness 的语义脑。只输出用户要求的内容。不要决定持久状态数值，不要越过隐私护栏。"
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
        ...(input.kind === "openrouter" ? { "HTTP-Referer": "http://localhost:5173", "X-Title": "Papo Demo" } : {})
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

async function callAudioTranscript(
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
        ...(input.kind === "openrouter" ? { "HTTP-Referer": "http://localhost:5173", "X-Title": "Papo Demo" } : {})
      },
      body: JSON.stringify({
        model: input.audioModel ?? input.model,
        temperature: temperatureForModel(input.audioModel ?? input.model, 0.1),
        messages: [
          {
            role: "system",
            content:
              "你是 Papo 的音频转写器。只转写和摘要用户生活片段中的可听内容，不要决定状态、记忆或行动。不要输出开发过程或产品说明。"
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

function parseAudioDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(audio\/[^;]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error("Invalid audio data URL");
  const mime = match[1].toLowerCase();
  const format = audioFormatFromMime(mime);
  return { data: match[2], format };
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
  try {
    return JSON.parse(text) as T;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return undefined;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return undefined;
    }
  }
}

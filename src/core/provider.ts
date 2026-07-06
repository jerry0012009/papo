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
}

export function createModelProvider(env: NodeJS.ProcessEnv = process.env): ModelProvider {
  const config = loadLocalProviderConfig(env.PAPO_CONFIG_PATH);
  const merged = { ...config, ...env };

  if (merged.MIMO_ENDPOINT || merged.MIMO_API_KEY) {
    return openAiCompatibleProvider({
      kind: "mimo",
      name: "Local Mimo",
      endpoint: merged.MIMO_ENDPOINT ?? "http://localhost:11434/v1/chat/completions",
      apiKey: merged.MIMO_API_KEY,
      model: merged.MIMO_MODEL ?? "mimo"
    });
  }
  if (merged.OPENROUTER_API_KEY) {
    return openAiCompatibleProvider({
      kind: "openrouter",
      name: "OpenRouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: merged.OPENROUTER_API_KEY,
      model: merged.OPENROUTER_MODEL ?? "openai/gpt-4.1-mini"
    });
  }
  if (merged.OPENAI_API_KEY || merged.GENERIC_MODEL_API_KEY) {
    return openAiCompatibleProvider({
      kind: "generic",
      name: "Generic model API",
      endpoint: merged.OPENAI_BASE_URL
        ? `${merged.OPENAI_BASE_URL.replace(/\/$/, "")}/chat/completions`
        : "https://api.openai.com/v1/chat/completions",
      apiKey: merged.OPENAI_API_KEY ?? merged.GENERIC_MODEL_API_KEY,
      model: merged.OPENAI_MODEL ?? merged.GENERIC_MODEL ?? "gpt-4.1-mini"
    });
  }
  return staticProvider("fallback", "Fallback demo brain", true);
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
    }
  };
}

function openAiCompatibleProvider(input: {
  kind: ProviderKind;
  name: string;
  endpoint: string;
  apiKey?: string;
  model: string;
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
    }
  };
}

async function callChatCompletions(
  input: { endpoint: string; apiKey?: string; model: string; kind: ProviderKind },
  prompt: string,
  json: boolean
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
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
        temperature: 0.35,
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
      throw new Error(`Model provider failed: ${response.status}`);
    }
    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return { content: data.choices?.[0]?.message?.content ?? "" };
  } finally {
    clearTimeout(timeout);
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

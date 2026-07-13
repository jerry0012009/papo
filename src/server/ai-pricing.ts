import type { AiCostSource, AiUsageCategory } from "../core/ai-usage";
import type { ProviderUsageReport } from "../core/provider";

export const AI_PRICE_VERSION = "2026-07-13-v2-cny";
const DEFAULT_USD_CNY = 7.2;

export interface AiPriceInput {
  category: AiUsageCategory;
  operation: string;
  provider: string;
  model: string;
  prompt?: string;
  outputText?: string;
  durationSeconds?: number;
  report?: ProviderUsageReport;
}

interface ModelPrice {
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  perImageUsd?: number;
  perVideoSecondUsd?: number;
  perAudioMinuteUsd?: number;
  inputCnyPerMillion?: number;
  outputCnyPerMillion?: number;
  perImageCny?: number;
  perVideoSecondCny?: number;
  perAudioMinuteCny?: number;
}

const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "mimo-v2.5-pro": { inputUsdPerMillion: 0.105, outputUsdPerMillion: 0.28 },
  "xiaomi/mimo-v2.5": { inputUsdPerMillion: 0.105, outputUsdPerMillion: 0.28 },
  "qwen/qwen3.5-flash-02-23": { inputUsdPerMillion: 0.065, outputUsdPerMillion: 0.26 },
  "nex-agi/nex-n2-mini": { inputUsdPerMillion: 0.025, outputUsdPerMillion: 0.1 },
  "google/gemini-3.1-flash-lite-image": { perImageUsd: 0.039 },
  "black-forest-labs/flux.2-klein-4b": { perImageUsd: 0.014 },
  "bytedance/seedance-1-5-pro": { perVideoSecondUsd: 0.0115296 },
  "wan2.2-i2v-flash": { perVideoSecondUsd: 0.0138889 }
};

export function priceAiCall(input: AiPriceInput, env: NodeJS.ProcessEnv = process.env) {
  const usdCny = positiveNumber(env.PAPO_BILLING_USD_CNY) ?? DEFAULT_USD_CNY;
  const reportedCost = finiteNonNegative(input.report?.cost);
  const reportedCurrency = input.report?.costCurrency;
  if (reportedCost !== undefined && reportedCurrency === "CNY") {
    return result(reportedCost, "provider_reported", input.report);
  }
  if (reportedCost !== undefined && reportedCurrency === "USD") {
    return result(reportedCost * usdCny, "provider_reported", input.report, usdCny);
  }
  const legacyReportedUsd = finiteNonNegative(input.report?.costUsd);
  if (legacyReportedUsd !== undefined) return result(legacyReportedUsd * usdCny, "provider_reported", input.report, usdCny);

  const prices = { ...DEFAULT_PRICES, ...priceOverrides(env.PAPO_MODEL_PRICES_JSON) };
  const price = prices[input.model];
  if (!price) return result(0, "unpriced", input.report);
  const report = input.report;
  const inputTokens = report?.inputTokens ?? estimateTokens(input.prompt);
  const outputTokens = report?.outputTokens ?? estimateTokens(input.outputText);
  let usd = 0;
  let cny = 0;
  if (price.inputUsdPerMillion) usd += inputTokens / 1_000_000 * price.inputUsdPerMillion;
  if (price.outputUsdPerMillion) usd += outputTokens / 1_000_000 * price.outputUsdPerMillion;
  if (price.inputCnyPerMillion) cny += inputTokens / 1_000_000 * price.inputCnyPerMillion;
  if (price.outputCnyPerMillion) cny += outputTokens / 1_000_000 * price.outputCnyPerMillion;
  if (input.category === "image" && input.operation.includes("generate") && price.perImageUsd) usd += price.perImageUsd;
  if (input.category === "image" && input.operation.includes("generate") && price.perImageCny) cny += price.perImageCny;
  if (input.category === "video" && price.perVideoSecondUsd) usd += Math.max(1, input.durationSeconds ?? 4) * price.perVideoSecondUsd;
  if (input.category === "video" && price.perVideoSecondCny) cny += Math.max(1, input.durationSeconds ?? 4) * price.perVideoSecondCny;
  if (input.category === "audio" && price.perAudioMinuteUsd) usd += Math.max(1 / 60, (input.durationSeconds ?? 0) / 60) * price.perAudioMinuteUsd;
  if (input.category === "audio" && price.perAudioMinuteCny) cny += Math.max(1 / 60, (input.durationSeconds ?? 0) / 60) * price.perAudioMinuteCny;
  return result(cny + usd * usdCny, cny > 0 || usd > 0 ? "catalog_estimate" : "unpriced", report, usd > 0 ? usdCny : undefined);
}

export function estimateExpensiveCallMicros(input: Omit<AiPriceInput, "report" | "outputText">, env: NodeJS.ProcessEnv = process.env) {
  const priced = priceAiCall(input, env);
  if (priced.costMicros > 0) return priced.costMicros;
  if (input.category === "video") return 500_000;
  if (input.category === "image") return input.operation === "generateEconomyImage" ? 120_000 : 350_000;
  return 0;
}

function result(cny: number, costSource: AiCostSource, report?: ProviderUsageReport, exchangeRate?: number) {
  const upstreamCost = report?.cost ?? report?.costUsd;
  const upstreamCurrency = report?.costCurrency ?? (report?.costUsd !== undefined ? "USD" : undefined);
  return {
    costMicros: Math.max(0, Math.round(cny * 1_000_000)),
    costSource,
    inputTokens: report?.inputTokens,
    outputTokens: report?.outputTokens,
    totalTokens: report?.totalTokens,
    cachedTokens: report?.cachedTokens,
    audioTokens: report?.audioTokens,
    imageTokens: report?.imageTokens,
    upstreamCost,
    upstreamCurrency,
    exchangeRate: upstreamCurrency === "USD" ? exchangeRate : undefined,
    upstreamCostUsd: upstreamCurrency === "USD" ? upstreamCost : undefined
  };
}

function priceOverrides(raw: string | undefined): Record<string, ModelPrice> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, ModelPrice>;
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value && typeof value === "object"));
  } catch {
    return {};
  }
}

function estimateTokens(value?: string) {
  return value ? Math.max(1, Math.ceil([...value].length / 3)) : 0;
}

function positiveNumber(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function finiteNonNegative(value: number | undefined) {
  return Number.isFinite(value) && (value ?? -1) >= 0 ? value : undefined;
}

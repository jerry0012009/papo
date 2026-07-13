import { randomUUID } from "node:crypto";
import type { AiUsageCategory, AiUsageEvent } from "../core/ai-usage";
import { captureProviderUsage, type ModelProvider, type ProviderUsageReport } from "../core/provider";
import { InsufficientAiBalanceError, type JsonAiBillingService } from "./ai-billing";
import { estimateExpensiveCallMicros, priceAiCall } from "./ai-pricing";

interface MeteredCall {
  category: AiUsageCategory;
  operation: string;
  provider: string;
  model: string;
  route?: string;
  prompt?: string;
  durationSeconds?: number;
  expensive?: boolean;
}

export function createMeteredProvider(provider: ModelProvider, billing: JsonAiBillingService): ModelProvider {
  const wrap = <T>(call: MeteredCall, run: () => Promise<T>) => meterCall(billing, call, run);
  return {
    ...provider,
    generate: (prompt) => wrap(textCall(provider, "generate", prompt), () => provider.generate(prompt)),
    generateJson: (prompt) => wrap(textCall(provider, "generateJson", prompt), () => provider.generateJson(prompt)),
    generateJsonFallback: provider.generateJsonFallback
      ? (prompt) => wrap(textFallbackCall(provider, prompt), () => provider.generateJsonFallback!(prompt))
      : undefined,
    summarizeImage: (dataUrl, prompt) => wrap(modalityCall(provider, "image", "summarizeImage", prompt), () => provider.summarizeImage(dataUrl, prompt)),
    observeAudio: (dataUrl, prompt) => wrap(modalityCall(provider, "audio", "observeAudio", prompt), () => provider.observeAudio(dataUrl, prompt)),
    generateImage: (prompt, input) => wrap({ ...modalityCall(provider, "image", "generateImage", prompt), expensive: true }, () => provider.generateImage(prompt, input)),
    generateEconomyImage: provider.generateEconomyImage
      ? (prompt, input) => wrap({ ...economyImageCall(provider, prompt), expensive: true }, () => provider.generateEconomyImage!(prompt, input))
      : undefined,
    generateVideo: provider.generateVideo
      ? (prompt, input) => wrap({ ...modalityCall(provider, "video", "generateVideo", prompt), durationSeconds: input?.durationSeconds, expensive: true }, () => provider.generateVideo!(prompt, input))
      : undefined
  };
}

async function meterCall<T>(billing: JsonAiBillingService, call: MeteredCall, run: () => Promise<T>): Promise<T> {
  const context = billing.context();
  if (!context?.userId) return run();
  const callId = `call_${randomUUID()}`;
  let reservedMicros = 0;
  if (call.expensive) {
    const estimate = estimateExpensiveCallMicros(call);
    try {
      await billing.authorize(context.userId, callId, estimate);
      reservedMicros = estimate;
    } catch (error) {
      if (error instanceof InsufficientAiBalanceError) {
        await billing.settle(eventInput(context, call, callId, {
          status: "blocked",
          costMicros: 0,
          costSource: "catalog_estimate",
          errorCode: "insufficient_balance"
        }));
      }
      throw error;
    }
  }

  try {
    const captured = await captureProviderUsage(run);
    const report = combineProviderUsage(captured.reports);
    const outputText = typeof captured.result === "string" ? captured.result : undefined;
    const model = report.model ?? resultModel(captured.result) ?? call.model;
    const calculated = priceAiCall({ ...call, model, outputText, report });
    const priced = call.expensive && calculated.costSource === "unpriced"
      ? { ...calculated, costMicros: reservedMicros, costSource: "catalog_estimate" as const }
      : calculated;
    await billing.settle(eventInput(context, { ...call, model }, callId, {
      status: "completed",
      ...priced,
      durationSeconds: call.durationSeconds,
      quantity: call.category === "image" && call.operation.includes("generate") ? 1 : undefined
    }));
    return captured.result;
  } catch (error) {
    await billing.settle(eventInput(context, call, callId, {
      status: "failed",
      costMicros: 0,
      costSource: "unpriced",
      errorCode: "provider_failed"
    })).catch(() => undefined);
    throw error;
  }
}

function eventInput(
  context: NonNullable<ReturnType<JsonAiBillingService["context"]>>,
  call: MeteredCall,
  callId: string,
  result: Pick<AiUsageEvent, "status" | "costMicros" | "costSource"> & Partial<AiUsageEvent>
): Omit<AiUsageEvent, "id" | "at" | "balanceAfterMicros" | "priceVersion"> {
  return {
    callId,
    userId: context.userId,
    category: call.category,
    operation: call.operation,
    feature: context.feature,
    sourceId: context.sourceId,
    turnId: context.turnId,
    jobId: context.jobId,
    provider: call.provider,
    model: call.model,
    route: call.route,
    ...result
  };
}

function textCall(provider: ModelProvider, operation: string, prompt: string): MeteredCall {
  return {
    category: "text",
    operation,
    provider: provider.diagnostics?.textProvider ?? provider.kind,
    model: provider.diagnostics?.textModel ?? provider.kind,
    prompt
  };
}

function textFallbackCall(provider: ModelProvider, prompt: string): MeteredCall {
  return {
    category: "text",
    operation: "generateJsonFallback",
    provider: provider.diagnostics?.textFallbackProvider ?? provider.kind,
    model: provider.diagnostics?.textFallbackModel ?? provider.diagnostics?.textModel ?? provider.kind,
    prompt
  };
}

function modalityCall(provider: ModelProvider, category: Exclude<AiUsageCategory, "text">, operation: string, prompt: string): MeteredCall {
  const diagnostics = provider.diagnostics;
  if (category === "audio") return { category, operation, provider: diagnostics?.audioProvider ?? provider.kind, model: diagnostics?.audioModel ?? provider.kind, route: diagnostics?.audioRoute, prompt };
  if (category === "video") return { category, operation, provider: diagnostics?.videoProvider ?? provider.kind, model: diagnostics?.videoModel ?? provider.kind, route: diagnostics?.videoRoute, prompt };
  return {
    category,
    operation,
    provider: operation === "summarizeImage" ? diagnostics?.visionProvider ?? provider.kind : diagnostics?.imageProvider ?? provider.kind,
    model: operation === "summarizeImage" ? diagnostics?.visionModel ?? provider.kind : diagnostics?.imageModel ?? provider.kind,
    route: operation === "summarizeImage" ? "chat_completions" : diagnostics?.imageRoute,
    prompt
  };
}

function economyImageCall(provider: ModelProvider, prompt: string): MeteredCall {
  return {
    category: "image",
    operation: "generateEconomyImage",
    provider: provider.diagnostics?.imageProvider ?? provider.kind,
    model: provider.diagnostics?.economyImageModel ?? provider.diagnostics?.imageModel ?? provider.kind,
    route: provider.diagnostics?.imageRoute,
    prompt
  };
}

export function combineProviderUsage(reports: ProviderUsageReport[]): ProviderUsageReport {
  return reports.reduce<ProviderUsageReport>((combined, report) => ({
    model: report.model ?? combined.model,
    inputTokens: cumulativeMaximum(combined.inputTokens, report.inputTokens),
    outputTokens: cumulativeMaximum(combined.outputTokens, report.outputTokens),
    totalTokens: cumulativeMaximum(combined.totalTokens, report.totalTokens),
    cachedTokens: cumulativeMaximum(combined.cachedTokens, report.cachedTokens),
    audioTokens: cumulativeMaximum(combined.audioTokens, report.audioTokens),
    imageTokens: cumulativeMaximum(combined.imageTokens, report.imageTokens),
    cost: cumulativeCost(combined, report),
    costCurrency: report.costCurrency ?? combined.costCurrency,
    costUsd: cumulativeMaximum(combined.costUsd, report.costUsd)
  }), {});
}

function cumulativeCost(left: ProviderUsageReport, right: ProviderUsageReport) {
  if (left.costCurrency && right.costCurrency && left.costCurrency !== right.costCurrency) return right.cost;
  return cumulativeMaximum(left.cost, right.cost);
}

function cumulativeMaximum(left: number | undefined, right: number | undefined) {
  if (left === undefined && right === undefined) return undefined;
  return Math.max(left ?? 0, right ?? 0);
}

function resultModel(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  return typeof (value as { model?: unknown }).model === "string" ? (value as { model: string }).model : undefined;
}

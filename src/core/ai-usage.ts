export type AiUsageCategory = "text" | "audio" | "image" | "video";
export type AiUsageStatus = "completed" | "failed" | "blocked";
export type AiCostSource = "provider_reported" | "catalog_estimate" | "unpriced";
export type AiCostCurrency = "USD" | "CNY";

export interface AiUsageEvent {
  id: string;
  callId: string;
  userId: string;
  at: string;
  category: AiUsageCategory;
  operation: string;
  feature?: string;
  sourceId?: string;
  turnId?: string;
  jobId?: string;
  provider: string;
  model: string;
  route?: string;
  status: AiUsageStatus;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  audioTokens?: number;
  imageTokens?: number;
  durationSeconds?: number;
  quantity?: number;
  upstreamCost?: number;
  upstreamCurrency?: AiCostCurrency;
  exchangeRate?: number;
  /** @deprecated Kept for records written before currency-aware billing. */
  upstreamCostUsd?: number;
  costMicros: number;
  costSource: AiCostSource;
  priceVersion: string;
  balanceAfterMicros: number;
  errorCode?: "insufficient_balance" | "provider_failed";
}

export interface AiUsageSummaryBucket {
  category: AiUsageCategory;
  calls: number;
  completed: number;
  failed: number;
  blocked: number;
  totalTokens: number;
  costMicros: number;
}

export interface AiBillingAccountView {
  userId: string;
  currency: "CNY";
  balanceMicros: number;
  trialGrantedAt: string;
  updatedAt: string;
  summary: AiUsageSummaryBucket[];
  events: AiUsageEvent[];
}

export interface AiRedemptionResult {
  creditedMicros: number;
  balanceMicros: number;
  redeemedAt: string;
}

export function formatCnyMicros(value: number) {
  return `¥${(value / 1_000_000).toFixed(2)}`;
}

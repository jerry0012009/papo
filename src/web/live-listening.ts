export const LIVE_BATCH_MS = 30_000;
export const LIVE_LISTENING_DEFAULT_MS = 180_000;
export const LIVE_LISTENING_DURATION_OPTIONS = [
  { label: "3 分钟", value: 180_000, description: "适合临时说一件事。" },
  { label: "15 分钟", value: 900_000, description: "适合吃饭、通勤、开会前后。" },
  { label: "60 分钟", value: 3_600_000, description: "适合一段较长的陪伴。" }
] as const;
export const LIVE_BATCH_AUDIO_GRACE_MS = 1_500;
export const LIVE_BATCH_MAX_WAIT_MS = 12_000;
export const FINAL_SLICE_SUPPRESS_MS = 1_000;

export function liveBatchId(startedAt: number, index: number) {
  return `live-${new Date(startedAt).toISOString()}-${String(index).padStart(2, "0")}`;
}

export function manualBatchId(nowMs = Date.now()) {
  return `manual-${Math.floor(nowMs / LIVE_BATCH_MS)}`;
}

export function currentLiveBatchId(startedAt: number | undefined, nowMs = Date.now()) {
  if (!startedAt) return manualBatchId(nowMs);
  const index = Math.max(1, Math.floor((nowMs - startedAt) / LIVE_BATCH_MS) + 1);
  return liveBatchId(startedAt, index);
}

export function audioSliceBatchId(startedAt: number | undefined, index: number, nowMs = Date.now()) {
  return startedAt ? liveBatchId(startedAt, index) : manualBatchId(nowMs);
}

export function liveBatchBoundaryMs(startedAt: number | undefined, batchId: string, nowMs = Date.now()) {
  const match = batchId.match(/-(\d{2})$/);
  if (!startedAt || !match) return nowMs;
  return startedAt + Number(match[1]) * LIVE_BATCH_MS;
}

export function shouldSuppressForcedAudioSlice(nowMs: number, lastRequestAt: number) {
  return nowMs - lastRequestAt < FINAL_SLICE_SUPPRESS_MS;
}

export function plannedLiveAudioSliceBatchIds(startedAt: number, totalMs = LIVE_LISTENING_DEFAULT_MS) {
  const count = Math.ceil(totalMs / LIVE_BATCH_MS);
  return Array.from({ length: count }, (_item, index) => liveBatchId(startedAt, index + 1));
}

export function imageSegmentContent(summary: string, label: string) {
  const cleanSummary = summary.trim();
  if (cleanSummary) return cleanSummary;
  return "你给 Papo 看了一张照片，但这张照片这次没有被看清。";
}

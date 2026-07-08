export const LIVE_BATCH_MS = 30_000;
export const LIVE_LISTENING_MAX_MS = 180_000;
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

export function plannedLiveAudioSliceBatchIds(startedAt: number, totalMs = LIVE_LISTENING_MAX_MS) {
  const count = Math.ceil(totalMs / LIVE_BATCH_MS);
  return Array.from({ length: count }, (_item, index) => liveBatchId(startedAt, index + 1));
}

export function imageSegmentContent(summary: string, label: string) {
  const cleanSummary = summary.trim();
  if (cleanSummary) return cleanSummary;
  return "你给 Papo 看了一张照片，但这张照片这次没有被看清。";
}

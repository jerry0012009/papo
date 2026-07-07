import assert from "node:assert/strict";
import {
  audioSliceBatchId,
  currentLiveBatchId,
  LIVE_BATCH_MS,
  LIVE_LISTENING_MAX_MS,
  liveBatchBoundaryMs,
  plannedLiveAudioSliceBatchIds,
  shouldSuppressForcedAudioSlice
} from "../src/web/live-listening";

const startedAt = Date.UTC(2026, 6, 7, 12, 0, 0);
const planned = plannedLiveAudioSliceBatchIds(startedAt, LIVE_LISTENING_MAX_MS);

assert.equal(planned.length, 6);
assert.deepEqual(
  planned.map((id) => id.slice(-2)),
  ["01", "02", "03", "04", "05", "06"]
);
assert.equal(new Set(planned).size, 6);

for (let index = 1; index <= 6; index += 1) {
  assert.equal(audioSliceBatchId(startedAt, index), planned[index - 1]);
  assert.equal(liveBatchBoundaryMs(startedAt, planned[index - 1]), startedAt + index * LIVE_BATCH_MS);
}

assert.equal(currentLiveBatchId(startedAt, startedAt), planned[0]);
assert.equal(currentLiveBatchId(startedAt, startedAt + LIVE_BATCH_MS - 1), planned[0]);
assert.equal(currentLiveBatchId(startedAt, startedAt + LIVE_BATCH_MS), planned[1]);
assert.equal(currentLiveBatchId(startedAt, startedAt + 5 * LIVE_BATCH_MS), planned[5]);

assert.equal(shouldSuppressForcedAudioSlice(startedAt + LIVE_LISTENING_MAX_MS, startedAt + LIVE_LISTENING_MAX_MS - 500), true);
assert.equal(shouldSuppressForcedAudioSlice(startedAt + LIVE_LISTENING_MAX_MS, startedAt + LIVE_LISTENING_MAX_MS - 1500), false);

console.log(JSON.stringify({ ok: true, planned }, null, 2));

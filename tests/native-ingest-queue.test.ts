import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NativeIngestQueue } from "../src/server/native-ingest-queue";

const directory = await mkdtemp(path.join(tmpdir(), "papo-native-queue-"));
const processed: string[] = [];
let firstAttempts = 0;
const queue = new NativeIngestQueue(async (_userId, payload) => {
  if (payload.batchId === "batch-001") {
    firstAttempts += 1;
    throw new Error("temporary provider failure");
  }
  processed.push(payload.batchId);
}, directory, 5, 500);

try {
  await queue.enqueue("user", { batchId: "batch-001", observedAt: new Date().toISOString(), audioDataUrl: "data:audio/mp4;base64,QQ==" });
  await queue.enqueue("user", { batchId: "batch-002", observedAt: new Date().toISOString(), audioDataUrl: "data:audio/mp4;base64,Qg==" });
  const deadline = Date.now() + 1_000;
  while (processed.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await queue.tick();
  }

  assert.equal(firstAttempts, 1);
  assert.deepEqual(processed, ["batch-002"], "a failed job must not block the next eligible job");
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".json")).length, 1);
  await new Promise((resolve) => setTimeout(resolve, 520));
  await queue.tick();
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".json")).length, 0, "expired raw native payloads must be removed even when processing keeps failing");
  console.log(JSON.stringify({ ok: true, processed }));
} finally {
  queue.stop();
  await rm(directory, { recursive: true, force: true });
}

const priorityDirectory = await mkdtemp(path.join(tmpdir(), "papo-native-priority-"));
const priorityProcessed: string[] = [];
let releaseBlocking!: () => void;
let markBlockingStarted!: () => void;
const blocking = new Promise<void>((resolve) => { releaseBlocking = resolve; });
const blockingStarted = new Promise<void>((resolve) => { markBlockingStarted = resolve; });
const priorityQueue = new NativeIngestQueue(async (_userId, payload) => {
  if (payload.batchId === "audio-blocking") {
    markBlockingStarted();
    await blocking;
  }
  priorityProcessed.push(payload.batchId);
}, priorityDirectory, 60_000, 60_000);

try {
  await priorityQueue.enqueue("user", { batchId: "audio-blocking", observedAt: new Date().toISOString(), audioDataUrl: "data:audio/mp4;base64,QQ==" });
  await blockingStarted;
  await priorityQueue.enqueue("user", { batchId: "camera-scheduled", observedAt: new Date().toISOString(), captureIntent: "scheduled", imageDataUrl: "data:image/jpeg;base64,QQ==" });
  await priorityQueue.enqueue("user", { batchId: "camera-manual", observedAt: new Date().toISOString(), captureIntent: "user_initiated", imageDataUrl: "data:image/jpeg;base64,Qg==" });
  releaseBlocking();
  await waitFor(() => priorityProcessed.includes("camera-manual"));

  assert.deepEqual(priorityProcessed, ["audio-blocking", "camera-manual"], "manual photos must bypass the normal interval without creating concurrent provider calls");
  assert.deepEqual((await readdir(priorityDirectory)).filter((name) => name.endsWith(".json")).sort(), ["user--camera-scheduled.json"]);
} finally {
  priorityQueue.stop();
  releaseBlocking();
  await rm(priorityDirectory, { recursive: true, force: true });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for prioritized native ingest");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

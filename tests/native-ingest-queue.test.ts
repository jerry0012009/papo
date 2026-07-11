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
}, directory, 5);

try {
  await queue.enqueue("user", { batchId: "batch-001", observedAt: new Date().toISOString(), audioDataUrl: "data:audio/mp4;base64,QQ==" });
  await queue.enqueue("user", { batchId: "batch-002", observedAt: new Date().toISOString(), audioDataUrl: "data:audio/mp4;base64,Qg==" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await queue.tick();

  assert.equal(firstAttempts, 1);
  assert.deepEqual(processed, ["batch-002"], "a failed job must not block the next eligible job");
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".json")).length, 1);
  console.log(JSON.stringify({ ok: true, processed }));
} finally {
  queue.stop();
  await rm(directory, { recursive: true, force: true });
}

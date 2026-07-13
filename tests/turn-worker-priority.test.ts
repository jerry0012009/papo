import assert from "node:assert/strict";
import test from "node:test";
import { createCreatureProfile } from "../src/core/profile";
import type { ConversationJobRecord } from "../src/core/types";
import { MemoryProfileStore } from "../src/server/store";
import { PersistentTurnWorker } from "../src/server/turn-worker";

test("user work preempts lifecycle artwork and lifecycle artwork stays single-flight", async () => {
  const store = new MemoryProfileStore();
  const profile = createCreatureProfile({ userId: "worker-priority", creatureName: "Papo", now: "2026-07-12T10:00:00.000Z" });
  profile.jobs = [
    job("memory-old-1", "memory_enrichment", "2026-07-12T09:00:00.000Z"),
    job("memory-old-2", "memory_enrichment", "2026-07-12T09:01:00.000Z"),
    job("candidate-old-3", "candidate_visual", "2026-07-12T09:02:00.000Z"),
    job("user-action", "illustration", "2026-07-12T10:00:00.000Z")
  ];
  await store.saveProfile(profile);

  const started: string[] = [];
  let activeLifecycle = 0;
  let maxActiveLifecycle = 0;
  let releaseLifecycle!: () => void;
  const lifecycleGate = new Promise<void>((resolve) => { releaseLifecycle = resolve; });
  const worker = new PersistentTurnWorker({
    store,
    concurrency: 3,
    intervalMs: 10,
    handle: async (_userId, running) => {
      started.push(running.id);
      if (running.type !== "memory_enrichment" && running.type !== "candidate_visual") return;
      activeLifecycle += 1;
      maxActiveLifecycle = Math.max(maxActiveLifecycle, activeLifecycle);
      await lifecycleGate;
      activeLifecycle -= 1;
    }
  });

  try {
    await worker.start();
    await waitFor(() => started.includes("user-action") && started.some((id) => id !== "user-action"));
    assert.equal(started[0], "user-action", "new user-facing work must start before historical artwork");
    assert.equal(maxActiveLifecycle, 1);
    assert.equal(started.filter((id) => id !== "user-action").length, 1, "only one lifecycle image may run at a time");
  } finally {
    releaseLifecycle();
    worker.stop();
  }
});

test("single-flight lifecycle work continues draining after each completion", async () => {
  const store = new MemoryProfileStore();
  const profile = createCreatureProfile({ userId: "worker-lifecycle-drain", creatureName: "Papo", now: "2026-07-12T10:00:00.000Z" });
  profile.jobs = [
    job("memory-drain-1", "memory_enrichment", "2026-07-12T09:00:00.000Z"),
    job("memory-drain-2", "memory_enrichment", "2026-07-12T09:01:00.000Z"),
    job("memory-drain-3", "memory_enrichment", "2026-07-12T09:02:00.000Z")
  ];
  await store.saveProfile(profile);
  const completed: string[] = [];
  const worker = new PersistentTurnWorker({ store, concurrency: 3, intervalMs: 10, handle: async (_userId, running) => { completed.push(running.id); } });
  try {
    await worker.start();
    await waitFor(() => completed.length === 3);
    assert.deepEqual(completed, ["memory-drain-1", "memory-drain-2", "memory-drain-3"]);
  } finally {
    worker.stop();
  }
});

test("a non-retryable billing gate failure is attempted only once", async () => {
  const store = new MemoryProfileStore();
  const profile = createCreatureProfile({ userId: "worker-non-retryable", creatureName: "Papo" });
  const gated = job("gated-video", "action_card", new Date().toISOString());
  gated.retryable = true;
  gated.maxAttempts = 3;
  profile.jobs = [gated];
  await store.saveProfile(profile);
  let attempts = 0;
  const worker = new PersistentTurnWorker({
    store, intervalMs: 10,
    handle: async () => {
      attempts += 1;
      const error = new Error("AI 余额不足") as Error & { retryable: boolean };
      error.retryable = false;
      throw error;
    }
  });
  try {
    await worker.start();
    await waitFor(async () => (await store.getProfile(profile.userId))?.jobs?.[0]?.status === "failed");
    assert.equal(attempts, 1);
    assert.equal((await store.getProfile(profile.userId))?.jobs?.[0]?.attempt, 1);
  } finally {
    worker.stop();
  }
});

function job(id: string, type: ConversationJobRecord["type"], createdAt: string): ConversationJobRecord {
  return {
    id,
    turnId: `turn-${id}`,
    requestId: `turn-${id}`,
    type,
    stage: "action",
    status: "queued",
    attempt: 0,
    maxAttempts: 1,
    retryable: false,
    createdAt,
    updatedAt: createdAt,
    sourceIds: [id]
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for worker scheduling");
}

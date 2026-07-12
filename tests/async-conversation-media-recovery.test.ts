import assert from "node:assert/strict";
import { upsertLongTermMemory } from "../src/core/memory";
import { createApp } from "../src/server/app";
import type { ModelProvider } from "../src/core/provider";
import { MemoryProfileStore } from "../src/server/store";
import { PersistentTurnWorker } from "../src/server/turn-worker";

const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const store = new MemoryProfileStore();
await store.createProfile({ userId: "media-turn-user", creatureName: "Papo" });
const provider: ModelProvider = {
  kind: "generic", name: "Media worker provider", available: true, usesRealModel: true,
  async generate() { return ""; },
  async generateJson(prompt) {
    if (prompt.includes("共同回忆编辑和视觉导演")) return { shortTitle: "咖啡时刻", narrative: "我记得你分享过一杯咖啡。", visualMode: "imaginative_illustration", papoPresence: "absent", visualReason: "没有现场照片，使用插画表达", imagePrompt: "Square hand-painted watercolor memory scene of a coffee cup on a lived-in table, visible paper texture, no text.", relatedMemoryIds: [], needsClientReferences: false };
    if (prompt.includes("Client.md 维护脑")) return { facts: [{ dimension: "leisure", text: "你会分享咖啡时刻", confidence: 80, sourceIds: ["ltm_async_memory"] }] };
    if (prompt.includes("注意决策脑")) {
      const segmentId = [...prompt.matchAll(/"segmentId":"([^"]+)"/g)].at(-1)?.[1];
      return { selected: [{ segmentId, whySelected: "媒体有内容", noticed: "用户分享了媒体", userMeaning: "希望交流", relatedMemoryIds: [], tags: [] }], ignored: [] };
    }
    if (prompt.includes("行动选择脑")) {
      const events = JSON.parse(prompt.match(/events:\n(\[[\s\S]*?\])\n/)?.[1] ?? "[]") as Array<{ id: string }>;
      return { decisions: [{ eventId: events[0].id, action: "respond", reason: "回应分享", stateDeltas: {}, shouldCreateEpisode: false, shouldConsiderMemory: false, shouldReply: true, reply: "我已经理解这份媒体了。" }] };
    }
    throw new Error("unexpected model prompt");
  },
  async summarizeImage() { return "画面里有一杯咖啡"; },
  async observeAudio() { return "ERROR_AUDIO_UNREADABLE"; },
  async generateImage() { return { dataUrl: IMAGE, mime: "image/png" }; }
};
const app = createApp({ store, provider, turns: { autoStart: false } });
const worker = app.locals.turnWorker as PersistentTurnWorker;
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");
const base = `http://127.0.0.1:${address.port}`;
const audio = `data:audio/webm;base64,${Buffer.from("test audio bytes").toString("base64")}`;

try {
  const response = await fetch(`${base}/api/profiles/media-turn-user/turns`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      turnId: "turn_media_recovery", requestId: "turn_media_recovery", channel: "curious",
      segments: [
        { id: "turn_media_image", kind: "image_summary", label: "咖啡照片", dataUrl: IMAGE },
        { id: "turn_media_audio", kind: "audio_observation", label: "一段录音", dataUrl: audio }
      ]
    })
  });
  const accepted = await response.json();
  assert.equal(response.status, 202);
  const placeholders = accepted.profile.conversation.filter((message: { turnId?: string }) => message.turnId === "turn_media_recovery");
  assert.equal(placeholders.some((message: { displayText?: string }) => message.displayText?.includes("照片已收到")), true);
  assert.equal(placeholders.some((message: { displayText?: string }) => message.displayText?.includes("录音已收到")), true);
  for (const message of placeholders) {
    for (const attachment of message.attachments ?? []) {
      const asset = await fetch(`${base}${attachment.url}`);
      assert.equal(asset.status, 200, "accepted media must already be durably readable");
    }
  }

  await store.updateProfile("media-turn-user", (profile) => {
    const cognition = profile.jobs?.find((job) => job.type === "cognition");
    if (!cognition) throw new Error("missing cognition job");
    cognition.status = "running";
    cognition.attempt = 1;
  });
  await worker.start();
  await waitFor(async () => (await store.getProfile("media-turn-user"))?.jobs?.every((job) => job.status === "completed") ?? false);
  const final = await store.getProfile("media-turn-user");
  assert.equal(final?.turns?.[0].segments.find((segment) => segment.kind === "image_summary")?.content, "画面里有一杯咖啡");
  assert.equal(final?.turns?.[0].segments.find((segment) => segment.kind === "audio_observation")?.sensingTrace?.status, "unreadable");
  assert.equal(final?.conversation.some((message) => message.role === "papo" && message.turnId === "turn_media_recovery"), true);

  await store.updateProfile("media-turn-user", (profile) => {
    const completed = profile.jobs?.find((job) => job.type === "cognition");
    if (completed) completed.status = "queued";
  });
  await worker.drainOnce();
  const retried = await store.getProfile("media-turn-user");
  assert.equal(retried?.conversation.filter((message) => message.role === "papo" && message.turnId === "turn_media_recovery").length, 1, "retry must not duplicate reply");
  assert.equal(new Set(retried?.jobs?.flatMap((job) => job.result?.memorySourceIds ?? [])).size, retried?.jobs?.flatMap((job) => job.result?.memorySourceIds ?? []).length, "memory stage source IDs stay idempotent");

  await store.updateProfile("media-turn-user", (profile) => {
    upsertLongTermMemory(profile, { id: "ltm_async_memory", createdAt: new Date().toISOString(), kind: "long_theme", text: "你分享了一杯咖啡", sourceEpisodeId: "episode_async_memory", weight: 80, tags: ["咖啡"] }, { sourceIds: ["turn_media_recovery", "turn_media_recovery-cognition"] });
    const lifecycleJob = profile.jobs?.find((job) => job.memoryId === "ltm_async_memory");
    if (lifecycleJob) profile.turns?.[0].jobIds.push(lifecycleJob.id);
  });
  worker.wake();
  await waitFor(async () => (await store.getProfile("media-turn-user"))?.jobs?.find((job) => job.memoryId === "ltm_async_memory")?.status === "completed");
  const enriched = await store.getProfile("media-turn-user");
  const enrichedMemory = enriched?.longTermMemories.find((memory) => memory.id === "ltm_async_memory");
  assert.equal(enrichedMemory?.visualStatus, "ready");
  const memoryJob = enriched?.jobs?.find((job) => job.memoryId === "ltm_async_memory");
  assert.equal(enrichedMemory?.visual?.jobId, memoryJob?.id);
  assert.equal(enrichedMemory?.visual?.sourceIds?.includes("turn_media_recovery"), true);
  assert.equal(memoryJob?.result?.memoryDecision, "created");
  assert.equal(enriched?.longTermMemories.filter((memory) => memory.id === "ltm_async_memory").length, 1);
} finally {
  worker.stop();
  server.close();
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for media jobs");
}

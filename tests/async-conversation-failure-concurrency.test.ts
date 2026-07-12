import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import type { ModelProvider } from "../src/core/provider";
import { MemoryProfileStore } from "../src/server/store";
import type { PersistentTurnWorker } from "../src/server/turn-worker";

const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const store = new MemoryProfileStore();
await store.createProfile({ userId: "failure-user", creatureName: "Papo" });
let activeSensing = 0;
let maxActiveSensing = 0;
const sensingResolvers: Array<() => void> = [];
let imageAttempts = 0;
const provider: ModelProvider = {
  kind: "generic", name: "Failure concurrency provider", available: true, usesRealModel: true,
  async generate() { return ""; },
  async generateJson(prompt) {
    if (prompt.includes("注意决策脑")) {
      const segmentId = [...prompt.matchAll(/"segmentId":"([^"]+)"/g)].at(-1)?.[1];
      return { selected: [{ segmentId, whySelected: "需要处理", noticed: "收到请求", userMeaning: "需要回复", relatedMemoryIds: [], tags: [] }], ignored: [] };
    }
    if (prompt.includes("行动选择脑")) {
      const events = JSON.parse(prompt.match(/events:\n(\[[\s\S]*?\])\n/)?.[1] ?? "[]") as Array<{ id: string; content: string }>;
      const wantsIllustration = events[0]?.content.includes("失败插画");
      return { decisions: [{ eventId: events[0].id, action: "respond", reason: "先回复", stateDeltas: {}, shouldCreateEpisode: false, shouldConsiderMemory: false, shouldReply: true, reply: wantsIllustration ? "先保留这条文字回答。" : "媒体已理解。", ...(wantsIllustration ? { actions: [{ action: "generate_illustration", actionResult: { kind: "illustration_draft", title: "会失败的小画", prompt: "测试失败" } }] } : {}) }] };
    }
    throw new Error("unexpected prompt");
  },
  async summarizeImage() {
    activeSensing += 1;
    maxActiveSensing = Math.max(maxActiveSensing, activeSensing);
    await new Promise<void>((resolve) => sensingResolvers.push(resolve));
    activeSensing -= 1;
    return "测试图片";
  },
  async observeAudio() { return ""; },
  async generateImage() { imageAttempts += 1; throw new Error("deterministic illustration failure"); }
};
const app = createApp({ store, provider, turns: { concurrency: 2, intervalMs: 10 } });
const worker = app.locals.turnWorker as PersistentTurnWorker;
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind");
const base = `http://127.0.0.1:${address.port}`;

try {
  const mediaResponse = await fetch(`${base}/api/profiles/failure-user/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turnId: "turn_parallel_media", requestId: "turn_parallel_media", channel: "curious", segments: [{ id: "parallel-image-1", kind: "image_summary", label: "图一", dataUrl: IMAGE }, { id: "parallel-image-2", kind: "image_summary", label: "图二", dataUrl: IMAGE }] }) });
  assert.equal(mediaResponse.status, 202);
  await waitFor(() => Promise.resolve(sensingResolvers.length === 2));
  assert.equal(maxActiveSensing, 2, "independent sensing jobs should use bounded concurrency");
  sensingResolvers.splice(0).forEach((resolve) => resolve());
  await waitFor(async () => (await store.getProfile("failure-user"))?.turns?.find((turn) => turn.id === "turn_parallel_media")?.status === "completed");

  const failureResponse = await fetch(`${base}/api/profiles/failure-user/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turnId: "turn_failed_illustration", requestId: "turn_failed_illustration", channel: "button", segments: [{ id: "failure-text", kind: "text", label: "你刚说的话", content: "失败插画但先回答" }] }) });
  assert.equal(failureResponse.status, 202);
  const nextResponse = await fetch(`${base}/api/profiles/failure-user/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turnId: "turn_after_failure", requestId: "turn_after_failure", channel: "button", segments: [{ id: "after-text", kind: "text", label: "你刚说的话", content: "失败后下一轮" }] }) });
  assert.equal(nextResponse.status, 202);
  try {
    await waitFor(async () => (await store.getProfile("failure-user"))?.jobs?.some((job) => job.turnId === "turn_failed_illustration" && job.type === "illustration" && job.status === "failed"));
  } catch (error) {
    const snapshot = await store.getProfile("failure-user");
    throw new Error(`${error instanceof Error ? error.message : error}; jobs=${JSON.stringify(snapshot?.jobs?.map((job) => ({ id: job.id, type: job.type, status: job.status, attempt: job.attempt, error: job.error })))}`);
  }
  const final = await store.getProfile("failure-user");
  assert.equal(imageAttempts, 3, "retry policy should stop at maxAttempts");
  assert.equal(final?.conversation.some((message) => message.turnId === "turn_failed_illustration" && message.role === "papo" && message.text.includes("文字回答")), true);
  assert.equal(final?.conversation.some((message) => message.turnId === "turn_after_failure" && message.role === "papo"), true);
  assert.equal(final?.jobs?.find((job) => job.turnId === "turn_failed_illustration" && job.type === "illustration")?.error?.includes("deterministic illustration failure"), true);
} finally {
  worker.stop();
  server.close();
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

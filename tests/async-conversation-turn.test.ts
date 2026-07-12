import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import type { ModelProvider } from "../src/core/provider";
import { MemoryProfileStore } from "../src/server/store";
import type { PersistentTurnWorker } from "../src/server/turn-worker";

const store = new MemoryProfileStore();
await store.createProfile({ userId: "async-turn-user", creatureName: "Papo" });

let releaseAction!: () => void;
const actionGate = new Promise<void>((resolve) => { releaseAction = resolve; });
let actionCalls = 0;
let imageCalls = 0;
const provider: ModelProvider = {
  kind: "generic",
  name: "Deferred test provider",
  available: true,
  usesRealModel: true,
  async generate() { return ""; },
  async generateJson(prompt) {
    if (prompt.includes("注意决策脑")) {
      const segmentId = [...prompt.matchAll(/"segmentId":"([^"]+)"/g)].at(-1)?.[1];
      return { selected: [{ segmentId, whySelected: "需要回答", noticed: "用户发来消息", userMeaning: "希望得到回答", relatedMemoryIds: [], tags: [] }], ignored: [] };
    }
    if (prompt.includes("行动选择脑")) {
      actionCalls += 1;
      if (actionCalls === 1) await actionGate;
      const events = JSON.parse(prompt.match(/events:\n(\[[\s\S]*?\])\n/)?.[1] ?? "[]") as Array<{ id: string; content: string }>;
      const composite = events[0]?.content.includes("插画");
      return { decisions: [{
        eventId: events[0].id,
        action: "respond",
        noticed: "用户希望快速回复",
        reason: "先回答",
        stateDeltas: {},
        shouldCreateEpisode: composite,
        shouldConsiderMemory: false,
        shouldReply: true,
        reply: composite ? "文字回答先给你，插画我继续画。" : "第二条也收到了。",
        ...(composite ? { actions: [{ action: "generate_illustration", reason: "用户明确要求", actionResult: { kind: "illustration_draft", title: "异步小画", prompt: "画一张温暖小画", caption: "小画完成了" } }] } : {})
      }] };
    }
    throw new Error(`Unexpected prompt: ${prompt.slice(0, 40)}`);
  },
  async summarizeImage() { return "桌上有一杯咖啡"; },
  async observeAudio() { return "用户说今天很开心"; },
  async generateImage() {
    imageCalls += 1;
    return { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", mime: "image/png", model: "fake-image" };
  }
};

const app = createApp({ store, provider, turns: { intervalMs: 10 } });
const worker = app.locals.turnWorker as PersistentTurnWorker;
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");
const base = `http://127.0.0.1:${address.port}`;

async function accept(turnId: string, text: string) {
  const response = await fetch(`${base}/api/profiles/async-turn-user/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turnId, requestId: turnId, channel: "button", segments: [{ id: `${turnId}-text`, kind: "text", label: "你刚说的话", content: text }] })
  });
  return { response, body: await response.json() };
}

try {
  const first = await accept("turn_async_first", "请回答并制作插画");
  assert.equal(first.response.status, 202);
  assert.equal(first.body.profile.conversation.some((message: { turnId?: string; text: string }) => message.turnId === "turn_async_first" && message.text.includes("插画")), true);
  assert.equal(first.body.profile.jobs.find((job: { type: string }) => job.type === "cognition").status, "queued");

  const duplicate = await accept("turn_async_first", "请回答并制作插画");
  assert.equal(duplicate.body.duplicate, true);
  assert.equal((await store.getProfile("async-turn-user"))?.turns?.filter((turn) => turn.id === "turn_async_first").length, 1);

  const second = await accept("turn_async_second", "这是第二条");
  assert.equal(second.response.status, 202, "second turn must be accepted while first cognition is blocked");
  assert.equal((await store.getProfile("async-turn-user"))?.conversation.filter((message) => message.role === "user").length, 2);
  await store.updateProfile("async-turn-user", (profile) => {
    profile.conversation.unshift({
      id: "external-message-during-cognition",
      at: new Date().toISOString(),
      role: "world",
      channel: "curious",
      text: "认知运行期间独立写入",
      relatedMemoryIds: []
    });
    while (profile.conversation.length < 80) profile.conversation.push({ id: `history-${profile.conversation.length}`, at: "2025-01-01T00:00:00.000Z", role: "world", channel: "curious", text: "历史消息", relatedMemoryIds: [] });
  });

  releaseAction();
  await waitFor(async () => (await store.getProfile("async-turn-user"))?.jobs?.every((job) => job.status === "completed") ?? false);
  const final = await store.getProfile("async-turn-user");
  assert.equal(final?.conversation.some((message) => message.turnId === "turn_async_first" && message.role === "papo" && message.text.includes("文字回答")), true);
  assert.equal(final?.conversation.some((message) => message.turnId === "turn_async_first" && message.role === "papo" && message.attachments?.some((attachment) => attachment.kind === "image")), true);
  assert.equal(final?.conversation.some((message) => message.turnId === "turn_async_second" && message.role === "papo"), true);
  assert.equal(imageCalls, 1);
  assert.equal(final?.conversation.some((message) => message.id === "external-message-during-cognition"), true, "owned cognition commit must preserve concurrent records");
  assert.equal(final?.conversation.some((message) => message.turnId === "turn_async_first" && message.role === "papo"), true, "new reply must survive a full conversation retention window");
  assert.deepEqual(final?.conversation.find((message) => message.jobId === "turn_async_first-cognition")?.cognitionTrace?.eventDecisions?.[0]?.backgroundActions?.map((action) => action.action), ["generate_illustration"]);
  const illustrationJob = final?.jobs?.find((job) => job.turnId === "turn_async_first" && job.type === "illustration");
  assert.equal(illustrationJob?.result?.memoryDecision, "skipped_no_new_fact");
  assert.equal(final?.episodes.find((episode) => episode.id === illustrationJob?.episodeId)?.attachments?.some((attachment) => attachment.jobId === illustrationJob?.id && attachment.turnId === "turn_async_first"), true, "generated attachment should be traceable from the source episode without creating duplicate memory");
  assert.equal(new Set(final?.conversation.map((message) => message.id)).size, final?.conversation.length);
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
  throw new Error("timed out waiting for async conversation jobs");
}

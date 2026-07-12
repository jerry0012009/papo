import assert from "node:assert/strict";
import test from "node:test";
import { runButtonHarness } from "../src/core/harness";
import { createCreatureProfile } from "../src/core/profile";
import { createModelProvider, isProviderRefusalText, ModelProviderRefusalError, type ModelProvider } from "../src/core/provider";
import { createApp } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";
import type { PersistentTurnWorker } from "../src/server/turn-worker";

const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const VIDEO = "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQ==";
const REQUEST = "之前有一张和 Papo 踢足球的动作卡。我今年32岁，旧卡画得太低龄，人物看起来像小男孩，请调整或做一张新的。";

test("provider refusal text is classified separately from malformed JSON", () => {
  assert.equal(isProviderRefusalText('The request was rejected because it was considered high risk'), true);
  assert.equal(isProviderRefusalText('{"decisions":[]}'), false);
});

test("provider classifies refusal fields and non-2xx refusal bodies before JSON parsing", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { refusal: "provider policy declined" } }] }), { status: 200 })) as typeof fetch;
    const provider = createModelProvider({ NODE_ENV: "test", PAPO_PROVIDER: "generic", OPENAI_API_KEY: "test", PAPO_TEXT_FALLBACK_PROVIDER: "none" } as NodeJS.ProcessEnv);
    await assert.rejects(provider.generateJson("test"), ModelProviderRefusalError);

    globalThis.fetch = (async () => new Response("The request was rejected because it was considered high risk", { status: 400 })) as typeof fetch;
    await assert.rejects(provider.generateJson("test"), ModelProviderRefusalError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a terminal model refusal preserves direct input and degrades without worker-style blind retries", async () => {
  const profile = createCreatureProfile({ userId: "refusal-fallback", creatureName: "Papo" });
  let calls = 0;
  const provider = providerBase(async () => {
    calls += 1;
    throw new ModelProviderRefusalError("safety");
  });
  const result = await runButtonHarness(profile, REQUEST, provider);
  assert.equal(calls, 5, "attention and action each get a compact recovery attempt; memory fails closed once without a worker retry loop");
  assert.equal(result.events.length, 1);
  assert.match(result.response, /已经收到并保留/);
  assert.doesNotMatch(result.response, /invalid JSON|high risk|安全策略/);
  assert.equal(result.events[0].triggerContent, REQUEST, "the durable user content is never rewritten");
});

test("compact recovery lets the text model author an age-accurate replacement card atomically", async () => {
  const store = new MemoryProfileStore();
  const userId = "revision-recovery";
  await store.createProfile({ userId, creatureName: "Papo", petKind: "british-shorthair" });
  const oldCardId = "vid_old_football_card";
  await store.updateProfile(userId, (profile) => {
    profile.actionCards = [{
      id: oldCardId,
      createdAt: "2026-06-01T10:00:00.000Z",
      title: "一起踢足球",
      caption: "旧动作卡",
      prompt: "legacy prompt",
      durationSeconds: 8,
      cover: { id: "img_old_cover", kind: "image", mime: "image/png", label: "旧封面", url: "/missing-old-cover.png" },
      video: { id: oldCardId, kind: "video", mime: "video/mp4", label: "旧视频", url: "/missing-old-video.mp4" },
      sourceIds: ["legacy"],
      providerKind: "generic",
      providerName: "legacy"
    }];
  });

  let attentionPrimary = 0;
  let actionPrimary = 0;
  const recoveryPrompts: string[] = [];
  let keyframePrompt = "";
  let videoPrompt = "";
  const creativePrompt = "Papo and the 32-year-old user share a lively football pass on a neighborhood pitch, with grounded adult proportions, a refined ink-and-gouache sports editorial treatment, and a stable wide camera.";
  const provider: ModelProvider = {
    ...providerBase(async (prompt) => {
      if (prompt.includes("注意决策脑")) {
        attentionPrimary += 1;
        throw new ModelProviderRefusalError("safety");
      }
      if (prompt.includes("行动选择脑")) {
        actionPrimary += 1;
        throw new ModelProviderRefusalError("safety");
      }
      throw new Error(`unexpected primary prompt: ${prompt.slice(0, 80)}`);
    }),
    async generateJsonFallback(prompt) {
      recoveryPrompts.push(prompt);
      assert.doesNotMatch(prompt, /小男孩|未成年人|高风险|不得生成|安全重试/);
      if (prompt.includes("attention stage")) {
        const candidates = JSON.parse(prompt.match(/Candidates:\n([\s\S]+)$/)?.[1] ?? "[]") as Array<{ segmentId: string }>;
        return { shouldAttend: true, selected: [{ segmentId: candidates[0].segmentId, whySelected: "用户提出了明确的媒体修订请求", noticed: "用户希望旧动作卡符合自己的真实成年形象", userMeaning: "保留原活动并重做成年形象", addressedToPapo: true, expectsResponse: true, relatedMemoryIds: [], tags: ["动作卡修订"] }], ignored: [] };
      }
      if (prompt.includes("action-planning stage")) {
        const events = JSON.parse(prompt.match(/Events:\n([\s\S]+)$/)?.[1] ?? "[]") as Array<{ id: string }>;
        return { decisions: [{ eventId: events[0].id, action: "generate_action_card", reason: "用户明确要求修订旧动作卡", stateDeltas: {}, shouldCreateEpisode: true, shouldConsiderMemory: false, shouldReply: true, reply: "我会按你真实的成年形象重新做这张动作卡。", actionResult: { kind: "action_card_draft", title: "和 Papo 一起踢球", prompt: creativePrompt, caption: "这次是更符合你的足球时光。", style: "mature sports editorial illustration", durationSeconds: 8, stateId: "ball_ready", statusText: "Papo 正和你在球场上踢球。", replacesActionCardId: oldCardId, sourceIds: [events[0].id] } }] };
      }
      throw new Error(`unexpected recovery prompt: ${prompt.slice(0, 80)}`);
    },
    async generateImage(prompt) {
      keyframePrompt = prompt;
      return { dataUrl: IMAGE, mime: "image/png", model: "fake-image" };
    },
    async generateVideo(prompt) {
      videoPrompt = prompt;
      return { dataUrl: VIDEO, mime: "video/mp4", model: "fake-video" };
    }
  };

  const app = createApp({ store, provider, turns: { intervalMs: 10 } });
  const worker = app.locals.turnWorker as PersistentTurnWorker;
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind test server");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles/${userId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId: "turn_revision", requestId: "request_revision", channel: "button", segments: [{ id: "segment_revision", kind: "text", label: "你刚说的话", content: REQUEST }] })
    });
    assert.equal(response.status, 202);
    const accepted = await response.json() as { profile: { conversation: Array<{ role: string; text: string }> } };
    assert.equal(accepted.profile.conversation.some((message) => message.role === "user" && message.text === REQUEST), true);

    const final = await waitFor(async () => {
      const profile = await store.getProfile(userId);
      return profile?.actionCards?.some((card) => card.replacementForActionCardId === oldCardId) ? profile : undefined;
    });
    const oldCard = final.actionCards?.find((card) => card.id === oldCardId);
    const newCard = final.actionCards?.find((card) => card.replacementForActionCardId === oldCardId);
    assert.equal(attentionPrimary, 1);
    assert.equal(actionPrimary, 1);
    assert.equal(recoveryPrompts.length, 2);
    assert.ok(newCard);
    const actionJob = final.jobs?.find((job) => job.type === "action_card" && job.turnId === "turn_revision");
    assert.equal(actionJob?.maxAttempts, 1, "billable video generation must not retry automatically");
    assert.equal(actionJob?.retryable, false);
    assert.equal(oldCard?.disabled, true);
    assert.equal(oldCard?.replacedByActionCardId, newCard?.id);
    assert.ok(keyframePrompt.includes(creativePrompt));
    assert.ok(videoPrompt.includes(creativePrompt.slice(0, -1)));
    assert.match(keyframePrompt, /32 years old and an adult/);
    assert.match(videoPrompt, /32 years old and an adult/);
    assert.equal(final.conversation.some((message) => message.role === "user" && message.text === REQUEST), true);
    assert.equal(final.jobs?.filter((job) => job.turnId === "turn_revision").every((job) => job.attempt === 1), true);
  } finally {
    worker.stop();
    server.close();
  }
});

test("a failed replacement job leaves the existing card active", async () => {
  const store = new MemoryProfileStore();
  const userId = "revision-failure";
  const oldCardId = "vid_active_old_card";
  await store.createProfile({ userId, creatureName: "Papo" });
  await store.updateProfile(userId, (profile) => {
    profile.actionCards = [{ id: oldCardId, createdAt: "2026-06-01T10:00:00.000Z", title: "旧卡", prompt: "legacy", durationSeconds: 8, video: { id: oldCardId, kind: "video", mime: "video/mp4", label: "旧卡", url: "/old.mp4" }, sourceIds: [], providerKind: "generic", providerName: "legacy" }];
  });
  const provider: ModelProvider = {
    ...providerBase(async (prompt) => {
      if (prompt.includes("注意决策脑")) {
        const segmentId = [...prompt.matchAll(/"segmentId":"([^"]+)"/g)].at(-1)?.[1];
        return { shouldAttend: true, selected: [{ segmentId, whySelected: "明确请求", noticed: "修订旧卡", userMeaning: "重做动作卡", addressedToPapo: true, expectsResponse: true, relatedMemoryIds: [], tags: [] }], ignored: [] };
      }
      if (prompt.includes("行动选择脑")) {
        const events = JSON.parse(prompt.match(/events:\n(\[[\s\S]*?\])\n/)?.[1] ?? "[]") as Array<{ id: string }>;
        return { decisions: [{ eventId: events[0].id, action: "generate_action_card", reason: "修订", stateDeltas: {}, shouldCreateEpisode: false, shouldConsiderMemory: false, shouldReply: true, reply: "我来重做。", actionResult: { kind: "action_card_draft", title: "新卡", prompt: "creative prompt from the action model", stateId: "ball_ready", statusText: "Papo 正在球场上活动。", replacesActionCardId: oldCardId } }] };
      }
      throw new Error("unexpected prompt");
    }),
    async generateImage() { return { dataUrl: IMAGE, mime: "image/png" }; },
    async generateVideo() { throw new Error("deterministic video failure"); }
  };
  const app = createApp({ store, provider, turns: { intervalMs: 10 } });
  const worker = app.locals.turnWorker as PersistentTurnWorker;
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind test server");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles/${userId}/turns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ turnId: "turn_failed_revision", requestId: "request_failed_revision", channel: "button", segments: [{ id: "segment_failed_revision", kind: "text", label: "输入", content: "请重做旧动作卡，我今年32岁，人物年龄画得不对。" }] }) });
    assert.equal(response.status, 202);
    const final = await waitFor(async () => {
      const profile = await store.getProfile(userId);
      return profile?.jobs?.some((job) => job.type === "action_card" && job.status === "failed") ? profile : undefined;
    });
    const oldCard = final.actionCards?.find((card) => card.id === oldCardId);
    assert.equal(oldCard?.disabled, false);
    assert.equal(oldCard?.displayMode, "dynamic");
    assert.equal(oldCard?.replacedByActionCardId, undefined);
    assert.equal(final.actionCards?.length, 1);
  } finally {
    worker.stop();
    server.close();
  }
});

test("public profiles keep diagnostic errors private for both old and new failed jobs", async () => {
  const store = new MemoryProfileStore();
  const userId = "public-error-boundary";
  await store.createProfile({ userId, creatureName: "Papo" });
  await store.updateProfile(userId, (profile) => {
    profile.jobs = [{
      id: "legacy-refusal-job",
      turnId: "legacy-refusal-turn",
      requestId: "legacy-refusal-request",
      type: "cognition",
      stage: "cognition",
      status: "failed",
      attempt: 3,
      maxAttempts: 3,
      retryable: true,
      createdAt: "2026-07-12T10:00:00.000Z",
      updatedAt: "2026-07-12T10:01:00.000Z",
      sourceIds: [],
      error: 'Model provider returned invalid JSON content (prefix="considered high risk")',
      attemptHistory: [{ attempt: 3, startedAt: "2026-07-12T10:00:00.000Z", completedAt: "2026-07-12T10:01:00.000Z", error: "raw provider secret diagnostic" }]
    }];
    profile.turns = [{ id: "legacy-refusal-turn", requestId: "legacy-refusal-request", channel: "button", status: "failed", createdAt: "2026-07-12T10:00:00.000Z", updatedAt: "2026-07-12T10:01:00.000Z", inputMessageIds: [], jobIds: ["legacy-refusal-job"], segments: [], error: "raw provider secret diagnostic" }];
  });
  const app = createApp({ store, provider: providerBase(async () => undefined) });
  const worker = app.locals.turnWorker as PersistentTurnWorker;
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind test server");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles/${userId}`);
    const payload = await response.json() as { profile: { jobs: Array<{ error?: string; attemptHistory?: Array<{ error?: string }> }>; turns: Array<{ error?: string }> } };
    assert.equal(response.status, 200);
    assert.match(payload.profile.jobs[0].error ?? "", /原消息已保留/);
    assert.doesNotMatch(JSON.stringify(payload), /invalid JSON|high risk|secret diagnostic/);
    assert.equal(payload.profile.turns[0].error, payload.profile.jobs[0].error);
    const stored = await store.getProfile(userId);
    assert.match(stored?.jobs?.[0].error ?? "", /invalid JSON/, "internal diagnostics remain durable");
  } finally {
    worker.stop();
    server.close();
  }
});

function providerBase(generateJson: ModelProvider["generateJson"]): ModelProvider {
  return {
    kind: "generic",
    name: "Deterministic refusal provider",
    available: true,
    usesRealModel: true,
    async generate() { return ""; },
    generateJson,
    async summarizeImage() { return ""; },
    async observeAudio() { return ""; },
    async generateImage() { throw new Error("not used"); }
  };
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 6_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for replacement card");
}

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelProvider } from "../src/core/provider";
import { createApp } from "../src/server/app";
import { JsonDeviceAuthService } from "../src/server/device-auth";
import { MemoryProfileStore } from "../src/server/store";

const store = new MemoryProfileStore();
const nativeProfile = await store.createProfile({ userId: "native-listening-user", creatureName: "Papo" });
nativeProfile.password = "native-secret";
await store.saveProfile(nativeProfile);
await store.createProfile({ userId: "passwordless-native-user", creatureName: "Papo" });
let audioCalls = 0;
let imageCalls = 0;
let releaseAudio!: () => void;
const audioGate = new Promise<void>((resolve) => {
  releaseAudio = resolve;
});

const provider: ModelProvider = {
  kind: "openrouter",
  name: "Native listening provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-text", audioModel: "fake-audio", visionModel: "fake-vision" },
  async generate() {
    return "";
  },
  async generateJson(prompt) {
    if (prompt.includes("连续生活事件归属脑")) {
      const segmentIds = [...new Set([...prompt.matchAll(/"segmentId":"([^"]+)"/g)].map((match) => match[1]))];
      return {
        assignments: segmentIds.map((segmentId, index) => ({
          segmentId, role: "scene_evidence", transition: index ? "continue" : "start", eventKind: "activity", eventTitle: "桌边工作",
          observationSummary: "用户在桌边，声音显示工作已经结束", updatedEventSummary: "用户在桌边，声音显示工作已经结束", importantFacts: ["工作已经结束"], reason: "同一时刻的画面与声音"
        })),
        currentContext: { activity: "桌边工作结束", rollingSummary: "用户在桌边，声音显示工作已经结束", importantContent: ["工作已经结束"], recentUserNotes: [] }
      };
    }
    if (!prompt.includes("注意决策脑")) throw new Error("action model should not run when all native segments are ignored");
    const segmentIds = [...new Set([...prompt.matchAll(/"segmentId":"([^"]+)"/g)].map((match) => match[1]))];
    assert.ok(segmentIds.length >= 2);
    return {
      shouldAttend: true,
      selected: [],
      ignored: segmentIds.map((segmentId) => ({ segmentId, whyIgnored: "测试只验证原生感知批次持久化。" })),
      creatureReport: "这批次已感知，不需要外显回复。"
    };
  },
  async summarizeImage() {
    imageCalls += 1;
    return "前置摄像头画面里，一个人坐在桌边。";
  },
  async observeAudio() {
    audioCalls += 1;
    if (audioCalls === 1) {
      await audioGate;
      return "ERROR_AUDIO_UNREADABLE";
    }
    return "能听见有人说今天工作已经结束。";
  },
  async generateImage() {
    return {
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      mime: "image/png",
      model: "fake-image"
    };
  }
};

const tempDir = await mkdtemp(path.join(tmpdir(), "papo-native-listening-"));
const deviceAuth = new JsonDeviceAuthService(path.join(tempDir, "device-sessions.json"));
const app = createApp({
  store,
  provider,
  deviceAuth,
  nativeIngest: { directory: path.join(tempDir, "native-ingest"), intervalMs: 10, autoStart: false, audioDirectory: path.join(tempDir, "transient-audio"), audioRetentionMs: 24 * 60 * 60_000 },
  proactive: { enabled: false },
  hermes: { enabled: false }
});
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");

try {
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const sessionResponse = await fetch(`${baseUrl}/api/profiles/native-listening-user/device-sessions`, {
    method: "POST",
    headers: { "x-papo-password": "native-secret" }
  });
  const session = await sessionResponse.json() as { token: string };
  assert.equal(sessionResponse.status, 201);
  assert.ok(session.token.length >= 32);
  const url = `${baseUrl}/api/profiles/native-listening-user/listening/native-batch`;
  const body = {
    batchId: "native-1783700000000-001",
    companionSessionId: "native-1783700000000",
    observedAt: "2026-07-10T18:30:30.000Z",
    cameraFacing: "front",
    audioDataUrl: `data:audio/mp4;base64,${Buffer.from("mock m4a data".repeat(8)).toString("base64")}`,
    imageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
  };
  const requestBatch = () => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
    body: JSON.stringify(body)
  });
  const [first, concurrentRetry] = await Promise.race([
    Promise.all([requestBatch(), requestBatch()]),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("ingest waited for model processing")), 1_000))
  ]);
  const [firstPayload, concurrentRetryPayload] = await Promise.all([first.json(), concurrentRetry.json()]);
  assert.equal(first.status, 202, JSON.stringify(firstPayload));
  assert.equal(concurrentRetry.status, 202, JSON.stringify(concurrentRetryPayload));
  assert.equal([firstPayload, concurrentRetryPayload].filter((payload) => payload.duplicate === true).length, 1);
  releaseAudio();

  await waitFor(async () => {
    const current = await store.getProfile("native-listening-user");
    return current?.turns?.find((turn) => turn.id.includes(body.batchId))?.status === "completed";
  });

  const current = await store.getProfile("native-listening-user");
  assert.ok(current);
  const nativeInputs = current.conversation.filter((message) => message.batchId === body.batchId);
  assert.equal(nativeInputs.length, 2);
  assert.deepEqual(new Set(nativeInputs.map((message) => message.sourceId)), new Set([`${body.batchId}:audio`, `${body.batchId}:image`]));
  assert.equal(nativeInputs.every((message) => message.attachments?.length === 0), true, "periodic camera frames must not persist raw images");
  const audioInput = nativeInputs.find((message) => message.modality === "audio_observation");
  assert.match(audioInput?.sensingTrace?.retainedAudio?.id ?? "", /^tmpaud_/);
  assert.equal(audioInput?.sensingTrace?.attempts, 2, "unreadable native audio should retry once before settling");
  assert.equal(audioInput?.cognitionTrace?.modelRuns.some((run) => run.stage === "attention"), true, "silent/ignored native turns must retain cognition trace on their input");
  assert.equal(current.companionSessions?.length, 1);
  assert.equal(current.companionSessions?.[0].id, body.companionSessionId);
  assert.equal(current.companionSessions?.[0].events?.[0].sourceSegmentIds.length, 2);

  const retry = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
    body: JSON.stringify(body)
  });
  const retryPayload = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retryPayload.duplicate, true);
  assert.equal(audioCalls, 2);
  assert.equal(imageCalls, 1);

  const unauthorized = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer invalid" },
    body: JSON.stringify({ ...body, batchId: "native-1783700000000-002" })
  });
  assert.equal(unauthorized.status, 401);
  const passwordlessUnauthorized = await fetch(`${baseUrl}/api/profiles/passwordless-native-user/listening/native-batch`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer invalid" },
    body: JSON.stringify({ ...body, batchId: "native-1783700000000-003" })
  });
  assert.equal(passwordlessUnauthorized.status, 401, "native ingest must never fall back to passwordless profile access");
  console.log(JSON.stringify({ ok: true, batchId: body.batchId }, null, 2));
} finally {
  app.locals.transientAudioStore.stop();
  server.close();
  await rm(tempDir, { recursive: true, force: true });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000) {
  const startedAt = Date.now();
  while (!await predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error("timed out waiting for native ingest processing");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

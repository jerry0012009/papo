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
let audioCalls = 0;
let imageCalls = 0;

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
    await new Promise((resolve) => setTimeout(resolve, 25));
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
const app = createApp({ store, provider, deviceAuth, proactive: { enabled: false }, hermes: { enabled: false } });
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
  const [first, concurrentRetry] = await Promise.all([requestBatch(), requestBatch()]);
  const [firstPayload, concurrentRetryPayload] = await Promise.all([first.json(), concurrentRetry.json()]);
  assert.equal(first.status, 200, JSON.stringify(firstPayload));
  assert.equal(concurrentRetry.status, 200, JSON.stringify(concurrentRetryPayload));
  assert.equal([firstPayload, concurrentRetryPayload].filter((payload) => payload.duplicate === true).length, 1);
  const processedPayload = [firstPayload, concurrentRetryPayload].find((payload) => payload.duplicate !== true);
  assert.ok(processedPayload);
  assert.deepEqual(processedPayload.sensing.map((item: { status: string }) => item.status), ["content", "content"]);

  const current = await store.getProfile("native-listening-user");
  assert.ok(current);
  const nativeInputs = current.conversation.filter((message) => message.batchId === body.batchId);
  assert.equal(nativeInputs.length, 2);
  assert.deepEqual(new Set(nativeInputs.map((message) => message.sourceId)), new Set([`${body.batchId}:audio`, `${body.batchId}:image`]));
  assert.equal(nativeInputs.every((message) => message.attachments?.length === 0), true, "periodic camera frames must not persist raw images");

  const retry = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session.token}` },
    body: JSON.stringify(body)
  });
  const retryPayload = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(retryPayload.duplicate, true);
  assert.equal(audioCalls, 1);
  assert.equal(imageCalls, 1);

  const unauthorized = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer invalid" },
    body: JSON.stringify({ ...body, batchId: "native-1783700000000-002" })
  });
  assert.equal(unauthorized.status, 401);
  console.log(JSON.stringify({ ok: true, batchId: body.batchId }, null, 2));
} finally {
  server.close();
  await rm(tempDir, { recursive: true, force: true });
}

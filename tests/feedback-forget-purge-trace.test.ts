import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";
import type { ModelProvider } from "../src/core/provider";

const store = new MemoryProfileStore();
const profile = await store.createProfile({ userId: "forget-purge-user", creatureName: "Papo" });
profile.longTermMemories.unshift({
  id: "ltm_drop",
  createdAt: "2026-07-07T08:00:00.000Z",
  kind: "habit",
  text: "用户曾经提到游泳馆人太多让自己不太喜欢。",
  sourceEpisodeId: "episode_swim",
  consolidatedBecause: "用户分享过这段运动体验。",
  weight: 0,
  tags: ["游泳"]
});
await store.saveProfile(profile);

let modelCalls = 0;
const provider: ModelProvider = {
  kind: "mimo",
  name: "Forget purge provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-feedback" },
  async generate() {
    return "";
  },
  async generateJson(prompt) {
    modelCalls += 1;
    throw new Error(`forget button should not invoke the model: ${prompt.slice(0, 20)}`);
  },
  async summarizeImage() {
    return "";
  },
  async observeAudio() {
    return "";
  },
  async generateImage() {
    return {
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      mime: "image/png",
      model: "fake-image"
    };
  }
};

const app = createApp({ store, provider });
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");

try {
  const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles/forget-purge-user/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "forget", targetId: "ltm_drop" })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(modelCalls, 0, "explicit forget should be a deterministic storage operation");

  const current = await store.getProfile("forget-purge-user");
  assert.equal(current?.longTermMemories.some((memory) => memory.id === "ltm_drop"), false);
  assert.equal(current?.feedbackHistory[0]?.targetSnapshot?.text?.includes("游泳馆人太多"), true);
  assert.equal(current?.conversation.some((message) => message.role === "user" && message.channel === "feedback"), false);
  const confirmation = current?.conversation.find((message) => message.role === "papo" && message.channel === "feedback");
  assert.equal(confirmation?.text, "已忘记 1 条内容 ✓");
  assert.equal(current?.feedbackHistory[0]?.storagePurged, true);
  assert.ok(current?.feedbackHistory[0]?.forgetBatchId);
  console.log(JSON.stringify({ ok: true }, null, 2));
} finally {
  server.close();
}

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

let promptSawDeletedTarget = false;
let promptWarnedUnavailableTarget = false;
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
    promptSawDeletedTarget = prompt.includes("游泳馆人太多") && prompt.includes("unavailableAfterStorageOperation");
    promptWarnedUnavailableTarget = prompt.includes("不要使用 update_memory") && prompt.includes("当前无可修改对象");
    return {
      responseAction: "quiet",
      learningNote: "用户再次要求放下这条已经降权的长期记忆，Papo 应该尊重这次彻底删除。",
      effect: "这条长期记忆已经从存储中删除，反馈反思记录了用户的放下意图。",
      memoryOperation: { type: "update_memory", text: "这条已经被删除的记忆不应再保留。", kind: "habit" },
      trace: ["saw pre-delete target snapshot", "model returned impossible update"]
    };
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
  assert.equal(promptSawDeletedTarget, true, "feedback model should see the pre-delete target snapshot");
  assert.equal(promptWarnedUnavailableTarget, true, "feedback prompt should tell the model not to update unavailable targets");

  const current = await store.getProfile("forget-purge-user");
  assert.equal(current?.longTermMemories.some((memory) => memory.id === "ltm_drop"), false);
  assert.equal(current?.feedbackHistory[0]?.targetSnapshot?.text?.includes("游泳馆人太多"), true);
  assert.equal(current?.conversation.some((message) => message.role === "papo" && message.channel === "feedback"), false);

  const feedbackInput = current?.conversation.find((message) => message.role === "user" && message.channel === "feedback");
  assert.equal(feedbackInput?.cognitionTrace?.feedbackDecision?.memoryChanges[0]?.operation, "purged");
  assert.equal(feedbackInput?.cognitionTrace?.feedbackDecision?.effect.includes("删除"), true);
  console.log(JSON.stringify({ ok: true }, null, 2));
} finally {
  server.close();
}

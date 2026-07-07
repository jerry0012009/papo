import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";
import type { ModelProvider } from "../src/core/provider";

const store = new MemoryProfileStore();
const profile = await store.createProfile({ userId: "feedback-weight-user", creatureName: "Papo" });
profile.longTermMemories.unshift({
  id: "ltm_snack",
  createdAt: "2026-07-07T08:00:00.000Z",
  kind: "user_preference",
  text: "用户喜欢旺旺仙贝。",
  sourceEpisodeId: "episode_snack",
  consolidatedBecause: "用户主动分享了自己的零食偏好。",
  weight: 42,
  tags: ["零食"]
});
await store.saveProfile(profile);

let promptIncludedImportantKind = false;
const provider: ModelProvider = {
  kind: "mimo",
  name: "Feedback weight provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-feedback-weight" },
  async generate() {
    return "";
  },
  async generateJson(prompt) {
    promptIncludedImportantKind = prompt.includes('"kind":"important"') && prompt.includes("用户喜欢旺旺仙贝");
    return {
      responseAction: "quiet",
      learningNote: "用户把这条记忆标为重要，但这次模型只记录反馈意图，不改变具体存储。",
      effect: "只理解了这次重要反馈，未改变记忆权重、内容或状态。",
      memoryOperation: { type: "none" }
    };
  },
  async summarizeImage() {
    return "";
  },
  async observeAudio() {
    return "";
  }
};

const app = createApp({ store, provider });
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");

try {
  const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles/feedback-weight-user/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "important", targetId: "ltm_snack" })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(promptIncludedImportantKind, true, "feedback model should receive the button kind and target memory");

  const current = await store.getProfile("feedback-weight-user");
  const memory = current?.longTermMemories.find((item) => item.id === "ltm_snack");
  assert.equal(memory?.weight, 42, "important button must not change weight unless the model returns a concrete change");
  assert.equal(memory?.text, "用户喜欢旺旺仙贝。");
  assert.equal(current?.conversation.some((message) => message.role === "papo" && message.channel === "feedback"), false);

  const feedbackInput = current?.conversation.find((message) => message.role === "user" && message.channel === "feedback");
  assert.equal(feedbackInput?.text, "重要");
  assert.equal(feedbackInput?.cognitionTrace?.feedbackDecision?.memoryChanges[0]?.operation, "unchanged");
  assert.equal(feedbackInput?.cognitionTrace?.feedbackDecision?.memoryChanges[0]?.beforeWeight, 42);
  assert.equal(feedbackInput?.cognitionTrace?.feedbackDecision?.memoryChanges[0]?.afterWeight, 42);
  assert.equal(feedbackInput?.cognitionTrace?.modelRuns.some((run) => run.stage === "feedback" && run.status === "applied"), true);
  console.log(JSON.stringify({ ok: true }, null, 2));
} finally {
  server.close();
}

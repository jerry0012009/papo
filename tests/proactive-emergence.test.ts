import assert from "node:assert/strict";
import { runProactiveEmergenceSweep } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";
import { markProactiveUserResponse } from "../src/core/proactive";
import type { ModelProvider } from "../src/core/provider";

const store = new MemoryProfileStore();
const profile = await store.createProfile({
  userId: "proactive-user",
  creatureName: "Papo"
});
profile.longTermMemories.unshift({
  id: "ltm_swim",
  createdAt: "2026-07-07T00:00:00.000Z",
  kind: "habit",
  text: "用户最近喜欢晚上去游泳，但不喜欢泳池人太多。",
  sourceEpisodeId: "episode_swim",
  consolidatedBecause: "用户明确分享了近期游泳习惯和感受。",
  weight: 82,
  tags: ["游泳"]
});
profile.proactive.nextCheckAt = "2026-07-07T10:00:00.000Z";
await store.saveProfile(profile);

const provider: ModelProvider = {
  kind: "mimo",
  name: "Fake real-shaped provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-emergence" },
  async generate() {
    return "";
  },
  async generateJson() {
    return {
      shouldEmerge: true,
      memoryId: "ltm_swim",
      driveSource: "memory_resonance",
      whyNow: "这条游泳习惯和最近的陪伴状态自然相关，适合轻轻提一下。",
      message: "我刚想起你最近晚上会去游泳。要是泳池人多，就慢慢来，不急着和人群挤在一起。",
      proactiveLevel: "gentle",
      trace: ["selected memory"]
    };
  },
  async summarizeImage() {
    return "";
  },
  async observeAudio() {
    return "";
  }
};

const first = await runProactiveEmergenceSweep(store, provider, "2026-07-07T10:00:00.000Z");
let current = await store.getProfile("proactive-user");
assert.deepEqual(first, { checked: 1, active: 1, quiet: 0, deferred: 0 });
assert.equal(current?.proactive.pendingCount, 1);
assert.equal(current?.proactive.nextCheckAt, "2026-07-07T11:00:00.000Z");
assert.equal(current?.conversation.filter((message) => message.channel === "emergence").length, 1);

const skipped = await runProactiveEmergenceSweep(store, provider, "2026-07-07T10:30:00.000Z");
current = await store.getProfile("proactive-user");
assert.deepEqual(skipped, { checked: 0, active: 0, quiet: 0, deferred: 0 });
assert.equal(current?.conversation.filter((message) => message.channel === "emergence").length, 1);

await runProactiveEmergenceSweep(store, provider, "2026-07-07T11:00:00.000Z");
current = await store.getProfile("proactive-user");
assert.equal(current?.proactive.pendingCount, 2);
assert.equal(current?.proactive.nextCheckAt, "2026-07-07T23:00:00.000Z");

await runProactiveEmergenceSweep(store, provider, "2026-07-07T23:00:00.000Z");
current = await store.getProfile("proactive-user");
assert.equal(current?.proactive.pendingCount, 3);
assert.equal(current?.proactive.paused, true);
assert.equal(current?.proactive.nextCheckAt, undefined);
assert.equal(current?.conversation.filter((message) => message.channel === "emergence").length, 3);

markProactiveUserResponse(current!, "2026-07-08T00:00:00.000Z");
assert.equal(current?.proactive.pendingCount, 0);
assert.equal(current?.proactive.paused, false);
assert.equal(current?.proactive.nextCheckAt, "2026-07-08T00:30:00.000Z");

console.log(JSON.stringify({ ok: true }, null, 2));

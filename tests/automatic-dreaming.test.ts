import assert from "node:assert/strict";
import { runAutomaticDreamingSweep } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";
import type { ModelProvider } from "../src/core/provider";

const store = new MemoryProfileStore();
const profile = await store.createProfile({
  userId: "dreaming-user",
  creatureName: "Papo",
  now: "2026-07-07T09:00:00.000Z"
});
profile.lastUserActivityAt = "2026-07-07T09:00:00.000Z";

for (let index = 0; index < 36; index += 1) {
  profile.longTermMemories.push({
    id: `ltm_${index}`,
    createdAt: "2026-07-07T00:00:00.000Z",
    kind: "habit",
    text: `用户分享过第 ${index} 条需要长期保留的小事。`,
    sourceEpisodeId: `episode_${index}`,
    consolidatedBecause: "用户明确分享过这件事。",
    weight: 70,
    tags: ["测试"]
  });
}
await store.saveProfile(profile);

let modelCalls = 0;
const provider: ModelProvider = {
  kind: "mimo",
  name: "Fake real-shaped provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-dreaming" },
  async generate() {
    return "";
  },
  async generateJson() {
    modelCalls += 1;
    if (modelCalls === 1) {
      return {
        shouldDream: true,
        summary: "把一条过碎的长期记忆改写得更稳。",
        operations: [
          {
            type: "update_memory",
            targetId: "ltm_0",
            text: "用户分享过一批需要长期保留的小事，其中第 0 条已经被整理成更清楚的表述。",
            kind: "long_theme",
            tags: ["测试", "整理"],
            consolidatedBecause: "后台 dreaming 认为这条记忆表达过碎，适合轻微改写。",
            weight: 78,
            reason: "这条记忆仍值得保留，只需要整理表达。"
          }
        ],
        trace: ["updated one memory"]
      };
    }
    return {
      shouldDream: false,
      summary: "这次没有必要继续整理。",
      operations: [],
      trace: ["no semantic merge needed"]
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

const first = await runAutomaticDreamingSweep(store, provider, "2026-07-07T10:00:00.000Z");
let current = await store.getProfile("dreaming-user");
assert.deepEqual(first, { checked: 1, applied: 1, quiet: 0, deferred: 0 });
assert.equal(modelCalls, 1);
assert.equal(current?.longTermMemories.find((memory) => memory.id === "ltm_0")?.kind, "long_theme");
assert.equal(current?.dreamHistory.length, 1);
assert.equal(current?.dreamHistory[0]?.operations[0]?.type, "update_memory");
assert.equal(current?.conversation.length, 0);

const cooldown = await runAutomaticDreamingSweep(store, provider, "2026-07-07T11:00:00.000Z");
current = await store.getProfile("dreaming-user");
assert.deepEqual(cooldown, { checked: 0, applied: 0, quiet: 0, deferred: 0 });
assert.equal(modelCalls, 1);
assert.equal(current?.dreamHistory.length, 1);

const quiet = await runAutomaticDreamingSweep(store, provider, "2026-07-08T00:00:00.000Z");
current = await store.getProfile("dreaming-user");
assert.deepEqual(quiet, { checked: 1, applied: 0, quiet: 1, deferred: 0 });
assert.equal(modelCalls, 2);
assert.equal(current?.dreamHistory[0]?.operations.length, 0);
assert.equal(current?.dreamHistory[0]?.summary, "这次没有必要继续整理");
assert.equal(current?.conversation.length, 0);

console.log(JSON.stringify({ ok: true }, null, 2));

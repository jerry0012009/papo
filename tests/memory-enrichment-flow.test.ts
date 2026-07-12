import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";
import type { ModelProvider } from "../src/core/provider";

const store = new MemoryProfileStore();
const profile = await store.createProfile({ userId: "memory-flow-user", creatureName: "Papo" });
profile.memoryCandidates.unshift({
  id: "candidate_walk",
  createdAt: "2026-07-11T10:00:00.000Z",
  candidateText: "Jerry 喜欢在傍晚散步",
  shortTitle: "傍晚散步",
  memoryKind: "habit",
  confidence: 82,
  sourceEpisodeId: "episode_walk",
  whyConsolidate: "明确而稳定的生活偏好",
  writePolicy: "wait_feedback",
  decayPolicy: "stable",
  status: "candidate",
  tags: ["散步"]
});
await store.saveProfile(profile);

let visualRevision = 0;
const provider: ModelProvider = {
  kind: "mimo", name: "Memory flow provider", available: true, usesRealModel: true,
  async generate() { return ""; },
  async generateJson(prompt) {
    if (prompt.includes("反馈反思脑")) {
      const correction = prompt.includes("画面改成雨后街道");
      return {
        responseAction: "acknowledge",
        learningNote: correction ? "按用户反馈修订长期记忆和画面。" : "用户确认要长期留下这条记忆。",
        effect: correction ? "已修订长期记忆，后台会更新展示。" : "已把候选升级为长期记忆。",
        replyText: correction ? "好，我会把这段回忆和画面一起改准。" : "嗯，这段日常我会认真留下。",
        memoryOperation: correction ? {
          type: "update_memory", text: "Jerry 喜欢雨后在街道散步", shortTitle: "雨后散步", kind: "habit", tags: ["散步", "雨后"], weight: 88
        } : {
          type: "promote_candidate", text: "Jerry 喜欢在傍晚散步", shortTitle: "傍晚散步", kind: "habit", tags: ["散步"], weight: 84
        }
      };
    }
    if (prompt.includes("共同回忆编辑和视觉导演")) {
      visualRevision += 1;
      const revised = prompt.includes("雨后街道");
      return {
        shortTitle: revised ? "雨后散步" : "傍晚散步",
        narrative: revised ? "我记得 Jerry 喜欢在雨后沿着街道慢慢散步。" : "我记得 Jerry 喜欢在傍晚出去走一走。",
        imagePrompt: revised ? "Square hand-drawn memory of Papo and Jerry walking on a street after rain, no text." : "Square hand-drawn memory of Papo and Jerry taking an evening walk, no text.",
        visualMode: "imaginative_illustration", papoPresence: "absent", visualReason: "没有现场照片，使用克制的插画表达",
        relatedMemoryIds: [], needsClientReferences: false
      };
    }
    if (prompt.includes("Client.md 维护脑")) {
      const sourceId = prompt.match(/allowedSourceIds：\["([^"]+)"/)?.[1];
      assert.ok(sourceId);
      return {
        preferredName: "Jerry",
        facts: [{ dimension: "leisure", text: "Jerry 喜欢散步", confidence: 94, sourceIds: [sourceId] }]
      };
    }
    throw new Error(`unexpected prompt: ${prompt.slice(0, 60)}`);
  },
  async summarizeImage() { return ""; }, async observeAudio() { return ""; },
  async generateImage() {
    return { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", mime: "image/png", model: "flow-image" };
  }
};

const app = createApp({ store, provider, hermes: { enabled: false }, proactive: { enabled: false } });
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");
const base = `http://127.0.0.1:${address.port}/api/profiles/memory-flow-user`;

try {
  const remember = await fetch(`${base}/feedback`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "remember", targetId: "candidate_walk", modality: "button" })
  });
  assert.equal(remember.status, 200, await remember.text());
  const first = await waitFor(async () => {
    const current = await store.getProfile("memory-flow-user");
    const memory = current?.longTermMemories[0];
    return memory?.visualStatus === "ready" && current?.clientDocument?.preferredName === "Jerry" ? { current, memory } : undefined;
  });
  assert.equal(first.memory.text, "Jerry 喜欢在傍晚散步");
  assert.match(first.memory.narrative ?? "", /我记得 Jerry/);
  assert.equal(first.memory.visual?.generatedBy, "papo_memory");

  const correction = await fetch(`${base}/feedback`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "continue", targetId: first.memory.id, content: "标题改成雨后散步，画面改成雨后街道", modality: "text" })
  });
  assert.equal(correction.status, 200, await correction.text());
  const revised = await waitFor(async () => {
    const current = await store.getProfile("memory-flow-user");
    const memory = current?.longTermMemories.find((item) => item.id === first.memory.id);
    return visualRevision >= 2 && memory?.enrichmentStatus === "completed" && memory.enrichedRevision === memory.contentRevision && memory.shortTitle === "雨后散步" ? memory : undefined;
  });
  assert.equal(revised.text, "Jerry 喜欢雨后在街道散步");
  assert.match(revised.narrative ?? "", /雨后/);
  assert.match(revised.visualPrompt ?? "", /after rain/);
  assert.equal(visualRevision, 2);
  console.log(JSON.stringify({ ok: true, visualRevision }));
} finally {
  server.close();
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for memory enrichment");
}

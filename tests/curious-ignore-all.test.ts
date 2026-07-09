import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import type { ModelProvider } from "../src/core/provider";
import { MemoryProfileStore } from "../src/server/store";

const store = new MemoryProfileStore();
await store.createProfile({ userId: "ignore-all-user", creatureName: "Papo" });

const provider: ModelProvider = {
  kind: "mimo",
  name: "Ignore all curious provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-ignore-all" },
  async generate() {
    return "";
  },
  async generateJson(prompt) {
    if (prompt.includes("注意决策脑")) {
      const segmentId = [...prompt.matchAll(/"segmentId":"([^"]+)"/g)].at(-1)?.[1];
      assert.ok(segmentId);
      return {
        shouldAttend: true,
        selected: [],
        ignored: [
          {
            segmentId,
            whyIgnored: "这段声音只有背景噪音，没有需要 Papo 继续处理的生活事件。"
          }
        ],
        creatureReport: "听过了，但这 30 秒不用打扰用户。"
      };
    }
    throw new Error("action model should not be called when attention ignores all candidates");
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

const app = createApp({ store, provider, hermes: { enabled: false }, proactive: { enabled: false } });
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");

try {
  const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles/ignore-all-user/curious`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      segments: [
        {
          id: "audio-noise-1",
          kind: "audio_observation",
          label: "听到的声音 1",
          content: "持续的水流声，没有听清具体说话内容。",
          batchId: "live-2026-07-09T08:00:00.000Z-01",
          observedAt: "2026-07-09T08:00:30.000Z"
        }
      ]
    })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.events.length, 0);
  assert.equal(payload.response, "");

  const current = await store.getProfile("ignore-all-user");
  assert.ok(current);
  assert.equal(current.conversation.filter((message) => message.role === "papo").length, 0);
  const input = current.conversation.find((message) => message.sourceId === "audio-noise-1");
  assert.ok(input);
  assert.equal(input.cognitionTrace?.modelRuns.some((run) => run.stage === "attention" && /ignored all/.test(run.message)), true);
  assert.equal(input.cognitionTrace?.harnessTrace.includes("semantic: llm ignored all candidates"), true);
  console.log(JSON.stringify({ ok: true }, null, 2));
} finally {
  server.close();
}

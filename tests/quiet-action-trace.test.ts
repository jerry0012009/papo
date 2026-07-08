import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";
import type { ModelProvider } from "../src/core/provider";

const store = new MemoryProfileStore();
await store.createProfile({ userId: "quiet-action-user", creatureName: "Papo" });

const provider: ModelProvider = {
  kind: "mimo",
  name: "Quiet action provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-quiet-action" },
  async generate() {
    return "";
  },
  async generateJson(prompt) {
    if (prompt.includes("注意决策脑")) {
      const segmentId = [...prompt.matchAll(/"segmentId":"([^"]+)"/g)].at(-1)?.[1];
      assert.ok(segmentId);
      return {
        shouldAttend: true,
        selected: [
          {
            segmentId,
            whySelected: "用户给了一句很短的近况，值得听见但不一定要打断。",
            noticed: "用户说自己先安静一下。",
            userMeaning: "用户可能只是表达当下想安静，不需要 Papo 立刻回应。",
            relatedMemoryIds: [],
            tags: ["安静"]
          }
        ],
        ignored: []
      };
    }
    if (prompt.includes("行动选择脑")) {
      const eventId = [...prompt.matchAll(/"id":"([^"]+)"/g)].at(-1)?.[1];
      assert.ok(eventId);
      return {
        decisions: [
          {
            eventId,
            action: "quiet",
            noticed: "用户想先安静一下。",
            userIntent: "希望 Papo 听见但不要打断。",
            emotionalTone: "平静",
            reason: "此刻最自然的行为是安静陪着，不制造一句模板回复。",
            stateDeltas: {},
            shouldCreateEpisode: false,
            shouldConsiderMemory: false,
            shouldReply: false
          }
        ]
      };
    }
    throw new Error("unexpected prompt");
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
  const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles/quiet-action-user/button`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "我先安静一下" })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.response, "");
  assert.equal(payload.events[0].actionDecision.action, "quiet");

  const current = await store.getProfile("quiet-action-user");
  assert.ok(current);
  assert.equal(current.conversation.filter((message) => message.role === "papo").length, 0);
  const inputMessage = current.conversation.find((message) => message.role === "user" && message.channel === "button");
  assert.ok(inputMessage?.cognitionTrace, "quiet input should still keep a cognition trace");
  assert.equal(inputMessage.cognitionTrace.eventDecisions?.[0]?.action, "quiet");
  assert.equal(inputMessage.cognitionTrace.eventDecisions?.[0]?.visibleReply, "");
  assert.equal(inputMessage.cognitionTrace.modelRuns.some((run) => run.stage === "attention" && run.status === "applied"), true);
  assert.equal(inputMessage.cognitionTrace.modelRuns.some((run) => run.stage === "action" && run.status === "applied"), true);
  console.log(JSON.stringify({ ok: true }, null, 2));
} finally {
  server.close();
}

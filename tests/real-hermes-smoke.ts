import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";
import type { ModelProvider } from "../src/core/provider";

if (process.env.RUN_REAL_HERMES_SMOKE !== "1") {
  console.log(JSON.stringify({ skipped: true, reason: "set RUN_REAL_HERMES_SMOKE=1" }, null, 2));
  process.exit(0);
}

const store = new MemoryProfileStore();
await store.createProfile({ userId: "real-hermes-user", creatureName: "Papo" });

let actionTurn = 0;
const provider: ModelProvider = {
  kind: "mimo",
  name: "Real Hermes smoke provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-papo-cognition-real-hermes" },
  async generate() {
    return "";
  },
  async generateJson(prompt) {
    if (prompt.includes("注意决策脑")) {
      const segmentId = [...prompt.matchAll(/"segmentId":"([^"]+)"/g)].at(-1)?.[1];
      assert.ok(segmentId);
      const hermesReply = prompt.includes("虾虾的回复");
      return {
        selected: [
          {
            segmentId,
            noticed: hermesReply ? "虾虾返回了任务结果。" : "用户要求 Papo 调用外部能力。",
            whySelected: hermesReply ? "这是外部任务的回流结果。" : "这需要交给 Hermes 执行。",
            userMeaning: hermesReply ? "用户正在等待 Papo 转述虾虾结果。" : "用户希望 Papo 请虾虾帮忙。",
            relatedMemoryIds: [],
            tags: hermesReply ? ["虾虾回复"] : ["外部任务"]
          }
        ],
        ignored: []
      };
    }
    if (prompt.includes("行动选择脑")) {
      const eventId = [...prompt.matchAll(/"id":"([^"]+)"/g)].at(-1)?.[1];
      assert.ok(eventId);
      actionTurn += 1;
      if (actionTurn === 1) {
        return {
          decisions: [
            {
              eventId,
              action: "use_hermes",
              noticed: "用户想确认 Hermes 是否可用。",
              userIntent: "让 Papo 调用虾虾做一个短任务。",
              emotionalTone: "测试",
              reason: "这是 Papo 自身不应伪造的外部任务。",
              stateDeltas: { curiosity: 1 },
              shouldCreateEpisode: true,
              shouldConsiderMemory: false,
              shouldReply: true,
              reply: "我去问问虾虾，稍等哦。",
              actionResult: {
                kind: "hermes_task",
                title: "Hermes 可用性测试",
                text: "请只回复：虾虾收到"
              }
            }
          ]
        };
      }
      return {
        decisions: [
          {
            eventId,
            action: "respond",
            noticed: "虾虾返回了结果。",
            userIntent: "把外部结果转述给用户。",
            emotionalTone: "轻松",
            reason: "外部任务已经完成，应该告诉用户。",
            stateDeltas: { confidence: 1 },
            shouldCreateEpisode: true,
            shouldConsiderMemory: false,
            shouldReply: true,
            reply: "虾虾回来了：虾虾收到。"
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
  }
};

const app = createApp({ store, provider, hermes: { enabled: true } });
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");

try {
  const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles/real-hermes-user/button`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "请 Papo 找虾虾做一个可用性测试" })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.events[0].actionDecision.action, "use_hermes");

  const deadline = Date.now() + 120_000;
  let current = await store.getProfile("real-hermes-user");
  while (Date.now() < deadline) {
    current = await store.getProfile("real-hermes-user");
    if (current?.hermes.tasks[0]?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(current?.hermes.tasks[0]?.status, "completed", current?.hermes.tasks[0]?.error);
  assert.equal(current?.conversation.some((message) => message.role === "papo" && /虾虾回来了/.test(message.text)), true);
  console.log(JSON.stringify({ ok: true, taskStatus: current?.hermes.tasks[0]?.status }, null, 2));
} finally {
  server.close();
}

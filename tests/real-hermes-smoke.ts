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
                title: "Hermes 会话测试",
                text: "请记住这个 Papo 会话测试词：蓝色风铃。只回复：已记住"
              }
            }
          ]
        };
      }
      if (actionTurn === 3) {
        return {
          decisions: [
            {
              eventId,
              action: "use_hermes",
              noticed: "用户想确认 Hermes 会话是否延续。",
              userIntent: "让 Papo 复用同一个虾虾会话。",
              emotionalTone: "测试",
              reason: "这需要 Hermes 记得同一会话里的上一轮内容。",
              stateDeltas: { curiosity: 1 },
              shouldCreateEpisode: true,
              shouldConsiderMemory: false,
              shouldReply: true,
              reply: "我再问问同一个虾虾会话。",
              actionResult: {
                kind: "hermes_task",
                title: "Hermes 会话延续测试",
                text: "刚才这个 Papo 会话测试词是什么？只回复这个词"
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
            reply: "虾虾回来了。"
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

  let current = await store.getProfile("real-hermes-user");
  const firstDeadline = Date.now() + 120_000;
  while (Date.now() < firstDeadline) {
    current = await store.getProfile("real-hermes-user");
    if (current?.hermes.tasks[0]?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(current?.hermes.tasks[0]?.status, "completed", current?.hermes.tasks[0]?.error);
  const firstSessionId = current?.hermes.sessionId;
  assert.ok(firstSessionId, "Hermes CLI dispatcher should persist a session id");

  const second = await fetch(`http://127.0.0.1:${address.port}/api/profiles/real-hermes-user/button`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "请 Papo 再问虾虾刚才那个测试词" })
  });
  const secondPayload = await second.json();
  assert.equal(second.status, 200, JSON.stringify(secondPayload));
  assert.equal(secondPayload.events[0].actionDecision.action, "use_hermes");

  const secondDeadline = Date.now() + 120_000;
  while (Date.now() < secondDeadline) {
    current = await store.getProfile("real-hermes-user");
    if (current?.hermes.tasks[0]?.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(current?.hermes.tasks[0]?.status, "completed", current?.hermes.tasks[0]?.error);
  assert.equal(current?.hermes.sessionId, firstSessionId);
  assert.equal(current?.hermes.tasks[0]?.sessionId, firstSessionId);
  assert.equal(current?.hermes.tasks[1]?.sessionId, firstSessionId);
  assert.equal(current?.conversation.some((message) => message.role === "world" && /蓝色风铃/.test(message.text)), true);
  assert.equal(current?.conversation.some((message) => message.role === "papo" && /虾虾回来了/.test(message.text)), true);
  console.log(JSON.stringify({ ok: true, taskStatus: current?.hermes.tasks[0]?.status, sessionId: firstSessionId }, null, 2));
} finally {
  server.close();
}

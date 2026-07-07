import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";
import type { HermesBridge } from "../src/server/hermes";
import type { ModelProvider } from "../src/core/provider";

const store = new MemoryProfileStore();
await store.createProfile({ userId: "hermes-user", creatureName: "Papo" });

let enqueued = 0;
const bridge: HermesBridge = {
  enabled: true,
  async enqueueTasks(profile, result) {
    const tasks = result.events
      .filter((event) => event.actionDecision.action === "use_hermes" && event.actionResult?.kind === "hermes_task")
      .map((event) => {
        const task = {
          id: "hermes_task_test",
          createdAt: "2026-07-07T10:00:00.000Z",
          updatedAt: "2026-07-07T10:00:00.000Z",
          status: "sent" as const,
          task: event.actionResult?.text ?? "",
          title: event.actionResult?.title,
          sourceEventId: event.id
        };
        if (event.actionResult) event.actionResult.hermesTaskId = task.id;
        profile.hermes.tasks.unshift(task);
        return task;
      });
    enqueued += tasks.length;
    return tasks;
  },
  start() {},
  stop() {},
  async checkTimeouts() {
    return 0;
  }
};

const provider: ModelProvider = {
  kind: "mimo",
  name: "Hermes action provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-hermes" },
  async generate() {
    return "";
  },
  async generateJson(prompt) {
    if (prompt.includes("注意决策脑")) {
      const segmentId = [...prompt.matchAll(/"segmentId":"([^"]+)"/g)].at(-1)?.[1];
      assert.ok(segmentId, "attention prompt should include a segment id");
      return {
        selected: [
          {
            segmentId,
            noticed: "用户想查一个实时外部信息。",
            whySelected: "这需要外部搜索能力。",
            userMeaning: "用户希望 Papo 找虾虾帮忙查资料。",
            relatedMemoryIds: [],
            tags: ["外部任务"]
          }
        ],
        ignored: []
      };
    }
    if (prompt.includes("行动选择脑")) {
      const eventId = prompt.match(/"id":"([^"]+)"/)?.[1];
      assert.ok(eventId, "action prompt should include an event id");
      return {
        decisions: [
          {
            eventId,
            action: "use_hermes",
            noticed: "用户需要查实时资料。",
            userIntent: "让 Papo 借助虾虾搜索。",
            emotionalTone: "直接",
            reason: "Papo 内置模型不能保证实时搜索，应该交给 Hermes。",
            stateDeltas: { curiosity: 2 },
            shouldCreateEpisode: true,
            shouldConsiderMemory: false,
            shouldReply: true,
            reply: "我去问问虾虾，稍等哦。",
            actionResult: {
              kind: "hermes_task",
              title: "查询实时资料",
              text: "请搜索并总结用户刚才提到的实时资料。"
            },
            memoryTags: ["外部任务"]
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

const app = createApp({ store, provider, hermes: { bridge } });
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");

try {
  const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles/hermes-user/button`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "帮我查一下今天这个项目的最新消息" })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(enqueued, 1);
  assert.equal(payload.events[0].actionDecision.action, "use_hermes");
  assert.equal(payload.events[0].actionResult.kind, "hermes_task");
  assert.equal(payload.events[0].actionResult.hermesTaskId, "hermes_task_test");

  const current = await store.getProfile("hermes-user");
  assert.equal(current?.hermes.tasks[0]?.status, "sent");
  assert.equal(current?.conversation.some((message) => message.role === "papo" && /虾虾/.test(message.text)), true);
  console.log(JSON.stringify({ ok: true }, null, 2));
} finally {
  server.close();
}

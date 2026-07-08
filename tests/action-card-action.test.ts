import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import type { ModelProvider } from "../src/core/provider";
import { MemoryProfileStore } from "../src/server/store";

const store = new MemoryProfileStore();
await store.createProfile({ userId: "action-card-user", creatureName: "吉祥", petKind: "british-shorthair" });

let videoPrompt = "";
const provider: ModelProvider = {
  kind: "openrouter",
  name: "Action card provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-text", videoModel: "fake-video", videoProvider: "openrouter", videoRoute: "openrouter_videos" },
  async generate() {
    return "";
  },
  async generateJson(prompt) {
    if (prompt.includes("注意决策脑")) {
      const segmentId = [...prompt.matchAll(/"segmentId":"([^"]+)"/g)].at(-1)?.[1];
      assert.ok(segmentId);
      return {
        selected: [
          {
            segmentId,
            whySelected: "用户明确想让小猫动起来。",
            noticed: "用户想看吉祥出去抓蝴蝶。",
            userMeaning: "用户希望生成一个小猫动作视频卡。",
            relatedMemoryIds: [],
            tags: ["动作卡", "小猫"]
          }
        ],
        ignored: []
      };
    }
    if (prompt.includes("行动选择脑")) {
      const events = JSON.parse(prompt.match(/events:\n(\[[\s\S]*?\])\n/)?.[1] ?? "[]") as Array<{ id?: string }>;
      const eventId = events[0]?.id;
      assert.ok(eventId);
      return {
        decisions: [
          {
            eventId,
            action: "generate_action_card",
            noticed: "用户想看吉祥出去抓蝴蝶。",
            userIntent: "生成一段小猫动作视频。",
            emotionalTone: "期待",
            reason: "这是明确的动作视频请求，适合生成动作卡。",
            stateDeltas: { curiosity: 2, energy: 1 },
            shouldCreateEpisode: true,
            shouldConsiderMemory: false,
            shouldReply: true,
            reply: "我让吉祥动起来给你看。",
            actionResult: {
              kind: "action_card_draft",
              title: "吉祥抓蝴蝶",
              prompt: "吉祥是一只圆脸灰白英短小猫，轻快跑到花丛边，抬爪追一只小蝴蝶，动作可爱自然。",
              caption: "吉祥追着蝴蝶动起来了。",
              style: "cute commercial pet animation, soft light, gentle camera",
              durationSeconds: 8,
              sourceIds: ["chat-text-action-card"]
            },
            memoryTags: ["动作卡"]
          }
        ]
      };
    }
    if (prompt.includes("记忆决策脑")) {
      return { candidates: [] };
    }
    throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
  },
  async summarizeImage() {
    return "";
  },
  async observeAudio() {
    return "";
  },
  async generateImage() {
    throw new Error("image generation should not be used");
  },
  async generateVideo(prompt) {
    videoPrompt = prompt;
    return {
      dataUrl: "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQ==",
      mime: "video/mp4",
      model: "fake-video"
    };
  }
};

const app = createApp({ store, provider });
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");

try {
  const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles/action-card-user/curious`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      segments: [
        {
          id: "chat-text-action-card",
          kind: "text",
          label: "你刚说的话",
          content: "让吉祥出去抓蝴蝶，做一个短短的动作视频。",
          observedAt: "2026-07-08T12:00:00.000Z",
          batchId: "action-card-batch"
        }
      ]
    })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.events[0].actionDecision.action, "generate_action_card");
  assert.equal(payload.events[0].actionResult.kind, "action_card_draft");

  const current = await waitForActionCard();
  assert.match(videoPrompt, /吉祥/);
  assert.match(videoPrompt, /British Shorthair/);
  assert.match(videoPrompt, /homepage motion avatar loops/);
  const papoMessage = current?.conversation.find((message) => message.role === "papo");
  assert.ok(papoMessage?.attachments?.[0]?.url, "Papo reply should carry generated action video");
  assert.equal(papoMessage.attachments[0].kind, "video");
  assert.equal(papoMessage.attachments[0].generatedBy, "papo_action_card");
  assert.equal(papoMessage.cognitionTrace?.eventDecisions?.[0]?.actionResult?.kind, "action_card");
  assert.equal(current?.actionCards?.[0]?.video.id, papoMessage.attachments[0].id);
  assert.equal(current?.actionCards?.[0]?.title, "吉祥抓蝴蝶");
  console.log(JSON.stringify({ ok: true, video: papoMessage.attachments[0].url }, null, 2));
} finally {
  server.close();
}

async function waitForActionCard() {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const current = await store.getProfile("action-card-user");
    if (current?.actionCards?.[0]?.video?.url && current.conversation.some((message) => message.role === "papo" && message.attachments?.some((attachment) => attachment.kind === "video"))) {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("action card was not generated asynchronously");
}

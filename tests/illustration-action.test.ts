import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import type { ModelProvider } from "../src/core/provider";
import { MemoryProfileStore } from "../src/server/store";

const store = new MemoryProfileStore();
await store.createProfile({ userId: "illustration-user", creatureName: "Papo" });

let imagePrompt = "";
let referenceCount = 0;
const provider: ModelProvider = {
  kind: "generic",
  name: "Illustration provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-text", imageModel: "fake-image" },
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
            whySelected: "用户明确想让 Papo 把今天的小事画下来。",
            noticed: "用户说今天游泳人很多但很开心。",
            userMeaning: "用户希望 Papo 用插画记录今天的游泳片段。",
            relatedMemoryIds: [],
            tags: ["插画", "游泳"]
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
            action: "generate_illustration",
            noticed: "用户想把今天游泳的片段画下来。",
            userIntent: "希望获得一张手绘风格的小画。",
            emotionalTone: "轻快",
            reason: "这是一段适合被画成小插画的生活片段。",
            stateDeltas: { attachment: 1, curiosity: 2 },
            shouldCreateEpisode: true,
            shouldConsiderMemory: true,
            shouldReply: true,
            reply: "我想把今天游泳这件小事画下来给你看。",
            actionResult: {
              kind: "illustration_draft",
              title: "今天的泳池小画",
              prompt: "一张温暖手绘漫画小插画：泳池里人很多，用户开心地游泳，旁边有一只可爱的柴犬 Papo 看着水面。",
              caption: "今天泳池有点挤，但你还是游得很开心。",
              style: "手绘漫画明信片",
              sourceIds: ["chat-text-test"]
            },
            memoryCandidateText: "用户今天去游泳，泳池人很多但仍然觉得开心。",
            memoryTags: ["游泳", "插画"]
          }
        ]
      };
    }
    if (prompt.includes("记忆决策脑")) {
      const candidateId = [...prompt.matchAll(/"candidateId":"([^"]+)"/g)].at(-1)?.[1];
      assert.ok(candidateId);
      return {
        candidates: [
          {
            candidateId,
            shouldKeepCandidate: true,
            candidateText: "你今天去游泳，泳池人很多但还是很开心。",
            memoryKind: "long_theme",
            confidence: 70,
            writePolicy: "wait_feedback",
            whyConsolidate: "这是今天真实发生、还被画下来的生活片段。",
            decayPolicy: "decay_without_feedback",
            tags: ["游泳"]
          }
        ]
      };
    }
    throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
  },
  async summarizeImage() {
    return "";
  },
  async observeAudio() {
    return "";
  },
  async generateImage(prompt, input) {
    imagePrompt = prompt;
    referenceCount = input?.references?.length ?? 0;
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
  const imageResponse = await fetch(`http://127.0.0.1:${address.port}/api/image-summary`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      label: "泳池小照片"
    })
  });
  const imagePayload = await imageResponse.json();
  assert.equal(imageResponse.status, 200, JSON.stringify(imagePayload));

  const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles/illustration-user/curious`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      segments: [
        {
          id: "chat-text-test",
          kind: "text",
          label: "你刚说的话",
          content: "今天游泳人很多，但我还是很开心。你能把它画下来吗？",
          observedAt: "2026-07-08T12:00:00.000Z",
          batchId: "illustration-batch",
          attachments: [imagePayload.asset]
        }
      ]
    })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.events[0].actionDecision.action, "generate_illustration");
  assert.equal(payload.events[0].actionResult.kind, "illustration");
  assert.match(imagePrompt, /手绘漫画小插画/);
  assert.equal(referenceCount, 1, "original uploaded image should be passed as image generation reference");

  const current = await store.getProfile("illustration-user");
  const papoMessage = current?.conversation.find((message) => message.role === "papo");
  assert.ok(papoMessage?.attachments?.[0]?.url, "Papo reply should carry generated illustration attachment");
  assert.equal(papoMessage.attachments[0].generatedBy, "papo_illustration");
  assert.equal(current?.illustrations?.[0]?.attachment.id, papoMessage.attachments[0].id);
  console.log(JSON.stringify({ ok: true, image: papoMessage.attachments[0].url }, null, 2));
} finally {
  server.close();
}

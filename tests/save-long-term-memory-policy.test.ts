import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";
import type { ModelProvider } from "../src/core/provider";

const store = new MemoryProfileStore();
await store.createProfile({ userId: "save-policy-user", creatureName: "Papo" });

const provider: ModelProvider = {
  kind: "mimo",
  name: "Save policy provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-save-policy" },
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
            whySelected: "用户明确交代一个可能值得长期记住的饮食偏好。",
            noticed: "用户说自己最近喜欢酸奶配蓝莓。",
            userMeaning: "用户希望 Papo 理解这是一条近期偏好，但是否长期保存还要继续判断。",
            relatedMemoryIds: [],
            tags: ["饮食"]
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
            action: "save_long_term",
            noticed: "用户分享了近期饮食偏好。",
            userIntent: "希望 Papo 把这件事当成偏好来理解。",
            emotionalTone: "平静",
            reason: "这看起来可能是稳定偏好，所以行动脑建议交给记忆脑认真判断。",
            stateDeltas: { attachment: 1, confidence: 1 },
            shouldCreateEpisode: true,
            shouldConsiderMemory: true,
            shouldReply: true,
            reply: "我听见啦，酸奶配蓝莓这件事我会认真放在心上。",
            actionResult: {
              kind: "memory_intent",
              text: "行动脑建议把这条近期偏好交给记忆脑判断。"
            },
            memoryCandidateText: "用户最近喜欢酸奶配蓝莓。",
            memoryTags: ["饮食", "偏好"]
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
            candidateText: "你最近喜欢酸奶配蓝莓",
            memoryKind: "user_preference",
            confidence: 68,
            writePolicy: "wait_feedback",
            whyConsolidate: "这像近期偏好，但还不确定是否稳定。",
            decayPolicy: "decay_without_feedback",
            tags: ["饮食", "偏好"]
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

const app = createApp({ store, provider });
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");

try {
  const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles/save-policy-user/button`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "请记住：我最近喜欢酸奶配蓝莓。" })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.events[0].actionDecision.action, "save_long_term");
  assert.equal(payload.memoryCandidates[0].writePolicy, "wait_feedback");
  assert.equal(payload.harnessTrace.includes("memory: auto_promoted=1"), false);

  const current = await store.getProfile("save-policy-user");
  assert.ok(current);
  assert.equal(current.longTermMemories.length, 0, "save_long_term must not bypass memory writePolicy");
  assert.equal(current.memoryCandidates.length, 1);
  assert.equal(current.memoryCandidates[0].status, "candidate");
  assert.equal(current.memoryCandidates[0].writePolicy, "wait_feedback");
  assert.equal(current.memoryCandidates[0].candidateText, "你最近喜欢酸奶配蓝莓");

  const papoMessage = current.conversation.find((message) => message.role === "papo" && message.channel === "button");
  assert.ok(papoMessage?.cognitionTrace, "visible reply should carry the full cognition trace");
  assert.equal(papoMessage.cognitionTrace.eventDecisions?.[0]?.action, "save_long_term");
  assert.equal(papoMessage.cognitionTrace.eventDecisions?.[0]?.memoryCandidateKept, true);
  assert.equal(papoMessage.cognitionTrace.memoryDecisions?.[0]?.writePolicy, "wait_feedback");
  assert.equal(papoMessage.cognitionTrace.memoryDecisions?.[0]?.status, "candidate");
  assert.equal(papoMessage.cognitionTrace.modelRuns.some((run) => run.stage === "memory" && run.status === "applied"), true);
  console.log(JSON.stringify({ ok: true }, null, 2));
} finally {
  server.close();
}

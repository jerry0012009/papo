import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";
import type { ModelProvider } from "../src/core/provider";

const store = new MemoryProfileStore();
await store.createProfile({ userId: "privacy-memory-user", creatureName: "Papo" });

let memoryPromptWasPrivacyHidden = false;
const provider: ModelProvider = {
  kind: "mimo",
  name: "High privacy memory provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-privacy-memory" },
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
            whySelected: "用户主动提交了一段高隐私凭据相关信息，需要被理解但不能自动长期保存。",
            noticed: "用户提到一段 API key 相关信息。",
            userMeaning: "用户可能在临时告诉 Papo 一段凭据信息，保存必须谨慎。",
            relatedMemoryIds: [],
            tags: ["隐私"]
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
            noticed: "用户提交了 API key 相关内容。",
            userIntent: "用户希望 Papo 暂时理解这段信息。",
            emotionalTone: "谨慎",
            reason: "这类信息即使用户说要记住，也必须交给记忆护栏处理。",
            stateDeltas: { safety: 2 },
            shouldCreateEpisode: true,
            shouldConsiderMemory: true,
            shouldReply: true,
            reply: "我听见了，这类信息我会很小心处理。",
            actionResult: {
              kind: "memory_intent",
              text: "交给记忆脑判断是否能保存。"
            },
            memoryCandidateText: "用户提到 api_key=sk-testhighprivacy1234567890。",
            memoryTags: ["隐私"]
          }
        ]
      };
    }
    if (prompt.includes("记忆决策脑")) {
      memoryPromptWasPrivacyHidden = prompt.includes('"contentHiddenForPrivacy":true') && prompt.includes("[内容因隐私护栏隐藏]");
      const candidateId = [...prompt.matchAll(/"candidateId":"([^"]+)"/g)].at(-1)?.[1];
      assert.ok(candidateId);
      return {
        candidates: [
          {
            candidateId,
            shouldKeepCandidate: true,
            candidateText: "用户提到 api_key=sk-testhighprivacy1234567890。",
            memoryKind: "safety_rule",
            confidence: 90,
            writePolicy: "auto",
            whyConsolidate: "模型误判为应该自动保存。",
            privacyReason: "包含 API key 类凭据信息。",
            decayPolicy: "stable",
            tags: ["隐私"]
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
  const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles/privacy-memory-user/button`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "请记住这个临时配置：api_key=sk-testhighprivacy1234567890。" })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(memoryPromptWasPrivacyHidden, true, "memory prompt should hide high-privacy source material");

  const current = await store.getProfile("privacy-memory-user");
  assert.ok(current);
  assert.equal(current.longTermMemories.length, 0, "high privacy content must not auto-promote to long-term memory");
  assert.equal(current.memoryCandidates.length, 1);
  assert.equal(current.memoryCandidates[0].writePolicy, "ask_user", "privacy guard should downgrade model auto to ask_user");
  assert.equal(current.memoryCandidates[0].status, "candidate");
  assert.equal(current.memoryCandidates[0].privacyReason, "包含 API key 类凭据信息");

  const papoMessage = current.conversation.find((message) => message.role === "papo" && message.channel === "button");
  assert.equal(papoMessage?.cognitionTrace?.memoryDecisions?.[0]?.writePolicy, "ask_user");
  assert.equal(papoMessage?.cognitionTrace?.memoryDecisions?.[0]?.status, "candidate");
  console.log(JSON.stringify({ ok: true }, null, 2));
} finally {
  server.close();
}

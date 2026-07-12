import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";
import { createEpisodeFromEvent, createMemoryCandidateFromEpisode } from "../src/core/memory";
import { semanticDreamMemories } from "../src/core/dreaming";
import { initialState } from "../src/core/state";
import type { ModelProvider } from "../src/core/provider";
import type { AttentionEvent } from "../src/core/types";

const store = new MemoryProfileStore();
const profile = await store.createProfile({ userId: "candidate-feedback-user", creatureName: "Papo" });
const now = "2026-07-07T10:00:00.000Z";
const event: AttentionEvent = {
  id: "attention_candidate_test",
  source: "button",
  triggerSegmentId: "segment_candidate_test",
  triggerLabel: "你刚说的话",
  triggerContent: "我最近每天晚上游泳，但是不喜欢泳池人太多。",
  noticed: "用户最近每天晚上游泳，也提到泳池人多会影响体验。",
  reason: "这是稳定生活习惯和偏好。",
  relatedMemoryIds: [],
  stateSnapshot: initialState("candidate-feedback-user"),
  attentionStrength: 80,
  privacyRisk: 0,
  suggestedAction: "save_episode",
  actionDecision: {
    action: "save_episode",
    confidence: 100,
    reason: "model selected",
    blockedActions: [],
    safetyNotes: [],
    llmSuggestedAction: "save_episode",
    ruleTrace: []
  },
  creatureExperience: { earReason: "", actionFeeling: "", saveFeeling: "" },
  tags: ["游泳"],
  semanticSource: "llm",
  createdAt: now
};
const episode = createEpisodeFromEvent(event, "我记住这件小事。", now);
profile.episodes.unshift(episode);
const candidate = createMemoryCandidateFromEpisode(profile, episode, { now });
candidate.candidateText = "用户最近每天晚上游泳，但不喜欢泳池人太多";
candidate.memoryKind = "habit";
candidate.confidence = 72;
await store.saveProfile(profile);

const provider: ModelProvider = {
  kind: "mimo",
  name: "Candidate feedback provider",
  available: true,
  usesRealModel: true,
  diagnostics: { textModel: "fake-memory" },
  async generate() {
    return "";
  },
  async generateJson(prompt) {
    if (prompt.includes("反馈反思脑")) {
      return {
        responseAction: "acknowledge",
        learningNote: "用户希望候选记忆长期留下。",
        effect: "把候选游泳习惯升级为长期记忆。",
        replyText: "嗯，这件我会认真留下。",
        memoryOperation: {
          type: "promote_candidate",
          text: "你最近每天晚上游泳，但不喜欢泳池人太多",
          kind: "habit",
          tags: ["游泳", "运动"],
          consolidatedBecause: "用户明确要求长期记住这条候选记忆。",
          weight: 84
        }
      };
    }
    if (prompt.includes("共同回忆编辑和视觉导演")) return {
      shortTitle: "晚间游泳",
      narrative: "我记得你最近每天晚上游泳，只是不喜欢泳池里人太多。",
      imagePrompt: "Square hand-painted gouache memory scene beside a quiet evening swimming pool, visible brush texture, no text.",
      visualMode: "imaginative_illustration", papoPresence: "absent", visualReason: "没有现场照片，使用插画表达",
      relatedMemoryIds: [], needsClientReferences: false
    };
    if (prompt.includes("Client.md 维护脑")) return { facts: [] };
    return {
      shouldDream: true,
      summary: "把重复的运动记忆整理得更稳，放下不需要的候选。",
      operations: [
        {
          type: "dismiss_candidate",
          targetId: candidate.id,
          reason: "这条候选已经升级为长期记忆，不需要继续作为候选保留。"
        },
        {
          type: "adjust_state",
          stateDeltas: { confidence: 1 },
          reason: "重要习惯被整理清楚后，Papo 对记忆更有把握。"
        }
      ]
    };
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
  const feedbackResponse = await fetch(`http://127.0.0.1:${address.port}/api/profiles/candidate-feedback-user/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "remember", targetId: candidate.id })
  });
  const feedbackPayload = await feedbackResponse.json();
  assert.equal(feedbackResponse.status, 200, JSON.stringify(feedbackPayload));
  const afterFeedback = await store.getProfile("candidate-feedback-user");
  assert.equal(afterFeedback?.memoryCandidates.find((item) => item.id === candidate.id)?.status, "promoted");
  assert.equal(afterFeedback?.longTermMemories.some((memory) => memory.sourceEpisodeId === episode.id && /游泳/.test(memory.text)), true);
  await waitFor(async () => (await store.getProfile("candidate-feedback-user"))?.longTermMemories.find((memory) => memory.visualStatus === "ready"));

  const beforeConfidence = afterFeedback!.state.confidence;
  const dream = await semanticDreamMemories(afterFeedback!, provider, { force: true, now: "2026-07-07T10:10:00.000Z" });
  assert.ok(dream);
  assert.equal(dream.operations.some((operation) => operation.type === "adjust_state"), true);
  assert.equal(afterFeedback!.state.confidence, beforeConfidence + 1);
  console.log(JSON.stringify({ ok: true }, null, 2));
} finally {
  server.close();
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for memory enrichment");
}

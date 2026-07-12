import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/server/app";
import type { ModelProvider } from "../src/core/provider";
import { MemoryProfileStore } from "../src/server/store";
import type { PersistentTurnWorker } from "../src/server/turn-worker";

test("selected companion input keeps trace while event aggregation owns the episode", async () => {
  const store = new MemoryProfileStore();
  await store.createProfile({ userId: "ambient-silent", creatureName: "Papo" });
  const provider: ModelProvider = {
    kind: "generic", name: "Ambient silent provider", available: true, usesRealModel: true,
    async generate() { return ""; },
    async generateJson(prompt) {
      if (prompt.includes("连续生活事件归属脑")) {
        return {
          assignments: [{
            segmentId: "live-lecture-001-audio", role: "scene_evidence", transition: "start", eventKind: "lecture", eventTitle: "产品讲座",
            observationSummary: "讲者说明产品定位和目标用户", updatedEventSummary: "讲者说明产品定位和目标用户", importantFacts: ["产品定位和目标用户"], reason: "讲座刚开始"
          }],
          currentContext: { activity: "正在听讲座", rollingSummary: "讲者说明产品定位和目标用户", importantContent: ["产品定位和目标用户"], recentUserNotes: [] }
        };
      }
      if (prompt.includes("注意决策脑")) {
        const segmentId = [...prompt.matchAll(/"segmentId":"([^"]+)"/g)].at(-1)?.[1];
        return { selected: [{ segmentId, whySelected: "讲座内容可用于会后整理", noticed: "听到讲者解释产品定位", userMeaning: "用户正在安静听讲座", addressedToPapo: false, expectsResponse: false, relatedMemoryIds: [], tags: ["讲座"] }], ignored: [] };
      }
      if (prompt.includes("行动选择脑")) {
        const eventId = [...prompt.matchAll(/"id":"([^"]+)"/g)].at(-1)?.[1];
        return { decisions: [{ eventId, action: "listen_silently", reason: "不打断用户", stateDeltas: {}, shouldCreateEpisode: false, shouldConsiderMemory: false, shouldReply: false }] };
      }
      throw new Error("unexpected prompt");
    },
    async summarizeImage() { return ""; },
    async observeAudio() { return ""; },
    async generateImage() { throw new Error("not used"); }
  };
  const app = createApp({ store, provider, proactive: { enabled: false }, turns: { intervalMs: 10 } });
  const worker = app.locals.turnWorker as PersistentTurnWorker;
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles/ambient-silent/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        turnId: "turn_live_lecture_001",
        requestId: "turn_live_lecture_001",
        channel: "curious",
        segments: [{
          id: "live-lecture-001-audio",
          kind: "audio_observation",
          label: "后台听到的声音",
          content: "讲者正在说明产品定位和目标用户。",
          observedAt: "2026-07-12T10:00:00.000Z",
          batchId: "live-lecture-001",
          sensingTrace: { at: "2026-07-12T10:00:00.000Z", modality: "audio", label: "后台听到的声音", provider: "fake", semanticSource: "llm", status: "content", decision: "content", observation: "讲者正在说明产品定位和目标用户。", ruleTrace: [] }
        }]
      })
    });
    assert.equal(response.status, 202);
    await waitFor(async () => (await store.getProfile("ambient-silent"))?.turns?.find((turn) => turn.id === "turn_live_lecture_001")?.status === "completed");
    const profile = await store.getProfile("ambient-silent");
    const input = profile?.conversation.find((message) => message.turnId === "turn_live_lecture_001" && message.role === "user");
    assert.equal(profile?.conversation.some((message) => message.turnId === "turn_live_lecture_001" && message.role === "papo"), false);
    assert.equal(input?.cognitionTrace?.eventDecisions?.[0]?.action, "listen_silently");
    assert.equal(input?.cognitionTrace?.eventDecisions?.[0]?.episodeKept, false);
    assert.equal(input?.cognitionTrace?.attentionDecision?.selected[0]?.whySelected, "讲座内容可用于会后整理");
    assert.equal(profile?.episodes.some((episode) => episode.sourceSegmentId === "live-lecture-001-audio"), false);
    assert.equal(profile?.companionSessions?.[0].events?.[0].sourceSegmentIds.includes("live-lecture-001-audio"), true);
    const job = profile?.jobs?.find((item) => item.id === "turn_live_lecture_001-cognition");
    assert.equal(job?.result?.cognition?.attention, "selected");
    assert.deepEqual(job?.result?.cognition?.actions, ["listen_silently"]);
  } finally {
    worker.stop();
    server.close();
  }
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out");
}

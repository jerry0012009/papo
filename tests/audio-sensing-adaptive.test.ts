import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/server/app";
import { buildAudioSensingPrompt, normalizeAudioSensingResult } from "../src/server/audio-sensing";
import { collectCompanionTurn, processCompanionTurnContext, runCompanionSessionSweep } from "../src/server/companion-session";
import type { ModelProvider } from "../src/core/provider";
import type { SensingTrace, StreamSegment } from "../src/core/types";
import { MemoryProfileStore } from "../src/server/store";

test("adaptive audio sensing preserves lecture transcript and separates all three content layers", async () => {
  const transcript = [
    "[speaker_1] 大家好，我是林博士。今天讨论 Qwen3.5 在端侧部署时的量化策略。实验组有 128 台设备，峰值内存从 6.4GB 降到 2.1GB，准确率保持在 72.5%。",
    ...Array.from({ length: 18 }, (_item, index) => `[speaker_1] 第 ${index + 1} 组论证先说明算子融合减少访存，再以热启动延迟作为反例，比较 A/B 两条路径的功耗与吞吐。`),
    "[speaker_2] 我补充一个限制：如果缓存命中率低于 43%，这种方案的收益会明显下降，所以结论只适用于高频重复场景。",
    "[speaker_1] 最终结论是先在三个高频场景试点，并保留云端回退；TAIL_MARKER_ZETA_2048。"
  ].join("\n");
  assert.ok(transcript.length > 1_200);

  const provider: ModelProvider = {
    kind: "generic", name: "adaptive audio fake", available: true, usesRealModel: true,
    async generate() { return ""; },
    async generateJson(prompt) {
      if (prompt.includes("连续生活事件归属脑")) {
        assert.match(prompt, /TAIL_MARKER_ZETA_2048/);
        assert.match(prompt, /72\.5%/);
        assert.match(prompt, /segmentSummary 必须严格基于/);
        return {
          assignments: [{
            segmentId: "lecture-audio", role: "scene_evidence", transition: "start", eventKind: "lecture", eventTitle: "端侧模型部署讲座",
            segmentSummary: "林博士围绕 Qwen3.5 端侧量化说明内存从 6.4GB 降至 2.1GB、准确率 72.5%，并讨论缓存命中率低于 43% 时收益下降的反例，结论是先试点并保留云端回退。",
            updatedEventSummary: "讲座讨论 Qwen3.5 端侧部署的量化、算子融合、缓存边界与回退方案。",
            importantFacts: ["128 台设备", "72.5%", "缓存命中率 43%"],
            speakerUpdates: [
              { speakerId: "speaker_1", displayName: "林博士", nameSource: "self_introduction", confidence: 0.98, evidence: "说话者明确说‘我是林博士’", sourceSegmentIds: ["lecture-audio"] },
              { speakerId: "speaker_2", displayName: "王教授", nameSource: "unknown", confidence: 0.99, evidence: "仅凭声音猜测", sourceSegmentIds: ["lecture-audio"] }
            ],
            reason: "连续的讲座论证"
          }],
          currentContext: { activity: "正在听端侧模型讲座", rollingSummary: "讲座正在讨论量化与部署边界。", importantContent: ["Qwen3.5", "72.5%", "43%"], recentUserNotes: [] }
        };
      }
      assert.match(prompt, /eventTranscript/);
      assert.match(prompt, /TAIL_MARKER_ZETA_2048/);
      assert.match(prompt, /第一事实源/);
      assert.match(prompt, /transcript 是事件资料，不等于长期记忆/);
      return {
        kind: "lecture", title: "端侧模型部署讲座", summary: "讲座完整讨论了端侧量化收益、适用边界与试点回退方案。",
        shouldRemember: false, importanceReason: "这是可回看的完整事件资料，但测试场景没有确认对用户具有持续长期价值。", tags: ["端侧模型", "讲座"]
      };
    },
    async summarizeImage() { return ""; },
    async observeAudio() {
      return JSON.stringify({
        sceneType: "lecture",
        transcript,
        environmentObservation: "室内扩音讲座，背景较安静。",
        speakers: [
          { speakerId: "speaker_1", displayName: "林博士", nameSource: "self_introduction", confidence: 0.98, evidence: "说话者明确说‘我是林博士’" },
          { speakerId: "speaker_2", displayName: "王教授", nameSource: "unknown", confidence: 0.99, evidence: "仅凭声音猜测" }
        ]
      });
    },
    async generateImage() { throw new Error("not used"); }
  };

  const store = new MemoryProfileStore();
  await store.createProfile({ userId: "adaptive-audio", creatureName: "Papo" });
  const app = createApp({ store, provider, proactive: { enabled: false }, turns: { autoStart: false }, nativeIngest: { autoStart: false } });
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/audio-observation`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: `data:audio/mp4;base64,${Buffer.from("audio fixture".repeat(8)).toString("base64")}`, label: "技术讲座" })
    });
    assert.equal(response.status, 200);
    const sensed = await response.json() as { observation: string; sensingTrace: SensingTrace };
    assert.match(sensed.observation, /TAIL_MARKER_ZETA_2048/);
    assert.equal(sensed.sensingTrace.audioContent?.transcript.length, transcript.length);
    assert.equal(sensed.sensingTrace.audioContent?.sceneType, "lecture");
    assert.equal(sensed.sensingTrace.audioContent?.speakers[0].displayName, "林博士");
    assert.equal(sensed.sensingTrace.audioContent?.speakers[1].displayName, undefined);

    const segment: StreamSegment = {
      id: "lecture-audio", kind: "audio_observation", label: "技术讲座", content: sensed.observation,
      observedAt: "2026-07-12T12:00:00.000Z", batchId: "live-adaptive-audio-01", companionSessionId: "live-adaptive-audio", sensingTrace: sensed.sensingTrace
    };
    await store.updateProfile("adaptive-audio", (profile) => collectCompanionTurn(profile, "turn-lecture-audio", [segment]));
    await processCompanionTurnContext(store, provider, "adaptive-audio", "turn-lecture-audio");
    await runCompanionSessionSweep(store, provider, "2026-07-12T12:05:00.000Z");
    const saved = await store.getProfile("adaptive-audio");
    const session = saved?.companionSessions?.[0];
    const observation = session?.observations[0];
    const event = session?.events?.[0];
    assert.equal(observation?.transcript?.length, transcript.length);
    assert.match(observation?.segmentSummary ?? "", /72\.5%/);
    assert.equal(event?.transcript[0].text.length, transcript.length);
    assert.match(event?.eventSummary ?? "", /适用边界/);
    assert.equal(event?.speakers.find((speaker) => speaker.speakerId === "speaker_1")?.displayName, "林博士");
    assert.equal(event?.speakers.find((speaker) => speaker.speakerId === "speaker_2")?.displayName, undefined);
    assert.equal(saved?.episodes.filter((episode) => episode.sourceBatchId === event?.id).length, 1);
    assert.equal(saved?.longTermMemories.filter((memory) => memory.sourceEpisodeId === event?.episodeId).length, 0);
  } finally {
    server.close();
  }
});

test("environment sensing stays concise while prompt has no uniform 400-character limit", () => {
  const prompt = buildAudioSensingPrompt("窗边环境声");
  assert.doesNotMatch(prompt, /400 字/);
  assert.match(prompt, /environment/);
  assert.match(prompt, /不设统一字数限制/);
  const normalized = normalizeAudioSensingResult(JSON.stringify({
    sceneType: "environment", transcript: "", environmentObservation: "窗外有短暂雨声。", speakers: []
  }));
  assert.equal(normalized.text, "窗外有短暂雨声。");
  assert.equal(normalized.audioContent?.transcript, "");
});

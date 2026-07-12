import assert from "node:assert/strict";
import test from "node:test";
import { createCreatureProfile } from "../src/core/profile";
import type { ModelProvider } from "../src/core/provider";
import type { StreamSegment } from "../src/core/types";
import { collectCompanionTurn, runCompanionSessionSweep } from "../src/server/companion-session";
import { MemoryProfileStore } from "../src/server/store";

test("a 15 minute lecture becomes one integrated memory independent of per-slice Attention", async () => {
  const store = new MemoryProfileStore();
  const profile = createCreatureProfile({ userId: "lecture-user", creatureName: "Papo", now: "2026-07-12T10:00:00.000Z" });
  profile.conversation.unshift({ id: "msg-goal", at: "2026-07-12T09:59:00.000Z", role: "user", channel: "button", text: "我在听讲座，你安静陪我，结束后整理核心内容。", relatedMemoryIds: [] });
  const observations = [
    "讲者先介绍产品面向海外来华用户，核心问题是中文在真实生活场景中难以使用。",
    "产品用打车、点餐等场景让用户通过语音和文字与 AI 互动，并纠正发音。",
    "当前已经完成 MVP，并邀请了一批海外用户试用，早期反馈较好。",
    "商业模式包括免费版和每月订阅的 Pro 版，也考虑与机构开展 B 端合作。",
    "团队计划七月底发布 iOS 和 Android，并在积累真实反馈后继续调整。",
    "讲者最后提出当前最需要的是海外推广和投流资源。"
  ];
  observations.forEach((content, index) => {
    const observedAt = new Date(Date.parse("2026-07-12T10:00:00.000Z") + index * 3 * 60_000).toISOString();
    const segment: StreamSegment = { id: `native-lecture-001:${index}`, kind: "audio_observation", label: "后台听到的声音", content, observedAt, batchId: `native-lecture-${String(index + 1).padStart(3, "0")}`, sensingTrace: { at: observedAt, modality: "audio", label: "后台听到的声音", provider: "fake", semanticSource: "llm", status: "content", decision: "content", observation: content, ruleTrace: [] } };
    collectCompanionTurn(profile, `turn-native-lecture-${index}`, [segment]);
  });
  const actual = await store.createProfile({ userId: "lecture-user", creatureName: "Papo" });
  Object.assign(actual, profile);
  await store.saveProfile(actual);

  let consolidationCalls = 0;
  const provider: ModelProvider = {
    kind: "generic", name: "Lecture consolidation provider", available: true, usesRealModel: true, diagnostics: { textModel: "fake-session" },
    async generate() { return ""; },
    async generateJson(prompt) {
      consolidationCalls += 1;
      assert.match(prompt, /所有 sensing 成功的片段/);
      for (const observation of observations) assert.match(prompt, new RegExp(observation.slice(0, 12)));
      return { kind: "lecture", title: "海外中文产品路演", summary: "讲座介绍了一款帮助海外用户在真实来华场景中学习和使用中文的 AI 产品，包括场景对话、发音纠正、MVP 验证、订阅与机构合作模式、七月底双端上线计划，以及海外推广资源需求。", shouldRemember: true, memoryText: "我陪你听完了一场海外中文学习产品路演：产品用打车、点餐等真实场景提供 AI 语音文字互动和发音纠正，已完成 MVP 并获得早期海外用户反馈，计划七月底上线 iOS/Android，以免费版和 Pro 订阅为主并探索 B 端合作，目前最需要海外推广与投流资源。", importanceReason: "完整讲座包含产品定位、验证、商业模式、时间计划和资源需求，值得以后回顾。", tags: ["路演", "AI", "中文学习", "海外推广"] };
    },
    async summarizeImage() { return ""; },
    async observeAudio() { return ""; },
    async generateImage() { throw new Error("not used"); }
  };

  const result = await runCompanionSessionSweep(store, provider, "2026-07-12T10:20:00.000Z");
  assert.deepEqual(result, { checked: 1, completed: 1, failed: 0 });
  let saved = await store.getProfile("lecture-user");
  assert.equal(saved?.companionSessions?.length, 1);
  assert.equal(saved?.companionSessions?.[0].status, "completed");
  assert.equal(saved?.episodes.filter((episode) => episode.sourceBatchId === "native-lecture").length, 1);
  assert.equal(saved?.longTermMemories.filter((memory) => memory.id.startsWith("ltm_session_")).length, 1);
  assert.match(saved?.longTermMemories.find((memory) => memory.id.startsWith("ltm_session_"))?.text ?? "", /MVP/);
  assert.equal(saved?.conversation.filter((message) => message.id.startsWith("msg_session_")).length, 1);
  assert.match(saved?.conversation.find((message) => message.id.startsWith("msg_session_"))?.text ?? "", /从头到尾整理好了/);

  const second = await runCompanionSessionSweep(store, provider, "2026-07-12T10:30:00.000Z");
  saved = await store.getProfile("lecture-user");
  assert.deepEqual(second, { checked: 0, completed: 0, failed: 0 });
  assert.equal(consolidationCalls, 1);
  assert.equal(saved?.longTermMemories.filter((memory) => memory.id.startsWith("ltm_session_")).length, 1);
  assert.equal(saved?.conversation.filter((message) => message.id.startsWith("msg_session_")).length, 1);
});

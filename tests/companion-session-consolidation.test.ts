import assert from "node:assert/strict";
import test from "node:test";
import { createCreatureProfile } from "../src/core/profile";
import type { ModelProvider } from "../src/core/provider";
import type { StreamSegment } from "../src/core/types";
import { createApp } from "../src/server/app";
import { collectCompanionTurn, processCompanionTurnContext, runCompanionSessionSweep } from "../src/server/companion-session";
import { MemoryProfileStore } from "../src/server/store";
import { PersistentTurnWorker } from "../src/server/turn-worker";

const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function segment(id: string, content: string, observedAt: string): StreamSegment {
  return {
    id,
    kind: "audio_observation",
    label: "后台听到的声音",
    content,
    observedAt,
    batchId: `native-lecture-${id}`,
    companionSessionId: "native-lecture",
    sensingTrace: {
      at: observedAt,
      modality: "audio",
      label: "后台听到的声音",
      provider: "fake",
      semanticSource: "llm",
      status: "content",
      decision: "content",
      observation: content,
      ruleTrace: []
    }
  };
}

test("a 15 minute lecture is tracked continuously and becomes one revisable memory", async () => {
  const store = new MemoryProfileStore();
  const profile = createCreatureProfile({ userId: "lecture-user", creatureName: "Papo", now: "2026-07-12T10:00:00.000Z" });
  const contents = [
    "讲者先介绍产品面向海外来华用户，核心问题是中文在真实生活场景中难以使用。",
    "产品用打车、点餐等场景让用户通过语音和文字与 AI 互动，并纠正发音。",
    "当前已经完成 MVP，并邀请了一批海外用户试用，早期反馈较好。",
    "商业模式包括免费版和每月订阅的 Pro 版，也考虑与机构开展 B 端合作。",
    "团队计划七月底发布 iOS 和 Android，并在积累真实反馈后继续调整。",
    "讲者最后提出当前最需要的是海外推广和投流资源。"
  ];
  contents.forEach((content, index) => {
    const observedAt = new Date(Date.parse("2026-07-12T10:00:00.000Z") + index * 3 * 60_000).toISOString();
    collectCompanionTurn(profile, `turn-${index}`, [segment(String(index + 1), content, observedAt)]);
  });
  const stored = await store.createProfile({ userId: profile.userId, creatureName: "Papo" });
  Object.assign(stored, profile);
  await store.saveProfile(stored);

  let consolidationCalls = 0;
  const provider: ModelProvider = {
    kind: "generic", name: "continuous event fake", available: true, usesRealModel: true,
    async generate() { return ""; },
    async generateJson(prompt) {
      if (prompt.includes("共同回忆编辑和视觉导演")) return {
        shortTitle: "中文路演", narrative: "我记得陪你听完这场产品路演，也理解了它的定位、验证和推广需求。",
        visualMode: "symbolic_cover", papoPresence: "absent", visualReason: "讲座适合用知识结构的象征封面表达",
        imagePrompt: "Square editorial illustration of language learning, product validation, subscriptions and global communities, clearly illustrated, no people, no pet, no text.",
        relatedMemoryIds: [], needsClientReferences: false
      };
      if (prompt.includes("Client.md 维护脑")) return { facts: [] };
      if (prompt.includes("连续生活事件归属脑")) {
        const observations = contents.map((content, index) => ({
          segmentId: String(index + 1),
          role: "scene_evidence",
          transition: index ? "continue" : "start",
          eventKind: "lecture",
          eventTitle: "海外中文产品路演",
          segmentSummary: content,
          updatedEventSummary: contents.slice(0, index + 1).join(" "),
          importantFacts: [content],
          reason: index ? "主题和讲者脉络持续一致" : "连续讲座开始"
        }));
        return { assignments: observations, currentContext: { activity: "正在听产品路演", rollingSummary: contents.join(" "), importantContent: contents, recentUserNotes: [] } };
      }
      consolidationCalls += 1;
      assert.match(prompt, /只整理给定 event/);
      for (const content of contents) assert.match(prompt, new RegExp(content.slice(0, 12)));
      return {
        kind: "lecture", title: "海外中文产品路演",
        summary: "讲座介绍了海外中文场景学习产品的定位、MVP、商业模式、上线计划和推广需求。",
        shouldRemember: true,
        memoryText: consolidationCalls === 1
          ? "我陪你听完海外中文产品路演：产品已完成 MVP，计划七月底上线双端，以订阅和机构合作商业化，目前需要海外推广资源。"
          : "我陪你听完并补充整理了海外中文产品路演：产品已完成 MVP，计划七月底上线双端，以订阅和机构合作商业化，目前需要海外推广资源；会后还补充了首批试点数据。",
        importanceReason: "完整讲座包含产品定位、验证、商业模式和后续计划。",
        tags: ["路演", "AI", "中文学习"]
      };
    },
    async summarizeImage() { return ""; },
    async observeAudio() { return ""; },
    async generateImage() { return { dataUrl: IMAGE, mime: "image/png" }; }
  };

  const first = await runCompanionSessionSweep(store, provider, "2026-07-12T10:20:00.000Z");
  assert.deepEqual(first, { checked: 2, completed: 1, failed: 0 });
  let saved = await store.getProfile(profile.userId);
  const event = saved?.companionSessions?.[0].events?.[0];
  assert.equal(event?.status, "completed");
  assert.equal(event?.sourceSegmentIds.length, 6);
  assert.equal(saved?.episodes.filter((episode) => episode.id.startsWith("episode_companion_event_")).length, 1, JSON.stringify(saved?.episodes.map((episode) => episode.id)));
  assert.equal(saved?.longTermMemories.filter((memory) => memory.id.startsWith("ltm_companion_event_")).length, 1);
  assert.equal(saved?.conversation.filter((message) => message.id.startsWith("msg_companion_event_")).length, 1);
  const lifecycleJob = saved?.jobs?.find((job) => job.memoryId === saved?.longTermMemories[0]?.id);
  assert.equal(lifecycleJob?.type, "memory_enrichment");
  const app = createApp({ store, provider, proactive: { enabled: false }, turns: { autoStart: false }, nativeIngest: { autoStart: false } });
  const worker = app.locals.turnWorker as PersistentTurnWorker;
  await worker.drainOnce();
  saved = await store.getProfile(profile.userId);
  const enrichedLecture = saved?.longTermMemories.find((memory) => memory.id.startsWith("ltm_companion_event_"));
  assert.equal(enrichedLecture?.visualStatus, "ready");
  assert.equal(enrichedLecture?.visualMode, "symbolic_cover");
  assert.equal(enrichedLecture?.papoPresence, "absent");
  assert.equal(enrichedLecture?.visual?.jobId, lifecycleJob?.id);
  worker.stop();

  const supplement = segment("7", "会后补充：首批试点将覆盖三个海外社群。", "2026-07-12T10:25:00.000Z");
  collectCompanionTurn(saved!, "turn-7", [supplement]);
  await store.saveProfile(saved!);
  const existingEventId = event!.id;
  provider.generateJson = async (prompt) => {
    if (prompt.includes("连续生活事件归属脑")) return {
      assignments: [{
        segmentId: "7", role: "context_note", transition: "resume", targetEventId: existingEventId,
        eventKind: "lecture", eventTitle: "海外中文产品路演", segmentSummary: supplement.content,
        updatedEventSummary: `${event!.summary} ${supplement.content}`, importantFacts: [supplement.content], reason: "这是同一场路演的会后补充"
      }],
      currentContext: { activity: "路演会后补充", rollingSummary: supplement.content, importantContent: [supplement.content], recentUserNotes: [] }
    };
    consolidationCalls += 1;
    return {
      kind: "lecture", title: "海外中文产品路演", summary: "路演及会后补充已完整整理。", shouldRemember: true,
      memoryText: "我陪你听完海外中文产品路演，内容覆盖产品定位、MVP、商业化和推广需求；会后补充首批试点覆盖三个海外社群。",
      importanceReason: "原事件获得了有价值的会后补充。", tags: ["路演", "试点"]
    };
  };
  await processCompanionTurnContext(store, provider, profile.userId, "turn-7");
  const second = await runCompanionSessionSweep(store, provider, "2026-07-12T10:30:00.000Z");
  saved = await store.getProfile(profile.userId);
  assert.equal(second.completed, 1);
  assert.equal(saved?.companionSessions?.[0].events?.length, 1);
  assert.equal(saved?.longTermMemories.filter((memory) => memory.id.startsWith("ltm_companion_event_")).length, 1);
  assert.match(saved?.longTermMemories.find((memory) => memory.id.startsWith("ltm_companion_event_"))?.text ?? "", /三个海外社群/);
  assert.equal(saved?.conversation.filter((message) => message.id.startsWith("msg_companion_event_")).length, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createCreatureProfile } from "../src/core/profile";
import type { ModelProvider } from "../src/core/provider";
import type { StreamSegment } from "../src/core/types";
import { collectCompanionTurn, companionCognitionContext, processCompanionTurnContext, runCompanionSessionSweep } from "../src/server/companion-session";
import { MemoryProfileStore } from "../src/server/store";

test("one companion session keeps multimodal scenes and alternating events separate", async () => {
  const store = new MemoryProfileStore();
  const profile = createCreatureProfile({ userId: "multi-event", creatureName: "Papo", now: "2026-07-12T12:00:00.000Z" });
  const sessionId = "native-2000000000000";
  const calls: Array<{ assignments: unknown[]; currentContext: unknown }> = [
    {
      assignments: [
        assignment("lunch-text", "context_note", "start", "meal", "午饭", "用户说午饭很好吃"),
        assignment("lunch-photo", "scene_evidence", "continue", "meal", "午饭", "照片里是午饭餐盘"),
        assignment("lunch-audio", "scene_evidence", "continue", "meal", "午饭", "同期有餐厅环境声")
      ],
      currentContext: context("正在吃午饭", "用户正在吃午饭，觉得味道很好", ["午饭很好吃"])
    },
    {
      assignments: [{ ...assignment("lecture-note", "context_setting", "switch", "lecture", "技术讲座", "用户说明接下来要听讲座"), switchDisposition: "complete" }],
      currentContext: context("正在听讲座", "午饭结束，接下来开始听技术讲座", ["接下来我要听讲座"])
    },
    {
      assignments: [assignment("lecture-audio-1", "scene_evidence", "continue", "lecture", "技术讲座", "讲者介绍端侧模型")],
      currentContext: context("正在听讲座", "讲者正在介绍端侧模型", ["接下来我要听讲座"])
    },
    {
      assignments: [{ ...assignment("noise", "noise", "unrelated", "ambient", "无关声音", "门外短暂施工噪音"), importantFacts: [] }],
      currentContext: context("不应采用", "噪音不应覆盖上下文", [])
    },
    {
      assignments: [assignment("pause", "context_setting", "pause", "lecture", "技术讲座", "讲座进入中场休息")],
      currentContext: context("中场休息", "技术讲座暂时休息", ["现在中场休息"])
    },
    {
      assignments: [assignment("resume", "context_setting", "resume", "lecture", "技术讲座", "第二位发言人继续讲座")],
      currentContext: context("继续听讲座", "第二位发言人开始分享", ["这是第二位发言人"])
    },
    {
      assignments: [assignment("lecture-end", "context_setting", "end", "lecture", "技术讲座", "用户说明讲座结束")],
      currentContext: context("讲座结束", "技术讲座已经结束", ["讲座结束了"])
    }
  ];
  const provider: ModelProvider = {
    kind: "generic", name: "event state fake", available: true, usesRealModel: true,
    async generate() { return ""; },
    async generateJson(prompt) {
      if (prompt.includes("连续生活事件归属脑")) {
        const next = calls.shift();
        assert.ok(next, "unexpected assignment call");
        if (String(next.assignments).includes("lecture-audio-1")) assert.match(prompt, /接下来我要听讲座/);
        return next;
      }
      const lecture = !prompt.includes('"kind":"meal"');
      if (lecture) {
        assert.match(prompt, /audioSourceType=device_playback/);
        assert.match(prompt, /不得据此推导“用户认为\/用户说\/用户偏好”/);
      }
      return lecture
        ? { kind: "lecture", title: "技术讲座", summary: "用户当时播放的媒体讲座围绕端侧模型展开，并由第二位发言人继续分享。", shouldRemember: true, memoryText: "用户当时播放的媒体讲座讨论了端侧模型，中场休息后由第二位发言人继续；这是媒体内容，不代表用户本人观点。", importanceReason: "完整且连续的技术学习经历。", tags: ["讲座", "端侧模型"] }
        : {
            kind: "meal", title: "一顿好吃的午饭", summary: "用户主动分享了午饭照片、说明和同期餐厅声音。",
            memoryDisposition: "candidate", memoryText: "我记得你主动让我看了这顿午饭：餐盘里有米饭和蔬菜，你说很好吃。",
            memoryKind: "long_theme", confidence: 72, writePolicy: "wait_feedback", userIntent: "希望 Papo 看见并分享这顿午饭",
            importanceReason: "这是用户主动选择取景的生活片段，先作为候选等待确认。", tags: ["午饭", "主动分享"]
          };
    },
    async summarizeImage() { return ""; }, async observeAudio() { return ""; }, async generateImage() { throw new Error("not used"); }
  };
  const created = await store.createProfile({ userId: profile.userId, creatureName: "Papo" });
  Object.assign(created, profile);
  await store.saveProfile(created);

  await addTurn(store, profile.userId, sessionId, "turn-lunch", [
    stream("lunch-text", "text", "这是我吃的午饭，很好吃", "2026-07-12T12:00:00.000Z", sessionId),
    { ...stream("lunch-photo", "image_summary", "餐盘里有米饭和蔬菜", "2026-07-12T12:00:10.000Z", sessionId), captureIntent: "user_initiated" },
    stream("lunch-audio", "audio_observation", "能听见餐具和餐厅交谈声", "2026-07-12T12:00:20.000Z", sessionId)
  ], provider);
  let saved = await store.getProfile(profile.userId);
  assert.equal(saved?.companionSessions?.[0].events?.length, 1);
  assert.equal(saved?.companionSessions?.[0].events?.[0].sourceSegmentIds.length, 3);

  await addTurn(store, profile.userId, sessionId, "turn-note", [stream("lecture-note", "text", "接下来我要听讲座", "2026-07-12T12:05:00.000Z", sessionId)], provider);
  await addTurn(store, profile.userId, sessionId, "turn-audio", [{
    ...stream("lecture-audio-1", "audio_observation", "[speaker_1] 讲者介绍端侧模型的部署方式", "2026-07-12T12:07:00.000Z", sessionId),
    devicePlaybackActive: true,
    echoCancellationRequested: true,
    audioInputSource: "voice_communication",
    sensingTrace: {
      at: "2026-07-12T12:07:00.000Z", modality: "audio", label: "本机媒体", provider: "fake", semanticSource: "llm",
      status: "content", decision: "检测为本机媒体播放", observation: "[speaker_1] 讲者介绍端侧模型的部署方式",
      audioContent: { sceneType: "lecture", sourceType: "device_playback", transcript: "[speaker_1] 讲者介绍端侧模型的部署方式", speakers: [] },
      ruleTrace: []
    }
  }], provider);
  saved = await store.getProfile(profile.userId);
  assert.match(companionCognitionContext(saved!, "turn-audio")?.currentContext ?? "", /端侧模型/);

  const contextBeforeNoise = saved?.companionSessions?.[0].currentContext?.rollingSummary;
  await addTurn(store, profile.userId, sessionId, "turn-noise", [stream("noise", "audio_observation", "门外突然有一阵施工声", "2026-07-12T12:08:00.000Z", sessionId)], provider);
  saved = await store.getProfile(profile.userId);
  assert.equal(saved?.companionSessions?.[0].currentContext?.rollingSummary, contextBeforeNoise);
  assert.equal(saved?.companionSessions?.[0].observations.find((item) => item.segmentId === "noise")?.assignmentStatus, "ignored");

  await addTurn(store, profile.userId, sessionId, "turn-pause", [stream("pause", "text", "现在中场休息", "2026-07-12T12:10:00.000Z", sessionId)], provider);
  saved = await store.getProfile(profile.userId);
  const lectureId = saved?.companionSessions?.[0].events?.find((event) => event.kind === "lecture")?.id;
  assert.equal(saved?.companionSessions?.[0].events?.find((event) => event.id === lectureId)?.status, "paused");
  calls[0].assignments = [{ ...(calls[0].assignments[0] as object), targetEventId: lectureId }];
  await addTurn(store, profile.userId, sessionId, "turn-resume", [stream("resume", "text", "这是第二位发言人", "2026-07-12T12:15:00.000Z", sessionId)], provider);
  await addTurn(store, profile.userId, sessionId, "turn-end", [stream("lecture-end", "text", "讲座结束了", "2026-07-12T12:20:00.000Z", sessionId)], provider);

  const result = await runCompanionSessionSweep(store, provider, "2026-07-12T12:21:00.000Z");
  saved = await store.getProfile(profile.userId);
  assert.equal(result.completed, 2);
  assert.equal(saved?.companionSessions?.[0].events?.length, 2);
  assert.equal(saved?.episodes.filter((episode) => episode.id.startsWith("episode_companion_event_")).length, 2);
  assert.equal(saved?.longTermMemories.filter((memory) => memory.id.startsWith("ltm_companion_event_")).length, 1);
  assert.match(saved?.longTermMemories.find((memory) => memory.id.startsWith("ltm_companion_event_"))?.text ?? "", /媒体内容，不代表用户本人观点/);
  assert.equal(saved?.companionSessions?.[0].events?.find((event) => event.id === lectureId)?.transcript[0]?.sourceType, "device_playback");
  assert.equal(saved?.episodes.find((episode) => episode.sourceBatchId === lectureId)?.audioSourceType, "device_playback");
  const mealEpisode = saved?.episodes.find((episode) => episode.tags.includes("午饭"));
  assert.equal(mealEpisode?.tags.includes("用户主动取景"), true);
  assert.equal(mealEpisode?.captureIntent, "user_initiated");
  assert.equal(mealEpisode?.weight, 72, "manual capture evidence raises a candidate episode without forcing long-term memory");
  const mealCandidate = saved?.memoryCandidates.find((candidate) => candidate.sourceEpisodeId === mealEpisode?.id);
  assert.ok(mealCandidate);
  assert.equal(mealCandidate?.writePolicy, "wait_feedback");
  assert.match(mealCandidate?.candidateText ?? "", /主动让我看了这顿午饭/);
  assert.equal(saved?.longTermMemories.some((memory) => memory.sourceEpisodeId === mealEpisode?.id), false);
  await runCompanionSessionSweep(store, provider, "2026-07-12T12:22:00.000Z");
  saved = await store.getProfile(profile.userId);
  assert.equal(saved?.memoryCandidates.filter((candidate) => candidate.id === mealCandidate?.id).length, 1, "a repeated sweep cannot duplicate the event candidate");
  assert.equal(saved?.companionSessions?.[0].events?.find((event) => event.id === lectureId)?.sourceSegmentIds.length, 5);
});

function assignment(segmentId: string, role: string, transition: string, eventKind: string, eventTitle: string, summary: string) {
  return { segmentId, role, transition, eventKind, eventTitle, segmentSummary: summary, updatedEventSummary: summary, importantFacts: [summary], reason: "语义与当前场景一致" };
}

function context(activity: string, rollingSummary: string, recentUserNotes: string[]) {
  return { activity, rollingSummary, importantContent: [rollingSummary], recentUserNotes };
}

function stream(id: string, kind: StreamSegment["kind"], content: string, observedAt: string, companionSessionId: string): StreamSegment {
  return { id, kind, label: id, content, observedAt, batchId: `${companionSessionId}-${id}`, companionSessionId };
}

async function addTurn(store: MemoryProfileStore, userId: string, sessionId: string, turnId: string, segments: StreamSegment[], provider: ModelProvider) {
  await store.updateProfile(userId, (profile) => collectCompanionTurn(profile, turnId, segments.map((segment) => ({ ...segment, companionSessionId: sessionId }))));
  const result = await processCompanionTurnContext(store, provider, userId, turnId);
  assert.equal(result.processed, segments.length);
}

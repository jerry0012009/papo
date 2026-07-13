import assert from "node:assert/strict";
import test from "node:test";
import { runButtonHarness, runCuriousHarness } from "../src/core/harness";
import { createCreatureProfile } from "../src/core/profile";
import type { ModelProvider } from "../src/core/provider";
import type { CognitionContext, HermesTaskRecord, StreamSegment } from "../src/core/types";

type Scenario = {
  expectsResponse: boolean;
  attention: "select" | "ignore";
  action: "respond" | "listen_silently" | "use_hermes" | "generate_action_card";
  keepEpisode?: boolean;
  considerMemory?: boolean;
  memoryText?: string;
};

function providerFor(scenario: Scenario): ModelProvider {
  return {
    kind: "generic",
    name: "Deterministic cognition provider",
    available: true,
    usesRealModel: true,
    diagnostics: { textModel: "fake-cognition-source" },
    async generate() { return ""; },
    async generateJson(prompt) {
      if (prompt.includes("注意决策脑")) {
        const segmentId = [...prompt.matchAll(/"segmentId":"([^"]+)"/g)].at(-1)?.[1];
        assert.ok(segmentId);
        if (scenario.attention === "ignore") return { shouldAttend: false, selected: [], ignored: [{ segmentId, whyIgnored: "没有可用环境信息" }], creatureReport: "环境里没有值得打断用户的内容" };
        return {
          shouldAttend: true,
          selected: [{
            segmentId,
            whySelected: "这是完整可用的输入",
            noticed: "Papo 听见了这段表达",
            userMeaning: scenario.expectsResponse ? "对方明确期待 Papo 处理" : "对方只是在记录当下感受",
            addressedToPapo: scenario.expectsResponse,
            expectsResponse: scenario.expectsResponse,
            relatedMemoryIds: [],
            tags: ["测试"]
          }],
          ignored: []
        };
      }
      if (prompt.includes("行动选择脑")) {
        const eventId = [...prompt.matchAll(/"id":"([^"]+)"/g)].at(-1)?.[1];
        assert.ok(eventId);
        const speaking = scenario.action !== "listen_silently";
        return {
          decisions: [{
            eventId,
            action: scenario.action,
            noticed: "Papo 已经感知输入",
            userIntent: scenario.expectsResponse ? "请求回应" : "记录感受",
            reason: speaking ? "应当回应或执行" : "安静陪伴更自然",
            stateDeltas: {},
            shouldCreateEpisode: scenario.keepEpisode ?? true,
            shouldConsiderMemory: scenario.considerMemory ?? false,
            shouldReply: speaking,
            reply: speaking ? "我听见了。" : undefined,
            actionResult: scenario.action === "use_hermes"
              ? { kind: "hermes_task", title: "外部查询", text: "请完成这项外部查询。" }
              : scenario.action === "generate_action_card"
                ? { kind: "action_card_draft", title: "环境动作", prompt: "让 Papo 在环境里轻轻摇尾巴", stateId: "desk_companion", statusText: "Papo 正轻轻陪着你。" }
              : undefined,
            memoryCandidateText: scenario.memoryText,
            memoryTags: ["测试"]
          }]
        };
      }
      if (prompt.includes("记忆决策脑")) {
        const candidateId = prompt.match(/"candidateId":"([^"]+)"/)?.[1];
        assert.ok(candidateId);
        return { candidates: [{ candidateId, shouldKeepCandidate: true, candidateText: scenario.memoryText ?? "外部任务得到了有长期价值的新事实", shortTitle: "任务结果", memoryKind: "long_theme", confidence: 85, writePolicy: "auto", whyConsolidate: "请求和结果合起来有长期价值", decayPolicy: "stable", tags: ["任务"] }] };
      }
      throw new Error("unexpected fake provider prompt");
    },
    async summarizeImage() { return ""; },
    async observeAudio() { return ""; },
    async generateImage() { throw new Error("not used"); }
  };
}

function segment(id: string, content: string): StreamSegment {
  return { id, kind: "text", label: "输入", content, semanticSource: "llm", status: "content", decision: "prepared", ruleTrace: [] };
}

test("direct input is perceived and may legally listen silently while keeping only an episode", async () => {
  const profile = createCreatureProfile({ userId: "direct-silent", creatureName: "Papo" });
  const result = await runButtonHarness(profile, "今天有点累，只是想记下来。", providerFor({ expectsResponse: false, attention: "select", action: "listen_silently", considerMemory: false }));
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].cognitionSource, "direct");
  assert.equal(result.events[0].actionDecision.action, "listen_silently");
  assert.equal(result.response, "");
  assert.equal(result.episodes.length, 1);
  assert.equal(result.memoryCandidates?.length, 0);
  assert.equal(profile.longTermMemories.length, 0);
});

test("direct input expecting a response cannot be converted into silent companionship", async () => {
  const profile = createCreatureProfile({ userId: "direct-question", creatureName: "Papo" });
  await assert.rejects(
    runButtonHarness(profile, "可以帮我回答这个问题吗？", providerFor({ expectsResponse: true, attention: "select", action: "listen_silently" })),
    /expects a response cannot select a silent action/
  );
  assert.equal(profile.episodes.length, 1, "Attention perceived the direct input before Action rejected an invalid silent choice");
});

test("ambient attention may ignore every candidate", async () => {
  const profile = createCreatureProfile({ userId: "ambient-ignore", creatureName: "Papo" });
  const result = await runCuriousHarness(profile, [segment("ambient-1", "持续的空调背景声")], providerFor({ expectsResponse: false, attention: "ignore", action: "listen_silently" }), undefined, { inputSource: "ambient" });
  assert.equal(result.events.length, 0);
  assert.equal(result.episodes.length, 0);
});

test("ambient cognition defers action cards to the budgeted emergence flow", async () => {
  const profile = createCreatureProfile({ userId: "ambient-card", creatureName: "Papo" });
  const result = await runCuriousHarness(profile, [segment("ambient-card-1", "陪伴画面里出现了一个普通生活片段")], providerFor({ expectsResponse: true, attention: "select", action: "generate_action_card" }), undefined, {
    inputSource: "ambient",
    companion: { sessionId: "companion-test", currentContext: "持续陪伴中", recentUserNotes: [], recentObservationSummaries: [] }
  });
  assert.equal(result.events[0].actionDecision.action, "acknowledge");
  assert.equal(result.events[0].actionResult?.kind, "visible_reply");
  assert.deepEqual(result.events[0].backgroundActions, []);
  assert.ok(result.events[0].decisionTrace?.includes("guardrail: ambient action card deferred to proactive emergence"));
});

test("Hermes task_result links its task and original episode and updates one long-term memory across retry", async () => {
  const profile = createCreatureProfile({ userId: "task-result", creatureName: "Papo" });
  const request = await runButtonHarness(profile, "请让 Hermes 帮我查这项长期计划。", providerFor({ expectsResponse: true, attention: "select", action: "use_hermes", considerMemory: false }));
  const sourceEvent = request.events[0];
  const sourceEpisode = request.episodes[0];
  assert.ok(sourceEvent && sourceEpisode);
  const task: HermesTaskRecord = {
    id: "hermes_task_linked",
    createdAt: "2026-07-12T10:00:00.000Z",
    updatedAt: "2026-07-12T10:00:00.000Z",
    status: "sent",
    task: "查询这项长期计划",
    sourceEventId: sourceEvent.id,
    sourceEpisodeId: sourceEpisode.id
  };
  profile.hermes.tasks.unshift(task);
  const context: CognitionContext = { inputSource: "task_result", taskId: task.id, sourceEventId: sourceEvent.id, sourceEpisodeId: sourceEpisode.id };

  const first = await runCuriousHarness(profile, [segment("result-1", "Hermes 返回了计划的关键进展。")], providerFor({ expectsResponse: true, attention: "select", action: "respond", considerMemory: true, memoryText: "这项长期计划已有关键进展" }), undefined, context);
  assert.equal(first.events[0].sourceTaskId, task.id);
  assert.equal(first.episodes[0].parentEpisodeId, sourceEpisode.id);
  assert.equal(profile.longTermMemories.length, 1);
  assert.equal(profile.longTermMemories[0].sourceEpisodeId, sourceEpisode.id);

  await runCuriousHarness(profile, [segment("result-2", "同一任务重试返回相同进展。")], providerFor({ expectsResponse: true, attention: "select", action: "respond", considerMemory: true, memoryText: "这项长期计划已有关键进展" }), undefined, context);
  assert.equal(profile.longTermMemories.length, 1, "task_result retry must update, not duplicate, the request memory");
});

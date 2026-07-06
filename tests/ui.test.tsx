import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/App";

describe("App", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the core mobile-first workbench", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/provider")) return json({ kind: "fallback", name: "Fallback demo brain", available: true, usesRealModel: false });
      if (url.endsWith("/api/profiles") && init?.method === "POST") {
        return json({ profile: profileFixture() }, 201);
      }
      if (url.endsWith("/api/profiles/u1/wake")) {
        return json({
          profile: profileFixture(),
          wake: {
            id: "wake1",
            at: new Date().toISOString(),
            elapsedMinutes: 0,
            message: "我刚刚醒着，你一打开我就还在这里。",
            innerThought: "我醒来时自己又想到妈妈复查这件事。",
            relatedMemoryIds: ["m2"],
            emergenceId: "emergence1",
            stateChangeReason: "app_wake_short_gap",
            stateDelta: {},
            ruleTrace: ["elapsed_minutes=0", "state_delta=none"]
          }
        });
      }
      if (url.endsWith("/api/profiles/u1/feedback")) {
        return json({
          profile: profileWithFeedback(),
          feedback: {
            id: "feedback1",
            at: new Date().toISOString(),
            kind: "continue",
            targetId: "episode1",
            inputText: "这里请多想一点",
            inputModality: "text",
            effect: "用户让我继续想，所以我以后会更愿意展开关联和推理。",
            learningNote: "我学到：这个主题你希望我不要浅浅带过。你还补充说：这里请多想一点。",
            stateDeltas: [{ key: "curiosity", before: 66, after: 74, delta: 8 }],
            policyDeltas: [{ key: "preferDepth", before: 45, after: 53, delta: 8 }]
          }
        });
      }
      if (url.endsWith("/api/profiles/u1/button")) {
        return json({
          profile: profileWithChatInput(),
          events: [],
          episodes: [],
          response: "我先试着理解：你刚才说的这件事会进入我们的对话和注意流。",
          memoryCandidates: [],
          harnessTrace: ["sense: button", "semantic: fallback/rules only"],
          provider: "fallback"
        });
      }
      if (url.endsWith("/api/profiles")) return json({ profiles: [] });
      return json({ profile: profileFixture() });
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Papo")).toBeInTheDocument());
    expect(screen.getByLabelText("Papo 是一只卡通柴犬")).toBeInTheDocument();
    expect(screen.getByText("当前心情")).toBeInTheDocument();
    expect(screen.getByText("会先观察，再决定要不要靠近")).toBeInTheDocument();
    expect(screen.getByText("Papo 刚动了一下")).toBeInTheDocument();
    expect(screen.getByText("我醒来时自己又想到妈妈复查这件事。")).toBeInTheDocument();
    expect(screen.queryByText("Papo 新说")).not.toBeInTheDocument();
    expect(screen.queryByText("桌面提醒")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("有未读 Papo 回复")).not.toBeInTheDocument();
    expect(screen.getByText("来自半分钟里的一小段")).toBeInTheDocument();
    expect(screen.getByText("单次输入")).toBeInTheDocument();
    expect(screen.getByText("陪我一会儿")).toBeInTheDocument();

    await userEvent.type(screen.getByPlaceholderText("也可以告诉 Papo：为什么对、为什么不想要、要怎么记"), "这里请多想一点");
    await userEvent.click(screen.getByRole("button", { name: "继续想" }));
    expect(await screen.findByText("这次养成变化")).toBeInTheDocument();
    expect(screen.getByText("你还补充了：这里请多想一点")).toBeInTheDocument();
    expect(screen.getByText("好奇心 +8")).toBeInTheDocument();
    expect(screen.getByText("深入倾向 +8")).toBeInTheDocument();
    expect(screen.queryByText("Papo 新说")).not.toBeInTheDocument();
    expect(screen.queryByText("桌面提醒")).not.toBeInTheDocument();
    expect(screen.getByLabelText("有未读 Papo 回复")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "单次输入" }));
    expect(screen.getByText("对话和注意流")).toBeInTheDocument();
    expect(screen.queryByLabelText("有未读 Papo 回复")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("直接告诉 Papo 一件刚发生的事")).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("直接告诉 Papo 一件刚发生的事"), "刚刚医生确认复查时间改到周六上午。");
    await userEvent.click(screen.getByRole("button", { name: "说给 Papo" }));
    expect(await screen.findByText("刚刚医生确认复查时间改到周六上午。")).toBeInTheDocument();
    expect(screen.queryByText("认真注意后")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "首页" }));
    expect(screen.queryByText(/sense: button/)).not.toBeInTheDocument();
    expect(screen.queryByText(/semantic: fallback/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "陪我" }));
    expect(screen.getByText("Curious Mode")).toBeInTheDocument();
    expect(screen.getByText("Curious 录音感知")).toBeInTheDocument();
    expect(screen.getByText("上传截图生成摘要")).toBeInTheDocument();
    expect(screen.getByText("上传录音转写")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "对话" }));
    expect(screen.getByText("对话和注意流")).toBeInTheDocument();
    expect(screen.getByText("3 条注意素材")).toBeInTheDocument();
    expect(screen.getByText("3 条 Papo 回应")).toBeInTheDocument();
    expect(screen.getByText("半分钟里的一小段")).toBeInTheDocument();
    expect(screen.getByText("1 条小素材")).toBeInTheDocument();
    expect(screen.queryByText("manual-1 · 1 条素材")).not.toBeInTheDocument();
    expect(screen.getByText(/和这一小段世界放在一起/)).toBeInTheDocument();
    expect(screen.getByText("你的反馈")).toBeInTheDocument();
    expect(screen.getByText(/你在教它/)).toBeInTheDocument();
    expect(screen.getAllByText("Papo").length).toBeGreaterThan(1);
    expect(screen.getByText("你给 Papo 看了照片")).toBeInTheDocument();
    expect(screen.getByText("我刚刚醒着，你一打开我就还在这里。")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "记忆" }));
    expect(screen.getByText("Papo 记得的事")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("找一段 Papo 记得的事")).toBeInTheDocument();
    expect(screen.getByText("Papo 关于自己的小记忆")).toBeInTheDocument();
    expect(screen.getByText("刚一起经历过的片段")).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.textContent === "这段它记得比较清楚 · 以后可能还会回来")).toBeInTheDocument();
    expect(screen.queryByText("future_review · 权重 80")).not.toBeInTheDocument();
    expect(screen.getAllByText("来自半分钟里的一小段").length).toBeGreaterThan(0);
    expect(screen.queryByText(/批次 manual-1/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "脑态" }));
    expect(screen.getByText("最近变化")).toBeInTheDocument();
    expect(screen.getByText("语义脑诊断")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "演示" }));
    expect(screen.getByText("演示模式")).toBeInTheDocument();
    expect(screen.getByText("一键准备 4 分钟演示")).toBeInTheDocument();
    expect(screen.getByText("场景 1：填入 8 段信息流")).toBeInTheDocument();
    expect(screen.queryByText("后续任务")).not.toBeInTheDocument();
  });
});

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

function profileFixture() {
  return {
    userId: "u1",
    creatureName: "Papo",
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    state: {
      curiosity: 66,
      attachment: 42,
      energy: 72,
      arousal: 45,
      safety: 58,
      confidence: 48,
      mood: "curious"
    },
    episodes: [
      {
        id: "episode1",
        createdAt: new Date().toISOString(),
        source: "curious_stream",
        sourceSegmentId: "segment-photo",
        sourceBatchId: "manual-1",
        sourceObservedAt: "2026-07-06T10:00:00.000Z",
        sourceLocation: { latitude: 52.52, longitude: 13.405, accuracy: 30, label: "上传时的位置" },
        inputSummary: "日历照片：妈妈周五复查，需要提前准备病历。",
        noticed: "我注意到妈妈复查需要提前准备病历。",
        possibleIntent: "你可能希望我帮你把重要家事提前放进注意里。",
        importanceReason: "这段有未来价值，也带着一点担心。",
        relatedMemoryIds: ["m2"],
        stateSnapshot: {
          curiosity: 66,
          attachment: 42,
          energy: 72,
          arousal: 45,
          safety: 58,
          confidence: 48,
          mood: "curious"
        },
        creatureResponse: "我会先把它当作一段共同经历记下来。",
        feedback: [],
        promotedToLongTerm: false,
        memoryCandidateIds: [],
        weight: 78,
        tags: ["妈妈复查", "病历"]
      }
    ],
    longTermMemories: [
      {
        id: "m1",
        createdAt: new Date().toISOString(),
        kind: "creature_self_memory",
        text: "我正在学习注意。",
        weight: 62,
        tags: ["注意"]
      },
      {
        id: "m2",
        createdAt: new Date().toISOString(),
        kind: "future_review",
        text: "妈妈周五复查，需要提前准备病历。",
        weight: 80,
        tags: ["妈妈复查"]
      }
    ],
    feedbackHistory: [],
    stateChanges: [],
    policyProfile: {
      preferDepth: 45,
      preferProactivity: 45,
      privacySensitivity: 55,
      saveThreshold: 70,
      askThreshold: 58,
      recallTendency: 50,
      quietTendency: 35
    },
    memoryCandidates: [],
    emergenceHistory: [],
    wakeHistory: [],
    semanticBrainHistory: [
      {
        id: "semantic1",
        at: new Date().toISOString(),
        source: "button",
        providerKind: "fallback",
        providerName: "Fallback demo brain",
        status: "skipped",
        message: "fallback provider; rules handled the loop",
        ruleTrace: ["provider=fallback", "source=button", "status=skipped"]
      }
    ],
    conversation: [
      {
        id: "msg2",
        at: new Date().toISOString(),
        role: "world",
        channel: "curious",
        text: "日历照片：妈妈周五复查，需要提前准备病历。",
        sourceId: "segment-photo",
        relatedMemoryIds: [],
        modality: "image_summary",
        batchId: "manual-1",
        observedAt: "2026-07-06T10:00:00.000Z",
        location: { latitude: 52.52, longitude: 13.405, accuracy: 30, label: "上传时的位置" }
      },
      {
        id: "msg1",
        at: new Date().toISOString(),
        role: "papo",
        channel: "wake",
        text: "我刚刚醒着，你一打开我就还在这里。",
        sourceId: "wake1",
        relatedMemoryIds: []
      }
    ]
  };
}

function profileWithFeedback() {
  const profile = profileFixture();
  return {
    ...profile,
    state: { ...profile.state, curiosity: 74 },
    policyProfile: { ...profile.policyProfile, preferDepth: 53 },
    feedbackHistory: [
      {
        id: "feedback1",
        at: new Date().toISOString(),
        kind: "continue",
        targetId: "episode1",
        inputText: "这里请多想一点",
        inputModality: "text",
        effect: "用户让我继续想，所以我以后会更愿意展开关联和推理。",
        learningNote: "我学到：这个主题你希望我不要浅浅带过。你还补充说：这里请多想一点。",
        stateDeltas: [{ key: "curiosity", before: 66, after: 74, delta: 8 }],
        policyDeltas: [{ key: "preferDepth", before: 45, after: 53, delta: 8 }]
      }
    ],
    conversation: [
      {
        id: "msg4",
        at: new Date().toISOString(),
        role: "papo",
        channel: "feedback",
        text: "我学到：这个主题你希望我不要浅浅带过。你还补充说：这里请多想一点。",
        sourceId: "feedback1",
        relatedMemoryIds: []
      },
      {
        id: "msg3",
        at: new Date().toISOString(),
        role: "user",
        channel: "feedback",
        text: "继续想：这里请多想一点",
        sourceId: "feedback1:input",
        relatedMemoryIds: [],
        modality: "text",
        observedAt: new Date().toISOString()
      },
      ...profile.conversation
    ]
  };
}

function profileWithChatInput() {
  const profile = profileWithFeedback();
  return {
    ...profile,
    conversation: [
      {
        id: "msg6",
        at: new Date().toISOString(),
        role: "papo",
        channel: "button",
        text: "我先试着理解：你刚才说的这件事会进入我们的对话和注意流。",
        sourceId: "episode-chat",
        relatedMemoryIds: []
      },
      {
        id: "msg5",
        at: new Date().toISOString(),
        role: "user",
        channel: "button",
        text: "刚刚医生确认复查时间改到周六上午。",
        sourceId: "button-chat",
        relatedMemoryIds: [],
        modality: "button"
      },
      ...profile.conversation
    ]
  };
}

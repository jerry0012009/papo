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
    let curiousRequest: { segments?: Array<{ kind: string; batchId?: string; content: string }> } | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/provider")) {
        return json({
          kind: "fallback",
          name: "Fallback demo brain",
          available: true,
          usesRealModel: false,
          diagnostics: { textProvider: "fallback", visionProvider: "fallback", audioProvider: "fallback", audioRoute: "fallback" }
        });
      }
      if (url.endsWith("/api/image-summary")) {
        return json({ summary: "照片里是周五复查的日历备注，写着提前准备病历。", provider: "fallback", semanticSource: "fallback" });
      }
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
            stateDeltas: [
              { key: "curiosity", before: 66, after: 74, delta: 8 },
              { key: "energy", before: 72, after: 68, delta: -4 }
            ],
            policyDeltas: [{ key: "preferDepth", before: 45, after: 53, delta: 8 }]
          }
        });
      }
      if (url.endsWith("/api/profiles/u1/button")) {
        return json({
          profile: profileWithChatInput(),
          events: [],
          episodes: [],
          response: "我先试着理解：你刚才说的这件事会和这一小段放在一起。",
          memoryCandidates: [],
          harnessTrace: ["sense: button", "semantic: fallback/rules only"],
          provider: "fallback"
        });
      }
      if (url.endsWith("/api/profiles/u1/curious")) {
        curiousRequest = JSON.parse(String(init?.body ?? "{}"));
        return json({
          profile: profileWithChatMoment(),
          events: [],
          episodes: [],
          response: "我把你刚说的话和照片放在同一小段里听了。",
          curiousSession: {
            totalSegments: 2,
            selected: [],
            ignored: [
              {
                segmentId: "chat-background",
                label: "背景小事",
                whyIgnored: "这段更像背景声，我先不抢着记住。",
                score: { privacyRisk: 0, redundancyPenalty: 0 }
              }
            ],
            stateInfluence: "我先听这一小段里真正重要的部分。"
          },
          memoryCandidates: [],
          harnessTrace: ["sense: curious_stream", "semantic: fallback/rules only"],
          provider: "fallback"
        });
      }
      if (url.endsWith("/api/profiles")) return json({ profiles: [] });
      return json({ profile: profileFixture() });
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Papo")).toBeInTheDocument());
    expect(screen.getByText("住在手机里的小狗")).toBeInTheDocument();
    expect(screen.getByText("正在陪你攒小片段")).toBeInTheDocument();
    expect(screen.queryByText("Fallback demo brain")).not.toBeInTheDocument();
    expect(screen.queryByText("Generic model API")).not.toBeInTheDocument();
    expect(screen.queryByText("LLM 语义脑已配置")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Papo 是一只卡通柴犬")).toBeInTheDocument();
    expect(screen.getByText("Papo 现在")).toBeInTheDocument();
    expect(screen.queryByText("当前心情")).not.toBeInTheDocument();
    expect(screen.queryByText(/触发了醒来节律|重新计算/)).not.toBeInTheDocument();
    expect(screen.getByText("刚收到你递来的一小段")).toBeInTheDocument();
    expect(screen.getByText("我已经接住这一小段，正在把文字、照片或声音放进同一个小情景里听。")).toBeInTheDocument();
    expect(screen.queryByText("它已经接住这一小段，正在把文字、照片或声音放进同一个小情景里听。")).not.toBeInTheDocument();
    expect(screen.queryByText(/材料|模拟一段信息流|录音分段/)).not.toBeInTheDocument();
    expect(screen.getByText("Papo 抬头看了你一眼")).toBeInTheDocument();
    expect(screen.getByText("我醒来时自己又想到妈妈复查这件事。")).toBeInTheDocument();
    expect(screen.getByLabelText("Papo 的身体信号")).toBeInTheDocument();
    expect(screen.getByText("小脑袋")).toBeInTheDocument();
    expect(screen.queryByText("依恋度")).not.toBeInTheDocument();
    expect(screen.queryByText("唤醒度")).not.toBeInTheDocument();
    expect(screen.queryByText("Papo 新说")).not.toBeInTheDocument();
    expect(screen.queryByText("桌面提醒")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("有未读 Papo 回复")).not.toBeInTheDocument();
    expect(screen.getByText("来自半分钟里的一小段")).toBeInTheDocument();
    expect(screen.getByText("跟 Papo 说")).toBeInTheDocument();
    expect(screen.getByText("陪我一会儿")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("看看哪只 Papo 在身边"));
    expect(screen.getByText("哪只 Papo 在你身边")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再养一只 Papo" })).toBeInTheDocument();
    expect(screen.queryByText("小动物切换")).not.toBeInTheDocument();
    expect(screen.queryByText("新建小动物")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("切换用户")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "首页" }));

    expect(screen.getByText("这一下你怎么养我")).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("也可以补一句：哪里懂对了、哪里先放下、要怎么记准"), "这里请多想一点");
    await userEvent.click(screen.getByRole("button", { name: "再想一会儿" }));
    expect(await screen.findByText("我这一下变了一点")).toBeInTheDocument();
    expect(screen.getByText("你刚才还告诉我：这里请多想一点")).toBeInTheDocument();
    expect(screen.getByText("下次遇到相似的小片段，我会多停一下，愿意展开一点。")).toBeInTheDocument();
    expect(screen.getByText("我刚认真用过一点力，接下来会先抱住重点。")).toBeInTheDocument();
    expect(screen.queryByText("好奇心 +8")).not.toBeInTheDocument();
    expect(screen.queryByText("深入倾向 +8")).not.toBeInTheDocument();
    expect(screen.queryByText("这次养成变化")).not.toBeInTheDocument();
    expect(screen.queryByText("下次遇到相似的小片段，它会多停一下，愿意展开一点。")).not.toBeInTheDocument();
    expect(screen.queryByText("Papo 新说")).not.toBeInTheDocument();
    expect(screen.queryByText("桌面提醒")).not.toBeInTheDocument();
    expect(screen.getByLabelText("有未读 Papo 回复")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "跟 Papo 说" }));
    expect(screen.getByText("和 Papo 的小日常")).toBeInTheDocument();
    expect(screen.queryByLabelText("有未读 Papo 回复")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("直接告诉 Papo 一件刚发生的事")).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("直接告诉 Papo 一件刚发生的事"), "刚刚医生确认复查时间改到周六上午。");
    await userEvent.click(screen.getByRole("button", { name: "说给 Papo" }));
    expect(await screen.findByText("刚刚医生确认复查时间改到周六上午。")).toBeInTheDocument();
    expect(screen.queryByText("认真注意后")).not.toBeInTheDocument();

    await userEvent.upload(screen.getByLabelText("加照片"), new File(["fake"], "复查照片.png", { type: "image/png" }));
    expect(await screen.findByText("准备一起给我听的这一小段")).toBeInTheDocument();
    expect(screen.queryByText("准备一起交给 Papo 的这一小段")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("复查照片.png")).toBeInTheDocument();
    expect(screen.getByDisplayValue("照片里是周五复查的日历备注，写着提前准备病历。")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "照片" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("直接告诉 Papo 一件刚发生的事"), "这张照片就是刚说的复查。");
    await userEvent.click(screen.getByRole("button", { name: "让 Papo 听听" }));
    await waitFor(() => expect(curiousRequest?.segments?.map((segment) => segment.kind)).toEqual(["text", "image_summary"]));
    expect(new Set(curiousRequest?.segments?.map((segment) => segment.batchId)).size).toBe(1);
    expect(await screen.findByText("我把你刚说的话和照片放在同一小段里听了。")).toBeInTheDocument();
    expect(screen.getByText("这张照片就是刚说的复查。")).toBeInTheDocument();
    expect(screen.getByText("照片里是周五复查的日历备注，写着提前准备病历。")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "首页" }));
    expect(screen.queryByText(/sense: button/)).not.toBeInTheDocument();
    expect(screen.queryByText(/semantic: fallback/)).not.toBeInTheDocument();
    expect(screen.getByText("刚才我竖起耳朵的地方")).toBeInTheDocument();
    expect(screen.getByText("我先放过了 背景小事：这段更像背景声，我先不抢着记住。")).toBeInTheDocument();
    expect(screen.queryByText("刚才 Papo 竖起耳朵的地方")).not.toBeInTheDocument();
    expect(screen.queryByText(/Papo 放过了/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "陪我" }));
    expect(screen.getByText("陪我看一小段世界")).toBeInTheDocument();
    expect(screen.getByText("陪我听一会儿")).toBeInTheDocument();
    expect(screen.getByText("加一张照片")).toBeInTheDocument();
    expect(screen.getByText("加一段录音")).toBeInTheDocument();
    expect(screen.queryByText("Curious Mode")).not.toBeInTheDocument();
    expect(screen.queryByText("Curious 录音感知")).not.toBeInTheDocument();
    expect(screen.queryByText(/image_summary|audio_transcript/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "文字" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "对话" }));
    expect(screen.getByText("和 Papo 的小日常")).toBeInTheDocument();
    expect(screen.getByText("5 条你递来的小片段")).toBeInTheDocument();
    expect(screen.getByText("4 次 Papo 回应")).toBeInTheDocument();
    expect(screen.getAllByText("半分钟里的一小段")).toHaveLength(2);
    expect(screen.getByText("2 条小片段")).toBeInTheDocument();
    expect(screen.getByText("1 条小片段")).toBeInTheDocument();
    expect(screen.queryByText("manual-1 · 1 条素材")).not.toBeInTheDocument();
    expect(screen.queryByText(/对话和注意流|注意素材|小素材|刚才的注意事件/)).not.toBeInTheDocument();
    expect(screen.queryByText(/批次 manual-1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/批次 chat-batch/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/和这一小段世界放在一起/).length).toBeGreaterThan(1);
    expect(screen.getByText("你的反馈")).toBeInTheDocument();
    expect(screen.getByText(/你在教我/)).toBeInTheDocument();
    expect(screen.queryByText(/你在教它/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Papo").length).toBeGreaterThan(1);
    expect(screen.getAllByText("你给 Papo 看了照片")).toHaveLength(2);
    expect(screen.getByText("我刚刚醒着，你一打开我就还在这里。")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "记忆" }));
    expect(screen.getByText("我还抱着的小事")).toBeInTheDocument();
    expect(screen.getByText("这里放着我和你一起攒下的小片段，我会按自己的小脑袋慢慢抱稳。")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("找找我抱着哪一段")).toBeInTheDocument();
    expect(screen.getByText("我对自己的小理解")).toBeInTheDocument();
    expect(screen.getByText("刚一起过的小片段")).toBeInTheDocument();
    expect(screen.getByText("这件以后会回来的小事，我先叼在身边：妈妈周五复查，需要提前准备病历")).toBeInTheDocument();
    expect(screen.getByText("我对自己留下一点小理解：我正在学习注意")).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.textContent === "我记得比较清楚。以后这件事可能会轻轻拽我一下。")).toBeInTheDocument();
    expect(screen.queryByText((_, element) => element?.textContent === "我记得比较清楚。它以后可能会轻轻拽我一下。")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "帮我记准" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "帮我先放下" })).toBeInTheDocument();
    expect(screen.queryByText("future_review · 权重 80")).not.toBeInTheDocument();
    expect(screen.queryByText("future_review · weight 80")).not.toBeInTheDocument();
    expect(screen.queryByText("记忆细节")).not.toBeInTheDocument();
    expect(screen.queryByText(/资料库|memory_resonance|scoreBreakdown|decisionTrace|weight \d|confidence \d|细节记录/)).not.toBeInTheDocument();
    expect(screen.getAllByText("来自半分钟里的一小段").length).toBeGreaterThan(0);
    expect(screen.queryByText(/批次 manual-1/)).not.toBeInTheDocument();
    expect(screen.queryByText("来源细节")).not.toBeInTheDocument();
    expect(screen.queryByText(/batch manual-1|segment segment-photo/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "脑态" }));
    expect(screen.getByText("最近变化")).toBeInTheDocument();
    expect(screen.getByText("模型路由")).toBeInTheDocument();
    expect(screen.getByText("语义脑诊断")).toBeInTheDocument();
    expect(screen.getByText("声音感知")).toBeInTheDocument();
    expect(screen.getAllByText("fallback").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "演示" }));
    expect(screen.getByText("带 Papo 走一圈")).toBeInTheDocument();
    expect(screen.getByText("带 Papo 完整走一圈")).toBeInTheDocument();
    expect(screen.queryByText("带它完整走一圈")).not.toBeInTheDocument();
    expect(screen.getByText("先递 8 段生活")).toBeInTheDocument();
    expect(screen.getByText("看两只 Papo 被养成不同样子")).toBeInTheDocument();
    expect(screen.getByText("问问 Papo 想到什么")).toBeInTheDocument();
    expect(screen.queryByText("先给它 8 段生活")).not.toBeInTheDocument();
    expect(screen.queryByText("问问它现在想到什么")).not.toBeInTheDocument();
    expect(screen.queryByText("演示模式")).not.toBeInTheDocument();
    expect(screen.queryByText(/场景 1|场景 2|场景 3|一键准备/)).not.toBeInTheDocument();
    expect(screen.queryByText("场景 2：生成 A/B 养成对比")).not.toBeInTheDocument();
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
        text: "再想一会儿：这里请多想一点",
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
        text: "我先试着理解：你刚才说的这件事会和这一小段放在一起。",
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

function profileWithChatMoment() {
  const profile = profileWithChatInput();
  return {
    ...profile,
    conversation: [
      {
        id: "msg9",
        at: new Date().toISOString(),
        role: "papo",
        channel: "curious",
        text: "我把你刚说的话和照片放在同一小段里听了。",
        sourceId: "chat-session",
        relatedMemoryIds: []
      },
      {
        id: "msg8",
        at: new Date().toISOString(),
        role: "world",
        channel: "curious",
        text: "照片里是周五复查的日历备注，写着提前准备病历。",
        sourceId: "chat-image",
        relatedMemoryIds: [],
        modality: "image_summary",
        batchId: "chat-batch",
        observedAt: new Date().toISOString()
      },
      {
        id: "msg7",
        at: new Date().toISOString(),
        role: "user",
        channel: "curious",
        text: "这张照片就是刚说的复查。",
        sourceId: "chat-text",
        relatedMemoryIds: [],
        modality: "text",
        batchId: "chat-batch",
        observedAt: new Date().toISOString()
      },
      ...profile.conversation
    ]
  };
}

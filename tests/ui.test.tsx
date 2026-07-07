import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/App";

describe("App", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders a new Papo as waiting for real shared life, not a static mood label", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/provider")) {
        return json({
          kind: "generic",
          name: "Test real-model harness",
          available: true,
          usesRealModel: true,
          diagnostics: { textProvider: "generic", visionProvider: "generic", audioProvider: "generic", audioRoute: "audio_transcriptions" }
        });
      }
      if (url.endsWith("/api/profiles") && init?.method === "POST") return json({ profile: blankProfileFixture() }, 201);
      if (url.endsWith("/api/profiles/u-empty/wake")) {
        return json({
          profile: blankProfileFixture(),
          wake: {
            id: "wake-empty",
            at: new Date().toISOString(),
            elapsedMinutes: 0,
            message: "我刚刚醒着，你一打开我就还在这里。",
            innerThought: "",
            relatedMemoryIds: [],
            stateDelta: {},
            ruleTrace: ["elapsed_minutes=0", "state_delta=none"]
          }
        });
      }
      if (url.endsWith("/api/profiles")) return json({ profiles: [] });
      return json({ profile: blankProfileFixture() });
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("等第一段生活靠近")).toBeInTheDocument());
    expect(screen.getByText("我还没有和你经历过多少事。你可以直接跟我说话，也可以给我照片或声音。")).toBeInTheDocument();
    expect(screen.queryByText("好奇地贴近")).not.toBeInTheDocument();
    expect(screen.queryByText("当前心情")).not.toBeInTheDocument();
  });

  it("surfaces a raised habit on Home without pretending it is a shared memory", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/provider")) {
        return json({
          kind: "generic",
          name: "Test real-model harness",
          available: true,
          usesRealModel: true,
          diagnostics: { textProvider: "generic", visionProvider: "generic", audioProvider: "generic", audioRoute: "audio_transcriptions" }
        });
      }
      if (url.endsWith("/api/profiles")) return json({ profiles: [{ userId: "u-raised", creatureName: "Papo" }] });
      if (url.endsWith("/api/profiles/u-raised")) return json({ profile: raisedOnlyProfileFixture() });
      if (url.endsWith("/api/profiles/u-raised/wake")) {
        return json({
          profile: raisedOnlyProfileFixture(),
          wake: {
            id: "wake-raised",
            at: new Date().toISOString(),
            elapsedMinutes: 0,
            message: "我刚刚醒着，你一打开我就还在这里。",
            innerThought: "",
            relatedMemoryIds: [],
            stateDelta: {},
            ruleTrace: ["elapsed_minutes=0", "state_delta=none"]
          }
        });
      }
      return json({ profile: raisedOnlyProfileFixture() });
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("记着你教过的听法")).toBeInTheDocument());
    expect(screen.getByText("你把我教得遇到相近的事要多停一下，不要太快放过去。")).toBeInTheDocument();
    expect(screen.queryByText("想起以前的事")).not.toBeInTheDocument();
    expect(screen.queryByText("我被你养成的样子")).not.toBeInTheDocument();
  });

  it("renders the core mobile-first workbench", async () => {
    let curiousRequest: { segments?: Array<{ kind: string; batchId?: string; content: string }> } | undefined;
    const feedbackRequests: Array<{ kind: string; targetId?: string; content?: string; modality?: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/provider")) {
        return json({
          kind: "generic",
          name: "Test real-model harness",
          available: true,
          usesRealModel: true,
          diagnostics: { textProvider: "generic", visionProvider: "generic", audioProvider: "generic", audioRoute: "audio_transcriptions" }
        });
      }
      if (url.endsWith("/api/image-summary")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { label?: string };
        if (body.label?.includes("坏照片")) {
          return json({ error: "Vision provider failed: 403" }, 500);
        }
        return json({ summary: "照片里是周五复查的日历备注，写着提前准备病历。", provider: "generic", semanticSource: "llm" });
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
            innerThought: "我醒来时又碰到妈妈复查这件小事。",
            relatedMemoryIds: ["m2"],
            emergenceId: "emergence1",
            stateChangeReason: "app_wake_short_gap",
            stateDelta: {},
            ruleTrace: ["elapsed_minutes=0", "state_delta=none"]
          }
        });
      }
      if (url.endsWith("/api/profiles/u1/emergence")) {
        return json({
          profile: profileFixture(),
          emergence: {
            id: "emergence-empty",
            text: "我安静了一下，先只是陪在这里。等你继续说的时候，我会认真接住新的事。",
            whyNow: "我有点想继续想。现在没有连到已经记住的事，所以先安静等你继续说。",
            driveSource: "curiosity",
            relatedMemoryIds: [],
            ruleTrace: ["memory=none"]
          }
        });
      }
      if (url.endsWith("/api/profiles/u1/feedback")) {
        const requestBody = JSON.parse(String(init?.body ?? "{}"));
        feedbackRequests.push(requestBody);
        if (requestBody.kind === "forget") {
          return json({
            profile: profileWithFeedback(),
            feedback: {
              id: "feedback-forget",
              at: new Date().toISOString(),
              kind: "forget",
              targetId: requestBody.targetId,
              inputText: requestBody.content,
              inputModality: requestBody.modality,
              effect: "你让我放下它，我会让这段变轻，也更小心守住边界。",
              learningNote: "我学到：这件事先不要主动提起，我会把它放轻一点。"
            }
          });
        }
        return json({
          profile: profileWithFeedback(),
          feedback: {
            id: "feedback1",
            at: new Date().toISOString(),
            kind: "continue",
            targetId: "episode1",
            inputText: "这里请多想一点",
            inputModality: "text",
            effect: "你让我再想一会儿，我以后会更愿意把相近的小事连起来多停一下。",
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
          response: "我接住了这件刚发生的小事，会先和这一小段放在一起。",
          memoryCandidates: [],
          harnessTrace: ["sense: button", "semantic: llm interpretation applied"],
          provider: "generic"
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
          harnessTrace: ["sense: curious_stream", "semantic: llm interpretation applied"],
          provider: "generic"
        });
      }
      if (url.endsWith("/api/profiles")) return json({ profiles: [] });
      return json({ profile: profileFixture() });
    });

    render(<App />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Papo" })).toBeInTheDocument());
    expect(screen.getByText("住在手机里的小狗")).toBeInTheDocument();
    expect(screen.getByText("正在陪着你")).toBeInTheDocument();
    expect(screen.queryByText("Test real-model harness")).not.toBeInTheDocument();
    expect(screen.queryByText("Generic model API")).not.toBeInTheDocument();
    expect(screen.queryByText("LLM 语义脑已配置")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Papo 是一只卡通柴犬")).toBeInTheDocument();
    expect(screen.getByText("Papo 在这里")).toBeInTheDocument();
    expect(screen.queryByText("Papo 现在")).not.toBeInTheDocument();
    expect(screen.queryByText("当前心情")).not.toBeInTheDocument();
    expect(screen.queryByText(/触发了醒来节律|重新计算/)).not.toBeInTheDocument();
    expect(screen.getByText("收到了你刚给的事")).toBeInTheDocument();
    expect(screen.getByText("文字、照片或声音会留在同一次对话里，让 Papo 接着回应。")).toBeInTheDocument();
    expect(screen.queryByLabelText("问问 Papo 想到了什么")).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("轻轻碰一下 Papo"));
    expect(await screen.findByText("Papo 安静了一下")).toBeInTheDocument();
    expect(screen.getByText(/先只是陪在这里/)).toBeInTheDocument();
    expect(screen.queryByText(/足够稳定|真的和你一起经历过|真实内容/)).not.toBeInTheDocument();
    const emergenceReason = screen.getByText("我有点想继续想。现在没有连到已经记住的事，所以先安静等你继续说。");
    expect(screen.getByText("看看为什么这时想起")).toBeInTheDocument();
    expect(emergenceReason).not.toBeVisible();
    await userEvent.click(screen.getByText("看看为什么这时想起"));
    expect(emergenceReason).toBeVisible();
    expect(screen.getByText("好奇心更高，所以还想继续想一会儿。")).toBeVisible();
    expect(screen.queryByText("Papo 想起一件事")).not.toBeInTheDocument();
    expect(screen.queryByText(/小情景|递来的一小段|情景记忆/)).not.toBeInTheDocument();
    expect(screen.queryByText(/材料|模拟一段信息流|录音分段/)).not.toBeInTheDocument();
    expect(screen.queryByText("Papo 抬头看了你一眼")).not.toBeInTheDocument();
    expect(screen.queryByText("我醒来时又碰到妈妈复查这件小事。")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Papo 的身体信号")).not.toBeInTheDocument();
    expect(screen.queryByText("我会先保护隐私和边界")).not.toBeInTheDocument();
    expect(screen.queryByText("耳朵竖起来，尾巴轻快地摆")).not.toBeInTheDocument();
    expect(screen.queryByText("我会先找最让我在意的一小段")).not.toBeInTheDocument();
    expect(screen.queryByText(/先谨慎一点|如果内容涉及隐私|耳朵正朝着你|身体往你这边靠|眼睛亮了一点|趴着听你|安静等你靠近/)).not.toBeInTheDocument();
    expect(screen.queryByText("我被你养成的样子")).not.toBeInTheDocument();
    expect(screen.queryByText("你教我不要浅浅带过。以后遇到「妈妈复查」，我会多停一下，先想起以前的小事再回应")).not.toBeInTheDocument();
    expect(screen.queryByText(/preferDepth|quietTendency|深入倾向|安静倾向/)).not.toBeInTheDocument();
    expect(screen.queryByText("依恋度")).not.toBeInTheDocument();
    expect(screen.queryByText("唤醒度")).not.toBeInTheDocument();
    expect(screen.queryByText("Papo 新说")).not.toBeInTheDocument();
    expect(screen.queryByText("桌面提醒")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("有未读 Papo 回复")).not.toBeInTheDocument();
    expect(screen.getByText("来自同一次事件")).toBeInTheDocument();
    expect(screen.getAllByText("日历照片：妈妈周五复查，需要提前准备病历。").length).toBeGreaterThan(0);
    expect(screen.queryByText("我听见了。")).not.toBeInTheDocument();
    expect(screen.queryByText("这段对我还很新")).not.toBeInTheDocument();
    expect(screen.queryByText("我会先把它当作一段共同经历记下来。")).not.toBeInTheDocument();
    expect(screen.queryByText(/我先听你说完|我想轻轻问一句|确认我有没有听对/)).not.toBeInTheDocument();
    expect(screen.queryByText(/轻问|存情景|存长期|以后回来/)).not.toBeInTheDocument();
    expect(screen.getAllByText("看看 Papo 怎么处理的").length).toBeGreaterThan(0);
    expect(screen.queryByText("查看后台流程")).not.toBeInTheDocument();
    expect(screen.getAllByText("听见什么").length).toBeGreaterThan(0);
    expect(screen.getAllByText("怎么理解").length).toBeGreaterThan(0);
    expect(screen.queryByText(/语义判断|状态约束|行动选择|记忆策略/)).not.toBeInTheDocument();
    expect(screen.queryByText("我刚才注意到：")).not.toBeInTheDocument();
    expect(screen.queryByText("我为什么注意：")).not.toBeInTheDocument();
    expect(screen.getByText("跟 Papo 说")).toBeInTheDocument();
    expect(screen.getByText("陪我一会儿")).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("看看哪只 Papo 在身边"));
    expect(screen.getByText("哪只 Papo 在你身边")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再养一只 Papo" })).toBeInTheDocument();
    expect(screen.queryByText("小动物切换")).not.toBeInTheDocument();
    expect(screen.queryByText("新建小动物")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("切换用户")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "首页" }));

    expect(screen.getByText("你想怎么补充")).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("也可以补一句：哪里懂对了、哪里先放下、要怎么记准"), "这里请多想一点");
    await userEvent.click(screen.getByRole("button", { name: "再想一会儿" }));
    expect(await screen.findByText("我接住了你的反馈")).toBeInTheDocument();
    expect(screen.getAllByText(/我学到：这个主题你希望我不要浅浅带过/).length).toBeGreaterThan(0);
    expect(screen.queryByText("你刚才还告诉我：这里请多想一点")).not.toBeInTheDocument();
    expect(screen.getByText("这次怎么影响我")).toBeInTheDocument();
    await userEvent.click(screen.getByText("这次怎么影响我"));
    expect(screen.getByText("下次遇到相似内容，我会多停一下，愿意展开一点。")).toBeInTheDocument();
    expect(screen.getByText("我刚认真用过一点力，接下来会先少说一点。")).toBeInTheDocument();
    expect(screen.queryByText("好奇心 +8")).not.toBeInTheDocument();
    expect(screen.queryByText("深入倾向 +8")).not.toBeInTheDocument();
    expect(screen.queryByText("这次养成变化")).not.toBeInTheDocument();
    expect(screen.queryByText("我这一下变了一点")).not.toBeInTheDocument();
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
    expect(await screen.findByText("这次分享里还带着")).toBeInTheDocument();
    expect(screen.queryByText(/准备一起给我听|这一小段/)).not.toBeInTheDocument();
    expect(screen.queryByText("准备一起交给 Papo 的这一小段")).not.toBeInTheDocument();
    expect(screen.getByText("复查照片.png")).toBeInTheDocument();
    expect(screen.getByDisplayValue("照片里是周五复查的日历备注，写着提前准备病历。")).toBeInTheDocument();
    expect(screen.getAllByText("照片").length).toBeGreaterThan(0);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("直接告诉 Papo 一件刚发生的事"), "这张照片就是刚说的复查。");
    await userEvent.click(screen.getByRole("button", { name: "让 Papo 听听" }));
    await waitFor(() => expect(curiousRequest?.segments?.map((segment) => segment.kind)).toEqual(["text", "image_summary"]));
    expect(new Set(curiousRequest?.segments?.map((segment) => segment.batchId)).size).toBe(1);
    expect(await screen.findByText("我把你刚说的话和照片放在同一件事里听了。")).toBeInTheDocument();
    expect(screen.getByText("这张照片就是刚说的复查。")).toBeInTheDocument();
    expect(screen.getByText("照片里是周五复查的日历备注，写着提前准备病历。")).toBeInTheDocument();

    await userEvent.upload(screen.getByLabelText("加照片"), new File(["bad"], "坏照片.png", { type: "image/png" }));
    expect(await screen.findByText("Vision provider failed: 403")).toBeInTheDocument();
    expect(screen.queryByText("坏照片.png")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(/暂时没有看清|Vision provider failed|403/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "说给 Papo" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "首页" }));
    expect(screen.queryByText(/sense: button/)).not.toBeInTheDocument();
    expect(screen.queryByText(/semantic:/)).not.toBeInTheDocument();
    expect(screen.queryByText("刚才 Papo 说")).not.toBeInTheDocument();
    expect(screen.queryByText("Papo 新说")).not.toBeInTheDocument();
    const skippedReason = screen.getByText("这段更像背景声，我先不抢着记住。");
    expect(screen.getByText("看看这次 Papo 注意了什么")).toBeInTheDocument();
    expect(skippedReason).not.toBeVisible();
    await userEvent.click(screen.getByText("看看这次 Papo 注意了什么"));
    expect(screen.getByText("暂时略过 背景小事")).toBeVisible();
    expect(skippedReason).toBeVisible();
    expect(screen.queryByText(/竖起耳朵|先放过了/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Papo 放过了/)).not.toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "陪我" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "陪我一会儿" }));
    expect(screen.getByText("和 Papo 的小日常")).toBeInTheDocument();
    expect(screen.getByText("Papo 趴在旁边等你")).toBeInTheDocument();
    expect(screen.getByText("陪你听一会儿")).toBeInTheDocument();
    expect(screen.getByText("开始后你仍然可以继续打字或加照片。")).toBeInTheDocument();
    expect(screen.queryByText(/最多 3 分钟|每 30 秒/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始陪我听" })).toBeInTheDocument();
    expect(screen.getByLabelText("加照片")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "说给 Papo" })).toBeInTheDocument();
    expect(screen.queryByText("刚才的对话")).not.toBeInTheDocument();
    expect(screen.queryByText("加一张照片")).not.toBeInTheDocument();
    expect(screen.queryByText("加一段录音")).not.toBeInTheDocument();
    expect(screen.queryByText("加一小段")).not.toBeInTheDocument();
    expect(screen.queryByText("让 Papo 看看")).not.toBeInTheDocument();
    expect(screen.queryByText("Curious Mode")).not.toBeInTheDocument();
    expect(screen.queryByText("Curious 录音感知")).not.toBeInTheDocument();
    expect(screen.queryByText(/image_summary|audio_transcript/)).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("和 Papo 的小日常")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "对话" }));
    expect(screen.getByText("和 Papo 的小日常")).toBeInTheDocument();
    expect(screen.queryByText(/条你给的内容|次 Papo 回应/)).not.toBeInTheDocument();
    expect(screen.getAllByText("同一次事件")).toHaveLength(1);
    expect(screen.getByText("文字和照片一起")).toBeInTheDocument();
    expect(screen.queryByText(/\d+ 条内容/)).not.toBeInTheDocument();
    expect(screen.queryByText("manual-1 · 1 条素材")).not.toBeInTheDocument();
    expect(screen.queryByText(/对话和注意流|注意素材|小素材|刚才的注意事件/)).not.toBeInTheDocument();
    expect(screen.queryByText(/批次 manual-1/)).not.toBeInTheDocument();
    expect(screen.queryByText(/批次 chat-batch/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/和这次陪伴放在一起/).length).toBeGreaterThan(1);
    expect(screen.getByText("你的反馈")).toBeInTheDocument();
    expect(screen.getByText(/你在教我/)).toBeInTheDocument();
    expect(screen.queryByText(/你在教它/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Papo").length).toBeGreaterThan(1);
    expect(screen.getAllByText("你给 Papo 看了照片")).toHaveLength(2);
    expect(screen.queryByText("我刚刚醒着，你一打开我就还在这里。")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "记忆" }));
    expect(screen.getByText("Papo 记得的生活")).toBeInTheDocument();
    expect(screen.getByText("这里慢慢留下你们一起经历过的事。每条都可以被你改准，或者让 Papo 放下。")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("找一找哪件事")).toBeInTheDocument();
    expect(screen.getByText("Papo 被你改过的地方")).toBeInTheDocument();
    expect(screen.getByText("最近一起经历过")).toBeInTheDocument();
    expect(screen.getAllByText("你当时说").length).toBeGreaterThan(0);
    expect(screen.queryByText("Papo 当时回你")).not.toBeInTheDocument();
    expect(screen.getAllByText("后来记住").length).toBeGreaterThan(0);
    expect(screen.getAllByText((_, element) =>
      Boolean(element?.textContent?.includes("如果你能说话") && element.textContent.includes("你就说句话给我听"))
    ).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Papo 学会").length).toBeGreaterThan(0);
    expect(screen.getByText(/你教我不要浅浅带过/)).toBeInTheDocument();
    expect(screen.queryByText("我正在学习注意")).not.toBeInTheDocument();
    expect(screen.queryByText("我记得比较清楚。以后聊到相近内容时，我会想起这一段。")).not.toBeInTheDocument();
    expect(screen.queryByText("我留下它，是因为这件事以后可能还会回来找你。")).not.toBeInTheDocument();
    expect(screen.queryByText((_, element) => element?.textContent === "我记得比较清楚。它以后可能会轻轻拽我一下。")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "教我记准" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "帮我先放下" })).toBeInTheDocument();
    expect(screen.getAllByText("你想怎么补充").length).toBeGreaterThan(0);
    expect(screen.getByText("你补的话会一起进入反馈；我会据此多想、安静、记稳或放下。")).toBeInTheDocument();
    await userEvent.type(screen.getByPlaceholderText("告诉我：这件事哪里要记准、放轻，或下次怎么回应"), "这条先不要主动提起");
    await userEvent.click(screen.getByRole("button", { name: "帮我先放下" }));
    await waitFor(() =>
      expect(feedbackRequests.at(-1)).toMatchObject({
        kind: "forget",
        targetId: "m2",
        content: "这条先不要主动提起",
        modality: "text"
      })
    );
    await userEvent.click(screen.getByRole("button", { name: "首页" }));
    expect(screen.getByText("我学到：这件事先不要主动提起，我会把它放轻一点。")).toBeInTheDocument();
    expect(screen.queryByText("这次怎么影响我")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "记忆" }));
    expect(screen.queryByText("future_review · 权重 80")).not.toBeInTheDocument();
    expect(screen.queryByText("future_review · weight 80")).not.toBeInTheDocument();
    expect(screen.queryByText("记忆细节")).not.toBeInTheDocument();
    expect(screen.queryByText(/资料库|memory_resonance|scoreBreakdown|decisionTrace|weight \d|confidence \d|细节记录/)).not.toBeInTheDocument();
    expect(screen.queryByText(/用户|小动物|episode|candidate|长期保存|当前事件|保存意图|未来价值/)).not.toBeInTheDocument();
    expect(screen.queryByText(/它以后可能还会回来找你，我先记着：如果你能说话/)).not.toBeInTheDocument();
    expect(screen.queryByText("我留下它，是因为这件事以后可能还会回来找你。")).not.toBeInTheDocument();
    expect(screen.getAllByText("来自同一次事件").length).toBeGreaterThan(0);
    expect(screen.queryByText(/批次 manual-1/)).not.toBeInTheDocument();
    expect(screen.queryByText("来源细节")).not.toBeInTheDocument();
    expect(screen.queryByText(/batch manual-1|segment segment-photo/)).not.toBeInTheDocument();

    expect(screen.queryByRole("button", { name: "脑态" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "演示" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("看看哪只 Papo 在身边"));
    expect(screen.getByText("开发查看")).toBeInTheDocument();
    expect(screen.queryByText("脑态诊断")).not.toBeVisible();
    await userEvent.click(screen.getByText("开发查看"));
    await userEvent.click(screen.getByRole("button", { name: "脑态诊断" }));
    expect(screen.getByText("最近变化")).toBeInTheDocument();
    expect(screen.getByText("模型路由")).toBeInTheDocument();
    expect(screen.getByText("语义脑诊断")).toBeInTheDocument();
    expect(screen.getByText("声音感知")).toBeInTheDocument();
    expect(screen.getAllByText("generic").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByLabelText("看看哪只 Papo 在身边"));
    await userEvent.click(screen.getByText("开发查看"));
    await userEvent.click(screen.getByRole("button", { name: "演示回路" }));
    expect(screen.getByText("带 Papo 走一圈")).toBeInTheDocument();
    expect(screen.getByText("用几段日常内容，看 Papo 怎么听见、回应、被你养一下，再在合适的时候想起真实记住的事。")).toBeInTheDocument();
    expect(screen.getByText("带 Papo 完整走一圈")).toBeInTheDocument();
    expect(screen.queryByText("带它完整走一圈")).not.toBeInTheDocument();
    expect(screen.getByText("先递 8 段生活")).toBeInTheDocument();
    expect(screen.getByText("看两只 Papo 被养成不同样子")).toBeInTheDocument();
    expect(screen.getByText("轻轻碰一下 Papo")).toBeInTheDocument();
    expect(screen.queryByText("先给它 8 段生活")).not.toBeInTheDocument();
    expect(screen.queryByText("问问它现在想到什么")).not.toBeInTheDocument();
    expect(screen.queryByText("演示模式")).not.toBeInTheDocument();
    expect(screen.queryByText(/场景 1|场景 2|场景 3|一键准备/)).not.toBeInTheDocument();
    expect(screen.queryByText("场景 2：生成 A/B 养成对比")).not.toBeInTheDocument();
    expect(screen.queryByText("后续任务")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "看两只 Papo 被养成不同样子" }));
    expect(await screen.findByText("同一句话")).toBeInTheDocument();
    expect(screen.getByText("我有点担心自己又把妈妈复查这件事拖到睡前，明明它很重要。")).toBeInTheDocument();
    expect(screen.getByText("连续收到“再想一会儿”")).toBeInTheDocument();
    expect(screen.getByText("连续收到“先安静点”")).toBeInTheDocument();
    expect(screen.getByText(/你教我不要浅浅带过|你把我教得会多停一下/)).toBeInTheDocument();
    expect(screen.getByText("你把我教得先轻声陪着，不急着追问。")).toBeInTheDocument();
    expect(screen.getAllByText(/我接住了这件刚发生/).length).toBeGreaterThan(0);
  }, 10_000);
});

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

function blankProfileFixture() {
  return {
    userId: "u-empty",
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
    episodes: [],
    longTermMemories: [
      {
        id: "seed-memory",
        createdAt: new Date().toISOString(),
        kind: "creature_self_memory",
        text: "我正在学习先注意、再记住、再根据反馈改变自己，而不是只做一个聊天框。",
        weight: 62,
        tags: ["注意", "记忆", "反馈", "小脑袋"]
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
    semanticBrainHistory: [],
    conversation: []
  };
}

function raisedOnlyProfileFixture() {
  const profile = blankProfileFixture();
  return {
    ...profile,
    userId: "u-raised",
    episodes: [],
    longTermMemories: [
      ...profile.longTermMemories,
      {
        id: "raised-depth",
        createdAt: new Date().toISOString(),
        kind: "creature_self_memory",
        text: "你教我不要浅浅带过。以后遇到相近内容，我会多停一下，先想起以前的小事再回应。",
        weight: 82,
        tags: ["被你养成", "更愿意多想"]
      }
    ],
    conversation: []
  };
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
        id: "m-raised",
        createdAt: new Date().toISOString(),
        kind: "creature_self_memory",
        text: "你教我不要浅浅带过。以后遇到「妈妈复查」，我会多停一下，先想起以前的小事再回应。",
        weight: 74,
        tags: ["被你养成", "更愿意多想", "妈妈复查"]
      },
      {
        id: "m2",
        createdAt: new Date().toISOString(),
        sourceEpisodeId: "episode1",
        kind: "future_review",
        text: "我先试着理解：我注意到这个片段可能是你想让我认真理解的当前事件：如果你能说话 你就说句话给我听。我还没有强烈联想到旧记忆，所以先把它作为新的情景片段。这段需要用户确认，尤其是隐私、情绪或保存意图还不够明确。",
        weight: 80,
        tags: ["妈妈复查"],
        consolidatedBecause: "这条 episode 有未来价值。"
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
        providerKind: "generic",
        providerName: "Test real-model harness",
        status: "skipped",
        message: "llm interpretation applied",
        ruleTrace: ["provider=generic", "source=button", "status=applied"]
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
        effect: "你让我再想一会儿，我以后会更愿意把相近的小事连起来多停一下。",
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
        text: "我接住了这件刚发生的小事，会先和这一小段放在一起。",
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

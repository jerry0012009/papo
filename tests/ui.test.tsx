import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/web/App";

describe("App", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
      if (url.endsWith("/api/profiles")) return json({ profiles: [] });
      return json({ profile: profileFixture() });
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Papo")).toBeInTheDocument());
    expect(screen.getByText("当前心情")).toBeInTheDocument();
    expect(screen.getByText("醒来时")).toBeInTheDocument();
    expect(screen.getByText("我醒来时自己又想到妈妈复查这件事。")).toBeInTheDocument();
    expect(screen.getByText("Papo 新说")).toBeInTheDocument();
    expect(screen.getByText("单次输入")).toBeInTheDocument();
    expect(screen.getByText("陪我一会儿")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "输入" }));
    expect(screen.getByText("Button Capture")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "陪我" }));
    expect(screen.getByText("Curious Mode")).toBeInTheDocument();
    expect(screen.getByText("语音陪伴实验")).toBeInTheDocument();
    expect(screen.getByText("上传截图生成摘要")).toBeInTheDocument();
    expect(screen.getByText("上传录音转写")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "对话" }));
    expect(screen.getByText("Papo 说过的话")).toBeInTheDocument();
    expect(screen.getByText("我刚刚醒着，你一打开我就还在这里。")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "记忆" }));
    expect(screen.getByText("长期记忆")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索旧记忆")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "脑态" }));
    expect(screen.getByText("最近变化")).toBeInTheDocument();
    expect(screen.getByText("语义脑诊断")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "演示" }));
    expect(screen.getByText("演示模式")).toBeInTheDocument();
    expect(screen.getByText("一键准备 4 分钟演示")).toBeInTheDocument();
    expect(screen.getByText("场景 1：填入 8 段信息流")).toBeInTheDocument();
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
    episodes: [],
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

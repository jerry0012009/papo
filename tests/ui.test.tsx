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
      if (url.endsWith("/api/profiles")) return json({ profiles: [] });
      return json({ profile: profileFixture() });
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText("Papo")).toBeInTheDocument());
    expect(screen.getByText("当前心情")).toBeInTheDocument();
    expect(screen.getByText("单次输入")).toBeInTheDocument();
    expect(screen.getByText("陪我一会儿")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "输入" }));
    expect(screen.getByText("Button Capture")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "陪我" }));
    expect(screen.getByText("Curious Mode")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "记忆" }));
    expect(screen.getByText("长期记忆")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索旧记忆")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "脑态" }));
    expect(screen.getByText("最近变化")).toBeInTheDocument();
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
      }
    ],
    feedbackHistory: [],
    stateChanges: []
  };
}

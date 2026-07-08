import { expect, test, type Page, type Route } from "@playwright/test";

const now = "2026-07-07T12:00:00.000Z";

test.beforeEach(async ({ page }, testInfo) => {
  await installMockApi(page);
  if (!testInfo.title.includes("first visit")) {
    await page.addInitScript(() => {
      window.localStorage.setItem("papo:userId", "demo");
    });
  }
});

test("first visit shows login and registration instead of creating a public Papo", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "养一只自己的小动物" })).toBeVisible();
  await expect(page.getByRole("button", { name: "注册" })).toBeVisible();
  await expect(page.getByRole("button", { name: "登录" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始养 Papo" })).toBeDisabled();
});

test("home developer panel opens and closes without overflowing", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "Papo" })).toBeVisible();
  await page.locator(".home-stage").getByRole("button", { name: "小眼睛" }).click();

  const panel = page.getByRole("dialog", { name: /Papo 状态/ });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("状态");
  await expect(panel).toContainText("最近状态日记");
  await expect(panel).toContainText("悄悄看你");
  await expectInViewport(page, panel);

  await page.getByRole("button", { name: "收起小眼睛" }).click();
  await expect(panel).toBeHidden();
});

test("chat opens at latest content and keeps the composer aligned with the thread", async ({ page }) => {
  await page.goto("/");
  await page.locator(".nav").getByRole("button", { name: /对话/ }).click();

  await expect(page.locator(".chat-bubble.papo p", { hasText: "最近一条回复在这里。" }).last()).toBeVisible();
  await expect(page.getByPlaceholder("直接告诉 Papo 一件刚发生的事")).toBeVisible();
  const sendButton = page.locator(".chat-send-button");
  await expect(sendButton).toBeVisible();
  await expect(sendButton).toContainText("说给 Papo");
  await expect(sendButton).toHaveCSS("color", "rgb(77, 86, 79)");
  await expect(sendButton).toHaveClass(/chat-send-button/);
  await expectButtonTextFits(sendButton);

  const listBox = await page.locator(".chat-list").boundingBox();
  const composerBox = await page.locator(".chat-composer").boundingBox();
  expect(listBox).toBeTruthy();
  expect(composerBox).toBeTruthy();
  expect(Math.abs(listBox!.width - composerBox!.width)).toBeLessThanOrEqual(2);

  await page.getByRole("button", { name: "查看这句话背后的模型调用" }).first().click();
  const trace = page.locator(".developer-trace-body").first();
  await expect(trace).toBeVisible();
  await expect(trace).toContainText("模型调用");
  await expectInViewport(page, trace);
});

test("quick microphone recording exposes recording, stop, processing, and send states", async ({ page }) => {
  await installMockMicrophone(page);
  await page.goto("/");
  await page.locator(".nav").getByRole("button", { name: /对话/ }).click();

  await page.getByRole("button", { name: "录一段" }).click();
  await expect(page.locator(".quick-audio-status").getByText(/录音中/)).toBeVisible();
  await expect(page.getByRole("button", { name: "停止" })).toBeVisible();

  await page.getByRole("button", { name: "停止" }).click();
  await expect(page.getByText("正在整理录音")).toBeVisible();
  await expect(page.getByText("麦克风 1")).toBeVisible({ timeout: 3_000 });
  const stagedAudio = page.locator(".staged-segment").filter({ hasText: "麦克风 1" });
  await expect(stagedAudio.locator("textarea")).toHaveCount(0);
  await expect(stagedAudio).toContainText("有一段声音");
  await expect(stagedAudio).not.toContainText("我听到你说想测试录音按钮。");
  await expect(page.getByRole("button", { name: "让 Papo 听听" })).toBeVisible();
});

test("companion listening starts from home and shows a countdown in chat", async ({ page }) => {
  await installMockMicrophone(page);
  await page.goto("/");

  await page.getByRole("button", { name: /陪我/ }).first().click();
  await expect(page.getByPlaceholder("直接告诉 Papo 一件刚发生的事")).toBeVisible();
  const listeningStatus = page.locator(".listening-session-status");
  await expect(listeningStatus).toBeVisible();
  await expect(listeningStatus).toContainText("陪你听着");
  await expect(listeningStatus).toContainText("剩余");
  await expect(listeningStatus.getByRole("button", { name: "停止陪我听" })).toBeVisible();
});

test("companion listening skips a failed audio slice without showing technical abort errors", async ({ page }) => {
  await installMockMicrophone(page);
  await page.addInitScript(() => {
    window.localStorage.setItem("papo:testAudioAbort", "1");
  });
  await page.goto("/");

  await page.getByRole("button", { name: /陪我/ }).first().click();
  await expect(page.locator(".listening-session-status")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { papoRequestAudioSliceForTest?: (force: boolean) => void }).papoRequestAudioSliceForTest?.(true);
  });
  await page.waitForTimeout(500);

  await expect(page.getByText(/This operation was aborted/)).toHaveCount(0);
  await expect(page.getByText(/整理时断开/)).toHaveCount(0);
  await expect(page.locator(".listening-session-status")).toBeVisible();
});

test("memory feedback shows a pending state while the request is in flight", async ({ page }) => {
  await page.goto("/");
  await page.locator(".nav").getByRole("button", { name: /记忆/ }).click();

  const memoryCard = page.locator(".memory-surface").filter({ hasText: "你喜欢旺旺仙贝。" }).first();
  await expect(memoryCard).toBeVisible();

  await memoryCard.getByRole("button", { name: "忘掉" }).click();
  await expect(memoryCard.getByRole("button", { name: "尝试中" })).toBeVisible();
  await expect(memoryCard.getByRole("button", { name: /忘掉|彻底忘掉/ })).toBeVisible({ timeout: 2_000 });
});

test("wide desktop uses a scan-friendly memory grid and local trace controls", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "wide desktop layout is verified in the desktop project");

  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");

  await page.locator(".nav").getByRole("button", { name: /对话/ }).click();
  await expect(page.locator(".chat-bubble.papo p", { hasText: "最近一条回复在这里。" }).last()).toBeVisible();
  const bubbleBox = await page.locator(".chat-bubble.papo").last().boundingBox();
  const traceBox = await page.getByRole("button", { name: "查看这句话背后的模型调用" }).last().boundingBox();
  expect(bubbleBox).toBeTruthy();
  expect(traceBox).toBeTruthy();
  expect(traceBox!.x).toBeGreaterThanOrEqual(bubbleBox!.x - 1);
  expect(traceBox!.x + traceBox!.width).toBeLessThanOrEqual(bubbleBox!.x + bubbleBox!.width + 1);

  await page.locator(".nav").getByRole("button", { name: /记忆/ }).click();
  const candidateCards = page.locator(".candidate-memory");
  await expect(candidateCards).toHaveCount(2);
  const first = await candidateCards.nth(0).boundingBox();
  const second = await candidateCards.nth(1).boundingBox();
  expect(first).toBeTruthy();
  expect(second).toBeTruthy();
  expect(Math.abs(first!.y - second!.y)).toBeLessThanOrEqual(2);
  expect(second!.x).toBeGreaterThan(first!.x + first!.width * 0.8);

  const companionBox = await page.locator(".companion-panel").boundingBox();
  expect(companionBox).toBeTruthy();
  expect(companionBox!.width).toBeGreaterThanOrEqual(300);
});

async function installMockApi(page: Page) {
  let profile = makeProfile();

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/api/profiles" && route.request().method() === "GET") {
      await json(route, {
        profiles: [{ userId: profile.userId, creatureName: profile.creatureName, createdAt: profile.createdAt }]
      });
      return;
    }

    if (path === "/api/profiles/demo" && route.request().method() === "GET") {
      await json(route, { profile });
      return;
    }

    if (path === "/api/profiles/demo/wake" && route.request().method() === "POST") {
      await json(route, {
        profile,
        wake: {
          id: "wake-1",
          at: now,
          elapsedMinutes: 0,
          message: "",
          relatedMemoryIds: [],
          stateChangeReason: "ui test wake",
          stateDelta: {},
          ruleTrace: []
        }
      });
      return;
    }

    if (path === "/api/profiles/demo/read-state" && route.request().method() === "PATCH") {
      profile = {
        ...profile,
        readState: { lastReadPapoMessageId: "msg-latest-papo", lastReadAt: now }
      };
      await json(route, { profile });
      return;
    }

    if (path === "/api/audio-observation" && route.request().method() === "POST") {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (await route.request().frame().page().evaluate(() => window.localStorage.getItem("papo:testAudioAbort") === "1")) {
        await json(route, { error: "This operation was aborted" }, 500);
        return;
      }
      await json(route, {
        observation: "我听到你说想测试录音按钮。",
        provider: "mock-audio",
        semanticSource: "llm",
        sensingTrace: {
          at: now,
          modality: "audio",
          label: "刚录的一段声音",
          provider: "mock-audio",
          semanticSource: "llm",
          status: "content",
          decision: "测试音频可用",
          observation: "我听到你说想测试录音按钮。",
          ruleTrace: []
        }
      });
      return;
    }

    if (path === "/api/profiles/demo/feedback" && route.request().method() === "POST") {
      await new Promise((resolve) => setTimeout(resolve, 450));
      profile = {
        ...profile,
        longTermMemories: profile.longTermMemories.map((memory) =>
          memory.id === "mem-1" ? { ...memory, weight: Math.max(0, memory.weight - 20) } : memory
        )
      };
      await json(route, {
        profile,
        feedback: {
          id: "feedback-1",
          at: now,
          kind: "forget",
          targetId: "mem-1",
          effect: "测试里的遗忘反馈已处理。",
          learningNote: "ui test",
          memoryCandidateIds: [],
          stateDeltas: [],
          policyDeltas: []
        }
      });
      return;
    }

    await json(route, { error: `Unhandled mock route: ${route.request().method()} ${path}` }, 404);
  });
}

async function installMockMicrophone(page: Page) {
  await page.addInitScript(() => {
    class FakeMediaRecorder {
      static isTypeSupported() {
        return true;
      }

      public state = "inactive";
      public mimeType = "audio/webm";
      public ondataavailable?: (event: { data: Blob }) => void;
      public onstop?: () => void;
      public onerror?: () => void;

      constructor(public stream: MediaStream, public options?: { mimeType?: string }) {
        this.mimeType = options?.mimeType ?? "audio/webm";
      }

      start() {
        this.state = "recording";
      }

      stop() {
        if (this.state === "inactive") return;
        this.state = "inactive";
        const data = new Blob(["mock audio"], { type: this.mimeType });
        setTimeout(() => {
          this.ondataavailable?.({ data });
          this.onstop?.();
        }, 20);
      }
    }

    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      writable: true,
      value: FakeMediaRecorder
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          active: true,
          getTracks: () => [{ stop() {} }]
        })
      }
    });
  });
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

async function expectInViewport(page: Page, locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box).toBeTruthy();
  expect(viewport).toBeTruthy();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

async function expectButtonTextFits(locator: ReturnType<Page["locator"]>) {
  const fits = await locator.evaluate((element) => {
    const html = element as HTMLElement;
    return html.scrollWidth <= html.clientWidth + 1 && html.scrollHeight <= html.clientHeight + 1;
  });
  expect(fits).toBe(true);
}

function makeProfile() {
  return {
    userId: "demo",
    creatureName: "Papo",
    petKind: "shiba",
    createdAt: now,
    lastSeenAt: now,
    state: {
      curiosity: 82,
      attachment: 76,
      energy: 88,
      arousal: 42,
      safety: 54,
      confidence: 61,
      mood: "curious"
    },
    policyProfile: {
      preferDepth: 54,
      preferProactivity: 46,
      privacySensitivity: 42,
      saveThreshold: 58,
      askThreshold: 45,
      recallTendency: 50,
      quietTendency: 28
    },
    episodes: [
      {
        id: "episode-1",
        createdAt: now,
        source: "button",
        sourceSegmentId: "segment-1",
        triggerLabel: "你刚说的话",
        inputSummary: "用户说喜欢旺旺仙贝。",
        noticed: "用户分享了一个具体喜欢的零食。",
        possibleIntent: "分享偏好",
        importanceReason: "具体、可复用的偏好信息。",
        relatedMemoryIds: ["mem-1"],
        stateSnapshot: {
          curiosity: 80,
          attachment: 74,
          energy: 88,
          arousal: 42,
          safety: 54,
          confidence: 60,
          mood: "curious"
        },
        creatureResponse: "我记住啦，旺旺仙贝是你喜欢的小零食。",
        feedback: [],
        promotedToLongTerm: true,
        memoryCandidateIds: ["cand-1"],
        weight: 70,
        tags: ["snack"]
      }
    ],
    longTermMemories: [
      {
        id: "mem-1",
        createdAt: now,
        kind: "user_preference",
        text: "你喜欢旺旺仙贝。",
        sourceEpisodeId: "episode-1",
        weight: 70,
        tags: ["snack"]
      }
    ],
    memoryCandidates: [
      {
        id: "cand-1",
        createdAt: now,
        candidateText: "你提到以后想让 Papo 记得更自然。",
        memoryKind: "long_theme",
        confidence: 0.72,
        sourceEpisodeId: "episode-1",
        whyConsolidate: "持续产品偏好。",
        writePolicy: "wait_feedback",
        decayPolicy: "decay_without_feedback",
        status: "candidate",
        tags: ["product"]
      },
      {
        id: "cand-2",
        createdAt: "2026-07-07T11:58:00.000Z",
        candidateText: "你希望 Papo 的界面像真正的 companion app。",
        memoryKind: "long_theme",
        confidence: 0.7,
        sourceEpisodeId: "episode-1",
        whyConsolidate: "持续产品偏好。",
        writePolicy: "wait_feedback",
        decayPolicy: "decay_without_feedback",
        status: "candidate",
        tags: ["ui"]
      }
    ],
    conversation: [
      {
        id: "msg-latest-papo",
        at: "2026-07-07T12:03:00.000Z",
        role: "papo",
        channel: "button",
        text: "最近一条回复在这里。",
        sourceId: "episode-1",
        relatedMemoryIds: ["mem-1"],
        modality: "button",
        cognitionTrace: makeTrace()
      },
      {
        id: "msg-user-1",
        at: "2026-07-07T12:02:00.000Z",
        role: "user",
        channel: "button",
        text: "你好呀 Papo",
        relatedMemoryIds: [],
        modality: "button"
      }
    ],
    feedbackHistory: [],
    stateChanges: [],
    emergenceHistory: [],
    wakeHistory: [],
    dreamHistory: [],
    semanticBrainHistory: [
      {
        id: "brain-1",
        at: now,
        source: "button",
        stage: "attention",
        providerKind: "mimo",
        providerName: "mimo",
        model: "mimo-v2.5-pro",
        status: "applied",
        message: "ui test attention",
        ruleTrace: ["semantic: llm cognition applied"]
      }
    ],
    proactive: { pendingCount: 0, paused: false, lastActiveAt: now },
    readState: {},
    hermes: { tasks: [] },
    dogState: {
      id: "curious_peek",
      selectedAt: now,
      label: "悄悄看你",
      actionText: "Papo 从旁边探出小脑袋，悄悄看了你一眼。",
      visualPrompt: "Shiba peeking from the side with one paw forward",
      animation: "peek",
      reason: "ui test",
      nextCheckAt: "2026-07-07T13:00:00.000Z",
      selectedBy: "llm"
    },
    dogStateHistory: [
      {
        id: "listen_softly",
        selectedAt: "2026-07-07T11:40:00.000Z",
        label: "竖起耳朵",
        actionText: "Papo 竖起耳朵，认真听了一会儿。",
        visualPrompt: "Shiba listening softly",
        animation: "listen",
        reason: "ui test history",
        nextCheckAt: "2026-07-07T12:00:00.000Z",
        selectedBy: "llm"
      }
    ]
  };
}

function makeTrace() {
  return {
    at: now,
    source: "button",
    providerKind: "mimo",
    providerName: "mimo",
    model: "mimo-v2.5-pro",
    modelRuns: [
      {
        id: "run-1",
        at: now,
        source: "button",
        stage: "attention",
        providerKind: "mimo",
        providerName: "mimo",
        model: "mimo-v2.5-pro",
        status: "applied",
        message: "llm attention decision applied",
        ruleTrace: ["semantic: llm attention decision applied"]
      }
    ],
    harnessTrace: ["semantic: llm cognition applied"],
    eventDecisions: [
      {
        eventId: "event-1",
        sourceLabel: "你刚说的话",
        sourceText: "你好呀 Papo",
        action: "respond",
        semanticSource: "llm",
        noticed: "用户在和 Papo 打招呼。",
        reason: "需要自然回应。",
        visibleReply: "最近一条回复在这里。",
        actionResult: { kind: "visible_reply", text: "最近一条回复在这里。" },
        stateDeltas: [],
        episodeKept: true,
        memoryCandidateKept: true,
        relatedMemoryIds: ["mem-1"],
        decisionTrace: ["episode=true", "memory_candidate=true"]
      }
    ],
    episodeDecisions: [],
    memoryDecisions: [
      {
        candidateId: "cand-1",
        sourceEpisodeId: "episode-1",
        status: "candidate",
        writePolicy: "wait_feedback",
        memoryKind: "long_theme",
        text: "你提到以后想让 Papo 记得更自然。",
        why: "持续产品偏好。"
      }
    ]
  };
}

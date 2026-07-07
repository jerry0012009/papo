import { expect, test, type Page, type Route } from "@playwright/test";

const now = "2026-07-07T12:00:00.000Z";

test.beforeEach(async ({ page }) => {
  await installMockApi(page);
});

test("home developer panel opens and closes without overflowing", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1, name: "Papo" })).toBeVisible();
  await page.getByRole("button", { name: "小眼睛" }).click();

  const panel = page.getByRole("dialog", { name: "Papo 状态和模型阶段" });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("状态");
  await expectInViewport(page, panel);

  await page.getByRole("button", { name: "收起" }).click();
  await expect(panel).toBeHidden();
});

test("chat opens at latest content and keeps the composer aligned with the thread", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "对话" }).click();

  await expect(page.locator(".chat-bubble.papo p", { hasText: "最近一条回复在这里。" }).last()).toBeVisible();
  await expect(page.getByPlaceholder("直接告诉 Papo 一件刚发生的事")).toBeVisible();

  const listBox = await page.locator(".chat-list").boundingBox();
  const composerBox = await page.locator(".chat-composer").boundingBox();
  expect(listBox).toBeTruthy();
  expect(composerBox).toBeTruthy();
  expect(Math.abs(listBox!.width - composerBox!.width)).toBeLessThanOrEqual(2);

  await page.locator('summary[aria-label="查看这句话背后的模型调用"]').first().click();
  const trace = page.locator(".developer-trace-body").first();
  await expect(trace).toBeVisible();
  await expect(trace).toContainText("模型调用");
  await expectInViewport(page, trace);
});

test("memory feedback shows a pending state while the request is in flight", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "记忆" }).click();

  const memoryCard = page.locator(".memory-surface").filter({ hasText: "你喜欢旺旺仙贝。" }).first();
  await expect(memoryCard).toBeVisible();

  await memoryCard.getByRole("button", { name: "忘掉" }).click();
  await expect(memoryCard.getByRole("button", { name: "尝试中" })).toBeVisible();
  await expect(memoryCard.getByRole("button", { name: /忘掉|彻底忘掉/ })).toBeVisible({ timeout: 2_000 });
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

function makeProfile() {
  return {
    userId: "demo",
    creatureName: "Papo",
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
    hermes: { tasks: [] }
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

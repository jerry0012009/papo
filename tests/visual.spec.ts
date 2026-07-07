import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await mockPapoApi(page);
});

test("renders lifeform surfaces in a real browser", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByText("Papo 现在")).toBeVisible();

  const avatar = page.getByLabel("Papo 是一只卡通柴犬");
  await expect(avatar).toBeVisible();
  await expect(avatar.locator("svg")).toBeVisible();
  await expect(avatar.locator(".shiba-tail-ring")).toHaveCount(1);
  await expect(avatar.locator(".shiba-urajiro")).toHaveCount(2);
  await expect(avatar.locator(".shiba-collar")).toHaveCount(1);
  await expect(avatar.locator(".shiba-tongue")).toHaveCount(1);
  await expect(avatar.locator(".shiba-paw")).toHaveCount(2);
  const avatarBox = await avatar.boundingBox();
  expect(avatarBox?.width ?? 0).toBeGreaterThan(120);
  expect(avatarBox?.height ?? 0).toBeGreaterThan(110);
  const avatarScreenshot = await page.screenshot({ clip: avatarBox ?? undefined });
  expect(avatarScreenshot.byteLength).toBeGreaterThan(8_000);

  await expect(page.getByLabel("Papo 的身体信号")).toHaveCount(0);
  await expect(page.getByText("我会先保护隐私和边界")).toHaveCount(0);
  await expect(page.getByText("耳朵竖起来，尾巴轻快地摆")).toHaveCount(0);
  await expect(page.getByText("我会先找最让我在意的一小段")).toHaveCount(0);
  await expect(page.getByText("我被你养成的样子")).toBeVisible();
  await expect(page.getByText("你教我不要浅浅带过。以后遇到「妈妈复查」，我会多停一下，先想起以前的小事再回应")).toBeVisible();
  await expect(page.getByText(/preferDepth|quietTendency|深入倾向|安静倾向/)).toHaveCount(0);
  await expect(page.getByText("Papo 抬头看了你一眼")).toBeVisible();
  await expect(page.getByText("我醒来时又碰到妈妈复查这件小事。")).toBeVisible();
  await expect(page.getByLabel("有未读 Papo 回复")).toBeVisible();
  await expect(page.getByPlaceholder("也可以补一句：哪里懂对了、哪里先放下、要怎么记准")).toBeVisible();
  await expect(page.getByText("查看后台流程")).toBeVisible();
  await expect(page.getByText("我刚才注意到：")).toHaveCount(0);
  await expect(page.getByText("我为什么注意：")).toHaveCount(0);
  await expect(page.getByText("来自半分钟里的一小段").first()).toBeVisible();
  expect(await navSitsOutsideScrollPort(page)).toBe(true);

  const homeScreenshot = await page.screenshot({ fullPage: true, path: testInfo.outputPath(`${testInfo.project.name}-home.png`) });
  expect(homeScreenshot.byteLength).toBeGreaterThan(30_000);

  await page.getByRole("button", { name: "对话" }).click();
  await expect(page.getByText("和 Papo 的小日常")).toBeVisible();
  await expect(page.getByText("半分钟里的一小段")).toBeVisible();
  await expect(page.getByText("你给 Papo 看了照片")).toBeVisible();
  await expect(page.getByText("Papo", { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel("有未读 Papo 回复")).toHaveCount(0);
  const chatScreenshot = await page.screenshot({ fullPage: true, path: testInfo.outputPath(`${testInfo.project.name}-chat.png`) });
  expect(chatScreenshot.byteLength).toBeGreaterThan(30_000);

  await page.getByRole("button", { name: "记忆" }).click();
  await expect(page.getByRole("heading", { name: "我记住的事" })).toBeVisible();
  await expect(page.getByText(/它以后可能还会回来找你，我先记着：如果你能说话/)).toBeVisible();
  await expect(page.getByText("我留下它，是因为这件事以后可能还会回来找你。")).toBeVisible();
  await expect(page.getByText(/用户|小动物|episode|candidate|长期保存|当前事件|保存意图|未来价值/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "教我记准" })).toBeVisible();
  await expect(page.getByRole("button", { name: "帮我先放下" })).toBeVisible();
  await expect(page.getByText("来自半分钟里的一小段")).toBeVisible();
  await expect(page.getByText("来源细节")).toHaveCount(0);
  await expect(page.getByText(/batch life-batch-1|segment photo-review/)).toHaveCount(0);
  const memoryScreenshot = await page.screenshot({ fullPage: true, path: testInfo.outputPath(`${testInfo.project.name}-memory.png`) });
  expect(memoryScreenshot.byteLength).toBeGreaterThan(30_000);

  await page.getByRole("button", { name: "陪我" }).click();
  await expect(page.getByText("陪我一会儿")).toBeVisible();
  await expect(page.getByText("可以让 Papo 持续听一会儿")).toBeVisible();
  await expect(page.getByText(/最多 3 分钟，每 30 秒整理一次声音/)).toBeVisible();
  await expect(page.getByRole("button", { name: "开始听 3 分钟" })).toBeVisible();
  await expect(page.getByText("加照片", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "提交这件事" })).toBeVisible();
  await expect(page.getByText("刚才的对话")).toBeVisible();
  await expect(page.getByText("加一张照片")).toHaveCount(0);
  await expect(page.getByText("加一段录音")).toHaveCount(0);
  await expect(page.getByText("加一小段")).toHaveCount(0);
  await expect(page.getByText("让 Papo 看看")).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(page.getByText("Curious Mode")).toHaveCount(0);

  await page.getByRole("button", { name: "演示" }).click();
  await expect(page.getByText("带 Papo 走一圈")).toBeVisible();
  await expect(page.getByRole("button", { name: "带 Papo 完整走一圈" })).toBeVisible();
  await expect(page.getByText(/场景 1|一键准备/)).toHaveCount(0);
});

async function navSitsOutsideScrollPort(page: Page) {
  const [nav, shell] = await Promise.all([page.locator(".nav").boundingBox(), page.locator(".shell").boundingBox()]);
  if (!nav || !shell) return false;
  return nav.y >= shell.y + shell.height - 2;
}

async function mockPapoApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/provider") {
      return route.fulfill({ json: { kind: "generic", name: "Generic model API", available: true, usesRealModel: true } });
    }
    if (path === "/api/profiles" && method === "GET") {
      return route.fulfill({ json: { profiles: [{ userId: "u1", creatureName: "Papo" }] } });
    }
    if (path === "/api/profiles/u1" && method === "GET") {
      return route.fulfill({ json: { profile: profileFixture() } });
    }
    if (path === "/api/profiles/u1/wake" && method === "POST") {
      return route.fulfill({
        json: {
          profile: profileFixture(),
          wake: {
            id: "wake1",
            at: now,
            elapsedMinutes: 18,
            message: "我刚刚醒着，你一打开我就还在这里。",
            innerThought: "我醒来时又碰到妈妈复查这件小事。",
            relatedMemoryIds: ["memory-review"],
            emergenceId: "emergence1",
            stateChangeReason: "app_wake_short_gap",
            stateDelta: {},
            ruleTrace: ["elapsed_minutes=18", "state_delta=none"]
          }
        }
      });
    }

    return route.fulfill({ status: 404, json: { error: `Unhandled mocked API route: ${method} ${path}` } });
  });
}

const now = "2026-07-07T08:30:00.000Z";
const observedAt = "2026-07-07T08:00:00.000Z";

function profileFixture() {
  return {
    userId: "u1",
    creatureName: "Papo",
    createdAt: now,
    lastSeenAt: now,
    state: {
      curiosity: 74,
      attachment: 64,
      energy: 72,
      arousal: 46,
      safety: 60,
      confidence: 58,
      mood: "curious"
    },
    episodes: [
      {
        id: "episode-review",
        createdAt: now,
        source: "curious_stream",
        sourceSegmentId: "photo-review",
        sourceBatchId: "life-batch-1",
        sourceObservedAt: observedAt,
        sourceLocation: { latitude: 52.52, longitude: 13.405, accuracy: 24, label: "上传时的位置" },
        inputSummary: "日历照片：妈妈周五复查，需要提前准备病历。",
        noticed: "我注意到妈妈复查需要提前准备病历。",
        possibleIntent: "你可能希望 Papo 帮你提前留意重要家事。",
        importanceReason: "这段带着未来价值和一点担心，不像背景噪音。",
        relatedMemoryIds: ["memory-review"],
        stateSnapshot: {
          curiosity: 74,
          attachment: 64,
          energy: 72,
          arousal: 46,
          safety: 60,
          confidence: 58,
          mood: "curious"
        },
        creatureResponse: "我把这张日历照片和你刚才的担心放在一起听了。",
        creatureExperience: {
          earReason: "这段需要回应，因为这是你很容易拖到最后的重要家事。",
          rememberedScene: "我想起你之前也说过，重要家事容易被压到睡前。",
          actionFeeling: "我更想先轻轻提醒你把资料提前准备好。",
          saveFeeling: "这件事值得先成为一段共同经历，等你的反馈决定要不要长期留下。"
        },
        actionDecision: {
          action: "ask",
          confidence: 0.78,
          reason: "这段适合轻轻追问是否需要提前准备。",
          blockedActions: [],
          safetyNotes: [],
          ruleTrace: ["visual-test-fixture"]
        },
        feedback: [],
        promotedToLongTerm: true,
        memoryCandidateIds: ["candidate-review"],
        weight: 82,
        tags: ["妈妈复查", "病历", "家事"]
      }
    ],
    longTermMemories: [
      {
        id: "memory-review",
        createdAt: now,
        sourceEpisodeId: "episode-review",
        kind: "future_review",
        text: "我先试着理解：我注意到这个片段可能是你想让我认真理解的当前事件：如果你能说话 你就说句话给我听。我还没有强烈联想到旧记忆，所以先把它作为新的情景片段。这段需要用户确认，尤其是隐私、情绪或保存意图还不够明确。",
        weight: 82,
        tags: ["妈妈复查", "病历"],
        consolidatedBecause: "这条 episode 有未来价值。"
      },
      {
        id: "memory-self",
        createdAt: now,
        kind: "creature_self_memory",
        text: "我正在学着把你递来的照片、文字和声音放成一段共同经历。",
        weight: 66,
        tags: ["共同经历", "注意"]
      },
      {
        id: "memory-raised",
        createdAt: now,
        kind: "creature_self_memory",
        text: "你教我不要浅浅带过。以后遇到「妈妈复查」，我会多停一下，先想起以前的小事再回应。",
        weight: 74,
        tags: ["被你养成", "更愿意多想", "妈妈复查"]
      }
    ],
    feedbackHistory: [],
    stateChanges: [],
    policyProfile: {
      preferDepth: 53,
      preferProactivity: 48,
      privacySensitivity: 58,
      saveThreshold: 68,
      askThreshold: 55,
      recallTendency: 58,
      quietTendency: 32
    },
    memoryCandidates: [],
    emergenceHistory: [],
    wakeHistory: [],
    semanticBrainHistory: [],
    conversation: [
      {
        id: "papo-attention",
        at: now,
        role: "papo",
        channel: "curious",
        text: "我把这张日历照片和你刚才的担心放在一起听了。",
        sourceId: "episode-review",
        relatedMemoryIds: ["memory-review"]
      },
      {
        id: "user-photo",
        at: observedAt,
        role: "world",
        channel: "curious",
        text: "日历照片：妈妈周五复查，需要提前准备病历。",
        sourceId: "photo-review",
        relatedMemoryIds: ["memory-review"],
        modality: "image_summary",
        batchId: "life-batch-1",
        observedAt,
        location: { latitude: 52.52, longitude: 13.405, accuracy: 24, label: "上传时的位置" }
      },
      {
        id: "user-text",
        at: observedAt,
        role: "user",
        channel: "curious",
        text: "我怕自己又拖到睡前才准备复查资料。",
        sourceId: "text-review",
        relatedMemoryIds: ["memory-review"],
        modality: "text",
        batchId: "life-batch-1",
        observedAt
      },
      {
        id: "wake-message",
        at: now,
        role: "papo",
        channel: "wake",
        text: "我刚刚醒着，你一打开我就还在这里。",
        sourceId: "wake1",
        relatedMemoryIds: ["memory-review"]
      }
    ]
  };
}

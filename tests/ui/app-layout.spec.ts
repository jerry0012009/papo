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
  await page.getByRole("button", { name: "Papo 动过" }).click();
  const actionGallery = page.getByRole("dialog", { name: "Papo 的动作卡" });
  await expect(actionGallery).toBeVisible();
  await expect(actionGallery).toContainText("Papo 抓蝴蝶");
  await expect(actionGallery.locator("video")).toBeVisible();
  await page.getByRole("button", { name: "收起" }).click();

  await page.locator(".home-stage").getByRole("button", { name: "小眼睛" }).click();

  const panel = page.getByRole("dialog", { name: /Papo 状态/ });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("状态");
  await expect(panel).toContainText("动作卡");
  await expect(panel.locator("video")).toBeVisible();
  await panel.getByRole("button", { name: "禁用" }).click();
  await expect(panel.locator(".action-card-admin.disabled")).toBeVisible();
  await expect(panel).toContainText("最近状态日记");
  await expect(panel).toContainText("悄悄看你");
  await expectInViewport(page, panel);

  await page.getByRole("button", { name: "收起小眼睛" }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByRole("button", { name: "Papo 动过" })).toHaveCount(0);

  await page.getByRole("button", { name: "Papo 画过" }).click();
  const gallery = page.getByRole("dialog", { name: "Papo 画过的小画" });
  await expect(gallery).toBeVisible();
  await expect(gallery).toContainText("今天的泳池小画");
  await expect(gallery.locator("img")).toBeVisible();
  await expectInViewport(page, gallery);
});

test("profile can rename the creature and logged-in UI follows the new name", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "看看哪只 Papo 在身边" }).click();
  await page.getByLabel("名字").fill("吉祥");
  await page.getByRole("button", { name: "保存名字" }).click();
  await expect(page.getByText("名字已保存")).toBeVisible();
  await expect(page.locator(".account-card")).toContainText("吉祥");

  await page.locator(".nav").getByRole("button", { name: /首页/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "吉祥" })).toBeVisible();
  await expect(page.getByRole("button", { name: "吉祥 动过" })).toBeVisible();
  await page.getByRole("button", { name: "吉祥 动过" }).click();
  await expect(page.getByRole("dialog", { name: "吉祥 的动作卡" })).toContainText("吉祥 抓蝴蝶");
  await page.getByRole("button", { name: "收起" }).click();

  await page.locator(".nav").getByRole("button", { name: /对话/ }).click();
  await expect(page.getByPlaceholder("告诉 吉祥...")).toBeVisible();
  await expect(page.getByRole("button", { name: "发送给 吉祥" })).toBeVisible();
});

test("home guide poster explains Papo without overflowing", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "了解 Papo 怎么陪你" }).click();
  const guide = page.getByRole("dialog", { name: /会陪伴、会记住/ });
  await expect(guide).toBeVisible();
  await expect(guide).toContainText("一只会陪伴、会记住、会自己行动的小动物");
  await expect(guide).toContainText("持续陪伴，但不打扰");
  await expect(guide).toContainText("虾虾是背后的好朋友");
  await expect(guide).toContainText("最自然的用法");
  await expectInViewport(page, guide);
});

test("home adapts generated British Shorthair and tap changes pose", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("papo:testPetKind", "british-shorthair");
  });
  await page.goto("/");

  await expect(page.getByText("住在手机里的小猫")).toBeVisible();
  await expect(page.getByText("住在手机里的小狗")).toHaveCount(0);
  const avatar = page.locator(".home-stage .generated-pet-avatar video");
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute("src", /pets\/generated\/british-shorthair-v1\/poke-wave\.mp4/);
  await expect(avatar).toHaveAttribute("poster", /pets\/generated\/british-shorthair-v1\/poke-wave\.webp/);

  await page.getByRole("button", { name: "戳戳 Papo" }).click();
  await expect(avatar).toHaveAttribute("src", /pets\/generated\/british-shorthair-v1\/play-ball\.mp4/);
  await expect(page.locator(".home-speech")).toContainText("小球");
});

test("chat opens at latest content and keeps the composer aligned with the thread", async ({ page }) => {
  await page.goto("/");
  await page.locator(".nav").getByRole("button", { name: /对话/ }).click();

  await expect(page.locator(".chat-bubble.papo p", { hasText: "最近一条回复在这里。" }).last()).toBeVisible();
  await expect(page.getByPlaceholder("告诉 Papo...")).toBeVisible();
  const sendButton = page.locator(".chat-send-button");
  await expect(sendButton).toBeVisible();
  await expect(sendButton).toHaveCSS("color", "rgb(77, 86, 79)");
  await expect(sendButton).toHaveClass(/chat-send-button/);
  await expectButtonTextFits(sendButton);
  await page.getByLabel("添加素材").click();
  await expect(page.locator(".composer-add-options")).toBeVisible();
  await expect(page.locator(".composer-add-options").getByText("相册")).toBeVisible();
  const userBubbleColor = await page.locator(".chat-bubble.user p").last().evaluate((node) => getComputedStyle(node).backgroundColor);
  const papoBubbleColor = await page.locator(".chat-bubble.papo p").last().evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(userBubbleColor).not.toBe(papoBubbleColor);

  const audioBubble = page.locator(".chat-bubble.world").filter({ hasText: "这段声音里" }).last();
  await expect(audioBubble).toBeVisible();
  await expect(audioBubble).toContainText("这段声音里");
  await expect(audioBubble).not.toContainText("消耗卡路里很多很快");

  const listBox = await page.locator(".chat-list").boundingBox();
  const composerBox = await page.locator(".chat-composer").boundingBox();
  expect(listBox).toBeTruthy();
  expect(composerBox).toBeTruthy();
  expect(Math.abs(listBox!.width - composerBox!.width)).toBeLessThanOrEqual(2);

  await page.locator(".chat-bubble.papo").filter({ hasText: "最近一条回复在这里。" }).getByRole("button", { name: "查看这句话背后的模型调用" }).click();
  const trace = page.locator(".developer-trace-body").first();
  await expect(trace).toBeVisible();
  await expect(trace).toContainText("模型调用");
  await expectInViewport(page, trace);
});

test("quick microphone recording exposes recording, stop, processing, and send states", async ({ page }) => {
  await installMockMicrophone(page);
  await page.goto("/");
  await page.locator(".nav").getByRole("button", { name: /对话/ }).click();

  await page.getByRole("button", { name: "录一段声音" }).click();
  await expect(page.locator(".quick-audio-status").getByText(/录音中/)).toBeVisible();
  await expect(page.getByRole("button", { name: "停止" })).toBeVisible();

  await page.getByRole("button", { name: "停止" }).click();
  await expect(page.getByText("正在整理录音")).toBeVisible();
  const stagedAudio = page.locator(".staged-segment.audio_observation");
  await expect(stagedAudio).toBeVisible({ timeout: 3_000 });
  await expect(stagedAudio.locator("textarea")).toHaveCount(0);
  await expect(stagedAudio).toContainText("一段声音");
  await expect(stagedAudio).not.toContainText("我听到你说想测试录音按钮。");
  await expect(page.getByRole("button", { name: "发送给 Papo" })).toBeVisible();
});

test("photo upload stages a thumbnail that can be removed before submit", async ({ page }) => {
  await page.goto("/");
  await page.locator(".nav").getByRole("button", { name: /对话/ }).click();

  await page.getByLabel("添加素材").click();
  await page.locator(".compact-upload").filter({ hasText: "相册" }).locator("input").setInputFiles({
    name: "pool.jpg",
    mimeType: "image/jpeg",
    buffer: tinyJpeg()
  });

  const stagedPhoto = page.locator(".staged-segment.image_summary");
  await expect(stagedPhoto).toBeVisible();
  await expect(stagedPhoto.locator("img")).toBeVisible();
  await expect(stagedPhoto).not.toContainText("Papo 正在接住这次分享");
  await expect(stagedPhoto).not.toContainText("照片、文字和声音线索正在传过去");
  await expect(stagedPhoto).not.toContainText("照片已加入");
  await expect(stagedPhoto).not.toContainText("照片已准备好");
  await expect(stagedPhoto).not.toContainText("pool.jpg");
  await expect(stagedPhoto.locator(".staged-image-overlay")).toHaveCount(0, { timeout: 3_000 });

  await stagedPhoto.getByRole("button", { name: "查看待发送照片" }).click();
  const preview = page.getByRole("dialog");
  await expect(preview.locator("img")).toBeVisible();
  await expectInViewport(page, preview);
  await preview.getByRole("button", { name: "关闭" }).click();
  await expect(preview).toHaveCount(0);

  await stagedPhoto.getByRole("button", { name: "移除这项素材" }).click();
  await expect(stagedPhoto).toHaveCount(0);
});

test("photo upload during companion mode waits for explicit submit", async ({ page }) => {
  await installMockMicrophone(page);
  await page.goto("/");
  await page.getByRole("button", { name: /陪我/ }).first().click();
  await expect(page.locator(".listening-session-status")).toBeVisible();

  await page.getByLabel("添加素材").click();
  await page.locator(".compact-upload").filter({ hasText: "相册" }).locator("input").setInputFiles({
    name: "companion-photo.jpg",
    mimeType: "image/jpeg",
    buffer: tinyJpeg()
  });

  const stagedPhoto = page.locator(".staged-segment.image_summary");
  await expect(stagedPhoto.locator("img")).toBeVisible({ timeout: 3_000 });
  await expect(page.locator(".chat-bubble.world", { hasText: "companion-photo.jpg" })).toHaveCount(0);

  await page.getByRole("button", { name: "发送给 Papo" }).click();
  await expect(page.locator(".staged-segment.image_summary")).toHaveCount(0);
  await expect(page.locator(".chat-bubble.world", { hasText: "这张照片里" })).toBeVisible();
});

test("photo submit shows a visible in-flight handoff state", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("papo:slowCuriousCapture", "1");
  });
  await page.goto("/");
  await page.locator(".nav").getByRole("button", { name: /对话/ }).click();

  await page.getByLabel("添加素材").click();
  await page.locator(".compact-upload").filter({ hasText: "相册" }).locator("input").setInputFiles({
    name: "handoff-photo.jpg",
    mimeType: "image/jpeg",
    buffer: tinyJpeg()
  });

  await expect(page.locator(".staged-segment.image_summary img")).toBeVisible({ timeout: 3_000 });
  await page.getByRole("button", { name: "发送给 Papo" }).click();
  await expect(page.getByRole("button", { name: "发送给 Papo" })).toBeDisabled();
  await expect(page.locator(".chat-bubble.world", { hasText: "这张照片里" })).toBeVisible({ timeout: 4_000 });
  await expect(page.locator(".chat-bubble.world", { hasText: "handoff-photo.jpg" })).toHaveCount(0);
});

test("large phone photos are compressed before image summary upload", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("papo:captureImageUploadBytes", "1");
  });
  await page.goto("/");
  await page.locator(".nav").getByRole("button", { name: /对话/ }).click();
  const largePhoto = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 4200;
    canvas.height = 3200;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas unavailable");
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#d85d42");
    gradient.addColorStop(0.35, "#f2c14e");
    gradient.addColorStop(0.7, "#4f8f7b");
    gradient.addColorStop(1, "#304f8f");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < 180; index += 1) {
      context.fillStyle = `rgba(${index % 255}, ${(index * 7) % 255}, ${(index * 13) % 255}, 0.38)`;
      context.fillRect((index * 37) % canvas.width, (index * 53) % canvas.height, 80 + (index % 180), 40 + (index % 120));
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("blob unavailable")), "image/jpeg", 0.96));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });

  await page.getByLabel("添加素材").click();
  await page.locator(".compact-upload").filter({ hasText: "相册" }).locator("input").setInputFiles({
    name: "phone-original.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from(largePhoto)
  });

  const stagedPhoto = page.locator(".staged-segment.image_summary");
  await expect(stagedPhoto.locator(".staged-image-overlay")).toHaveCount(0, { timeout: 5_000 });
  const uploadedLength = await page.evaluate(() => Number(window.localStorage.getItem("papo:lastImageUploadLength") ?? 0));
  expect(uploadedLength).toBeGreaterThan(64);
  expect(uploadedLength).toBeLessThanOrEqual(3_500_000);
});

test("companion listening starts from home and shows a countdown in chat", async ({ page }) => {
  await installMockMicrophone(page);
  await page.goto("/");

  await page.getByRole("button", { name: /陪我/ }).first().click();
  await expect(page.getByPlaceholder("告诉 Papo...")).toBeVisible();
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
      const nextProfile = await profileWithTestOverrides(route, profile);
      profile = nextProfile;
      await json(route, { profile: nextProfile });
      return;
    }

    if (path === "/api/profiles/demo" && route.request().method() === "PATCH") {
      const requestBody = safePostJson(route) as { creatureName?: string };
      if (requestBody.creatureName?.trim()) profile = { ...profile, creatureName: requestBody.creatureName.trim() };
      await json(route, { profile });
      return;
    }

    if (path.startsWith("/api/profiles/demo/action-cards/") && route.request().method() === "PATCH") {
      const cardId = path.split("/").at(-1);
      const requestBody = safePostJson(route) as { disabled?: boolean; deleted?: boolean };
      profile = {
        ...profile,
        actionCards: (profile.actionCards ?? []).map((card) =>
          card.id === cardId ? { ...card, ...requestBody } : card
        )
      };
      await json(route, { profile });
      return;
    }

    if (path === "/api/profiles/demo/wake" && route.request().method() === "POST") {
      profile = await profileWithTestOverrides(route, profile);
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

    if (path === "/api/profiles/demo/pet-touch" && route.request().method() === "POST") {
      const requestBody = safePostJson(route) as { action?: string };
      if (requestBody.action === "play-ball") {
        profile = {
          ...profile,
          dogState: {
            ...profile.dogState,
            id: "ball_ready",
            label: "抱着球等你",
            actionText: "Papo 把小球抱在爪子边，等你看过来。",
            animation: "play",
            selectedBy: "touch"
          }
        };
      }
      await json(route, { profile, applied: requestBody.action === "play-ball" });
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

    if (path === "/api/image-summary" && route.request().method() === "POST") {
      const requestBody = safePostJson(route) as { label?: string };
      if (await route.request().frame().page().evaluate(() => window.localStorage.getItem("papo:captureImageUploadBytes") === "1")) {
        await route.request().frame().page().evaluate((length) => {
          window.localStorage.setItem("papo:lastImageUploadLength", String(length));
        }, typeof (requestBody as { dataUrl?: string }).dataUrl === "string" ? (requestBody as { dataUrl: string }).dataUrl.length : 0);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      await json(route, {
        summary: "一张测试照片，画面里有用户分享给 Papo 的生活片段。",
        asset: {
          id: "img_test_photo",
          kind: "image",
          label: requestBody.label ?? "照片",
          mime: "image/jpeg",
          url: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==",
          createdAt: now,
          sizeBytes: 24
        },
        provider: "mock-vision",
        model: "mock-vision",
        route: "chat_completions",
        semanticSource: "llm",
        sensingTrace: {
          at: now,
          modality: "image",
          label: requestBody.label ?? "照片",
          provider: "mock-vision",
          semanticSource: "llm",
          status: "content",
          decision: "测试图片可用",
          observation: "一张测试照片，画面里有用户分享给 Papo 的生活片段。",
          ruleTrace: ["route=curious_candidate"]
        }
      });
      return;
    }

    if (path === "/api/profiles/demo/curious" && route.request().method() === "POST") {
      if (await route.request().frame().page().evaluate(() => window.localStorage.getItem("papo:slowCuriousCapture") === "1")) {
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      const requestBody = safePostJson(route) as { segments?: Array<{ id: string; label: string; content: string; kind: string; attachments?: unknown[] }> };
      const firstSegment = requestBody.segments?.[0];
      if (firstSegment) {
        profile = {
          ...profile,
          conversation: [
            {
              id: `msg-world-${Date.now()}`,
              at: now,
              role: "world",
              channel: "curious",
              text: `${firstSegment.label}：${firstSegment.content}`,
              displayText: firstSegment.kind === "audio_observation" ? "这段声音里，你刚录了一段想交给 Papo 听的现场线索" : undefined,
              relatedMemoryIds: [],
              modality: firstSegment.kind,
              attachments: firstSegment.attachments as never
            },
            ...profile.conversation
          ]
        };
      }
      await json(route, { profile, events: [], episodes: [], response: "" });
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

async function profileWithTestOverrides(route: Route, profile: ReturnType<typeof makeProfile>) {
  const petKind = await route.request().frame().page().evaluate(() => window.localStorage.getItem("papo:testPetKind")).catch(() => null);
  if (!petKind) return profile;
  return { ...profile, petKind };
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

function safePostJson(route: Route) {
  try {
    return route.request().postDataJSON();
  } catch {
    return {};
  }
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

function tinyJpeg() {
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Ar//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
    "base64"
  );
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
      },
      {
        id: "msg-audio-1",
        at: "2026-07-07T12:01:30.000Z",
        role: "world",
        channel: "curious",
        text: "麦克风 1：音频中，说话者打招呼说“你好呀”，然后描述自己今天很开心去游泳，但游泳时人特别多，全是小朋友，会互相撞。说话者感叹“哎呀”，并说游泳真的是一件消耗卡路里很多很快的事情，自己还挺喜欢的。",
        displayText: "这段声音里，你提到今天去游泳，人很多，也聊到游泳消耗卡路里。",
        relatedMemoryIds: [],
        modality: "audio_observation",
        sensingTrace: {
          at: now,
          modality: "audio",
          label: "麦克风 1",
          provider: "mock-audio",
          semanticSource: "llm",
          status: "content",
          decision: "测试音频可用",
          observation:
            "音频中，说话者打招呼说“你好呀”，然后描述自己今天很开心去游泳，但游泳时人特别多，全是小朋友，会互相撞。说话者感叹“哎呀”，并说游泳真的是一件消耗卡路里很多很快的事情，自己还挺喜欢的。",
          ruleTrace: ["route=curious_candidate"]
        }
      }
    ],
    feedbackHistory: [],
    stateChanges: [],
    emergenceHistory: [],
    wakeHistory: [],
    dreamHistory: [],
    illustrations: [
      {
        id: "img_ui_illustration",
        createdAt: now,
        kind: "evening_diary",
        title: "今天的泳池小画",
        caption: "泳池很热闹，但你还是游得开心。",
        prompt: "手绘漫画泳池明信片",
        style: "手绘漫画明信片",
        sourceIds: ["episode-1"],
        providerKind: "generic",
        providerName: "ui provider",
        model: "fake-image",
        attachment: {
          id: "img_ui_illustration",
          kind: "image",
          label: "今天的泳池小画",
          mime: "image/png",
          url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
          createdAt: now,
          generatedBy: "papo_illustration",
          sizeBytes: 68
        }
      }
    ],
    actionCards: [
      {
        id: "vid_ui_action",
        createdAt: now,
        title: "Papo 抓蝴蝶",
        caption: "它轻轻追了一下小蝴蝶。",
        prompt: "cute pet chasing a butterfly",
        style: "cute commercial pet animation",
        durationSeconds: 8,
        sourceIds: ["episode-1"],
        providerKind: "openrouter",
        providerName: "openrouter video",
        model: "alibaba/happyhorse-1.1",
        video: {
          id: "vid_ui_action",
          kind: "video",
          label: "Papo 抓蝴蝶",
          mime: "video/mp4",
          url: "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQ==",
          createdAt: now,
          generatedBy: "papo_action_card",
          sizeBytes: 32
        }
      }
    ],
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

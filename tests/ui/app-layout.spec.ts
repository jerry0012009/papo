import { expect, test, type Page, type Route } from "@playwright/test";

const now = "2026-07-07T12:00:00.000Z";

test.beforeEach(async ({ page }, testInfo) => {
  await installMockApi(page);
  await page.route("**/papo/android/latest.json", async (route) => {
    await json(route, {
      versionName: "0.3.1",
      versionCode: 5,
      downloadUrl: "https://eu.jerrypsy.top/papo/android/papo-0.3.1.apk",
      publishedAt: "2026-07-10T22:00:00.000Z",
      notes: ["陪看模式调整为每 5 分钟拍摄一帧"]
    });
  });
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
  await expect(page.locator(".pet-option")).toHaveCount(7);
  await expect(page.getByRole("button", { name: /柴犬 Papo/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /英短短/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /金毛犬/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /布偶猫/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /垂耳兔/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /小仓鼠/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /玄凤鹦鹉/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Claude|Codex|DataWhale|Dewey|Fireball|Mo Xia|Rocky|Seedy|Stacky/ })).toHaveCount(0);
  await expect(page.locator(".pet-option img")).toHaveCount(1);
  await expect(page.locator(".pet-option video")).toHaveCount(6);
  await expect(page.locator(".pet-option img").first()).toHaveAttribute("src", /pets\/register\/shiba\.jpg/);
  await expect(page.locator(".pet-option video").first()).toHaveAttribute("src", /british-shorthair-v1\/idle\.mp4|pets\/register\/golden-retriever\.mp4/);
  await expect(page.locator(".pet-option .registration-pet-avatar")).toHaveCount(7);
  await expect(page.locator(".pet-option .shiba")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "开始养 Papo" })).toBeDisabled();
});

test("home developer panel opens and closes without overflowing", async ({ page }, testInfo) => {
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

  await gallery.getByRole("button", { name: /今天的泳池小画/ }).click();
  const imageViewer = page.locator(".papo-photo-view");
  await expect(imageViewer).toBeVisible();
  const downloadButton = imageViewer.getByRole("button", { name: "下载原图" });
  const closeButton = imageViewer.getByRole("button", { name: "关闭图片" });
  await expect(downloadButton).toBeVisible();
  await expect(closeButton).toBeVisible();
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("viewport is unavailable");
  const fillRatio = Math.min(viewport.width, viewport.height) >= 600 || viewport.width > viewport.height ? 0.8 : 0.86;
  await expect.poll(async () => {
    const box = await imageViewer.locator(".papo-photo-view-image").boundingBox();
    if (!box) return Number.POSITIVE_INFINITY;
    return Math.min(Math.abs(box.width - viewport.width * fillRatio), Math.abs(box.height - viewport.height * fillRatio));
  }).toBeLessThan(40);
  const imageBox = await imageViewer.locator(".papo-photo-view-image").boundingBox();
  const downloadBox = await downloadButton.boundingBox();
  const closeBox = await closeButton.boundingBox();
  expect(imageBox).not.toBeNull();
  expect(downloadBox).not.toBeNull();
  expect(closeBox).not.toBeNull();
  expect(Math.min(Math.abs(imageBox!.width - viewport.width * fillRatio), Math.abs(imageBox!.height - viewport.height * fillRatio))).toBeLessThan(40);
  expect(closeBox!.x).toBeGreaterThan(viewport.width / 2);
  expect(closeBox!.y).toBeLessThan(viewport.height / 3);
  expect(downloadBox!.x).toBeGreaterThan(viewport.width / 2);
  expect(downloadBox!.y).toBeGreaterThan(viewport.height * 2 / 3);
  expect(await imageViewer.locator(".PhotoView-Slider__BannerWrap").evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgba(0, 0, 0, 0)");

  if (testInfo.project.name === "mobile") await pinchImage(page, imageViewer, 45, 140);
  else await imageViewer.locator(".papo-photo-view-image").dblclick();
  await expect.poll(async () => {
    return viewerScale(imageViewer);
  }).toBeGreaterThan(1.5);

  if (testInfo.project.name === "mobile") {
    await pinchImage(page, imageViewer, 140, 45);
    await expect.poll(() => viewerScale(imageViewer)).toBeLessThan(1.15);
  }

  await page.goBack();
  await expect(imageViewer).toBeHidden();
  await expect(gallery).toBeVisible();

  await gallery.getByRole("button", { name: /今天的泳池小画/ }).click();
  await expect(imageViewer).toBeVisible();
  await imageViewer.getByRole("button", { name: "关闭图片" }).click();
  await expect(imageViewer).toBeHidden();
  await expect(gallery).toBeVisible();

  await gallery.getByRole("button", { name: /今天的泳池小画/ }).click();
  await expect(imageViewer).toBeVisible();
  const photoWrap = imageViewer.locator(".PhotoView__PhotoWrap").first();
  if (testInfo.project.name === "mobile") await photoWrap.tap({ position: { x: 5, y: 5 } });
  else await photoWrap.click({ position: { x: 5, y: 5 } });
  await expect(imageViewer).toBeHidden();
  await expect(gallery).toBeVisible();

  await page.goBack();
  await expect(gallery).toBeHidden();
});

async function pinchImage(page: Page, viewer: ReturnType<Page["locator"]>, fromDistance: number, toDistance: number) {
  const box = await viewer.locator(".PhotoView__PhotoWrap").first().boundingBox();
  if (!box) throw new Error("lightbox slide is not visible");
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  const session = await page.context().newCDPSession(page);
  const points = (distance: number) => [
    { x: centerX - distance, y: centerY, radiusX: 4, radiusY: 4, force: 1, id: 0 },
    { x: centerX + distance, y: centerY, radiusX: 4, radiusY: 4, force: 1, id: 1 }
  ];
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(fromDistance) });
  for (let step = 1; step <= 6; step += 1) {
    const distance = fromDistance + (toDistance - fromDistance) * step / 6;
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(distance) });
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function viewerScale(viewer: ReturnType<Page["locator"]>) {
  return Number(await viewer.locator(".papo-photo-view-toolbar").evaluate((node) => node.style.getPropertyValue("--papo-photo-view-scale") || 1));
}

test("profile can rename the creature and logged-in UI follows the new name", async ({ page }) => {
  await page.goto("/");

  await page.locator(".nav").getByRole("button", { name: "我的" }).click();
  await page.getByRole("button", { name: "Papo 设置" }).click();
  await page.locator(".profile-setting-group").filter({ hasText: "名字" }).locator("summary").click();
  await page.getByLabel("名字").fill("吉祥");
  await page.getByRole("button", { name: "保存名字" }).click();
  await expect(page.getByText("名字已保存")).toBeVisible();
  await expect(page.locator(".profile-identity")).toContainText("吉祥");

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

test("chat, memory, illustrations, and action cards share the media viewer", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByLabel("Papo 导航");

  await nav.getByRole("button", { name: "对话" }).click();
  await page.getByRole("button", { name: "查看图片：对话里的照片" }).click();
  await expect(page.locator(".papo-photo-view")).toBeVisible();
  await page.getByRole("button", { name: "关闭图片" }).click();
  await expect(page.getByRole("heading", { name: "和 Papo 说话" })).toBeVisible();

  await page.getByRole("button", { name: "播放视频：对话里的动作视频" }).click();
  const videoViewer = page.getByRole("dialog", { name: "播放视频：对话里的动作视频" });
  await expect(videoViewer).toBeVisible();
  await expect(videoViewer.locator("video")).toHaveAttribute("controls", "");
  await expect(videoViewer.getByRole("button", { name: "下载原文件" })).toBeVisible();
  await videoViewer.getByRole("button", { name: "关闭媒体" }).click();
  await expect(page.getByRole("heading", { name: "和 Papo 说话" })).toBeVisible();

  await nav.getByRole("button", { name: "记忆" }).click();
  await page.getByRole("button", { name: "查看记忆：旺旺仙贝" }).click();
  await page.getByRole("button", { name: "查看图片：旺旺仙贝" }).click();
  await expect(page.locator(".papo-photo-view")).toBeVisible();
  await page.getByRole("button", { name: "关闭图片" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Papo 记得的生活" })).toBeVisible();

  await nav.getByRole("button", { name: "我的" }).click();
  await page.getByRole("button", { name: "播放视频：Papo 抓蝴蝶" }).click();
  await expect(page.getByRole("dialog", { name: "播放视频：Papo 抓蝴蝶" })).toBeVisible();
});

test("native media download resolves API assets and waits for Android save completion", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Native bridge behavior runs once in the mobile project");
  await page.addInitScript(() => {
    const state = { options: undefined as unknown, resolved: false, complete: undefined as (() => void) | undefined };
    Object.assign(window as unknown as Record<string, unknown>, {
      androidBridge: {},
      __papoMediaDownload: state,
      Capacitor: {
        PluginHeaders: [{ name: "PapoMedia", methods: [{ name: "downloadMedia", rtype: "promise" }] }],
        nativePromise(_plugin: string, method: string, options: unknown) {
          if (method !== "downloadMedia") return Promise.reject(new Error("unexpected native method"));
          state.options = options;
          return new Promise((resolve) => { state.complete = () => { state.resolved = true; resolve({ uri: "content://downloads/papo" }); }; });
        }
      }
    });
  });
  await page.addInitScript(() => localStorage.setItem("papo:nativeDownloadTest", "1"));
  await page.goto("/");
  await page.getByLabel("Papo 导航").getByRole("button", { name: "对话" }).click();
  await page.getByRole("button", { name: "查看图片：安卓下载测试图" }).click();
  await page.getByRole("button", { name: "下载原图" }).click();
  await expect(page.getByRole("status")).toContainText("正在保存原文件");
  await page.evaluate(() => (window as unknown as { __papoMediaDownload: { complete?: () => void } }).__papoMediaDownload.complete?.());
  await expect(page.getByRole("status")).toContainText("已保存到系统下载/Papo");
  const state = await page.evaluate(() => (window as unknown as { __papoMediaDownload: { options: { url: string; mime: string }; resolved: boolean } }).__papoMediaDownload);
  expect(state.resolved).toBe(true);
  expect(state.options.url).toBe("https://eu.jerrypsy.top/papo-api/assets/android-download-test.jpg");
  expect(state.options.mime).toBe("image/jpeg");

  await page.getByRole("button", { name: "关闭图片" }).click();
  await page.getByRole("button", { name: "播放视频：对话里的动作视频" }).click();
  await page.getByRole("button", { name: "下载原文件" }).click();
  await expect(page.getByRole("status")).toContainText("正在保存原文件");
  const videoOptions = await page.evaluate(() => {
    const mediaState = (window as unknown as { __papoMediaDownload: { options: { url: string; mime: string; filename: string }; resolved: boolean; complete?: () => void } }).__papoMediaDownload;
    const options = mediaState.options;
    mediaState.complete?.();
    return options;
  });
  await expect(page.getByRole("status")).toContainText("已保存到系统下载/Papo");
  expect(videoOptions.mime).toBe("video/mp4");
  expect(videoOptions.filename).toMatch(/\.mp4$/);
});

test("my tab organizes content, companion settings, and account settings", async ({ page }, testInfo) => {
  await page.goto("/");

  const nav = page.locator(".nav");
  await expect(nav.getByRole("button")).toHaveCount(4);
  await expect(nav.getByRole("button", { name: "我的" })).toBeVisible();
  await nav.getByRole("button", { name: "我的" }).click();

  const hub = page.locator(".profile-hub");
  await expect(page.getByRole("heading", { level: 1, name: "我的" })).toBeVisible();
  await expect(hub).toContainText("@demo");
  await expect(hub.getByRole("heading", { name: "Papo" })).toBeVisible();
  await expect(hub.getByText("画过", { exact: true }).first()).toBeVisible();
  await expect(hub.getByText("动作卡", { exact: true }).first()).toBeVisible();
  await expect(hub.locator(".profile-illustration-rail img")).toBeVisible();
  const actionItem = hub.locator(".profile-action-item").first();
  await expect(actionItem.locator(".action-card-cover img, .action-card-cover .shiba")).toBeVisible();
  await expect(actionItem.locator("video")).toHaveCount(0);
  await expect(hub.locator(".memory-cover")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("my-hub.png"), fullPage: true });

  await hub.getByRole("button", { name: /查看图片：今天的泳池小画/ }).click();
  const viewer = page.locator(".papo-photo-view");
  await expect(viewer).toBeVisible();
  await page.goBack();
  await expect(viewer).toBeHidden();
  await expect(hub).toBeVisible();

  await actionItem.getByRole("button", { name: /播放视频/ }).click();
  await expect(page.getByRole("dialog", { name: /播放视频/ })).toBeVisible();
  await page.getByRole("button", { name: "关闭媒体" }).click();
  await actionItem.getByRole("button", { name: "停用" }).click();
  await expect(actionItem).toHaveClass(/disabled/);
  await actionItem.getByRole("button", { name: "启用" }).click();
  await expect(actionItem).not.toHaveClass(/disabled/);

  await hub.getByRole("button", { name: "Papo 设置" }).click();
  await expect(hub.getByText("设备与服务")).toBeVisible();
  await expect(hub.getByText("账号与安全")).toBeVisible();
  await hub.locator(".profile-setting-group").filter({ hasText: "名字" }).locator("summary").click();
  await expect(hub.getByLabel("名字")).toBeVisible();
  await hub.locator(".profile-setting-group").filter({ hasText: "形象与性格" }).locator("summary").click();
  await expect(hub.getByText("你想把它养成什么样")).toBeVisible();
  await page.goBack();
  await expect(hub.getByRole("button", { name: "Papo 设置" })).toBeVisible();
  await hub.locator(".memory-cover-details").first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Papo 记得的生活" })).toBeVisible();
});

test("native Android back closes the image viewer without leaving the app", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Android bridge behavior is covered on the mobile project");
  await page.addInitScript(() => {
    const nativeState = { callback: undefined as (() => void) | undefined, removed: false };
    Object.assign(window as unknown as Record<string, unknown>, {
      androidBridge: {},
      __papoNativeBack: nativeState,
      Capacitor: {
        PluginHeaders: [{ name: "App", methods: [{ name: "addListener", rtype: "callback" }, { name: "removeListener", rtype: "callback" }] }],
        nativeCallback(_plugin: string, method: string, _options: unknown, callback?: () => void) {
          if (method === "addListener") nativeState.callback = callback;
          if (method === "removeListener") nativeState.removed = true;
          return method === "addListener" ? "native-back-listener" : undefined;
        }
      }
    });
  });
  await page.goto("/");
  const nav = page.locator(".nav");
  await nav.getByRole("button", { name: "我的" }).click();
  const hub = page.locator(".profile-hub");
  await hub.getByRole("button", { name: /查看图片：今天的泳池小画/ }).click();
  const viewer = page.locator(".papo-photo-view");
  await expect(viewer).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __papoNativeBack?: { callback?: () => void } }).__papoNativeBack?.callback))).toBe(true);
  await page.evaluate(() => (window as unknown as { __papoNativeBack: { callback?: () => void } }).__papoNativeBack.callback?.());
  await expect(viewer).toBeHidden();
  await expect(hub).toBeVisible();
  await expect(nav.getByRole("button", { name: "我的" })).toHaveClass(/active/);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __papoNativeBack: { removed: boolean } }).__papoNativeBack.removed)).toBe(true);
});

test("four initial motions guide the user to chat for more action cards", async ({ page }) => {
  await page.addInitScript(() => {
    const baseCard = {
      id: "",
      createdAt: "2026-07-07T12:00:00.000Z",
      title: "动作",
      prompt: "动作",
      durationSeconds: 8,
      sourceIds: [],
      providerKind: "generic",
      providerName: "test",
      video: {
        id: "",
        kind: "video",
        label: "动作",
        mime: "video/mp4",
        url: "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQ==",
        createdAt: "2026-07-07T12:00:00.000Z"
      }
    };
    localStorage.setItem("papo:testProfileOverride", JSON.stringify({
      actionCards: Array.from({ length: 4 }, (_, index) => ({
        ...baseCard,
        id: `initial-${index}`,
        title: `初始动作 ${index + 1}`,
        sourceIds: [`initial-motion:motion-${index}`],
        video: { ...baseCard.video, id: `video-${index}` }
      }))
    }));
  });
  await page.goto("/");
  await page.locator(".nav").getByRole("button", { name: "我的" }).click();
  await page.getByRole("button", { name: "Papo 设置" }).click();
  await page.locator(".profile-setting-group").filter({ hasText: "生成动作" }).locator("summary").click();
  await expect(page.getByText(/还想增加动作卡，直接在对话里告诉/)).toBeVisible();
  await page.getByRole("button", { name: "去对话生成更多" }).click();
  await expect(page.getByPlaceholder("告诉 Papo...")).toBeVisible();
});

test("profile checks and exposes the latest Android APK", async ({ page }) => {
  await page.goto("/");
  await page.locator(".nav").getByRole("button", { name: "我的" }).click();
  await page.getByRole("button", { name: "Papo 设置" }).click();

  const updater = page.locator(".app-update-settings");
  await expect(updater).toContainText("Android 最新版 0.3.1");
  await expect(updater.getByRole("button", { name: "检查更新" })).toBeVisible();
  await expect(updater.getByRole("button", { name: "下载 0.3.1" })).toBeVisible();
});

test("installed Android detects and opens the latest update", async ({ page }) => {
  await installMockAndroidBridge(page, { versionName: "0.2.1", versionCode: 3 });
  await page.goto("/");
  await page.locator(".nav").getByRole("button", { name: "我的" }).click();
  await page.getByRole("button", { name: "Papo 设置" }).click();

  const updater = page.locator(".app-update-settings");
  await expect(updater).toContainText("当前 0.2.1，可更新到 0.3.1");
  await updater.getByRole("button", { name: "下载 0.3.1" }).click();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("papo:testOpenedUpdate"))).toBe(
    "https://eu.jerrypsy.top/papo/android/papo-0.3.1.apk"
  );
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
  const papoBubbleShell = await page.locator(".chat-bubble.papo").last().evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      borderColor: style.borderColor,
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow
    };
  });
  expect(papoBubbleShell.borderColor).toBe("rgba(0, 0, 0, 0)");
  expect(papoBubbleShell.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(papoBubbleShell.boxShadow).toBe("none");

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

test("quick microphone recording stages an audio placeholder without waiting for transcription", async ({ page }) => {
  await installMockMicrophone(page);
  await page.goto("/");
  await page.locator(".nav").getByRole("button", { name: /对话/ }).click();

  await page.getByRole("button", { name: "录一段声音" }).click();
  await expect(page.locator(".quick-audio-status").getByText(/录音中/)).toBeVisible();
  await expect(page.getByRole("button", { name: "停止" })).toBeVisible();

  await page.getByRole("button", { name: "停止" }).click();
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

  await stagedPhoto.getByRole("button", { name: "查看图片：待发送照片" }).click();
  const preview = page.locator(".papo-photo-view");
  await expect(preview.locator(".papo-photo-view-image")).toBeVisible();
  await expectInViewport(page, preview);
  await preview.getByRole("button", { name: "关闭图片" }).click();
  await expect(preview).toBeHidden();

  await stagedPhoto.getByRole("button", { name: "移除这项素材" }).click();
  await expect(stagedPhoto).toHaveCount(0);
});

test("photo upload during companion mode waits for explicit submit", async ({ page }) => {
  await installMockMicrophone(page);
  await page.goto("/");
  await startCompanionListening(page);
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
  await expect(page.locator(".companion-session", { hasText: "照片已收到" })).toBeVisible();
  await expect(page.locator(".conversation-work")).toContainText(/正在看照片|正在理解和回复/);
});

test("accepted turn shows immediately and composer stays available while work continues", async ({ page }) => {
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
  await expect(page.locator(".chat-bubble.user", { hasText: "照片已收到" })).toBeVisible({ timeout: 2_000 });
  await expect(page.locator(".conversation-work")).toContainText(/正在看照片|正在理解和回复/);
  const composer = page.locator(".chat-composer textarea").last();
  await composer.fill("后台还在处理时发送第二条");
  await expect(page.getByRole("button", { name: "发送给 Papo" })).toBeEnabled();
  await page.getByRole("button", { name: "发送给 Papo" }).click();
  await expect(page.locator(".chat-bubble.user", { hasText: "后台还在处理时发送第二条" })).toBeVisible();
  await expect(page.locator(".chat-bubble.world", { hasText: "handoff-photo.jpg" })).toHaveCount(0);
});

test("large phone photos are compressed before durable turn receipt", async ({ page }) => {
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
  await page.getByRole("button", { name: "发送给 Papo" }).click();
  await expect(page.locator(".chat-bubble.user", { hasText: "照片已收到" })).toBeVisible();
  const uploadedLength = await page.evaluate(() => Number(window.localStorage.getItem("papo:lastImageUploadLength") ?? 0));
  expect(uploadedLength).toBeGreaterThan(64);
  expect(uploadedLength).toBeLessThanOrEqual(3_500_000);
});

test("companion listening starts from home and shows a countdown in chat", async ({ page }) => {
  await installMockMicrophone(page);
  await page.goto("/");

  await page.getByRole("button", { name: /陪我/ }).first().click();
  await expect(page.getByRole("dialog", { name: "怎么陪你" })).toBeVisible();
  await page.getByRole("button", { name: /15 分钟/ }).click();
  await page.getByRole("button", { name: "开始陪伴" }).click();
  await expect(page.getByPlaceholder("告诉 Papo...")).toBeVisible();
  const listeningStatus = page.locator(".listening-session-status");
  await expect(listeningStatus).toBeVisible();
  await expect(listeningStatus).toContainText("陪你听着");
  await expect(listeningStatus).toContainText("15:00");
  await expect(listeningStatus).toContainText("剩余");
  await expect(listeningStatus.getByRole("button", { name: "停止陪我听" })).toBeVisible();
});

test("companion picker supports listen, watch, duration, and camera direction", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: /陪我/ }).first().click();
  const dialog = page.getByRole("dialog", { name: "怎么陪你" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "陪我", exact: true })).toHaveClass(/active/);
  await dialog.getByRole("button", { name: "陪我+看我", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "陪我+看我", exact: true })).toHaveClass(/active/);
  await dialog.getByRole("button", { name: "后置" }).click();
  await expect(dialog.getByRole("button", { name: "后置" })).toHaveClass(/active/);
  await dialog.getByRole("button", { name: /60 分钟/ }).click();
  await expect(dialog.getByRole("button", { name: /60 分钟/ })).toHaveClass(/active/);
  await expect(dialog.getByRole("button", { name: "开始陪伴" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("companion-picker.png"), fullPage: true });
});

test("companion listening skips a failed audio slice without showing technical abort errors", async ({ page }) => {
  await installMockMicrophone(page);
  await page.addInitScript(() => {
    window.localStorage.setItem("papo:testAudioAbort", "1");
  });
  await page.goto("/");

  await startCompanionListening(page);
  await expect(page.locator(".listening-session-status")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { papoRequestAudioSliceForTest?: (force: boolean) => void }).papoRequestAudioSliceForTest?.(true);
  });
  await page.waitForTimeout(500);

  await expect(page.getByText(/This operation was aborted/)).toHaveCount(0);
  await expect(page.getByText(/整理时断开/)).toHaveCount(0);
  await expect(page.locator(".listening-session-status")).toBeVisible();
});

test("companion browser slices enter the persistent async turn pipeline", async ({ page }) => {
  await installMockMicrophone(page);
  await page.addInitScript(() => window.localStorage.setItem("papo:captureCompanionTurn", "1"));
  await page.goto("/");
  await startCompanionListening(page);
  await page.evaluate(() => {
    (window as unknown as { papoRequestAudioSliceForTest?: (force: boolean) => void }).papoRequestAudioSliceForTest?.(true);
  });
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("papo:lastCompanionTurn"))).not.toBeNull();
  const captured = JSON.parse(await page.evaluate(() => window.localStorage.getItem("papo:lastCompanionTurn") ?? "{}")) as { turnId?: string; segments?: Array<{ sensingTrace?: unknown; companionSessionId?: string; batchId?: string }> };
  expect(captured.turnId).toMatch(/^turn_live_/);
  expect(captured.segments?.[0]?.sensingTrace).toBeTruthy();
  expect(captured.segments?.[0]?.companionSessionId).toMatch(/^live-/);
  expect(captured.segments?.[0]?.batchId?.startsWith(captured.segments?.[0]?.companionSessionId ?? "missing")).toBe(true);
});

test("text sent during companionship carries the active session context", async ({ page }) => {
  await installMockMicrophone(page);
  await page.addInitScript(() => window.localStorage.setItem("papo:captureCompanionTurn", "1"));
  await page.goto("/");
  await startCompanionListening(page);
  await page.getByPlaceholder("告诉 Papo...").fill("接下来我要听讲座");
  await page.getByRole("button", { name: "发送给 Papo" }).click();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("papo:lastCompanionTurn"))).not.toBeNull();
  const captured = JSON.parse(await page.evaluate(() => window.localStorage.getItem("papo:lastCompanionTurn") ?? "{}")) as { segments?: Array<{ content?: string; companionSessionId?: string }> };
  expect(captured.segments?.[0]?.content).toBe("接下来我要听讲座");
  expect(captured.segments?.[0]?.companionSessionId).toMatch(/^live-/);
  await expect(page.getByPlaceholder("告诉 Papo...")).toBeEnabled();
});

test("companion stream groups live slices into one readable session card", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("papo:testProfileOverride", JSON.stringify({
      conversation: [
        {
          id: "live-msg-2",
          at: "2026-07-07T12:00:35.000Z",
          observedAt: "2026-07-07T12:00:32.000Z",
          role: "world",
          channel: "curious",
          text: "听到的声音 2：这 30 秒里没有听到需要继续处理的内容。",
          displayText: "这 30 秒里没有听到需要继续处理的内容。",
          relatedMemoryIds: [],
          modality: "audio_observation",
          batchId: "live-2026-07-07T12:00:00.000Z-02",
          auditOnly: true,
          sensingTrace: { at: "2026-07-07T12:00:00.000Z", modality: "audio", label: "听到的声音 2", status: "empty", route: "ignored" }
        },
        {
          id: "live-msg-1",
          at: "2026-07-07T12:00:04.000Z",
          observedAt: "2026-07-07T12:00:02.000Z",
          role: "world",
          channel: "curious",
          text: "听到的声音 1：你在开会，提到了心理中心的会议安排。",
          displayText: "你在开会，提到了心理中心的会议安排。",
          relatedMemoryIds: [],
          modality: "audio_observation",
          batchId: "live-2026-07-07T12:00:00.000Z-01",
          auditOnly: false,
          sensingTrace: { at: "2026-07-07T12:00:00.000Z", modality: "audio", label: "听到的声音 1", status: "content", route: "curious_candidate" }
        }
      ]
    }));
  });
  await page.goto("/");
  await page.locator(".nav").getByRole("button", { name: /对话/ }).click();

  const session = page.locator(".companion-session");
  await expect(session).toBeVisible();
  await expect(session).toContainText("Papo 听了一会儿");
  await expect(session).toContainText("2 段声音");
  await expect(session).toContainText("1 段有内容");
  await expect(session).toContainText("你在开会，提到了心理中心的会议安排。");
  await expect(session.locator(".chat-bubble.world").first()).toBeHidden();
  await session.getByText("查看 2 条分段记录").click();
  await expect(session.locator(".chat-bubble.world").first()).toBeVisible();
});

test("memory feedback shows a pending state while the request is in flight", async ({ page }) => {
  await page.goto("/");
  await page.locator(".nav").getByRole("button", { name: /记忆/ }).click();

  await page.getByRole("button", { name: "查看记忆：旺旺仙贝" }).click();
  const memoryCard = page.locator(".memory-detail#memory-mem-1");
  await expect(memoryCard).toBeVisible();

  await memoryCard.getByRole("button", { name: "放下" }).click();
  await expect(memoryCard.getByRole("button", { name: "处理中" })).toBeVisible();
  await expect(memoryCard.getByRole("button", { name: /放下|彻底忘掉/ })).toBeVisible({ timeout: 2_000 });
});

test("profile memory links deep-link, focus, and survive refresh", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByLabel("Papo 导航").getByRole("button", { name: "我的" }).click();
  await page.getByRole("button", { name: "查看记忆：旺旺仙贝" }).click();

  await expect(page).toHaveURL(/open=memory.*memory=mem-1|memory=mem-1.*open=memory/);
  const target = page.locator(".memory-detail#memory-mem-1");
  await expect(target).toBeVisible();
  await expect(target.getByRole("heading", { name: "旺旺仙贝" })).toBeVisible();
  await expect(target.getByText("你喜欢旺旺仙贝")).toBeVisible();
  await expectInViewport(page, target.getByRole("heading", { name: "旺旺仙贝" }));
  await page.screenshot({ path: testInfo.outputPath(`memory-deep-link-${testInfo.project.name}.png`), fullPage: true });

  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Papo 记得的生活" })).toBeVisible();
  await expect(page.locator(".memory-detail#memory-mem-1")).toBeVisible();
  await page.getByRole("button", { name: "返回记忆列表" }).click();
  await expect(page.getByRole("button", { name: "查看记忆：旺旺仙贝" })).toBeVisible();
  await expect(page).not.toHaveURL(/memory=mem-1/);
  await page.screenshot({ path: testInfo.outputPath(`memory-list-${testInfo.project.name}.png`), fullPage: true });
});

test("wide desktop uses a scan-friendly memory archive and local trace controls", async ({ page }, testInfo) => {
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
  await page.getByRole("button", { name: /待确认 2/ }).click();
  const candidateCards = page.locator(".candidate-memory");
  await expect(candidateCards).toHaveCount(2);
  await expect(candidateCards.nth(0).getByRole("heading", { name: "记得更自然" })).toBeVisible();
  await expect(candidateCards.nth(0).getByRole("button", { name: "查看图片：记得更自然" })).toBeVisible();
  await expect(candidateCards.nth(1).getByRole("heading", { name: "界面像真正的co" })).toBeVisible();
  await expect(candidateCards.nth(1).locator(".candidate-memory-placeholder")).toBeVisible();
  await expect(candidateCards.nth(0).getByRole("button", { name: "留下这段记忆" })).toBeVisible();
  await expect(candidateCards.nth(0).getByRole("button", { name: "这次不留下" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath(`memory-candidate-inbox-${testInfo.project.name}.png`), fullPage: true });
  const first = await candidateCards.nth(0).boundingBox();
  const second = await candidateCards.nth(1).boundingBox();
  expect(first).toBeTruthy();
  expect(second).toBeTruthy();
  expect(second!.y).toBeGreaterThan(first!.y + first!.height * 0.8);
  expect(Math.abs(first!.x - second!.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(first!.width - second!.width)).toBeLessThanOrEqual(2);

  await page.getByRole("button", { name: /已留下 1/ }).click();
  const memoryCard = page.getByRole("button", { name: "查看记忆：旺旺仙贝" });
  const memoryImage = memoryCard.locator(".memory-archive-thumb");
  const memoryCopy = memoryCard.locator(".memory-archive-copy");
  const cardBox = await memoryCard.boundingBox();
  const imageBox = await memoryImage.boundingBox();
  const copyBox = await memoryCopy.boundingBox();
  expect(cardBox).toBeTruthy();
  expect(imageBox).toBeTruthy();
  expect(copyBox).toBeTruthy();
  expect(copyBox!.x).toBeGreaterThan(imageBox!.x + imageBox!.width);
  expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual((await page.locator(".app-main").boundingBox())!.x + (await page.locator(".app-main").boundingBox())!.width + 1);

  const companionBox = await page.locator(".companion-panel").boundingBox();
  expect(companionBox).toBeTruthy();
  expect(companionBox!.width).toBeGreaterThanOrEqual(300);
});

test("candidate memory inbox keeps visual hierarchy with and without artwork", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.locator(".nav").getByRole("button", { name: /记忆/ }).click();
  await page.getByRole("button", { name: /待确认 2/ }).click();

  const candidates = page.locator(".candidate-memory");
  await expect(candidates).toHaveCount(2);
  await expect(candidates.nth(0).getByRole("heading", { name: "记得更自然" })).toBeVisible();
  await expect(candidates.nth(0).getByRole("button", { name: "查看图片：记得更自然" })).toBeVisible();
  await expect(candidates.nth(1).getByRole("heading", { name: "界面像真正的co" })).toBeVisible();
  await expect(candidates.nth(1).locator(".candidate-memory-placeholder")).toBeVisible();
  await expect(candidates.nth(0).getByText("Papo 为什么暂存")).toBeVisible();
  await expect(candidates.nth(0).getByRole("button", { name: "留下这段记忆" })).toBeVisible();
  await expect(candidates.nth(0).getByRole("button", { name: "这次不留下" })).toBeVisible();
  await expectInViewport(page, candidates.nth(0));
  await page.screenshot({ path: testInfo.outputPath(`memory-candidate-inbox-${testInfo.project.name}.png`), fullPage: true });
});

test("memory lifecycle failures never appear as chat reply failures", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("papo:testProfileOverride", JSON.stringify({
    jobs: [
      { id: "candidate-preview-failed", turnId: "candidate_lifecycle_cand-1", requestId: "candidate_lifecycle_cand-1", type: "candidate_visual", stage: "action", status: "failed", attempt: 2, maxAttempts: 2, retryable: true, createdAt: "2026-07-07T12:00:00.000Z", updatedAt: "2026-07-07T12:01:00.000Z", sourceIds: ["cand-1"], candidateId: "cand-1", error: "provider unavailable" },
      { id: "memory-preview-failed", turnId: "memory_lifecycle_mem-1", requestId: "memory_lifecycle_mem-1", type: "memory_enrichment", stage: "action", status: "failed", attempt: 3, maxAttempts: 3, retryable: true, createdAt: "2026-07-07T12:00:00.000Z", updatedAt: "2026-07-07T12:01:00.000Z", sourceIds: ["mem-1"], memoryId: "mem-1", error: "provider unavailable" }
    ]
  })));
  await page.goto("/");
  await page.locator(".nav").getByRole("button", { name: /对话/ }).click();
  await expect(page.locator(".conversation-work.failed")).toHaveCount(0);
  await expect(page.getByText(/回复失败：provider unavailable/)).toHaveCount(0);
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

    if (path === "/api/push/config" && route.request().method() === "GET") {
      await json(route, { enabled: false });
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

    if (path === "/api/profiles/demo/turns" && route.request().method() === "POST") {
      const requestBody = safePostJson(route) as { turnId: string; requestId: string; channel: "button" | "curious"; segments: Array<{ id: string; label: string; content?: string; kind: "text" | "image_summary" | "audio_observation"; batchId?: string; companionSessionId?: string; dataUrl?: string }> };
      if (requestBody.segments.some((segment) => segment.companionSessionId) && await route.request().frame().page().evaluate(() => window.localStorage.getItem("papo:captureCompanionTurn") === "1")) {
        await route.request().frame().page().evaluate((body) => window.localStorage.setItem("papo:lastCompanionTurn", JSON.stringify(body)), requestBody);
      }
      if (await route.request().frame().page().evaluate(() => window.localStorage.getItem("papo:captureImageUploadBytes") === "1")) {
        const imageLength = requestBody.segments.find((segment) => segment.kind === "image_summary")?.dataUrl?.length ?? 0;
        await route.request().frame().page().evaluate((length) => window.localStorage.setItem("papo:lastImageUploadLength", String(length)), imageLength);
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
      const at = new Date().toISOString();
      const messages = requestBody.segments.map((segment, index) => ({
        id: `${requestBody.turnId}-message-${index}`,
        at,
        role: "user" as const,
        channel: requestBody.channel,
        text: segment.kind === "text" ? segment.content ?? "" : `${segment.label}：${segment.kind === "image_summary" ? "照片已收到，正在理解" : "录音已收到，正在转写"}`,
        displayText: segment.kind === "text" ? undefined : segment.kind === "image_summary" ? "照片已收到，正在理解" : "录音已收到，正在转写",
        sourceId: segment.id,
        turnId: requestBody.turnId,
        requestId: requestBody.requestId,
        relatedMemoryIds: [],
        modality: segment.kind,
        batchId: segment.batchId,
        attachments: []
      }));
      const job = {
        id: `${requestBody.turnId}-cognition`, turnId: requestBody.turnId, requestId: requestBody.requestId,
        type: requestBody.segments.some((segment) => segment.kind === "image_summary") ? "image_understanding" : "cognition",
        stage: requestBody.segments.some((segment) => segment.kind !== "text") ? "sensing" : "cognition",
        status: "running", attempt: 1, maxAttempts: 3, retryable: true, createdAt: at, updatedAt: at, sourceIds: [requestBody.turnId]
      };
      profile = { ...profile, conversation: [...messages, ...profile.conversation], jobs: [job, ...(profile.jobs ?? [])] };
      await json(route, {
        profile,
        turn: { id: requestBody.turnId, requestId: requestBody.requestId, channel: requestBody.channel, status: "running", createdAt: at, updatedAt: at, inputMessageIds: messages.map((message) => message.id), jobIds: [job.id], segments: requestBody.segments },
        jobs: [job]
      }, 202);
      return;
    }

    if (path === "/api/profiles/demo/curious" && route.request().method() === "POST") {
      if (await route.request().frame().page().evaluate(() => window.localStorage.getItem("papo:slowCuriousCapture") === "1")) {
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      const requestBody = safePostJson(route) as { segments?: Array<{ id: string; label: string; content: string; kind: string; batchId?: string; auditOnly?: boolean; attachments?: unknown[] }> };
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
              batchId: firstSegment.batchId,
              auditOnly: firstSegment.auditOnly,
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
  const rawProfileOverride = await route.request().frame().page().evaluate(() => window.localStorage.getItem("papo:testProfileOverride")).catch(() => null);
  let overridden = rawProfileOverride ? { ...profile, ...JSON.parse(rawProfileOverride) } : profile;
  const nativeDownloadTest = await route.request().frame().page().evaluate(() => window.localStorage.getItem("papo:nativeDownloadTest")).catch(() => null);
  if (nativeDownloadTest) overridden = {
    ...overridden,
    conversation: overridden.conversation.map((message, index) => index === 0 ? {
      ...message,
      attachments: [
        { id: "img_native_download", kind: "image" as const, label: "安卓下载测试图", mime: "image/jpeg", url: "https://eu.jerrypsy.top/papo-api/assets/android-download-test.jpg", createdAt: now },
        { id: "vid_native_download", kind: "video" as const, label: "对话里的动作视频", mime: "video/mp4", url: "https://eu.jerrypsy.top/papo-api/assets/android-download-test.mp4", createdAt: now }
      ]
    } : message)
  };
  if (!petKind) return overridden;
  return { ...overridden, petKind };
}

async function startCompanionListening(page: Page, label = "3 分钟") {
  await page.getByRole("button", { name: /陪我/ }).first().click();
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await page.getByRole("button", { name: "开始陪伴" }).click();
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

async function installMockAndroidBridge(page: Page, version: { versionName: string; versionCode: number }) {
  await page.addInitScript((appVersion) => {
    const nativeWindow = window as typeof window & {
      androidBridge?: object;
      Capacitor?: {
        PluginHeaders: Array<{ name: string; methods: Array<{ name: string; rtype: string }> }>;
        nativePromise: (plugin: string, method: string, options?: Record<string, unknown>) => Promise<unknown>;
        nativeCallback: () => Promise<string>;
      };
    };
    nativeWindow.androidBridge = {};
    nativeWindow.Capacitor = {
      PluginHeaders: [
        {
          name: "PapoUpdater",
          methods: [
            { name: "getVersion", rtype: "promise" },
            { name: "openDownload", rtype: "promise" }
          ]
        },
        {
          name: "PapoListening",
          methods: [
            { name: "getStatus", rtype: "promise" },
            { name: "addListener", rtype: "callback" },
            { name: "removeListener", rtype: "promise" }
          ]
        }
      ],
      nativePromise: async (plugin, method, options) => {
        if (plugin === "PapoUpdater" && method === "getVersion") return appVersion;
        if (plugin === "PapoUpdater" && method === "openDownload") {
          window.localStorage.setItem("papo:testOpenedUpdate", String(options?.url ?? ""));
          return {};
        }
        if (plugin === "PapoListening" && method === "getStatus") {
          return { active: false, startedAt: 0, endAt: 0, mode: "listen", cameraFacing: "front" };
        }
        return {};
      },
      nativeCallback: async () => "mock-listener"
    };
  }, version);
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
        tags: ["snack"],
        visual: {
          id: "img_memory_visual",
          kind: "image",
          label: "旺旺仙贝的共同回忆",
          mime: "image/jpeg",
          url: "/pets/register/shiba.jpg",
          createdAt: now
        }
      }
    ],
    memoryCandidates: [
      {
        id: "cand-1",
        createdAt: now,
        candidateText: "你提到以后想让 Papo 记得更自然。",
        shortTitle: "记得更自然",
        memoryKind: "long_theme",
        confidence: 0.72,
        sourceEpisodeId: "episode-1",
        whyConsolidate: "持续产品偏好。",
        writePolicy: "wait_feedback",
        decayPolicy: "decay_without_feedback",
        status: "candidate",
        tags: ["product"],
        previewVisual: {
          id: "img_candidate_preview",
          kind: "image",
          label: "记得更自然",
          mime: "image/jpeg",
          url: "/pets/register/shiba.jpg",
          createdAt: now,
          generatedBy: "papo_memory"
        },
        previewStatus: "ready"
      },
      {
        id: "cand-2",
        createdAt: "2026-07-07T11:58:00.000Z",
        candidateText: "你希望 Papo 的界面像真正的 companion app。",
        shortTitle: "界面像真正的co",
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
        cognitionTrace: makeTrace(),
        attachments: [
          {
            id: "img_chat_attachment",
            kind: "image",
            label: "对话里的照片",
            mime: "image/jpeg",
            url: "/pets/register/shiba.jpg",
            createdAt: now
          },
          {
            id: "vid_chat_attachment",
            kind: "video",
            label: "对话里的动作视频",
            mime: "video/mp4",
            url: "/pets/register/golden-retriever.mp4",
            createdAt: now
          }
        ]
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
          mime: "image/jpeg",
          url: "/pets/register/shiba.jpg",
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

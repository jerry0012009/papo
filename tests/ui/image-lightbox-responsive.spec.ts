import { expect, test, type Page } from "@playwright/test";

const viewports = [
  { name: "small-phone", width: 320, height: 568 },
  { name: "compact-android", width: 360, height: 800 },
  { name: "standard-phone", width: 393, height: 851 },
  { name: "large-phone", width: 412, height: 915 },
  { name: "fold-cover", width: 344, height: 882 },
  { name: "phone-landscape", width: 851, height: 393 },
  { name: "tablet-portrait", width: 768, height: 1024 },
  { name: "tablet-landscape", width: 1024, height: 768 }
];

for (const viewport of viewports) {
  test(`lightbox contains images and keeps corner controls healthy on ${viewport.name}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "The responsive matrix runs once in the touch-enabled mobile context.");
    await page.setViewportSize(viewport);
    await installLightboxProfile(page);
    await page.goto("/");
    await page.getByLabel("Papo 导航").getByRole("button", { name: "我的" }).click();
    await page.getByRole("button", { name: /查看图片：响应式测试图/ }).click();
    await assertHealthyLightbox(page, viewport);
    if (["small-phone", "standard-phone", "phone-landscape", "tablet-portrait"].includes(viewport.name)) {
      await page.screenshot({ path: testInfo.outputPath(`${viewport.name}.png`) });
    }

    if (viewport.name === "standard-phone") {
      const viewer = page.locator(".papo-photo-view");
      await pinch(page, viewer, 40, 130);
      await expect.poll(() => zoomLevel(viewer)).toBeGreaterThan(1.5);
      await pinch(page, viewer, 130, 40);
      await expect.poll(() => zoomLevel(viewer)).toBeLessThan(1.15);
    }

    if (viewport.name === "standard-phone") {
      const rotated = { width: viewport.height, height: viewport.width };
      await page.setViewportSize(rotated);
      await assertHealthyLightbox(page, rotated);
    }
  });
}

async function assertHealthyLightbox(page: Page, viewport: { width: number; height: number }) {
  const viewer = page.locator(".papo-photo-view");
  const image = viewer.locator(".papo-photo-view-image");
  const close = viewer.getByRole("button", { name: "关闭图片" });
  const download = viewer.getByRole("button", { name: "下载原图" });
  await expect(viewer).toBeVisible();
  const fillRatio = Math.min(viewport.width, viewport.height) >= 600 || viewport.width > viewport.height ? 0.8 : 0.86;
  await expect.poll(async () => {
    const box = await image.boundingBox();
    if (!box) return Number.POSITIVE_INFINITY;
    return Math.min(Math.abs(box.width - viewport.width * fillRatio), Math.abs(box.height - viewport.height * fillRatio));
  }).toBeLessThan(2);
  const imageBox = await image.boundingBox();
  const closeBox = await close.boundingBox();
  const downloadBox = await download.boundingBox();
  if (!imageBox || !closeBox || !downloadBox) throw new Error("lightbox geometry is unavailable");

  expect(imageBox.x).toBeGreaterThanOrEqual(-1);
  expect(imageBox.y).toBeGreaterThanOrEqual(-1);
  expect(imageBox.x + imageBox.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(imageBox.y + imageBox.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(Math.min(Math.abs(imageBox.width - viewport.width * fillRatio), Math.abs(imageBox.height - viewport.height * fillRatio))).toBeLessThan(2);
  expect(closeBox.width).toBeGreaterThanOrEqual(40);
  expect(closeBox.width).toBeLessThanOrEqual(48);
  expect(downloadBox.width).toBeGreaterThanOrEqual(40);
  expect(downloadBox.width).toBeLessThanOrEqual(48);
  expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(viewport.width - 7);
  expect(closeBox.y).toBeGreaterThanOrEqual(7);
  expect(downloadBox.x + downloadBox.width).toBeLessThanOrEqual(viewport.width - 7);
  expect(downloadBox.y + downloadBox.height).toBeLessThanOrEqual(viewport.height - 7);
  expect(await viewer.locator(".PhotoView-Slider__BannerWrap").evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
}

async function installLightboxProfile(page: Page) {
  await page.addInitScript(() => localStorage.setItem("papo:userId", "responsive"));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const profile = {
      userId: "responsive", creatureName: "Papo", petKind: "shiba", createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(),
      state: { curiosity: 50, attachment: 50, energy: 50, arousal: 50, safety: 50, confidence: 50 }, episodes: [], longTermMemories: [], memoryCandidates: [],
      feedbackHistory: [], stateChanges: [], emergenceHistory: [], wakeHistory: [], dreamHistory: [], semanticBrainHistory: [], conversation: [],
      policyProfile: { preferDepth: 50, preferProactivity: 50, privacySensitivity: 50, saveThreshold: 50, askThreshold: 50, recallTendency: 50, quietTendency: 50 },
      proactive: { pendingCount: 0, paused: false }, readState: {}, hermes: { tasks: [] }, actionCards: [],
      illustrations: [{ id: "responsive-image", createdAt: new Date().toISOString(), kind: "evening_diary", title: "响应式测试图", prompt: "test", style: "test", sourceIds: [], providerKind: "generic", providerName: "test", attachment: { id: "responsive-image", kind: "image", label: "响应式测试图", mime: "image/jpeg", url: "/pets/register/shiba.jpg", createdAt: new Date().toISOString() } }],
      petProfile: { updatedAt: new Date().toISOString(), source: "registration", displaySpecies: "柴犬", appearance: "柴犬", personality: "亲近", habits: "陪伴", visualStyle: "温暖", imagePrompt: "shiba", motionStyle: "idle" },
      dogState: { id: "idle", selectedAt: new Date().toISOString(), label: "安静陪伴", actionText: "安静陪伴", visualPrompt: "idle", animation: "idle", reason: "test", selectedBy: "rules" }, dogStateHistory: []
    };
    const body = path.endsWith("/wake") ? { profile, wake: { id: "wake", at: new Date().toISOString(), elapsedMinutes: 0, message: "", relatedMemoryIds: [], stateChangeReason: "test", stateDelta: {}, ruleTrace: [] } } : { profile };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

async function pinch(page: Page, viewer: ReturnType<Page["locator"]>, fromDistance: number, toDistance: number) {
  const box = await viewer.locator(".PhotoView__PhotoWrap").first().boundingBox();
  if (!box) throw new Error("lightbox slide is unavailable");
  const session = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const points = (distance: number) => [{ x: x - distance, y, id: 0 }, { x: x + distance, y, id: 1 }];
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(fromDistance) });
  for (let step = 1; step <= 6; step += 1) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(fromDistance + (toDistance - fromDistance) * step / 6) });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

async function zoomLevel(viewer: ReturnType<Page["locator"]>) {
  return Number(await viewer.locator(".papo-photo-view-toolbar").evaluate((node) => node.style.getPropertyValue("--papo-photo-view-scale") || 1));
}

import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("papo:userId", "usage-demo"));
  await installUsageApi(page);
});

test("AI usage menu shows balance, category detail, models, and redemption", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByLabel("Papo 导航");
  await expect(nav.getByRole("button")).toHaveCount(5);
  await nav.getByRole("button", { name: "用量" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "AI 用量" })).toBeVisible();
  await expect(page.locator(".usage-balance-band")).toContainText("¥19.75");
  await expect(page.locator(".usage-summary-grid")).toContainText("文字");
  await expect(page.locator(".usage-summary-grid")).toContainText("视频");
  await expect(page.locator(".usage-event-list")).toContainText("xiaomi/mimo-v2.5");
  await expect(page.locator(".usage-event-list")).toContainText("bytedance/seedance-1-5-pro-with-a-very-long-model-name");

  await page.getByLabel("兑换码").fill("PAPO-TESTCODE");
  await page.getByRole("button", { name: "兑换", exact: true }).click();
  await expect(page.locator(".usage-balance-band")).toContainText("¥24.75");
  await expect(page.getByText("已充值 ¥5.00")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
});

async function installUsageApi(page: Page) {
  const now = "2026-07-13T12:00:00.000Z";
  const profile = {
    userId: "usage-demo", creatureName: "Papo", petKind: "shiba", createdAt: now, lastSeenAt: now,
    state: { curiosity: 50, attachment: 50, energy: 50, arousal: 50, safety: 50, confidence: 50 }, episodes: [], longTermMemories: [], memoryCandidates: [],
    feedbackHistory: [], stateChanges: [], emergenceHistory: [], wakeHistory: [], dreamHistory: [], semanticBrainHistory: [], conversation: [], jobs: [], turns: [],
    policyProfile: { preferDepth: 50, preferProactivity: 50, privacySensitivity: 50, saveThreshold: 50, askThreshold: 50, recallTendency: 50, quietTendency: 50 },
    proactive: { pendingCount: 0, paused: false }, readState: {}, hermes: { tasks: [] }, actionCards: [], illustrations: [],
    petProfile: { updatedAt: now, source: "registration", displaySpecies: "柴犬", appearance: "柴犬", personality: "亲近", habits: "陪伴", visualStyle: "温暖", imagePrompt: "shiba", motionStyle: "idle" },
    dogState: { id: "idle", selectedAt: now, label: "安静陪伴", actionText: "安静陪伴", visualPrompt: "idle", animation: "idle", reason: "test", selectedBy: "rules" }, dogStateHistory: []
  };
  const events = [
    { id: "usage_text", callId: "call_text", userId: "usage-demo", at: now, category: "text", operation: "generateJson", provider: "openrouter", model: "xiaomi/mimo-v2.5", status: "completed", inputTokens: 800, outputTokens: 200, totalTokens: 1000, costMicros: 5_000, costSource: "provider_reported", priceVersion: "test", balanceAfterMicros: 19_750_000 },
    { id: "usage_video", callId: "call_video", userId: "usage-demo", at: now, category: "video", operation: "generateVideo", provider: "openrouter", model: "bytedance/seedance-1-5-pro-with-a-very-long-model-name", status: "completed", durationSeconds: 4, costMicros: 245_000, costSource: "catalog_estimate", priceVersion: "test", balanceAfterMicros: 19_750_000 }
  ];
  const account = (balanceMicros: number) => ({
    userId: "usage-demo", currency: "CNY", balanceMicros, trialGrantedAt: now, updatedAt: now,
    summary: [
      { category: "text", calls: 1, completed: 1, failed: 0, blocked: 0, totalTokens: 1000, costMicros: 5_000 },
      { category: "audio", calls: 0, completed: 0, failed: 0, blocked: 0, totalTokens: 0, costMicros: 0 },
      { category: "image", calls: 0, completed: 0, failed: 0, blocked: 0, totalTokens: 0, costMicros: 0 },
      { category: "video", calls: 1, completed: 1, failed: 0, blocked: 0, totalTokens: 0, costMicros: 245_000 }
    ], events
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/ai-usage/redeem")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ account: account(24_750_000), redemption: { creditedMicros: 5_000_000, balanceMicros: 24_750_000, redeemedAt: now } }) });
    if (path.endsWith("/ai-usage")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ account: account(19_750_000) }) });
    if (path.endsWith("/push/config")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: false }) });
    if (path.endsWith("/wake")) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ profile, wake: { id: "wake", at: now, elapsedMinutes: 0, message: "", relatedMemoryIds: [], stateChangeReason: "test", stateDelta: {}, ruleTrace: [] } }) });
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ profile }) });
  });
}

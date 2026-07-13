import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createModelProvider, type ModelProvider } from "../src/core/provider";
import { JsonAiBillingService, InsufficientAiBalanceError } from "../src/server/ai-billing";
import { combineProviderUsage, createMeteredProvider } from "../src/server/metered-provider";

test("trial credit, redemption, and user isolation are durable and idempotent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "papo-billing-"));
  try {
    const billing = new JsonAiBillingService(path.join(directory, "billing.json"));
    const first = await billing.account("alice");
    const second = await billing.account("alice");
    assert.equal(first.balanceMicros, 20_000_000);
    assert.equal(second.balanceMicros, 20_000_000, "reading an account cannot grant the trial twice");

    const created = await billing.createRedemptionCode(5_000_000, { maxUses: 2 });
    const redeemed = await billing.redeem("alice", created.code);
    assert.equal(redeemed.balanceMicros, 25_000_000);
    await assert.rejects(() => billing.redeem("alice", created.code), /已经使用过/);
    assert.equal((await billing.redeem("bob", created.code)).balanceMicros, 25_000_000);
    await assert.rejects(() => billing.redeem("carol", created.code), /已经用完/);
    assert.equal((await billing.account("bob")).events.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent image calls reserve balance atomically and a blocked call never reaches the provider", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "papo-billing-gate-"));
  try {
    const billing = new JsonAiBillingService(path.join(directory, "billing.json"), 400_000);
    let imageCalls = 0;
    const provider = createMeteredProvider(fakeProvider({
      imageModel: "google/gemini-3.1-flash-lite-image",
      async generateImage() {
        imageCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { dataUrl: "data:image/png;base64,QQ==", mime: "image/png" as const, model: "google/gemini-3.1-flash-lite-image" };
      }
    }), billing);
    const calls = await Promise.allSettled([
      billing.withContext({ userId: "alice", feature: "illustration" }, () => provider.generateImage("first")),
      billing.withContext({ userId: "alice", feature: "illustration" }, () => provider.generateImage("second"))
    ]);
    assert.equal(calls.filter((item) => item.status === "fulfilled").length, 1);
    const rejected = calls.find((item): item is PromiseRejectedResult => item.status === "rejected");
    assert.ok(rejected?.reason instanceof InsufficientAiBalanceError);
    assert.equal(imageCalls, 1);
    const account = await billing.account("alice");
    assert.equal(account.balanceMicros, 119_200);
    assert.equal(account.summary.find((item) => item.category === "image")?.completed, 1);
    assert.equal(account.summary.find((item) => item.category === "image")?.blocked, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider failure refunds an expensive reservation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "papo-billing-refund-"));
  try {
    const billing = new JsonAiBillingService(path.join(directory, "billing.json"), 400_000);
    const provider = createMeteredProvider(fakeProvider({
      imageModel: "google/gemini-3.1-flash-lite-image",
      async generateImage() { throw new Error("deterministic provider failure"); }
    }), billing);
    await assert.rejects(() => billing.withContext({ userId: "alice" }, () => provider.generateImage("fail")), /deterministic/);
    const account = await billing.account("alice");
    assert.equal(account.balanceMicros, 400_000);
    assert.equal(account.events[0]?.status, "failed");
    assert.equal(account.events[0]?.costMicros, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unpriced successful media model is charged at its preauthorization estimate", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "papo-billing-unpriced-media-"));
  try {
    const billing = new JsonAiBillingService(path.join(directory, "billing.json"), 500_000);
    const provider = createMeteredProvider(fakeProvider({
      imageModel: "vendor/new-image-model",
      async generateImage() { return { dataUrl: "data:image/png;base64,QQ==", mime: "image/png", model: "vendor/new-image-model" }; }
    }), billing);
    await billing.withContext({ userId: "alice" }, () => provider.generateImage("new model"));
    const account = await billing.account("alice");
    assert.equal(account.balanceMicros, 150_000);
    assert.equal(account.events[0]?.costMicros, 350_000);
    assert.equal(account.events[0]?.costSource, "catalog_estimate");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenRouter reported tokens and cost override catalog estimates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "papo-billing-usage-"));
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      model: "qwen/qwen3.5-flash-02-23",
      choices: [{ message: { content: "{\"ok\":true}" } }],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, cost: 0.00125 }
    }), { status: 200, headers: { "content-type": "application/json" } });
    const billing = new JsonAiBillingService(path.join(directory, "billing.json"));
    const raw = createModelProvider({ NODE_ENV: "test", PAPO_PROVIDER: "openrouter", OPENROUTER_API_KEY: "test", OPENROUTER_MODEL: "qwen/qwen3.5-flash-02-23" });
    const provider = createMeteredProvider(raw, billing);
    await billing.withContext({ userId: "alice", turnId: "turn-1" }, () => provider.generateJson("return json"));
    const event = (await billing.account("alice")).events[0];
    assert.equal(event.inputTokens, 120);
    assert.equal(event.outputTokens, 30);
    assert.equal(event.totalTokens, 150);
    assert.equal(event.costMicros, 9_000);
    assert.equal(event.costSource, "provider_reported");
    assert.equal(event.turnId, "turn-1");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent billing service instances cannot overwrite concurrent writes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "papo-billing-file-lock-"));
  try {
    const filePath = path.join(directory, "billing.json");
    const first = new JsonAiBillingService(filePath);
    const second = new JsonAiBillingService(filePath);
    await first.account("alice");
    await Promise.all([
      first.settle(usageInput("call-first", 100_000)),
      second.settle(usageInput("call-second", 200_000))
    ]);
    const account = await first.account("alice");
    assert.equal(account.balanceMicros, 19_700_000);
    assert.deepEqual(new Set(account.events.map((event) => event.callId)), new Set(["call-first", "call-second"]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cumulative provider usage from media polling is not double counted", () => {
  const usage = combineProviderUsage([
    { model: "video-model", totalTokens: 100, costUsd: 0.03 },
    { model: "video-model", totalTokens: 180, costUsd: 0.05 },
    { model: "video-model", totalTokens: 180, costUsd: 0.05 }
  ]);
  assert.equal(usage.model, "video-model");
  assert.equal(usage.totalTokens, 180);
  assert.equal(usage.costUsd, 0.05);
});

function usageInput(callId: string, costMicros: number) {
  return {
    callId,
    userId: "alice",
    category: "text" as const,
    operation: "generate",
    provider: "test",
    model: "test-model",
    status: "completed" as const,
    costMicros,
    costSource: "provider_reported" as const
  };
}

function fakeProvider(overrides: { imageModel: string; generateImage: ModelProvider["generateImage"] }): ModelProvider {
  return {
    kind: "openrouter",
    name: "billing fake",
    available: true,
    usesRealModel: true,
    diagnostics: { imageProvider: "openrouter", imageModel: overrides.imageModel, imageRoute: "openrouter_images", textModel: "unpriced-text" },
    async generate() { return "ok"; },
    async generateJson() { return { ok: true }; },
    async summarizeImage() { return "image"; },
    async observeAudio() { return "audio"; },
    generateImage: overrides.generateImage
  };
}

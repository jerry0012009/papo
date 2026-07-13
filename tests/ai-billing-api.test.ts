import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ModelProvider } from "../src/core/provider";
import { createApp } from "../src/server/app";
import { JsonAiBillingService } from "../src/server/ai-billing";
import { MemoryProfileStore } from "../src/server/store";

test("AI usage API grants trial credit, isolates events, and redeems a code", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "papo-billing-api-"));
  const store = new MemoryProfileStore();
  await store.createProfile({ userId: "billing-alice", creatureName: "Papo" });
  const bob = await store.createProfile({ userId: "billing-bob", creatureName: "Papo" });
  bob.password = "bob-secret";
  await store.saveProfile(bob);
  const billing = new JsonAiBillingService(path.join(directory, "billing.json"));
  await billing.settle({
    callId: "call_alice_text", userId: "billing-alice", category: "text", operation: "generateJson", provider: "openrouter", model: "test-model",
    status: "completed", inputTokens: 10, outputTokens: 5, totalTokens: 15, costMicros: 12_000, costSource: "catalog_estimate"
  });
  await billing.settle({
    callId: "call_bob_audio", userId: "billing-bob", category: "audio", operation: "observeAudio", provider: "openrouter", model: "audio-model",
    status: "completed", totalTokens: 50, costMicros: 30_000, costSource: "provider_reported"
  });
  const code = await billing.createRedemptionCode(3_000_000);
  const app = createApp({ store, billing, provider: fakeProvider(), proactive: { enabled: false }, turns: { autoStart: false }, nativeIngest: { autoStart: false } });
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind billing API test");
  const base = `http://127.0.0.1:${address.port}/api/profiles`;
  try {
    const response = await fetch(`${base}/billing-alice/ai-usage`);
    assert.equal(response.status, 200);
    const initial = await response.json() as { account: { balanceMicros: number; events: Array<{ userId: string; category: string }> } };
    assert.equal(initial.account.balanceMicros, 19_988_000);
    assert.deepEqual(initial.account.events.map((event) => event.userId), ["billing-alice"]);
    assert.equal(initial.account.events[0]?.category, "text");

    const redeem = await fetch(`${base}/billing-alice/ai-usage/redeem`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.code })
    });
    assert.equal(redeem.status, 200);
    const redeemed = await redeem.json() as { account: { balanceMicros: number } };
    assert.equal(redeemed.account.balanceMicros, 22_988_000);
    const duplicate = await fetch(`${base}/billing-alice/ai-usage/redeem`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.code })
    });
    assert.equal(duplicate.status, 400);

    assert.equal((await fetch(`${base}/billing-bob/ai-usage`)).status, 401, "a protected profile cannot expose billing without its password");
  } finally {
    app.locals.turnWorker.stop();
    app.locals.transientAudioStore.stop();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function fakeProvider(): ModelProvider {
  return {
    kind: "generic", name: "billing API fake", available: true, usesRealModel: true,
    async generate() { return ""; }, async generateJson() { return {}; }, async summarizeImage() { return ""; }, async observeAudio() { return ""; },
    async generateImage() { return { dataUrl: "data:image/png;base64,QQ==", mime: "image/png" }; }
  };
}

import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/server/app";
import { createModelProvider } from "../src/core/provider";
import { MemoryProfileStore } from "../src/server/store";

test(
  "button illustration action reaches the real image provider",
  { skip: process.env.RUN_REAL_MODEL_SMOKE === "1" ? false : "set RUN_REAL_MODEL_SMOKE=1 to spend real model tokens" },
  async () => {
    const store = new MemoryProfileStore();
    await store.createProfile({ userId: "real-button-illustration-smoke", creatureName: "Papo" });
    const provider = createModelProvider();
    const app = createApp({ store, provider, hermes: { enabled: false }, proactive: { enabled: false } });
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to bind test server");

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles/real-button-illustration-smoke/button`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "帮我真实生成一张两格漫画日记图片：第一格是小柴犬Papo在窗边看雨，第二格是Papo把这一天画进小本子里。"
        })
      });
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      assert.equal(payload.events[0]?.actionDecision?.action, "generate_illustration");
      assert.equal(payload.events[0]?.actionResult?.kind, "illustration");
      assert.ok(payload.events[0]?.actionResult?.attachment?.url);

      const current = await store.getProfile("real-button-illustration-smoke");
      const papoMessage = current?.conversation.find((message) => message.role === "papo" && message.channel === "button");
      assert.equal(papoMessage?.cognitionTrace?.eventDecisions?.[0]?.actionResult?.kind, "illustration");
      assert.ok(papoMessage?.attachments?.[0]?.url, "button Papo reply should carry generated illustration attachment");
      assert.equal(current?.illustrations?.[0]?.attachment.id, papoMessage.attachments[0].id);
      console.log(JSON.stringify({
        ok: true,
        provider: provider.kind,
        textModel: provider.diagnostics?.textModel,
        imageProvider: provider.diagnostics?.imageProvider ?? provider.kind,
        imageModel: provider.diagnostics?.imageModel,
        image: papoMessage.attachments[0].url
      }, null, 2));
    } finally {
      server.close();
    }
  }
);

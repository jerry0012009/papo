import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";
import type { ModelProvider } from "../src/core/provider";

const provider: ModelProvider = {
  kind: "openrouter",
  name: "Unreadable audio provider",
  available: true,
  usesRealModel: true,
  diagnostics: {
    audioProvider: "openrouter",
    audioModel: "xiaomi/mimo-v2.5",
    audioRoute: "chat_completions"
  },
  async generate() {
    return "";
  },
  async generateJson() {
    return undefined;
  },
  async summarizeImage() {
    return "";
  },
  async observeAudio() {
    throw new Error("Audio input conversion failed: EBML header parsing failed");
  }
};

const app = createApp({ store: new MemoryProfileStore(), provider });
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");

try {
  const response = await fetch(`http://127.0.0.1:${address.port}/api/audio-observation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: "broken webm chunk",
      dataUrl: `data:audio/webm;base64,${Buffer.from("not a real webm audio chunk".repeat(4)).toString("base64")}`
    })
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.observation, "");
  assert.equal(body.noSpeech, true);
  assert.equal(body.unreadable, true);
  assert.equal(body.sensingTrace.status, "unreadable");
  assert.equal(body.sensingTrace.observation, undefined);
  assert.equal(body.sensingTrace.ruleTrace.includes("route=settle_audio_batch_only"), true);
  console.log(JSON.stringify({ ok: true }, null, 2));
} finally {
  server.close();
}

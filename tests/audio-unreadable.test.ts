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
  async observeAudio(_dataUrl: string, prompt: string) {
    if (prompt.includes("aborted webm chunk")) throw new Error("This operation was aborted");
    throw new Error("Audio input conversion failed: EBML header parsing failed");
  },
  async generateImage() {
    return {
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      mime: "image/png",
      model: "fake-image"
    };
  }
};

const store = new MemoryProfileStore();
await store.createProfile({ userId: "audio-unreadable", creatureName: "Papo" });
const app = createApp({ store, provider });
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");

try {
  const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles/audio-unreadable/audio-observation`, {
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

  const abortedResponse = await fetch(`http://127.0.0.1:${address.port}/api/profiles/audio-unreadable/audio-observation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      label: "aborted webm chunk",
      dataUrl: `data:audio/webm;base64,${Buffer.from("slow audio chunk".repeat(4)).toString("base64")}`
    })
  });
  const abortedBody = await abortedResponse.json();
  assert.equal(abortedResponse.status, 200, JSON.stringify(abortedBody));
  assert.equal(abortedBody.observation, "");
  assert.equal(abortedBody.noSpeech, true);
  assert.equal(abortedBody.unreadable, true);
  assert.equal(abortedBody.sensingTrace.status, "unreadable");
  console.log(JSON.stringify({ ok: true }, null, 2));
} finally {
  server.close();
}

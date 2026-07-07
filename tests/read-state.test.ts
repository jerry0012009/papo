import assert from "node:assert/strict";
import { createApp } from "../src/server/app";
import { appendPapoMessage } from "../src/core/conversation";
import { MemoryProfileStore } from "../src/server/store";
import type { ModelProvider } from "../src/core/provider";

const store = new MemoryProfileStore();
const profile = await store.createProfile({ userId: "read-user", creatureName: "Papo" });
const wake = appendPapoMessage(profile, { channel: "wake", text: "醒来时" });
const first = appendPapoMessage(profile, { channel: "emergence", text: "第一条" });
const second = appendPapoMessage(profile, { channel: "button", text: "第二条" });
await store.saveProfile(profile);

const provider: ModelProvider = {
  kind: "mimo",
  name: "Read state provider",
  available: true,
  usesRealModel: true,
  diagnostics: {},
  async generate() {
    return "";
  },
  async generateJson() {
    return {};
  },
  async summarizeImage() {
    return "";
  },
  async observeAudio() {
    return "";
  }
};

const app = createApp({ store, provider });
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");

try {
  const response = await fetch(`http://127.0.0.1:${address.port}/api/profiles/read-user/read-state`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lastReadPapoMessageId: second?.id })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  const current = await store.getProfile("read-user");
  assert.equal(current?.readState.lastReadPapoMessageId, second?.id);
  assert.notEqual(current?.readState.lastReadPapoMessageId, first?.id);

  const bad = await fetch(`http://127.0.0.1:${address.port}/api/profiles/read-user/read-state`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lastReadPapoMessageId: "missing" })
  });
  assert.equal(bad.status, 400);

  const wakeRead = await fetch(`http://127.0.0.1:${address.port}/api/profiles/read-user/read-state`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lastReadPapoMessageId: wake?.id })
  });
  assert.equal(wakeRead.status, 400);
  console.log(JSON.stringify({ ok: true }, null, 2));
} finally {
  server.close();
}

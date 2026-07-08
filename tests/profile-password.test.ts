import assert from "node:assert/strict";
import type { ModelProvider } from "../src/core/provider";
import { createApp } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";

const provider: ModelProvider = {
  kind: "generic",
  name: "Password test provider",
  available: true,
  usesRealModel: false,
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
  },
  async generateImage() {
    throw new Error("not used");
  }
};

const store = new MemoryProfileStore();
await store.createProfile({ userId: "password-user", creatureName: "Papo" });
const app = createApp({ store, provider, hermes: { enabled: false }, proactive: { enabled: false } });
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const open = await fetch(`${baseUrl}/api/profiles/password-user`);
  const openPayload = await open.json();
  assert.equal(open.status, 200, JSON.stringify(openPayload));
  assert.equal(openPayload.profile.hasPassword, false);
  assert.equal(openPayload.profile.password, undefined);

  const created = await fetch(`${baseUrl}/api/profiles/password-user/password`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newPassword: "secret" })
  });
  const createdPayload = await created.json();
  assert.equal(created.status, 200, JSON.stringify(createdPayload));
  assert.equal(createdPayload.profile.hasPassword, true);
  assert.equal(createdPayload.profile.password, undefined);
  assert.equal((await store.getProfile("password-user"))?.password, "secret");

  const blocked = await fetch(`${baseUrl}/api/profiles/password-user`);
  const blockedPayload = await blocked.json();
  assert.equal(blocked.status, 401);
  assert.equal(blockedPayload.error, "Password required");

  const wrongLogin = await fetch(`${baseUrl}/api/profiles/password-user/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "wrong" })
  });
  assert.equal(wrongLogin.status, 401);

  const login = await fetch(`${baseUrl}/api/profiles/password-user/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "secret" })
  });
  const loginPayload = await login.json();
  assert.equal(login.status, 200, JSON.stringify(loginPayload));
  assert.equal(loginPayload.profile.hasPassword, true);
  assert.equal(loginPayload.profile.password, undefined);

  const authed = await fetch(`${baseUrl}/api/profiles/password-user`, {
    headers: { "x-papo-password": "secret" }
  });
  assert.equal(authed.status, 200);

  const changed = await fetch(`${baseUrl}/api/profiles/password-user/password`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-papo-password": "secret" },
    body: JSON.stringify({ currentPassword: "secret", newPassword: "changed" })
  });
  assert.equal(changed.status, 200);
  assert.equal((await store.getProfile("password-user"))?.password, "changed");

  const oldPassword = await fetch(`${baseUrl}/api/profiles/password-user`, {
    headers: { "x-papo-password": "secret" }
  });
  assert.equal(oldPassword.status, 401);

  const cleared = await fetch(`${baseUrl}/api/profiles/password-user/password`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-papo-password": "changed" },
    body: JSON.stringify({ currentPassword: "changed", newPassword: "" })
  });
  const clearedPayload = await cleared.json();
  assert.equal(cleared.status, 200, JSON.stringify(clearedPayload));
  assert.equal(clearedPayload.profile.hasPassword, false);
  assert.equal((await store.getProfile("password-user"))?.password, undefined);

  const reopened = await fetch(`${baseUrl}/api/profiles/password-user`);
  assert.equal(reopened.status, 200);
  console.log(JSON.stringify({ ok: true }, null, 2));
} finally {
  server.close();
}

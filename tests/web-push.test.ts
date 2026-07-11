import assert from "node:assert/strict";
import { appendPapoMessage } from "../src/core/conversation";
import type { CreatureMessage, CreatureProfile } from "../src/core/types";
import { createApp } from "../src/server/app";
import { PushNotifyingProfileStore, type BrowserPushSubscription, type WebPushService } from "../src/server/push";
import { MemoryProfileStore } from "../src/server/store";

const deliveries: Array<{ profile: CreatureProfile; messages: CreatureMessage[] }> = [];
const subscriptions: BrowserPushSubscription[] = [];
const removals: string[] = [];
const push: WebPushService = {
  enabled: true,
  publicKey: "test-public-key",
  async subscribe(_userId, subscription) {
    subscriptions.push(subscription);
  },
  async unsubscribe(_userId, endpoint) {
    removals.push(endpoint);
  },
  async sendMessages(profile, messages) {
    deliveries.push({ profile, messages });
  }
};

const baseStore = new MemoryProfileStore();
const notifyingStore = new PushNotifyingProfileStore(baseStore, push);
const profile = await notifyingStore.createProfile({ userId: "push-user", creatureName: "Papo" });

appendPapoMessage(profile, { channel: "wake", text: "醒来了" });
await notifyingStore.saveProfile(profile);
assert.equal(deliveries.length, 0, "wake messages must not create notifications");

const message = appendPapoMessage(profile, { channel: "emergence", text: "我想起你今天提到的事情。" });
await notifyingStore.saveProfile(profile);
assert.equal(deliveries.length, 1);
assert.deepEqual(deliveries[0].messages.map((item) => item.id), [message?.id]);

await notifyingStore.saveProfile(profile);
assert.equal(deliveries.length, 1, "saving the same message twice must not notify twice");

const app = createApp({ store: baseStore, push, proactive: { enabled: false }, hermes: { enabled: false } });
const server = app.listen(0);
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");

try {
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const configResponse = await fetch(`${baseUrl}/api/push/config`);
  assert.deepEqual(await configResponse.json(), { enabled: true, publicKey: "test-public-key" });

  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/subscription-1",
    expirationTime: null,
    keys: { p256dh: "p256dh-value", auth: "auth-value" },
    appUrl: "https://example.test/papo/"
  };
  const subscribeResponse = await fetch(`${baseUrl}/api/profiles/push-user/push-subscriptions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(subscription)
  });
  assert.equal(subscribeResponse.status, 201, await subscribeResponse.text());
  assert.equal(subscriptions.at(-1)?.endpoint, subscription.endpoint);

  const removeResponse = await fetch(`${baseUrl}/api/profiles/push-user/push-subscriptions`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint })
  });
  assert.equal(removeResponse.status, 200, await removeResponse.text());
  assert.equal(removals.at(-1), subscription.endpoint);
} finally {
  server.close();
}

console.log(JSON.stringify({ ok: true, deliveries: deliveries.length }, null, 2));

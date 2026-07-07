import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonProfileStore } from "../src/server/store";

const dir = await mkdtemp(path.join(os.tmpdir(), "papo-store-merge-"));
const store = new JsonProfileStore(path.join(dir, "store.json"));
const profile = await store.createProfile({ userId: "merge-user", creatureName: "Papo" });
profile.hermes.tasks.unshift({
  id: "hermes_task_merge",
  createdAt: "2026-07-07T10:00:00.000Z",
  updatedAt: "2026-07-07T10:00:01.000Z",
  status: "sent",
  task: "查一个创业项目",
  title: "外部任务"
});
await store.saveProfile(profile);

const staleUserRequest = await store.getProfile("merge-user");
const hermesCompletion = await store.getProfile("merge-user");
assert.ok(staleUserRequest && hermesCompletion);

hermesCompletion.hermes.tasks[0] = {
  ...hermesCompletion.hermes.tasks[0],
  updatedAt: "2026-07-07T10:01:00.000Z",
  status: "completed",
  resultMessageId: "msg_hermes_result"
};
hermesCompletion.conversation.unshift({
  id: "msg_hermes_result",
  at: "2026-07-07T10:01:00.000Z",
  role: "papo",
  channel: "curious",
  text: "虾虾查完了。",
  sourceId: "hermes_task_merge",
  relatedMemoryIds: []
});
await store.saveProfile(hermesCompletion);

staleUserRequest.conversation.unshift({
  id: "msg_user_later",
  at: "2026-07-07T10:01:10.000Z",
  role: "user",
  channel: "button",
  text: "我又说了一句话。",
  sourceId: "button-later",
  relatedMemoryIds: [],
  modality: "button"
});
await store.saveProfile(staleUserRequest);

const merged = await store.getProfile("merge-user");
assert.equal(merged?.hermes.tasks.find((task) => task.id === "hermes_task_merge")?.status, "completed");
assert.equal(merged?.hermes.tasks.find((task) => task.id === "hermes_task_merge")?.resultMessageId, "msg_hermes_result");
assert.equal(merged?.conversation.some((message) => message.id === "msg_hermes_result"), true);
assert.equal(merged?.conversation.some((message) => message.id === "msg_user_later"), true);

console.log(JSON.stringify({ ok: true }, null, 2));

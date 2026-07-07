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

const purgeBase = await store.createProfile({ userId: "purge-merge-user", creatureName: "Papo" });
purgeBase.longTermMemories.unshift({
  id: "ltm_should_stay_gone",
  createdAt: "2026-07-07T09:00:00.000Z",
  kind: "habit",
  text: "用户以前说过游泳馆太吵。",
  sourceEpisodeId: "episode_noise",
  consolidatedBecause: "旧记忆",
  weight: 0,
  tags: ["游泳"]
});
await store.saveProfile(purgeBase);

const staleWithDeletedMemory = await store.getProfile("purge-merge-user");
const purgedSnapshot = await store.getProfile("purge-merge-user");
assert.ok(staleWithDeletedMemory && purgedSnapshot);

purgedSnapshot.longTermMemories = purgedSnapshot.longTermMemories.filter((memory) => memory.id !== "ltm_should_stay_gone");
purgedSnapshot.conversation.unshift({
  id: "msg_purge_trace",
  at: "2026-07-07T09:01:00.000Z",
  role: "user",
  channel: "feedback",
  text: "忘掉",
  sourceId: "feedback-purge",
  relatedMemoryIds: [],
  modality: "button",
  cognitionTrace: {
    at: "2026-07-07T09:01:00.000Z",
    source: "feedback",
    providerKind: "mimo",
    providerName: "test provider",
    modelRuns: [],
    feedbackDecision: {
      feedbackId: "feedback-purge",
      kind: "forget",
      targetId: "ltm_should_stay_gone",
      effect: "彻底删除这条记忆。",
      learningNote: "用户明确要求放下。",
      memoryCandidateIds: [],
      memoryChanges: [{
        targetId: "ltm_should_stay_gone",
        targetType: "memory",
        operation: "purged",
        beforeText: "用户以前说过游泳馆太吵。"
      }],
      stateDeltas: [],
      policyDeltas: []
    }
  }
});
await store.saveProfile(purgedSnapshot);

staleWithDeletedMemory.conversation.unshift({
  id: "msg_after_purge",
  at: "2026-07-07T09:02:00.000Z",
  role: "user",
  channel: "button",
  text: "这是一条后来的普通消息。",
  sourceId: "button-after-purge",
  relatedMemoryIds: [],
  modality: "button"
});
await store.saveProfile(staleWithDeletedMemory);

const afterPurgeMerge = await store.getProfile("purge-merge-user");
assert.equal(afterPurgeMerge?.longTermMemories.some((memory) => memory.id === "ltm_should_stay_gone"), false);
assert.equal(afterPurgeMerge?.conversation.some((message) => message.id === "msg_after_purge"), true);
assert.equal(afterPurgeMerge?.conversation.some((message) => message.id === "msg_purge_trace"), true);

console.log(JSON.stringify({ ok: true }, null, 2));

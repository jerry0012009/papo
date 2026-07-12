import assert from "node:assert/strict";
import { createCreatureProfile } from "../src/core/profile";
import { createModelProvider } from "../src/core/provider";
import type { StreamSegment } from "../src/core/types";
import { collectCompanionTurn, processCompanionTurnContext, runCompanionSessionSweep } from "../src/server/companion-session";
import { MemoryProfileStore } from "../src/server/store";

assert.equal(process.env.RUN_REAL_MODEL_SMOKE, "1", "Set RUN_REAL_MODEL_SMOKE=1 to run the paid real-model smoke.");
console.log("Starting real companion multi-event smoke...");
const keepAlive = setInterval(() => undefined, 1_000);

const store = new MemoryProfileStore();
const profile = createCreatureProfile({ userId: "real-multi-event-smoke", creatureName: "Papo", now: "2026-07-12T12:00:00.000Z" });
const created = await store.createProfile({ userId: profile.userId, creatureName: profile.creatureName });
Object.assign(created, profile);
await store.saveProfile(created);
const sessionId = "live-real-multi-event";
const lunch = [
  stream("lunch-note", "text", "这是我吃的午饭，很好吃。", "2026-07-12T12:00:00.000Z"),
  stream("lunch-photo", "image_summary", "照片里是一份米饭、青菜和烤鱼组成的午饭。", "2026-07-12T12:00:10.000Z"),
  stream("lunch-audio", "audio_observation", "同期能听见轻微的餐具声和餐厅交谈声。", "2026-07-12T12:00:20.000Z")
];
const lecture = [
  stream("lecture-note", "text", "接下来我要听一场端侧 AI 讲座，你安静陪我。", "2026-07-12T12:05:00.000Z"),
  stream("lecture-audio-1", "audio_observation", "讲者解释端侧模型通过量化降低内存占用，并比较云端推理的延迟。", "2026-07-12T12:07:00.000Z"),
  stream("lecture-audio-2", "audio_observation", "讲者介绍在手机芯片上做算子融合，并用缓存减少重复计算。", "2026-07-12T12:10:00.000Z"),
  stream("noise", "audio_observation", "门外突然出现十几秒钻墙施工声，随后消失。", "2026-07-12T12:11:00.000Z"),
  stream("pause", "text", "现在中场休息。", "2026-07-12T12:12:00.000Z"),
  stream("resume", "text", "这是第二位发言人，继续刚才的讲座。", "2026-07-12T12:15:00.000Z"),
  stream("lecture-audio-3", "audio_observation", "第二位讲者总结部署时要平衡速度、功耗和模型效果，并建议先从高频场景试点。", "2026-07-12T12:18:00.000Z"),
  stream("end", "text", "讲座结束了。", "2026-07-12T12:20:00.000Z")
];
await store.updateProfile(profile.userId, (latest) => collectCompanionTurn(latest, "turn-lunch", lunch));
const provider = createModelProvider();
const realGenerateJson = provider.generateJson.bind(provider);
provider.generateJson = async (prompt) => {
  console.log(prompt.includes("事件级经历整理") ? "Calling real event consolidation..." : "Calling real event assignment...");
  const output = await realGenerateJson(prompt);
  console.log("Real model JSON returned.");
  return output;
};
await processCompanionTurnContext(store, provider, profile.userId, "turn-lunch");
console.log("Real model assigned the lunch observations.");
await store.updateProfile(profile.userId, (latest) => collectCompanionTurn(latest, "turn-lecture", lecture));
await processCompanionTurnContext(store, provider, profile.userId, "turn-lecture");
console.log("Real model assigned the lecture observations.");
const result = await runCompanionSessionSweep(store, provider, "2026-07-12T12:21:00.000Z");
console.log("Real model consolidated completed events.");
const saved = await store.getProfile(profile.userId);
const session = saved?.companionSessions?.find((item) => item.id === sessionId);
assert.ok(session);
assert.ok((session.events?.length ?? 0) >= 2, JSON.stringify(session, null, 2));
const lunchEvent = session.events?.find((event) => event.sourceSegmentIds.includes("lunch-photo"));
const lectureEvent = session.events?.find((event) => event.sourceSegmentIds.includes("lecture-audio-3"));
assert.ok(lunchEvent?.sourceSegmentIds.includes("lunch-note"));
assert.ok(lectureEvent?.sourceSegmentIds.includes("lecture-note"));
assert.equal(session.observations.find((item) => item.segmentId === "noise")?.eventId === lectureEvent?.id, false, "short construction noise must not contaminate the lecture");
assert.ok(lectureEvent?.memoryId, "the 15 minute lecture must produce an integrated memory");
assert.equal(saved?.longTermMemories.filter((memory) => memory.id === lectureEvent.memoryId).length, 1);
console.log(JSON.stringify({ result, currentContext: session.currentContext, events: session.events, memory: saved?.longTermMemories.find((item) => item.id === lectureEvent.memoryId)?.text }, null, 2));
clearInterval(keepAlive);

function stream(id: string, kind: StreamSegment["kind"], content: string, observedAt: string): StreamSegment {
  return { id, kind, label: id, content, observedAt, batchId: `${sessionId}-${id}`, companionSessionId: sessionId };
}

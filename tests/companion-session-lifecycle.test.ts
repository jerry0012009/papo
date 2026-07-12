import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/server/app";
import { createCreatureProfile, normalizeCreatureProfile } from "../src/core/profile";
import type { ModelProvider } from "../src/core/provider";
import type { CompanionSessionRecord } from "../src/core/types";
import { runCompanionSessionSweep } from "../src/server/companion-session";
import { MemoryProfileStore } from "../src/server/store";

const unusedProvider: ModelProvider = {
  kind: "generic", name: "unused", available: true, usesRealModel: true,
  async generate() { return ""; }, async generateJson() { throw new Error("model should not run for an empty session"); },
  async summarizeImage() { return ""; }, async observeAudio() { return ""; }, async generateImage() { throw new Error("not used"); }
};

test("companion start/end API persists an empty session and explicit end settles it", async () => {
  const store = new MemoryProfileStore();
  await store.createProfile({ userId: "session-lifecycle", creatureName: "Papo" });
  const app = createApp({ store, provider: unusedProvider, proactive: { enabled: false }, turns: { autoStart: false } });
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind");
  try {
    const base = `http://127.0.0.1:${address.port}/api/profiles/session-lifecycle/companion-sessions`;
    const start = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "live-session-lifecycle", startedAt: "2026-07-12T12:00:00.000Z" }) });
    assert.equal(start.status, 201);
    assert.equal((await store.getProfile("session-lifecycle"))?.companionSessions?.[0].status, "active");
    const end = await fetch(`${base}/live-session-lifecycle/end`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ endedAt: "2026-07-12T12:01:00.000Z" }) });
    assert.equal(end.status, 200);
    await runCompanionSessionSweep(store, unusedProvider, "2026-07-12T12:01:00.000Z");
    const saved = await store.getProfile("session-lifecycle");
    assert.equal(saved?.companionSessions?.[0].status, "completed");
    assert.equal(saved?.companionSessions?.[0].summary, "这次陪伴没有形成可用的连续事件。");
  } finally {
    server.close();
  }
});

test("legacy consolidation and stale claims normalize without duplicate work", () => {
  const profile = createCreatureProfile({ userId: "legacy-session", creatureName: "Papo", now: "2026-07-12T12:00:00.000Z" });
  profile.companionSessions = [{
    id: "native-legacy", startedAt: "2026-07-12T10:00:00.000Z", lastObservedAt: "2026-07-12T10:15:00.000Z", updatedAt: "2026-07-12T10:20:00.000Z",
    status: "completed", sourceTurnIds: ["turn-old"], sourceSegmentIds: ["old-audio"],
    observations: [{ segmentId: "old-audio", observedAt: "2026-07-12T10:00:00.000Z", modality: "audio_observation", status: "content", content: "旧讲座" }],
    episodeId: "episode_session_old", memoryId: "ltm_session_old", messageId: "msg_session_old", kind: "lecture", title: "旧讲座", summary: "旧版已整理", consolidatedAt: "2026-07-12T10:20:00.000Z"
  }];
  const normalized = normalizeCreatureProfile(profile);
  const session = normalized.companionSessions?.[0];
  assert.equal(session?.events?.length, 1);
  assert.equal(session?.events?.[0].memoryId, "ltm_session_old");
  assert.equal(session?.events?.[0].consolidatedRevision, 1);
  assert.equal(session?.observations[0].eventId, session?.events?.[0].id);
  assert.equal(session?.observations[0].assignmentStatus, "assigned");

  const stale = structuredClone(session!) as CompanionSessionRecord;
  stale.observations.push({ segmentId: "stale", observedAt: "2020-01-01T10:21:00.000Z", modality: "audio_observation", status: "content", content: "待恢复", assignmentStatus: "processing", processedAt: "2020-01-01T10:21:00.000Z" });
  stale.events![0].status = "consolidating";
  stale.events![0].updatedAt = "2020-01-01T10:21:00.000Z";
  normalized.companionSessions = [stale];
  normalizeCreatureProfile(normalized);
  assert.equal(normalized.companionSessions?.[0].observations.find((item) => item.segmentId === "stale")?.assignmentStatus, "pending");
  assert.equal(normalized.companionSessions?.[0].events?.[0].status, "completed");
});

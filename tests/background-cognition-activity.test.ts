import assert from "node:assert/strict";
import test from "node:test";
import { appendInputMessage } from "../src/core/conversation";
import { createCreatureProfile, normalizeCreatureProfile } from "../src/core/profile";
import type { ModelProvider } from "../src/core/provider";
import { isBackgroundCognitionEligible, markMeaningfulUserActivity } from "../src/core/proactive";
import { runAutomaticDreamingSweep, runDogStateSweep, runProactiveEmergenceSweep } from "../src/server/app";
import { MemoryProfileStore } from "../src/server/store";

test("inactive profiles do not spend model calls in recurring cognition or visual normalization", async () => {
  const store = new MemoryProfileStore();
  const profile = createCreatureProfile({ userId: "inactive-background", creatureName: "Papo", now: "2026-07-01T00:00:00.000Z" });
  profile.lastUserActivityAt = "2026-07-01T00:00:00.000Z";
  profile.proactive.nextCheckAt = "2026-07-01T00:30:00.000Z";
  profile.dogState.nextCheckAt = "2026-07-01T01:00:00.000Z";
  for (let index = 0; index < 36; index += 1) profile.longTermMemories.push({
    id: `ltm_inactive_${index}`, createdAt: "2026-07-01T00:00:00.000Z", kind: "habit", text: `历史记忆 ${index}`,
    weight: 75, tags: [], visualStatus: "not_needed", visualMode: "no_visual", visualPolicyVersion: 5,
    contentRevision: 1, enrichedRevision: 1, enrichmentStatus: "completed"
  });
  profile.memoryCandidates.push({
    id: "candidate_inactive", createdAt: "2026-07-01T00:00:00.000Z", candidateText: "一个离线候选", memoryKind: "long_theme",
    confidence: 90, sourceEpisodeId: "episode_inactive", whyConsolidate: "测试", writePolicy: "wait_feedback",
    decayPolicy: "stable", status: "candidate", tags: []
  });
  await store.saveProfile(profile);
  let modelCalls = 0;
  const provider = fakeProvider(() => { modelCalls += 1; return {}; });
  const now = "2026-07-03T00:00:01.000Z";

  assert.equal(isBackgroundCognitionEligible(profile, now), false);
  assert.deepEqual(await runAutomaticDreamingSweep(store, provider, now), { checked: 0, applied: 0, quiet: 0, deferred: 0 });
  assert.deepEqual(await runDogStateSweep(store, provider, now), { checked: 0, applied: 0, deferred: 0 });
  assert.deepEqual(await runProactiveEmergenceSweep(store, provider, now), { checked: 0, active: 0, quiet: 0, deferred: 0 });
  const normalized = normalizeCreatureProfile(structuredClone(profile));
  assert.equal(modelCalls, 0);
  assert.equal(normalized.jobs?.length, 0, "reading an inactive profile must not enqueue paid visual work");
});

test("real user activity re-enables background cognition while system wake does not", () => {
  const profile = createCreatureProfile({ userId: "activity-resume", creatureName: "Papo", now: "2026-07-01T00:00:00.000Z" });
  const now = "2026-07-03T00:00:01.000Z";
  assert.equal(isBackgroundCognitionEligible(profile, now), false);
  profile.lastSeenAt = now;
  assert.equal(isBackgroundCognitionEligible(profile, now), false, "system wake/lastSeen must not renew paid background work");
  appendInputMessage(profile, { channel: "button", role: "user", text: "我回来了", sourceId: "resume", at: now });
  assert.equal(profile.lastUserActivityAt, now);
  assert.equal(isBackgroundCognitionEligible(profile, now), true);
  markMeaningfulUserActivity(profile, "2026-07-04T00:00:00.000Z");
  assert.equal(profile.lastUserActivityAt, "2026-07-04T00:00:00.000Z");
});

function fakeProvider(onJson: () => unknown): ModelProvider {
  return {
    kind: "generic", name: "background gate fake", available: true, usesRealModel: true,
    async generate() { return ""; }, async generateJson() { return onJson(); }, async summarizeImage() { return ""; },
    async observeAudio() { return ""; }, async generateImage() { throw new Error("image generation must not run"); }
  };
}
